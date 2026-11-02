import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonLines, ClaudeUsage, CodexUsage, collectCodexUsage } from "../../src/harness/usage.ts";

test("decodes bounded chunked UTF-8 JSON and retains records around corruption", () => {
  const records: unknown[] = [];
  const decoder = new JsonLines((record) => records.push(record), 32);
  const bytes = Buffer.from('{"text":"é"}\ninvalid\n' + 'x'.repeat(100) + '\n{"ok":true}\n{"cut":');
  for (const byte of bytes) decoder.write(Buffer.from([byte]));
  decoder.end();
  assert.deepEqual(records, [{ text: "é" }, { ok: true }]);
});

test("Claude uses the last whole-tree cumulative result without double counting", async () => {
  const decoder = new ClaudeUsage();
  const bytes = await readFile("test/fixtures/harness/claude-delegation.jsonl");
  decoder.write(bytes); decoder.write(bytes); decoder.end();
  const usage = decoder.usage();
  assert.equal(usage?.totalTokens, 1100);
  assert.equal(usage?.model, undefined);
  assert.equal(usage?.costSource, "harness");
  assert.ok(Math.abs(usage!.costUsd! - 0.0039) < 1e-10);
});

test("Codex includes descendants once and ignores inherited fork metadata", async (t) => {
  for (const name of ["codex-delegation", "codex-fork"]) {
    const home = await mkdtemp(join(tmpdir(), "codex-usage-test-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const files = JSON.parse(await readFile(`test/fixtures/harness/${name}.json`, "utf8"));
    await mkdir(join(home, "sessions"));
    for (const [index, records] of files.entries()) {
      await writeFile(join(home, "sessions", `${index}.jsonl`), records.map(JSON.stringify).join("\n") + "\n");
    }
    const decoder = new CodexUsage();
    decoder.write(Buffer.from(JSON.stringify({ type: "thread.started", thread_id: files[0][0].payload.id }) + "\n"));
    decoder.write(Buffer.from('{"type":"turn.completed"}\n')); decoder.end();
    const usage = await collectCodexUsage(home, decoder);
    assert.equal(usage?.totalTokens, 1100);
    assert.equal(usage?.cachedInputTokens, 10);
    assert.equal(usage?.model, undefined);
    assert.equal(usage?.costUsd, undefined);
  }
});


test("Claude retains deduplicated assistant input/cache usage before an interrupted result", () => {
  const decoder = new ClaudeUsage();
  const assistant = (id: string, input: number) => ({ type: "assistant", session_id: "root",
    message: { id, model: "claude-sonnet-4-6", usage: { input_tokens: input,
      cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 1 } } });
  const first = assistant("message-1", 100);
  const records = [first, first, assistant("message-2", 200),
    { type: "assistant", message: { id: "invalid", usage: { input_tokens: -1, cache_read_input_tokens: "20" } } }];
  const bytes = Buffer.from(records.map(JSON.stringify).join("\n") + '\n{"type":"result"');
  for (const byte of bytes) decoder.write(Buffer.from([byte]));
  decoder.end();
  assert.deepEqual(decoder.usage(), { inputTokens: 300, cacheReadInputTokens: 40, cacheCreationInputTokens: 60 });
});

test("Claude replaces partial assistant observations with a complete aggregate", async () => {
  const decoder = new ClaudeUsage();
  decoder.write(Buffer.from(JSON.stringify({ type: "assistant", message: { id: "message-1",
    usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 1 } } }) + "\n"));
  decoder.write(await readFile("test/fixtures/harness/claude-delegation.jsonl"));
  decoder.end();
  assert.equal(decoder.usage()?.inputTokens, 1000);
  assert.equal(decoder.usage()?.totalTokens, 1100);
  assert.equal(decoder.usage()?.costSource, "harness");
});
