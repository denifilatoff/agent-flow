import assert from "node:assert/strict";
import test from "node:test";
import { eligibleAfterMigration } from "../../src/runtime/migration-recovery.ts";
test("same-pin replay excludes all old stage and downstream result identities", () => {
  const receipt = {
    baseline: {
      comments: ["old-plan", "old-question"],
      reviews: ["old-review"],
    },
  };
  assert.equal(
    eligibleAfterMigration(receipt as never, "comment", "old-plan"),
    false,
  );
  assert.equal(
    eligibleAfterMigration(receipt as never, "review", "old-review"),
    false,
  );
  assert.equal(
    eligibleAfterMigration(receipt as never, "comment", "new-result"),
    true,
  );
  assert.equal(
    eligibleAfterMigration(receipt as never, "change-request", "8"),
    false,
  );
});

test("receipt-chain recovery freezes same-pin replay and rejects edited requests and forks", async () => {
  const { loadConfigBundle } = await import("../../src/config/load.ts");
  const { behaviorDigest, digest } = await import(
    "../../src/config/migrations.ts"
  );
  const { renderMigrationReceipt } = await import(
    "../../src/provider/migration-receipt.ts"
  );
  const { renderPublication } = await import(
    "../../src/provider/publication.ts"
  );
  const { recoverMigration } = await import(
    "../../src/runtime/migration-recovery.ts"
  );
  const sha = "a".repeat(40),
    controller = "eb587def-76dc-4d14-beb1-87c12cdd37e1",
    actor = { login: "owner", providerId: "1" };
  const bundle = await loadConfigBundle(
      process.cwd(),
      "config/stack.yaml",
      sha,
    ),
    marker = renderPublication({ config: sha, controller });
  const key = (kind: string, id: string) =>
    JSON.stringify([
      "github",
      "https://api.github.com/",
      "owner/repo",
      kind,
      id,
    ]);
  const request = {
    id: "request",
    body: "/agent-flow migrate --pr 8 --to " + sha + " --resume-from planning",
    actor,
    createdAt: "2026-10-30T00:03:00Z",
    updatedAt: "2026-10-30T00:03:00Z",
    url: "request",
  };
  const owner = {
    key: key("comment", "owner"),
    metadata: { config: sha, controller },
    createdAt: "2026-10-30T00:01:00Z",
  };
  const activation = {
    present: true,
    eventId: "activation",
    label: "agent-flow:development",
    actor,
    occurredAt: "2026-10-30T00:00:00Z",
  };
  const change = {
    provider: "github",
    repository: "owner/repo",
    number: 8,
    url: "https://github.com/owner/repo/pull/8",
    headRepository: "owner/repo",
    headBranch: "feature",
    headSha: sha,
    state: "open",
    body: marker,
    actor,
    createdAt: "2026-10-30T00:02:00Z",
    updatedAt: "2026-10-30T00:02:00Z",
  };
  const receipt = {
    workspace: "11111111-1111-4111-8111-111111111111",
    apiVersion: "agent-flow/migration-v1",
    kind: "MigrationReceipt",
    ticket: { provider: "github", repository: "owner/repo", number: 2 },
    activation: {
      eventId: activation.eventId,
      label: activation.label,
      actor,
      occurredAt: activation.occurredAt,
    },
    owner: { key: owner.key, config: sha, createdAt: owner.createdAt },
    request: {
      id: request.id,
      actor,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      bodyHash: digest(request.body),
    },
    source: { config: sha, stage: "awaiting-merge", resume: null },
    target: {
      config: sha,
      flow: bundle.flow.metadata.id,
      label: activation.label,
      basis: "unchanged:" + (await behaviorDigest(bundle)),
    },
    change: { ...change, marker },
    start: "planning",
    retained: [],
    baseline: { comments: ["owner", "request"], reviews: [] },
    predecessor: null,
  };
  delete (receipt.change as Partial<typeof change>).body;
  delete (receipt.change as Partial<typeof change>).actor;
  delete (receipt.change as Partial<typeof change>).state;
  delete (receipt.change as Partial<typeof change>).createdAt;
  delete (receipt.change as Partial<typeof change>).updatedAt;
  const comment = {
    id: "receipt",
    url: "receipt",
    body: renderMigrationReceipt(receipt as never, controller),
    actor,
    createdAt: "2026-10-30T00:04:00Z",
    updatedAt: "2026-10-30T00:04:00Z",
  };
  const evidence = {
    snapshot: {
      ref: receipt.ticket,
      activation,
      comments: [request, comment],
      changeRequest: change,
      open: true,
      labels: ["agent-stage:awaiting-merge"],
    },
    complete: true,
    activeBoundary: "known",
    legacyActive: false,
    changes: [change],
    reviews: [],
    ambiguities: [],
    publications: [
      owner,
      {
        key: key("comment", comment.id),
        metadata: { config: sha, controller },
        createdAt: comment.createdAt,
      },
    ],
  };
  const recovered = await recoverMigration(
    evidence as never,
    async () => bundle,
  );
  assert.equal(recovered.migration?.receipt.start, "planning");
  assert.equal(recovered.publications.length, 0);
  const edited = structuredClone(evidence);
  edited.snapshot.comments[0]!.body += " edited";
  await assert.rejects(
    recoverMigration(edited as never, async () => bundle),
    /missing or edited/,
  );
  const fork = structuredClone(evidence);
  fork.snapshot.comments.push({ ...comment, id: "fork" });
  await assert.rejects(
    recoverMigration(fork as never, async () => bundle),
    /conflicting root/,
  );
});
