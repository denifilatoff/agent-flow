import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectCodexCost, decodeCodexCostReport } from "../../src/harness/ccusage.ts";
import { processDependencies, type CommandRunner } from "../../src/harness/process.ts";
import { CodexUsage, collectCodexUsage } from "../../src/harness/usage.ts";

function report(ids = ["root", "child"]) {
  const counts = { inputTokens: 90, cacheReadTokens: 10, cacheCreationTokens: 0, outputTokens: 20,
    reasoningOutputTokens: 5, totalTokens: 120 };
  return { sessions: ids.map((sessionId) => ({ sessionId, ...counts, costUSD: 0.04,
    models: { "gpt-6.1-sol": { ...counts, isFallback: false } } })),
    totals: { ...Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value * ids.length])),
      costUSD: 0.04 * ids.length } };
}

function nativeReport(ids: string[]) {
  const value = report(ids);
  for (const [index, session] of value.sessions.entries()) {
    const input = index === 0 ? 700 : 300;
    const counts = { inputTokens: input * 0.99, cacheReadTokens: input / 100, cacheCreationTokens: 0,
      outputTokens: input / 10, reasoningOutputTokens: input / 100, totalTokens: input + input / 10 };
    Object.assign(session, counts, { models: { "gpt-6.1-sol": { ...counts, isFallback: false } } });
  }
  for (const field of ["inputTokens", "cacheReadTokens", "cacheCreationTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const) {
    value.totals[field] = value.sessions.reduce((sum, session) => sum + session[field], 0);
  }
  return value;
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
    (value: ReturnType<typeof report>) => { value.totals.reasoningOutputTokens = 0; },
    (value: ReturnType<typeof report>) => { delete (value.sessions[0]!.models["gpt-6.1-sol"] as { isFallback?: boolean }).isFallback; },
    (value: ReturnType<typeof report>) => { value.sessions.forEach((session) => { session.costUSD = 0; }); value.totals.costUSD = 0; },
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
  const home = await realpath(await mkdtemp(join(tmpdir(), "ccusage-cost-test-")));
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
    if (file === "python3") return processDependencies().runCommand(file, args, options);
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
    return { stdout: JSON.stringify(nativeReport(f.ids)), stderr: "" };
  };
  const usage = await collectCodexCost(f.home, f.decoder, runner);
  assert.equal(usage.costUsd, 0.08);
  assert.equal(usage.costCalculator, "ccusage 20.0.47");
  await assert.rejects(access(snapshot));
  assert.equal(await readFile(join(f.home, "auth.json"), "utf8"), "must not reach calculator");
});

test("does not price incomplete descendants, unsupported tools, warnings, or linked files", async (t) => {
  for (const problem of ["incomplete", "version", "warning", "symlink", "null-counters", "cache-overflow",
    "missing-spawn-result", "invalid-spawn-result", "invalid-stdout", "missing-child"] as const) {
    await t.test(problem, async (context) => {
      const f = await fixture(context);
      if (problem === "incomplete") {
        const path = join(f.home, "sessions", `${f.ids[1]}.jsonl`);
        const lines = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
        await writeFile(path, lines.filter((line) => line.payload?.type !== "task_complete").map(JSON.stringify).join("\n"));
      }
      if (problem === "symlink") await symlink(join(f.home, "auth.json"), join(f.home, "sessions", "linked.jsonl"));
      if (["null-counters", "cache-overflow", "missing-spawn-result", "invalid-spawn-result"].includes(problem)) {
        const path = join(f.home, "sessions", `${f.ids[0]}.jsonl`);
        const lines = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
        if (problem === "null-counters") {
          const event = lines.findLast((line) => line.payload?.type === "token_count");
          event.payload.info.total_token_usage = null;
          event.payload.info.last_token_usage = null;
        } else if (problem === "cache-overflow") {
          const event = lines.findLast((line) => line.payload?.type === "token_count");
          event.payload.info.last_token_usage.cached_input_tokens = 1000;
        } else {
          lines.splice(-1, 0, { type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: "unknown-child" } });
          if (problem === "invalid-spawn-result") lines.splice(-1, 0, { type: "response_item",
            payload: { type: "function_call_output", call_id: "unknown-child", output: "not a confirmed result" } });
        }
        await writeFile(path, lines.map(JSON.stringify).join("\n") + "\n");
      }
      if (problem === "invalid-stdout") f.decoder.write(Buffer.from("not JSON\n"));
      if (problem === "missing-child") f.decoder.spawned.add("missing-child");
      const runner: CommandRunner = async (file, args, options = {}) => {
        if (file === "python3") return processDependencies().runCommand(file, args, options);
        return args[0] === "--version"
          ? { stdout: problem === "version" ? "ccusage 21.0.0" : "ccusage 20.0.47", stderr: "" }
          : { stdout: JSON.stringify(report(f.ids)), stderr: problem === "warning" ? "Pricing fallback used" : "" };
      };
      await assert.rejects(collectCodexCost(f.home, f.decoder, runner));
    });
  }
});

test("preserves quoted TOML tier keys in calculator snapshots", async (t) => {
  for (const key of ['"service_tier"', "'service_tier'", '"service_\\u0074ier"']) {
    const f = await fixture(t);
    await writeFile(join(f.home, "config.toml"), `${key} = "fast"\n`);
    const runner: CommandRunner = async (file, args, options = {}) => {
      if (file === "python3") return processDependencies().runCommand(file, args, options);
      if (args[0] === "--version") return { stdout: "ccusage 20.0.47", stderr: "" };
      assert.equal(await readFile(join(options.env!.CODEX_HOME!, "config.toml"), "utf8"), 'service_tier = "fast"\n');
      return { stdout: JSON.stringify(nativeReport(f.ids)), stderr: "" };
    };
    await collectCodexCost(f.home, f.decoder, runner);
  }
});

