import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ProviderHttpError } from "../../src/provider/http.ts";
import { join } from "node:path";
import test from "node:test";
import { freezePreparedPublication, deliverPreparedPublication } from "../../src/runtime/prepared-publication.ts";
import type { DecisionExpectation } from "../../src/runtime/receipts.ts";
import type { ProviderAdapter, ProviderComment } from "../../src/provider/types.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "prepared-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = { flow: { spec: { states: { assessment: { on: { "agent-succeeded": {} } } } } },
    publicationKeys: [], stateId: "assessment", mode: "stage", resultContract: "assessment", configRevision: "a".repeat(40),
    controllerId: "11111111-1111-4111-8111-111111111111", flowInstanceId: "22222222-2222-4222-8222-222222222222",
    attemptId: "33333333-3333-4333-8333-333333333333",
    ticket: { provider: "github", repository: "owner/repo", number: 2 } } as DecisionExpectation;
  await writeFile(join(root, "decision.json"), '{"event":"agent-succeeded"}');
  await writeFile(join(root, "prepared-comment.txt"), "Assessment complete.");
  let creates = 0, uncertain = false;
  const comments: ProviderComment[] = [];
  const provider = { kind: "github", readTicket: async () => ({ ref: expected.ticket, open: true,
    activation: { present: true }, comments }),
    createComment: async (_ref: unknown, body: string) => {
      creates++;
      const comment = { id: "7", url: "https://github.test/comment/7", body,
        actor: { login: "agent", providerId: "1" }, createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z" };
      comments.push(comment);
      if (uncertain) throw new Error("uncertain write");
      return comment;
    }, readComment: async () => comments[0],
    updateComment: async () => { throw new Error("must never edit"); } } as unknown as ProviderAdapter;
  return { root, expected, provider, comments, creates: () => creates, uncertain: () => { uncertain = true; } };
}

test("publishes frozen substantive text and accounting together with exact readback", async (t) => {
  const f = await fixture(t);
  await freezePreparedPublication(f.root, f.expected, { totalTokens: 1100 });
  await writeFile(join(f.root, "prepared-comment.txt"), "Changed after completion.");
  await deliverPreparedPublication(f.root, f.expected, f.provider);
  await deliverPreparedPublication(f.root, f.expected, f.provider);
  assert.equal(f.creates(), 1);
  assert.match(f.comments[0]!.body, /Assessment complete\./);
  assert.match(f.comments[0]!.body, /Usage: 1,100 tokens/);
  assert.equal(f.comments[0]!.createdAt, f.comments[0]!.updatedAt);
});

test("reconciles uncertain creates without duplicate publication", async (t) => {
  const f = await fixture(t);
  await freezePreparedPublication(f.root, f.expected, { costUsd: 0, costSource: "harness" });
  f.uncertain();
  await assert.rejects(deliverPreparedPublication(f.root, f.expected, f.provider));
  await deliverPreparedPublication(f.root, f.expected, f.provider);
  assert.equal(f.creates(), 1);
  assert.match(f.comments[0]!.body, /Usage: \$0.00 harness estimate/);
});

test("cancellation prevents a prepared write and unavailable cost stays absent", async (t) => {
  const f = await fixture(t);
  await freezePreparedPublication(f.root, f.expected, { totalTokens: 12 });
  await assert.rejects(deliverPreparedPublication(f.root, f.expected, f.provider, () => false));
  assert.equal(f.creates(), 0);
  await deliverPreparedPublication(f.root, f.expected, f.provider);
  assert.match(f.comments[0]!.body, /Usage: 12 tokens/);
  assert.doesNotMatch(f.comments[0]!.body, /\$/);
});

test("uncertain writes without matching evidence cannot create a duplicate", async (t) => {
  const f = await fixture(t);
  await freezePreparedPublication(f.root, f.expected, undefined);
  f.uncertain();
  await assert.rejects(deliverPreparedPublication(f.root, f.expected, f.provider));
  f.comments.length = 0;
  await assert.rejects(deliverPreparedPublication(f.root, f.expected, f.provider), /uncertain publication/);
  assert.equal(f.creates(), 1);
});

test("mismatched readback is rejected and retried from provider evidence", async (t) => {
  const f = await fixture(t);
  await freezePreparedPublication(f.root, f.expected, undefined);
  const read = f.provider.readComment;
  f.provider.readComment = async () => ({ ...f.comments[0]!, body: "Wrong text" });
  await assert.rejects(deliverPreparedPublication(f.root, f.expected, f.provider), /readback/);
  f.provider.readComment = read;
  await deliverPreparedPublication(f.root, f.expected, f.provider);
  assert.equal(f.creates(), 1);
  assert.doesNotMatch(f.comments[0]!.body, /Usage:/);
});


test("retries explicit rate-limit rejection after checking provider evidence", async (t) => {
  const f = await fixture(t);
  await freezePreparedPublication(f.root, f.expected, undefined);
  const create = f.provider.createComment;
  f.provider.createComment = async () => { throw new ProviderHttpError("rate limited", 429, true, null, {}); };
  await assert.rejects(deliverPreparedPublication(f.root, f.expected, f.provider));
  assert.equal(f.creates(), 0);
  f.provider.createComment = create;
  await deliverPreparedPublication(f.root, f.expected, f.provider);
  assert.equal(f.creates(), 1);
});

test("rejects missing stage text and invalid verification text before publication", async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, "prepared-comment.txt"));
  await assert.rejects(freezePreparedPublication(f.root, f.expected, undefined), /not prepared/);
  await writeFile(join(f.root, "prepared-comment.txt"), "Verification is unfinished.");
  await assert.rejects(freezePreparedPublication(f.root, { ...f.expected, resultContract: "verification" }, undefined),
    /VERIFIED/);
  assert.equal(f.creates(), 0);
});

test("ignores foreign publications from before this activation but stops a current foreign owner", async (t) => {
  const f = await fixture(t);
  const marker = '<!-- agent-flow:v1 {"config":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","controller":"44444444-4444-4444-8444-444444444444"} -->';
  const old: ProviderComment = { id: "old", url: "https://github.test/comment/old", body: `${marker}\nEarlier flow.`,
    actor: { login: "other", providerId: "2" }, createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" };
  f.comments.push(old);
  f.provider.readComment = async (_ref, id) => f.comments.find((comment) => comment.id === id)!;
  const expected = { ...f.expected, activatedAt: "2026-10-29T00:00:00Z" };
  await freezePreparedPublication(f.root, expected, undefined);
  await deliverPreparedPublication(f.root, expected, f.provider);
  assert.equal(f.creates(), 1);
  f.comments.splice(0, f.comments.length, { ...old, createdAt: "2026-10-29T00:00:00Z" });
  await assert.rejects(deliverPreparedPublication(f.root, expected, f.provider), /ownership/);
  assert.equal(f.creates(), 1);
});


test("malformed prepared decisions keep the existing retryable invalid-decision classification", async (t) => {
  const f = await fixture(t);
  for (const text of ["{", '{"event":"agent-succeeded","extra":true}']) {
    await writeFile(join(f.root, "decision.json"), text);
    await assert.rejects(freezePreparedPublication(f.root, f.expected, undefined),
      (error: unknown) => (error as { code: string; retryable: boolean }).code === "INVALID_DECISION"
        && (error as { retryable: boolean }).retryable);
  }
  assert.equal(f.creates(), 0);
});
