import assert from "node:assert/strict";
import test from "node:test";
import { processMigration } from "../../src/runtime/migration.ts";
test("unauthorized migration comments never resolve targets or mutate provider state", async () => {
  const evidence = {
    complete: true,
    legacyActive: false,
    activeBoundary: "known",
    ambiguities: [],
    publications: [],
    changes: [],
    reviews: [],
    snapshot: {
      ref: { repository: "owner/repo" },
      open: true,
      activation: { present: true },
      comments: [
        {
          id: "1",
          body: "/agent-flow migrate --pr 8 --to latest",
          actor: { login: "outsider", providerId: "2" },
        },
      ],
    },
  };
  const dependencies = {
    provider: { permission: async () => "read" },
    config: {
      resolveTarget: async () => assert.fail("unauthorized resolution"),
    },
  };
  assert.equal(
    await processMigration(dependencies as never, evidence as never),
    evidence,
  );
});

async function migrationFixture(t: import("node:test").TestContext) {
  const { mkdtemp, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const { loadConfigBundle } = await import("../../src/config/load.ts"),
    { openLocalStore, providerScope } = await import(
      "../../src/runtime/local-store.ts"
    ),
    { createControlWriter } = await import(
      "../../src/runtime/control-state.ts"
    );
  const { parsePublication, renderPublication } = await import(
    "../../src/provider/publication.ts"
  );
  const controller = "eb587def-76dc-4d14-beb1-87c12cdd37e1",
    sourceSha = "a".repeat(40),
    targetSha = "b".repeat(40),
    actor = { login: "owner", providerId: "1" };
  const source = await loadConfigBundle(
      process.cwd(),
      "config/stack.yaml",
      sourceSha,
    ),
    target = { ...source, revision: targetSha };
  const root = await mkdtemp(join(tmpdir(), "migration-protocol-")),
    store = await openLocalStore(join(root, "local.sqlite"));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const ref = {
    provider: "github",
    repository: "owner/repo",
    number: 2,
  } as const;
  const marker = renderPublication({ config: sourceSha, controller });
  const comment = (id: string, body: string) => ({
    id,
    url: "https://github.com/owner/repo/issues/2#issuecomment-" + id,
    body,
    actor,
    createdAt: "2026-10-30T00:01:" + id.padStart(2, "0") + "Z",
    updatedAt: "2026-10-30T00:01:" + id.padStart(2, "0") + "Z",
  });
  const selected = {
    provider: "github",
    repository: ref.repository,
    number: 8,
    url: "https://github.com/owner/repo/pull/8",
    headRepository: ref.repository,
    headBranch: "feature",
    headSha: "1".repeat(40),
    state: "open",
    body: marker,
    actor,
    createdAt: "2026-10-30T00:01:02Z",
    updatedAt: "2026-10-30T00:01:02Z",
  } as const;
  const snapshot = {
    ref,
    repository: {
      provider: "github",
      name: ref.repository,
      host: "github.com",
      cloneRoot: "https://github.com/",
      cloneUrl: "https://github.com/owner/repo.git",
    },
    title: "migration",
    description: "ticket",
    open: true,
    labels: [
      "agent-flow:managed",
      "agent-flow:development",
      "agent-stage:awaiting-merge",
    ],
    updatedAt: "2026-10-30T00:02:00Z",
    activation: {
      present: true,
      label: "agent-flow:development",
      eventId: "activation",
      actor,
      occurredAt: "2026-10-30T00:00:00Z",
    },
    comments: [
      comment("1", marker + "\nAssessment"),
      comment(
        "3",
        "/agent-flow migrate --pr 8 --to latest --resume-from development",
      ),
    ],
    changeRequest: selected,
  };
  const key = (kind: string, id: string) =>
    JSON.stringify([
      "github",
      "https://api.github.com/",
      ref.repository,
      kind,
      id,
    ]);
  const reviews: Array<{
    id: string;
    body: string;
    headSha: string;
    verdict: string;
    submittedAt: string;
    actor: typeof actor;
    url: string;
  }> = [];
  const raw = () => ({
    snapshot: structuredClone(snapshot),
    complete: true,
    activeBoundary: "known",
    legacyActive: false,
    ambiguities: [],
    changes: [structuredClone(selected)],
    reviews: structuredClone(reviews),
    publications: [
      ...reviews.map((r) => ({
        key: key("review", r.id),
        createdAt: r.submittedAt,
        metadata: (
          parsePublication(r.body) as {
            kind: "current";
            metadata: { config: string; controller: string };
          }
        ).metadata,
      })),
      ...snapshot.comments.flatMap((c) => {
        const p = parsePublication(c.body);
        return p.kind === "current"
          ? [
              {
                key: key("comment", c.id),
                createdAt: c.createdAt,
                metadata: p.metadata,
              },
            ]
          : [];
      }),
      {
        key: key("change-request", "8"),
        createdAt: selected.createdAt,
        metadata: { config: sourceSha, controller },
      },
    ],
  });
  let next = 4,
    resolves = 0,
    creates = 0,
    cancels = 0;
  const starts: unknown[] = [];
  const provider = {
    kind: "github",
    permission: async () => "write",
    readRecoveryEvidence: async () => raw(),
    readTicket: async () => structuredClone(snapshot),
    readChangeRequest: async () => structuredClone(selected),
    readComment: async (_ref: unknown, id: string) =>
      snapshot.comments.find((c) => c.id === id)!,
    createComment: async (_ref: unknown, body: string) => {
      creates++;
      const c = comment(String(next++), body);
      snapshot.comments.push(c);
      return c;
    },
    setControllerLabels: async (
      _ref: unknown,
      remove: string[],
      add: string[],
    ) => {
      snapshot.labels = snapshot.labels.filter((l) => !remove.includes(l));
      snapshot.labels.push(...add);
      return snapshot.labels;
    },
  };
  const writeControl = createControlWriter(
    store,
    providerScope("github", "https://api.github.com"),
    controller,
  );
  const d = {
    provider,
    controllerId: controller,
    writeControl,
    config: {
      loadPinned: async (sha: string) => (sha === sourceSha ? source : target),
      loadCurrent: async () => target,
      resolveTarget: async () => {
        resolves++;
        return targetSha;
      },
    },
    launcher: {
      start: async (request: unknown) => {
        starts.push(request);
      },
      cancel: async () => {
        cancels++;
      },
      isRunning: () => false,
    },
  };
  return {
    d,
    raw,
    snapshot,
    selected,
    source,
    target,
    starts,
    writeControl,
    ref,
    reviews,
    comment,
    async reset() {
      const empty = await openLocalStore(
        join(root, "empty-" + next++ + ".sqlite"),
      );
      t.after(() => empty.close());
      d.writeControl = createControlWriter(
        empty,
        providerScope("github", "https://api.github.com"),
        controller,
      );
    },
    counts: () => ({ resolves, creates, cancels }),
  };
}

test("receipt commit/readback carries PR 8 and duplicate reconciliation preserves one replay boundary", async (t) => {
  const f = await migrationFixture(t),
    { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
  const first = await reconcileTicket(f.d as never, f.ref);
  assert.equal(first.stateId, "development");
  assert.equal(first.configRevision, f.target.revision);
  assert.equal(f.counts().creates, 1);
  assert.equal(f.counts().resolves, 1);
  assert.equal(f.starts.length, 1);
  assert.equal(f.snapshot.changeRequest.number, 8);
  assert.ok(f.snapshot.changeRequest.body.includes(f.source.revision));
  const saved = f.writeControl.load!(f.ref)!;
  assert.ok(saved.value.migrationId);
  await reconcileTicket(f.d as never, f.ref);
  assert.equal(f.counts().creates, 1);
  assert.equal(f.counts().resolves, 1);
  assert.equal(
    f.writeControl.load!(f.ref)!.value.migrationId,
    saved.value.migrationId,
  );
});

test("uncertain receipt creation recovers the published decision without another resolution or write", async (t) => {
  const f = await migrationFixture(t),
    { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
  const create = f.d.provider.createComment;
  let fail = true;
  f.d.provider.createComment = async (ref, body) => {
    const result = await create(ref, body);
    if (body.includes("agent-flow-migration:v1") && fail) {
      fail = false;
      throw new Error("connection lost after create");
    }
    return result;
  };
  const first = await reconcileTicket(f.d as never, f.ref);
  assert.equal(first.started, false);
  assert.equal(f.starts.length, 0);
  const second = await reconcileTicket(f.d as never, f.ref);
  assert.equal(second.stateId, "development");
  assert.equal(f.counts().creates, 1);
  assert.equal(f.counts().resolves, 1);
});

test("failed kill and activation loss while draining never commit a migration", async (t) => {
  for (const mode of ["kill", "activation"]) {
    const f = await migrationFixture(t),
      { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
    // Establish source local state so cancellation is required before commitment.
    await f.writeControl(f.ref, null, {
      apiVersion: "agent-flow/v1alpha1",
      kind: "ControlState",
      flowInstanceId: "11111111-1111-4111-8111-111111111111",
      flowId: f.source.flow.metadata.id,
      configRevision: f.source.revision,
      sequence: 0,
      stateId: "awaiting-merge",
      resumeStateId: null,
      activatedBy: f.snapshot.activation.actor,
      activatedAt: f.snapshot.activation.occurredAt,
      activationEventId: f.snapshot.activation.eventId,
      activationLabel: f.snapshot.activation.label,
      updatedAt: f.snapshot.updatedAt,
      attemptSeries: null,
      latestReceipt: null,
      humanGate: null,
      changeRequest: {
        provider: f.selected.provider,
        repository: f.selected.repository,
        number: f.selected.number,
        url: f.selected.url,
        headSha: f.selected.headSha,
        state: f.selected.state,
      },
    });
    f.d.launcher.cancel = async () => {
      if (mode === "kill") throw new Error("cannot confirm termination");
      f.snapshot.activation.present = false;
      f.snapshot.labels = f.snapshot.labels.filter(
        (l) => l !== "agent-flow:development",
      );
    };
    await reconcileTicket(f.d as never, f.ref);
    assert.equal(
      f.snapshot.comments.filter((c) =>
        c.body.includes("<!-- agent-flow-migration:v1"),
      ).length,
      0,
    );
  }
});

test("incomplete receipt readback retries only from a complete provider snapshot", async (t) => {
  const f = await migrationFixture(t),
    { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
  const read = f.d.provider.readRecoveryEvidence;
  let reads = 0;
  f.d.provider.readRecoveryEvidence = async () => {
    const result = await read();
    reads++;
    if (reads === 3) result.complete = false;
    return result;
  };
  await reconcileTicket(f.d as never, f.ref);
  assert.equal(f.starts.length, 0);
  await reconcileTicket(f.d as never, f.ref);
  assert.equal(f.starts.length, 1);
  assert.equal(f.counts().creates, 1);
});

test("empty SQLite recovers the committed replay and later justified progress without rewinding", async (t) => {
  const f = await migrationFixture(t),
    { reconcileTicket } = await import("../../src/runtime/reconcile.ts"),
    { renderPublication } = await import("../../src/provider/publication.ts");
  await reconcileTicket(f.d as never, f.ref);
  await f.reset();
  assert.equal(
    (await reconcileTicket(f.d as never, f.ref)).stateId,
    "development",
  );
  const marker = renderPublication({
    config: f.target.revision,
    controller: f.d.controllerId,
  });
  f.snapshot.comments.push(
    f.comment("20", marker + "\nDevelopment revalidated"),
  );
  f.snapshot.labels = f.snapshot.labels
    .filter((l) => !l.startsWith("agent-stage:"))
    .concat("agent-stage:review");
  await f.reset();
  assert.equal((await reconcileTicket(f.d as never, f.ref)).stateId, "review");
  f.reviews.push({
    id: "701",
    body:
      marker +
      "\n<!-- agent-flow-review:v1 head=" +
      f.selected.headSha +
      " verdict=approved -->",
    headSha: f.selected.headSha,
    verdict: "approved",
    submittedAt: "2026-10-30T00:02:00Z",
    actor: f.snapshot.activation.actor,
    url: "https://github.com/owner/repo/pull/8#pullrequestreview-701",
  });
  f.snapshot.labels = f.snapshot.labels
    .filter((l) => !l.startsWith("agent-stage:"))
    .concat("agent-stage:awaiting-merge");
  await f.reset();
  assert.equal(
    (await reconcileTicket(f.d as never, f.ref)).stateId,
    "awaiting-merge",
  );
  assert.equal(f.counts().creates, 1);
});

test("unchanged-contract migration without replay retains only explicitly referenced current-head approval", async (t) => {
  const f = await migrationFixture(t),
    { reconcileTicket } = await import("../../src/runtime/reconcile.ts"),
    { renderPublication } = await import("../../src/provider/publication.ts");
  f.snapshot.comments[1]!.body = "/agent-flow migrate --pr 8 --to latest";
  const marker = renderPublication({
    config: f.source.revision,
    controller: f.d.controllerId,
  });
  f.reviews.push({
    id: "701",
    body:
      marker +
      "\n<!-- agent-flow-review:v1 head=" +
      f.selected.headSha +
      " verdict=approved -->",
    headSha: f.selected.headSha,
    verdict: "approved",
    submittedAt: "2026-10-30T00:01:02Z",
    actor: f.snapshot.activation.actor,
    url: "https://github.com/owner/repo/pull/8#pullrequestreview-701",
  });
  const result = await reconcileTicket(f.d as never, f.ref);
  assert.equal(result.stateId, "awaiting-merge");
  assert.equal(f.starts.length, 0);
  await f.reset();
  assert.equal(
    (await reconcileTicket(f.d as never, f.ref)).stateId,
    "awaiting-merge",
  );
});

test("duplicate migration reconciliation preserves surviving replay retry consumption and input identity", async (t) => {
  const f = await migrationFixture(t),
    { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
  await reconcileTicket(f.d as never, f.ref);
  const request = f
    .starts[0] as import("../../src/runtime/reconcile.ts").AttemptRequest;
  const stored = f.writeControl.load!(f.ref)!.value.control!;
  await f.writeControl(f.ref, stored, {
    ...stored,
    sequence: stored.sequence + 1,
    attemptSeries: {
      seriesId: "22222222-2222-4222-8222-222222222222",
      agentId: "developer",
      stateId: "development",
      inputRevision: request.inputRevision,
      maxAttempts: 3,
      consumed: 2,
      current: {
        attemptId: "33333333-3333-4333-8333-333333333333",
        status: "failed",
        startedAt: stored.updatedAt,
      },
    },
  });
  await reconcileTicket(f.d as never, f.ref);
  assert.equal(
    f.writeControl.load!(f.ref)!.value.control!.attemptSeries!.consumed,
    2,
  );
  assert.equal(
    (f.starts.at(-1) as typeof request).inputRevision,
    request.inputRevision,
  );
  assert.equal(f.counts().creates, 1);
});

test("foreign ownership never produces a migration diagnostic or provider mutation", async (t) => {
  const f = await migrationFixture(t);
  f.d.controllerId = "11111111-1111-4111-8111-111111111111";
  await processMigration(f.d as never, f.raw() as never);
  assert.equal(f.counts().creates, 0);
  assert.equal(f.counts().resolves, 0);
});

test("unsupported provider and unavailable target leave source execution unchanged and deduplicate diagnostics", async (t) => {
  for (const mode of ["gitlab", "unavailable"]) {
    const f = await migrationFixture(t);
    if (mode === "gitlab") f.d.provider.kind = "gitlab";
    else
      f.d.config.resolveTarget = async () => {
        throw new Error("configuration refresh unavailable");
      };
    await processMigration(f.d as never, f.raw() as never);
    assert.equal(
      f.snapshot.comments.filter((c) =>
        c.body.includes("<!-- agent-flow-migration:v1"),
      ).length,
      0,
    );
    assert.equal(f.counts().creates, 1);
    await processMigration(f.d as never, f.raw() as never);
    assert.equal(f.counts().creates, 1);
    assert.ok(f.snapshot.labels.includes("agent-stage:awaiting-merge"));
  }
});

test("successive direct migrations recover one predecessor chain and preserve the same selected PR/workspace", async (t) => {
  const f = await migrationFixture(t),
    { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
  await reconcileTicket(f.d as never, f.ref);
  const first = f.d.writeControl.load!(f.ref)!.value.control!;
  f.snapshot.comments.push(
    f.comment(
      "21",
      "/agent-flow migrate --pr 8 --to latest --resume-from development",
    ),
  );
  await reconcileTicket(f.d as never, f.ref);
  const second = f.d.writeControl.load!(f.ref)!.value.control!;
  assert.equal(second.flowInstanceId, first.flowInstanceId);
  assert.equal(f.counts().creates, 2);
  await f.reset();
  const recovered = await reconcileTicket(f.d as never, f.ref);
  assert.equal(recovered.stateId, "development");
  assert.equal(f.counts().creates, 2);
  assert.equal(f.counts().resolves, 2);
});

test("merged carried PR completes after empty-store recovery only with target results and fresh review", async (t) => {
  const f = await migrationFixture(t),
    { reconcileTicket } = await import("../../src/runtime/reconcile.ts"),
    { renderPublication } = await import("../../src/provider/publication.ts");
  await reconcileTicket(f.d as never, f.ref);
  const marker = renderPublication({
    config: f.target.revision,
    controller: f.d.controllerId,
  });
  f.snapshot.comments.push(
    f.comment("20", marker + "\nDevelopment revalidated"),
  );
  f.reviews.push({
    id: "701",
    body:
      marker +
      "\n<!-- agent-flow-review:v1 head=" +
      f.selected.headSha +
      " verdict=approved -->",
    headSha: f.selected.headSha,
    verdict: "approved",
    submittedAt: "2026-10-30T00:02:00Z",
    actor: f.snapshot.activation.actor,
    url: "https://github.com/owner/repo/pull/8#pullrequestreview-701",
  });
  f.snapshot.labels = f.snapshot.labels
    .filter((l) => !l.startsWith("agent-stage:"))
    .concat("agent-stage:awaiting-merge");
  Object.assign(f.selected, { state: "merged" });
  f.snapshot.open = false;
  await f.reset();
  assert.equal((await reconcileTicket(f.d as never, f.ref)).stateId, "done");
});