test("applies one expired accounting deadline to pricing and fallback log reads", async (t) => {
  const f = await fixture(t);
  const signal = AbortSignal.abort();
  let commands = 0;
  const runner: CommandRunner = async () => { commands++; return { stdout: "", stderr: "" }; };
  await assert.rejects(collectCodexCost(f.home, f.decoder, runner, signal), { name: "AbortError" });
  await assert.rejects(collectCodexUsage(f.home, f.decoder, signal), { name: "AbortError" });
  assert.equal(commands, 0);
});

test("rejects contradictory deltas and overlapping native cache subsets", async (t) => {
  for (const problem of ["larger-than-cumulative", "wrong-delta", "overlapping-cache", "wrong-report"] as const) {
    await t.test(problem, async (context) => {
      const f = await fixture(context);
      const path = join(f.home, "sessions", `${f.ids[0]}.jsonl`);
      const lines = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
      const last = lines.findLast((line) => line.payload?.type === "token_count").payload.info.last_token_usage;
      if (problem === "overlapping-cache") Object.assign(last, { cached_input_tokens: 399, cache_write_input_tokens: 399 });
      else if (problem !== "wrong-report") Object.assign(last, {
        input_tokens: problem === "wrong-delta" ? 650 : 4000,
        total_tokens: problem === "wrong-delta" ? 690 : 4040,
      });
      await writeFile(path, lines.map(JSON.stringify).join("\n") + "\n");
      const value = nativeReport(f.ids);
      const delta = problem === "wrong-delta" ? 250 : 3600;
      value.sessions[0]!.inputTokens += delta;
      value.sessions[0]!.totalTokens += delta;
      Object.assign(value.sessions[0]!.models["gpt-6.1-sol"]!, {
        inputTokens: value.sessions[0]!.inputTokens, totalTokens: value.sessions[0]!.totalTokens,
      });
      value.totals.inputTokens += delta;
      value.totals.totalTokens += delta;
      const runner: CommandRunner = async (file, args, options = {}) => {
        if (file === "python3") return processDependencies().runCommand(file, args, options);
        return { stdout: args[0] === "--version" ? "ccusage 20.0.47" : JSON.stringify(value), stderr: "" };
      };
      await assert.rejects(collectCodexCost(f.home, f.decoder, runner));
    });
  }
});

test("allows independent compaction usage only with matching own billable records", async (t) => {
  for (const problem of ["none", "marker-only", "malformed-usage"] as const) {
    await t.test(problem, async (context) => {
      const f = await fixture(context);
      const path = join(f.home, "sessions", `${f.ids[0]}.jsonl`);
      const lines = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
      const compacted = { type: "compacted", payload: { compaction_response_id: "compact-1" } };
      const usage = { input_tokens: 300, output_tokens: 30 };
      if (problem !== "marker-only") lines.splice(-1, 0, { timestamp: "2026-10-29T14:30:09.663Z",
        type: "token_usage_record", payload: { response_id: "compact-1",
          usage: problem === "malformed-usage" ? { ...usage, cached_input_tokens: 500 } : usage } });
      lines.splice(-1, 0, compacted);
      await writeFile(path, lines.map(JSON.stringify).join("\n") + "\n");
      const value = nativeReport(f.ids);
      for (const counts of [value.sessions[0]!, value.sessions[0]!.models["gpt-6.1-sol"]!, value.totals]) {
        counts.inputTokens += 300; counts.outputTokens += 30; counts.totalTokens += 330;
      }
      const runner: CommandRunner = async (file, args, options = {}) => {
        if (file === "python3") return processDependencies().runCommand(file, args, options);
        return { stdout: args[0] === "--version" ? "ccusage 20.0.47" : JSON.stringify(value), stderr: "" };
      };
      if (problem === "none") assert.equal((await collectCodexCost(f.home, f.decoder, runner)).totalTokens, 1430);
      else await assert.rejects(collectCodexCost(f.home, f.decoder, runner));
    });
  }
});

test("ignores inherited completion, spawn, and compaction evidence in native forks", async (t) => {
  const f = await fixture(t);
  const fork = JSON.parse(await readFile("test/fixtures/harness/codex-fork.json", "utf8"));
  for (const name of await readdir(join(f.home, "sessions"))) await rm(join(f.home, "sessions", name));
  const ids = fork.map((records: any[]) => records[0].payload.id);
  fork[1].splice(1, 0, { ordinal: 3, type: "token_usage_record", payload: { response_id: "inherited", usage: null } },
    { ordinal: 4, type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: "inherited" } });
  for (const records of fork) await writeFile(join(f.home, "sessions", `${records[0].payload.id}.jsonl`), records.map(JSON.stringify).join("\n") + "\n");
  const decoder = new CodexUsage();
  decoder.write(Buffer.from(JSON.stringify({ type: "thread.started", thread_id: ids[0] }) + '\n{"type":"turn.completed"}\n'));
  decoder.end();
  const runner: CommandRunner = async (file, args, options = {}) => {
    if (file === "python3") return processDependencies().runCommand(file, args, options);
    return { stdout: args[0] === "--version" ? "ccusage 20.0.47" : JSON.stringify(nativeReport(ids)), stderr: "" };
  };
  assert.equal((await collectCodexCost(f.home, decoder, runner)).totalTokens, 1100);
});
