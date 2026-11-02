import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { collectCodexCost, decodeCodexCostReport } from "../../src/harness/ccusage.ts";
import type { CommandRunner } from "../../src/harness/process.ts";
import { CodexUsage } from "../../src/harness/usage.ts";

function report(ids = ["root", "child"]) {
  const counts = { inputTokens: 90, cacheReadTokens: 10, cacheCreationTokens: 0, outputTokens: 20,
    reasoningOutputTokens: 5, totalTokens: 120 };
  return { sessions: ids.map((sessionId) => ({ sessionId, ...counts, costUSD: 0.04,
    models: { "gpt-6.1-sol": { ...counts, isFallback: false } } })),
    totals: { ...Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value * ids.length])),
      costUSD: 0.04 * ids.length } };
}

test("validates whole-attempt ccusage totals and preserves cache subsets", () => {
  assert.deepEqual(decodeCodexCostReport(report(), ["root", "child"]), {
    inputTokens: 200, cachedInputTokens: 20, cacheCreationInputTokens: 0, outputTokens: 40,
    reasoningOutputTokens: 10, totalTokens: 240, model: "gpt-6.1-sol", costUsd: 0.08, costSource: "estimated",
  });
});

test("rejects missing, duplicate, unpriced, fallback, and inconsistent ccusage reports", () => {
  const changes = [
    (value: ReturnType<typeof report>) => { value.sessions.pop(); },
    (value: ReturnType<typeof report>) => { value.sessions[1]!.sessionId = "root"; },
    (value: ReturnType<typeof report>) => { value.sessions[0]!.models["gpt-6.1-sol"]!.isFallback = true; },
    (value: ReturnType<typeof report>) => { Object.assign(value.sessions[0]!.models["gpt-6.1-sol"]!, { missingPricing: true }); },
    (value: ReturnType<typeof report>) => { Object.assign(value.totals, { unpricedModels: ["gpt-6.1-sol"] }); },
    (value: ReturnType<typeof report>) => { value.totals.costUSD = 1; },
    (value: ReturnType<typeof report>) => { value.sessions[0]!.totalTokens++; },
    (value: ReturnType<typeof report>) => { value.sessions[0]!.models["gpt-6.1-sol"]!.inputTokens--; },
    (value: ReturnType<typeof report>) => { value.sessions[0]!.costUSD = NaN; },
  ];
  for (const change of changes) {
    const value = report();
    change(value);
    assert.throws(() => decodeCodexCostReport(value, ["root", "child"]));
  }
});

test("mixed actual models retain their full cost without claiming one model", () => {
  const value = report();
  const child = value.sessions[1]!;
  child.models = { "gpt-6.1-astra": child.models["gpt-6.1-sol"]! } as typeof child.models;
  assert.equal(decodeCodexCostReport(value, ["root", "child"]).model, undefined);
  assert.equal(decodeCodexCostReport(value, ["root", "child"]).costUsd, 0.08);
});

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "ccusage-cost-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "sessions"));
  const sessions = JSON.parse(await readFile("test/fixtures/harness/codex-delegation.json", "utf8"));
  for (const records of sessions) {
    await writeFile(join(home, "sessions", `${records[0].payload.id}.jsonl`), records.map(JSON.stringify).join("\n") + "\n");
  }
  await writeFile(join(home, "auth.json"), "must not reach calculator");
  await writeFile(join(home, "config.toml"), 'service_tier = "priority"\napi_key = "must not reach calculator"\n');
  const decoder = new CodexUsage();
  decoder.write(Buffer.from(JSON.stringify({ type: "thread.started", thread_id: sessions[0][0].payload.id }) + "\n"));
  decoder.write(Buffer.from('{"type":"turn.completed"}\n'));
  decoder.end();
  return { home, decoder, ids: sessions.map((records: Array<{ payload: { id: string } }>) => records[0]!.payload.id) };
}

test("prices only completed selected logs in a credential-free snapshot and cleans it up", async (t) => {
  const f = await fixture(t);
  let snapshot = "";
  const runner: CommandRunner = async (file, args, options = {}) => {
    assert.equal(file, "ccusage");
    assert.ok(options.signal);
    if (args[0] === "--version") return { stdout: "ccusage 20.0.47\n", stderr: "" };
    assert.deepEqual(args.slice(0, 5), ["codex", "session", "--json", "--no-offline", "--config"]);
    snapshot = options.env!.CODEX_HOME!;
    assert.notEqual(snapshot, f.home);
    assert.equal(options.cwd, snapshot);
    await assert.rejects(access(join(snapshot, "auth.json")));
    assert.equal(await readFile(join(snapshot, "config.toml"), "utf8"), 'service_tier = "priority"\n');
    assert.deepEqual((await readdir(join(snapshot, "sessions"))).sort(), f.ids.map((id: string) => `${id}.jsonl`).sort());
    assert.equal(options.env!.GH_TOKEN, undefined);
    return { stdout: JSON.stringify(report(f.ids)), stderr: "" };
  };
  const usage = await collectCodexCost(f.home, f.decoder, runner);
  assert.equal(usage.costUsd, 0.08);
  assert.equal(usage.costCalculator, "ccusage 20.0.47");
  await assert.rejects(access(snapshot));
  assert.equal(await readFile(join(f.home, "auth.json"), "utf8"), "must not reach calculator");
});

test("does not price incomplete descendants, unsupported tools, warnings, or linked files", async (t) => {
  for (const problem of ["incomplete", "version", "warning", "symlink"] as const) {
    await t.test(problem, async (context) => {
      const f = await fixture(context);
      if (problem === "incomplete") {
        const path = join(f.home, "sessions", `${f.ids[1]}.jsonl`);
        const lines = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
        await writeFile(path, lines.filter((line) => line.payload?.type !== "task_complete").map(JSON.stringify).join("\n"));
      }
      if (problem === "symlink") await symlink(join(f.home, "auth.json"), join(f.home, "sessions", "linked.jsonl"));
      const runner: CommandRunner = async (_file, args) => args[0] === "--version"
        ? { stdout: problem === "version" ? "ccusage 21.0.0" : "ccusage 20.0.47", stderr: "" }
        : { stdout: JSON.stringify(report(f.ids)), stderr: problem === "warning" ? "Pricing fallback used" : "" };
      await assert.rejects(collectCodexCost(f.home, f.decoder, runner));
    });
  }
});
