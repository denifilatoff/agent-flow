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

test("no-replay merge-wait migration recovers a changed head through fresh review", async (t) => {
  for (const stage of ["review", "awaiting-merge"]) {
    await t.test(stage, async (t) => {
      const f = await migrationFixture(t);
      const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
      f.snapshot.comments[1]!.body = "/agent-flow migrate --pr 8 --to latest";
      const review = (id: string, config: string, headSha: string) => ({
        id, headSha, verdict: "approved", actor: f.selected.actor,
        body: `<!-- agent-flow:v1 {"config":"${config}","controller":"${f.d.controllerId}"} -->`
          + `\n<!-- agent-flow-review:v1 head=${headSha} verdict=approved -->`,
        submittedAt: f.comment(id, "").createdAt,
        url: `https://github.com/owner/repo/pull/8#pullrequestreview-${id}`,
      });
      f.reviews.push(review("2", f.source.revision, f.selected.headSha));
      assert.equal((await reconcileTicket(f.d as never, f.ref)).stateId, "awaiting-merge");
      Object.assign(f.selected, { headSha: "2".repeat(40) });
      f.snapshot.changeRequest = f.selected;
      if (stage === "awaiting-merge") f.reviews.push(review("21", f.target.revision, f.selected.headSha));
      f.snapshot.labels = ["agent-flow:managed", "agent-flow:development", "agent-stage:" + stage];
      await f.reset();
      const recovered = await reconcileTicket(f.d as never, f.ref);
      assert.equal(recovered.stateId, stage);
      assert.equal(recovered.configRevision, f.target.revision);
      assert.equal(f.d.writeControl.load!(f.ref)!.value.control!.changeRequest?.headSha, f.selected.headSha);
      assert.equal(f.counts().creates, 1);
      if (stage === "review") {
        assert.equal(f.starts.length, 1);
      } else {
        for (const invalid of ["head", "verdict", "authorization", "missing"]) {
          const original = structuredClone(f.reviews[1]!);
          if (invalid === "head") f.reviews[1]!.headSha = "3".repeat(40);
          if (invalid === "verdict") f.reviews[1]!.verdict = "commented";
          if (invalid === "authorization") {
            f.reviews[1]!.actor = { login: "outsider", providerId: "2" };
            f.d.provider.permission = async (...args: unknown[]) =>
              (args[1] as { login: string }).login === "outsider" ? "read" : "write";
          }
          if (invalid === "missing") f.reviews.pop();
          f.snapshot.labels = ["agent-flow:managed", "agent-flow:development", "agent-stage:awaiting-merge"];
          await f.reset();
          const rejected = await reconcileTicket(f.d as never, f.ref);
          assert.notEqual(rejected.stateId, "awaiting-merge", invalid);
          if (invalid === "authorization") {
            assert.equal(rejected.recoveryDisposition, "ambiguous", invalid);
          }
          f.reviews[1] = original;
        }
      }
    });
  }
});

function approveSourceHead(f: Awaited<ReturnType<typeof migrationFixture>>) {
  f.reviews.push({
    id: "2", headSha: f.selected.headSha, verdict: "approved", actor: f.selected.actor,
    body: f.selected.body + `\n<!-- agent-flow-review:v1 head=${f.selected.headSha} verdict=approved -->`,
    submittedAt: f.comment("2", "").createdAt,
    url: "https://github.com/owner/repo/pull/8#pullrequestreview-2",
  });
}

test("merge-wait verification replay applies its destination before stale-label review recovery", async (t) => {
  for (const interrupted of [false, true]) {
    await t.test(interrupted ? "receipt before label write" : "ordinary commit", async (t) => {
      const f = await migrationFixture(t);
      const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
      f.snapshot.activation.label = "bugfix";
      f.snapshot.labels = ["agent-flow:managed", "bugfix", "agent-stage:awaiting-merge"];
      f.snapshot.comments[1]!.body = "/agent-flow migrate --pr 8 --to latest --resume-from bug-verification";
      approveSourceHead(f);
      const originalBody = f.selected.body;
      const writeLabels = f.d.provider.setControllerLabels;
      if (interrupted) f.d.provider.setControllerLabels = async () => { throw new Error("interrupted label write"); };
      if (interrupted) {
        await assert.rejects(reconcileTicket(f.d as never, f.ref), /controller label update failed/);
        assert.equal(f.counts().creates, 1);
        assert.equal(f.starts.length, 0);
        await f.reset();
        f.d.provider.setControllerLabels = writeLabels;
      }
      const migrated = await reconcileTicket(f.d as never, f.ref);
      assert.equal(migrated.stateId, "bug-verification");
      assert.equal(migrated.configRevision, f.target.revision);
      assert.equal(f.counts().creates, 1);
      const { parseMigrationReceipt } = await import("../../src/provider/migration-receipt.ts");
      const receipt = f.snapshot.comments.map((c) => parseMigrationReceipt(c.body)).find(Boolean)!.receipt;
      assert.equal(receipt.retained[0]?.stage, "bug-review");
      assert.equal(f.starts.length, 1);
      assert.equal((await reconcileTicket(f.d as never, f.ref)).stateId, "bug-verification");
      await f.reset();
      assert.equal((await reconcileTicket(f.d as never, f.ref)).stateId, "bug-verification");
      assert.equal(f.counts().creates, 1);
      assert.equal(f.selected.body, originalBody);
      // A completed replay is reassessed on restart rather than starting another migration.
      const marker = `<!-- agent-flow:v1 {"config":"${f.target.revision}","controller":"${f.d.controllerId}"} -->`;
      f.snapshot.comments.push(f.comment("22", marker + "\nVerification complete"));
      f.snapshot.labels = ["agent-flow:managed", "bugfix", "agent-stage:awaiting-merge"];
      await f.reset();
      assert.equal((await reconcileTicket(f.d as never, f.ref)).stateId, "bug-verification");
      assert.equal(f.counts().creates, 1);
    });
  }
});

test("verification replay rejects unavailable or unauthorized preceding approval before committing", async (t) => {
  for (const invalid of ["missing", "head", "authorization"]) {
    await t.test(invalid, async (t) => {
      const f = await migrationFixture(t);
      const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
      const { parseMigrationReceipt } = await import("../../src/provider/migration-receipt.ts");
      f.snapshot.activation.label = "bugfix";
      f.snapshot.labels = ["agent-flow:managed", "bugfix", "agent-stage:awaiting-merge"];
      f.snapshot.comments[1]!.body = "/agent-flow migrate --pr 8 --to latest --resume-from bug-verification";
      if (invalid !== "missing") approveSourceHead(f);
      if (invalid === "head") f.reviews[0]!.headSha = "2".repeat(40);
      if (invalid === "authorization") {
        f.reviews[0]!.actor = { login: "outsider", providerId: "2" };
        f.d.provider.permission = async (...args: unknown[]) =>
          (args[1] as { login: string }).login === "outsider" ? "read" : "write";
      }
      await reconcileTicket(f.d as never, f.ref);
      assert.equal(f.snapshot.comments.some((c) => parseMigrationReceipt(c.body)), false);
      assert.ok(f.snapshot.comments.some((c) => c.body.includes("request an explicit review replay")));
      assert.equal(f.counts().cancels, 0);
    });
  }
});

test("verification replay follows a changed head to review across SQLite loss", async (t) => {
  const f = await migrationFixture(t);
  const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
  f.snapshot.activation.label = "bugfix";
  f.snapshot.labels = ["agent-flow:managed", "bugfix", "agent-stage:bug-verification"];
  f.snapshot.comments[1]!.body = "/agent-flow migrate --pr 8 --to latest --resume-from bug-verification";
  approveSourceHead(f);
  const migrated = await reconcileTicket(f.d as never, f.ref);
  assert.equal(migrated.stateId, "bug-verification");
  assert.equal(f.counts().creates, 1);
  Object.assign(f.selected, { headSha: "2".repeat(40) });
  f.snapshot.changeRequest = f.selected;
  const updated = await reconcileTicket(f.d as never, f.ref);
  assert.equal(updated.stateId, "bug-review");
  assert.ok(f.snapshot.labels.includes("agent-stage:bug-review"));
  const starts = f.starts.length;
  await f.reset();
  const recovered = await reconcileTicket(f.d as never, f.ref);
  assert.equal(recovered.stateId, "bug-review");
  assert.equal(recovered.configRevision, f.target.revision);
  assert.equal(f.starts.length, starts + 1);
  assert.equal(f.counts().creates, 1);
  assert.equal(f.snapshot.changeRequest.number, 8);
  assert.ok(f.snapshot.changeRequest.body.includes(f.source.revision));
  const marker = `<!-- agent-flow:v1 {"config":"${f.target.revision}","controller":"${f.d.controllerId}"} -->`;
  f.reviews.push({
    id: "21", headSha: f.selected.headSha, verdict: "approved",
    body: marker + `\n<!-- agent-flow-review:v1 head=${f.selected.headSha} verdict=approved -->`,
    submittedAt: f.comment("21", "").createdAt,
    actor: f.selected.actor,
    url: "https://github.com/owner/repo/pull/8#pullrequestreview-21",
  });
  f.snapshot.labels = ["agent-flow:managed", "bugfix", "agent-stage:bug-verification"];
  await f.reset();
  assert.equal((await reconcileTicket(f.d as never, f.ref)).stateId, "bug-verification");
  f.snapshot.comments.push(f.comment("22", marker + "\nVerification completed on the new head"));
  f.snapshot.labels = ["agent-flow:managed", "bugfix", "agent-stage:awaiting-merge"];
  await f.reset();
  assert.equal((await reconcileTicket(f.d as never, f.ref)).stateId, "bug-verification");
  assert.equal(f.counts().creates, 1);
});

for (const replay of ["bug-development", "bug-review", "bug-verification"]) {
  test(`${replay} replay retires completed verification after a head change`, async (t) => {
    for (const stage of ["bug-review", "bug-verification", "awaiting-merge", "unauthorized", "incomplete"]) {
      await t.test(stage, async (t) => {
        const f = await migrationFixture(t);
        const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
        f.snapshot.activation.label = "bugfix";
        f.snapshot.labels = ["agent-flow:managed", "bugfix", "agent-stage:awaiting-merge"];
        f.snapshot.comments[1]!.body = "/agent-flow migrate --pr 8 --to latest --resume-from " + replay;
        approveSourceHead(f);
        assert.equal((await reconcileTicket(f.d as never, f.ref)).stateId, replay);
        const marker = `<!-- agent-flow:v1 {"config":"${f.target.revision}","controller":"${f.d.controllerId}"} -->`;
        if (replay === "bug-development") f.snapshot.comments.push(f.comment("18", marker + "\nDevelopment completed"));
        if (replay !== "bug-verification") f.reviews.push({
          id: "19", headSha: f.selected.headSha, verdict: "approved", actor: f.selected.actor,
          body: marker + `\n<!-- agent-flow-review:v1 head=${f.selected.headSha} verdict=approved -->`,
          submittedAt: f.comment("19", "").createdAt,
          url: "https://github.com/owner/repo/pull/8#pullrequestreview-19",
        });
        f.snapshot.comments.push(f.comment("20", "# Bug receipt\nBUG RECEIPT · VERIFIED\n" + marker));
        if (stage === "unauthorized") {
          f.snapshot.comments.at(-1)!.actor = { login: "outsider", providerId: "2" };
          f.d.provider.permission = async (...args: unknown[]) =>
            (args[1] as { login: string }).login === "outsider" ? "read" : "write";
        }
        if (stage === "incomplete") f.snapshot.comments.at(-1)!.body = marker + "\nVerification pending";
        Object.assign(f.selected, { headSha: "2".repeat(40) });
        f.snapshot.changeRequest = f.selected;
        if (["bug-verification", "awaiting-merge"].includes(stage)) f.reviews.push({
          id: "21", headSha: f.selected.headSha, verdict: "approved", actor: f.selected.actor,
          body: marker + `\n<!-- agent-flow-review:v1 head=${f.selected.headSha} verdict=approved -->`,
          submittedAt: f.comment("21", "").createdAt,
          url: "https://github.com/owner/repo/pull/8#pullrequestreview-21",
        });
        if (stage === "awaiting-merge") f.snapshot.comments.push(
          f.comment("22", "# Bug receipt\nBUG RECEIPT · VERIFIED\n" + marker));
        f.snapshot.labels = ["agent-flow:managed", "bugfix", "agent-stage:" + (["unauthorized", "incomplete"].includes(stage) ? "bug-review" : stage)];
        await f.reset();
        const recovered = await reconcileTicket(f.d as never, f.ref);
        if (["unauthorized", "incomplete"].includes(stage)) {
          assert.equal(recovered.recoveryDisposition, "ambiguous");
          return;
        }
        assert.equal(recovered.stateId, stage === "bug-review" ? "bug-review" : "bug-verification");
        assert.equal(recovered.configRevision, f.target.revision);
        assert.equal(f.counts().creates, 1);
        const request = f.starts.at(-1) as { publicationKeys: string[] };
        assert.ok(request.publicationKeys.includes(f.raw().publications.find((p) => p.key.includes('"20"'))!.key));
        if (stage === "awaiting-merge") assert.ok(!request.publicationKeys.some((key) => key.includes('"22"')));
      });
    }
  });

}

for (const { replay, rework } of [
  ...["bug-development", "bug-review", "bug-verification"].map((replay) => ({ replay, rework: false })),
  ...["bug-development", "bug-review"].map((replay) => ({ replay, rework: true })),
]) {
  test(`${replay} replay CI correction survives SQLite loss through subsequent stages${rework ? " after review rework" : ""}`, async (t) => {
    for (const stage of ["bug-development", "development-without-result", "bug-review", "review-new-head", "bug-verification", "awaiting-merge", "unauthorized", "incomplete", ...(replay !== "bug-verification" ? ["unauthorized-approval"] : [])]) {
      await t.test(stage, async (t) => {
        const f = await migrationFixture(t);
        const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
        f.snapshot.activation.label = "bugfix";
        f.snapshot.labels = ["agent-flow:managed", "bugfix", "agent-stage:awaiting-merge"];
        f.snapshot.comments[1]!.body = "/agent-flow migrate --pr 8 --to latest --resume-from " + replay;
        approveSourceHead(f);
        assert.equal((await reconcileTicket(f.d as never, f.ref)).stateId, replay);
        const marker = `<!-- agent-flow:v1 {"config":"${f.target.revision}","controller":"${f.d.controllerId}"} -->`;
        if (rework) {
          if (replay === "bug-development") f.snapshot.comments.push(f.comment("16", marker + "\nInitial development completed"));
          f.reviews.push({
            id: "17", headSha: f.selected.headSha, verdict: "changes-requested", actor: f.selected.actor,
            body: marker + `\n<!-- agent-flow-review:v1 head=${f.selected.headSha} verdict=changes-requested -->`,
            submittedAt: f.comment("17", "").createdAt,
            url: "https://github.com/owner/repo/pull/8#pullrequestreview-17",
          });
        }
        if (replay === "bug-development" || rework) f.snapshot.comments.push(f.comment("18", marker + "\nDevelopment completed"));
        if (replay !== "bug-verification") f.reviews.push({
          id: "19", headSha: f.selected.headSha, verdict: "approved", actor: f.selected.actor,
          body: marker + `\n<!-- agent-flow-review:v1 head=${f.selected.headSha} verdict=approved -->`,
          submittedAt: f.comment("19", "").createdAt,
          url: "https://github.com/owner/repo/pull/8#pullrequestreview-19",
        });
        if (stage === "unauthorized-approval") {
          f.reviews.at(-1)!.actor = { login: "outsider", providerId: "2" };
          f.d.provider.permission = async (...args: unknown[]) =>
            (args[1] as { login: string }).login === "outsider" ? "read" : "write";
        }
        f.snapshot.comments.push(f.comment("20", "# Bug receipt\nBUG RECEIPT · VERIFIED\n" + marker));
        if (stage === "unauthorized") {
          f.snapshot.comments.at(-1)!.actor = { login: "outsider", providerId: "2" };
          f.d.provider.permission = async (...args: unknown[]) =>
            (args[1] as { login: string }).login === "outsider" ? "read" : "write";
        }
        if (stage === "incomplete") f.snapshot.comments.at(-1)!.body = marker + "\nVerification pending";
        if (stage !== "development-without-result") f.snapshot.comments.push(f.comment("21", marker + "\nCI correction complete"));
        if (stage === "review-new-head") Object.assign(f.selected, { headSha: "2".repeat(40) });
        if (["bug-verification", "awaiting-merge"].includes(stage)) f.reviews.push({
          id: "22", headSha: f.selected.headSha, verdict: "approved", actor: f.selected.actor,
          body: marker + `\n<!-- agent-flow-review:v1 head=${f.selected.headSha} verdict=approved -->`,
          submittedAt: f.comment("22", "").createdAt,
          url: "https://github.com/owner/repo/pull/8#pullrequestreview-22",
        });
        if (stage === "awaiting-merge") f.snapshot.comments.push(
          f.comment("23", "# Bug receipt\nBUG RECEIPT · VERIFIED\n" + marker));
        const recorded = ["unauthorized", "incomplete", "unauthorized-approval", "development-without-result"].includes(stage)
          ? "bug-development" : stage === "review-new-head" ? "bug-review" : stage;
        f.snapshot.labels = ["agent-flow:managed", "bugfix", "agent-stage:" + recorded];
        await f.reset();
        const result = await reconcileTicket(f.d as never, f.ref);
        if (["unauthorized", "incomplete", "unauthorized-approval"].includes(stage)) {
          assert.equal(result.recoveryDisposition, "ambiguous");
          return;
        }
        assert.equal(result.stateId, stage === "awaiting-merge" ? "bug-verification" : recorded, result.recoveryReason);
        assert.equal(result.configRevision, f.target.revision);
        assert.equal(f.counts().creates, 1);
        const request = f.starts.at(-1) as import("../../src/runtime/reconcile.ts").AttemptRequest;
        assert.ok(request.publicationKeys.some((key) => JSON.parse(key)[4] === "20"));
        if (stage === "bug-development") assert.ok(!request.publicationKeys.some((key) => JSON.parse(key)[4] === "21"));
        if (stage === "awaiting-merge") assert.ok(!request.publicationKeys.some((key) => JSON.parse(key)[4] === "23"));
      });
    }
  });
}

test("verification replay cannot recover an unexplained review label at the receipt head", async (t) => {
  const f = await migrationFixture(t);
  const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
  f.snapshot.activation.label = "bugfix";
  f.snapshot.labels = ["agent-flow:managed", "bugfix", "agent-stage:bug-verification"];
  f.snapshot.comments[1]!.body = "/agent-flow migrate --pr 8 --to latest --resume-from bug-verification";
  approveSourceHead(f);
  assert.equal((await reconcileTicket(f.d as never, f.ref)).stateId, "bug-verification");
  f.snapshot.labels = ["agent-flow:managed", "bugfix", "agent-stage:bug-review"];
  await f.reset();
  const starts = f.starts.length;
  const recovered = await reconcileTicket(f.d as never, f.ref);
  assert.equal(recovered.recoveryDisposition, "ambiguous");
  assert.equal(f.starts.length, starts);
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

test("committed migrations replace stale paused source labels before repair and after restart", async (t) => {
  for (const paused of ["blocked", "needs-human"]) {
    for (const restart of [false, true]) {
      await t.test(`${paused}, ${restart ? "empty-store restart" : "surviving source control"}`, async (t) => {
        const f = await migrationFixture(t);
        const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
        f.snapshot.labels = f.snapshot.labels.filter((l) => !l.startsWith("agent-stage:"));
        f.snapshot.labels.push("agent-stage:" + paused);
        await f.writeControl(f.ref, null, {
          apiVersion: "agent-flow/v1alpha1", kind: "ControlState",
          flowInstanceId: "11111111-1111-4111-8111-111111111111",
          flowId: f.source.flow.metadata.id, configRevision: f.source.revision,
          sequence: 0, stateId: paused, resumeStateId: "development",
          activatedBy: f.snapshot.activation.actor,
          activatedAt: f.snapshot.activation.occurredAt,
          activationEventId: f.snapshot.activation.eventId,
          activationLabel: f.snapshot.activation.label,
          updatedAt: f.snapshot.updatedAt, attemptSeries: null,
          latestReceipt: null, humanGate: null, changeRequest: {
            provider: f.selected.provider, repository: f.selected.repository,
            number: f.selected.number, url: f.selected.url,
            headSha: f.selected.headSha, state: f.selected.state,
          },
        });
        // Publish and verify the receipt, then interrupt before any label/cache repair.
        const committed = await processMigration(f.d as never, f.raw() as never);
        assert.ok(committed.migration);
        assert.ok(f.snapshot.labels.includes("agent-stage:" + paused));
        if (restart) await f.reset();
        const recovered = await reconcileTicket(f.d as never, f.ref);
        assert.equal(recovered.stateId, "development");
        assert.equal(recovered.configRevision, f.target.revision);
        assert.deepEqual(f.snapshot.labels.filter((l) => l.startsWith("agent-stage:")), ["agent-stage:development"]);
        assert.equal(f.starts.length, 1);
        assert.equal(f.counts().creates, 1);
        const again = await reconcileTicket(f.d as never, f.ref);
        assert.equal(again.stateId, "development");
        assert.equal(again.configRevision, f.target.revision);
        assert.equal(f.counts().creates, 1);
        if (!restart) {
          // A later target execution pause is not the receipt-before-label window.
          const current = f.d.writeControl.load!(f.ref)!.value.control!;
          await f.d.writeControl(f.ref, current, {
            ...current, sequence: current.sequence + 1,
            stateId: paused, resumeStateId: "development",
          });
          f.snapshot.labels = f.snapshot.labels.filter((l) => !l.startsWith("agent-stage:"));
          f.snapshot.labels.push("agent-stage:" + paused);
          const later = await reconcileTicket(f.d as never, f.ref);
          assert.equal(later.stateId, paused);
          assert.equal(later.configRevision, f.target.revision);
          assert.equal(f.counts().creates, 1);
        }
      });
    }
  }
});

test("no-replay migrations retain each human gate's predecessor and wait for fresh human input after recovery", async (t) => {
  for (const [gate, predecessor, label] of [
    ["assessment-review", "assessment", "agent-flow:development"],
    ["plan-review", "planning", "agent-flow:development"],
    ["bug-reproduction-review", "bug-reproduction", "bugfix"],
  ] as const) {
    await t.test(gate, async (t) => {
      const f = await migrationFixture(t);
      const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
      const { readFile } = await import("node:fs/promises");
      const { parse } = await import("yaml");
      f.source.flow = parse(await readFile("config/flows/development.yaml", "utf8"));
      f.target.flow = structuredClone(f.source.flow);
      f.snapshot.activation.label = label;
      f.snapshot.labels = ["agent-flow:managed", label, "agent-stage:" + gate];
      f.snapshot.comments[0]!.body = f.snapshot.comments[0]!.body.replace("Assessment", "Completed " + predecessor);
      f.snapshot.comments[1]!.body = "/agent-flow migrate --pr 8 --to latest";
      const committed = await processMigration(f.d as never, f.raw() as never);
      assert.equal(committed.migration?.receipt.start, gate);
      assert.equal(committed.migration?.receipt.retained[0]?.stage, predecessor);
      for (const restart of [false, true]) {
        if (restart) await f.reset();
        const result = await reconcileTicket(f.d as never, f.ref);
        assert.equal(result.stateId, gate);
        assert.equal(result.configRevision, f.target.revision);
        assert.equal(f.starts.length, 0);
        assert.equal(f.counts().creates, 1);
      }
    });
  }
});

test("no-replay human-gate migration rejects missing predecessor provenance before commitment", async (t) => {
  const f = await migrationFixture(t);
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  f.source.flow = parse(await readFile("config/flows/development.yaml", "utf8"));
  f.target.flow = structuredClone(f.source.flow);
  f.snapshot.labels = ["agent-flow:managed", "agent-flow:development", "agent-stage:plan-review"];
  f.snapshot.comments[0]!.body = "Unmarked context";
  f.snapshot.comments[1]!.body = "/agent-flow migrate --pr 8 --to latest";
  await processMigration(f.d as never, f.raw() as never);
  assert.equal(f.counts().creates, 1);
  assert.match(f.snapshot.comments.at(-1)!.body, /Cannot retain human gate without a verified predecessor/);
  assert.ok(f.snapshot.labels.includes("agent-stage:plan-review"));
  assert.equal(f.d.writeControl.load!(f.ref), null);
});

test("no-replay human-gate migration preserves consumed input and leaves a pending answer eligible", async (t) => {
  const f = await migrationFixture(t);
  const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  f.source.flow = parse(await readFile("config/flows/development.yaml", "utf8"));
  f.target.flow = structuredClone(f.source.flow);
  f.snapshot.labels = ["agent-flow:managed", "agent-flow:development", "agent-stage:plan-review"];
  f.snapshot.comments[1]!.body = "/agent-flow migrate --pr 8 --to latest";
  await reconcileTicket(f.d as never, f.ref);
  const current = f.d.writeControl.load!(f.ref)!.value.control!;
  const question = f.comment("20", "What is the plan's deployment strategy?");
  f.snapshot.comments.push(question, f.comment("21", "Approved"));
  await f.d.writeControl(f.ref, current, {
    ...current, sequence: current.sequence + 1, updatedAt: question.createdAt,
    humanGate: {
      sourceCommentId: question.id, actor: question.actor, verdict: "question", notes: [],
      interpretedByAttemptId: "11111111-1111-4111-8111-111111111111",
    },
  });
  const next = { ...f.target, revision: "c".repeat(40) };
  f.d.config.loadPinned = async (sha) => sha === f.source.revision ? f.source : sha === f.target.revision ? f.target : next;
  f.d.config.resolveTarget = async () => next.revision;
  f.snapshot.comments.push(f.comment("22", "/agent-flow migrate --pr 8 --to latest"));
  for (const restart of [false, true]) {
    if (restart) await f.reset();
    const result = await reconcileTicket(f.d as never, f.ref);
    assert.equal(result.stateId, "plan-review");
    assert.equal(result.configRevision, next.revision);
    assert.equal((f.starts.at(-1) as import("../../src/runtime/reconcile.ts").AttemptRequest).sourceComment?.id, "21");
  }
  question.body += " (edited after acceptance)";
  const { recoverMigration } = await import("../../src/runtime/migration-recovery.ts");
  await assert.rejects(
    recoverMigration(f.raw() as never, f.d.config.loadPinned, f.d.provider as never),
    /Retained human gate input is unavailable or changed/,
  );
});

test("empty-store recovery reassesses the latest migrated gate iteration before selecting fresh approval", async (t) => {
  const f = await migrationFixture(t);
  const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
  const { readDecisionAndBuildReceipt } = await import("../../src/runtime/receipts.ts");
  const { readFile, writeFile, mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { parse } = await import("yaml");
  f.source.flow = parse(await readFile("config/flows/development.yaml", "utf8"));
  f.target.flow = structuredClone(f.source.flow);
  f.snapshot.labels = ["agent-flow:managed", "agent-flow:development", "agent-stage:plan-review"];
  f.snapshot.comments[1]!.body = "/agent-flow migrate --pr 8 --to latest";
  await reconcileTicket(f.d as never, f.ref);
  const marker = `<!-- agent-flow:v1 {"config":"${f.target.revision}","controller":"${f.d.controllerId}"} -->`;
  f.snapshot.comments.push(
    f.comment("20", "Changes requested: add recovery details."),
    f.comment("21", marker + "\nRevised plan with recovery details."),
    f.comment("22", "Changes requested: cover restart validation too."),
    f.comment("23", marker + "\nRevised plan covering recovery and restart validation."),
    f.comment("24", "Approved"),
  );
  await f.reset();
  const recovered = await reconcileTicket(f.d as never, f.ref);
  assert.equal(recovered.stateId, "planning");
  const request = f.starts.at(-1) as import("../../src/runtime/reconcile.ts").AttemptRequest;
  assert.equal(request.mode, "stage");
  assert.equal(request.publicationKeys.some((key) => JSON.parse(key)[4] === "21"), true);
  assert.equal(request.publicationKeys.some((key) => JSON.parse(key)[4] === "23"), false);
  const root = await mkdtemp(join(tmpdir(), "migration-gate-decision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "decision.json");
  await writeFile(path, JSON.stringify({ event: "agent-succeeded" }));
  const attemptId = "11111111-1111-4111-8111-111111111111";
  const receipt = await readDecisionAndBuildReceipt(path, {
    flow: request.bundle.flow, stateId: request.stateId, mode: request.mode,
    resultContract: request.resultContract, flowInstanceId: request.control.flowInstanceId,
    attemptId, configRevision: f.target.revision, controllerId: f.d.controllerId,
    publicationKeys: request.publicationKeys, ticket: f.ref,
    pinnedChangeRequest: request.control.changeRequest, sourceComment: null,
  }, f.d.provider as never, false);
  assert.equal(receipt.artifacts[0]?.kind === "comment" && receipt.artifacts[0].id, "23");
  const before = f.d.writeControl.load!(f.ref)!.value.control!;
  await f.d.writeControl(f.ref, before, {
    ...before, sequence: before.sequence + 1, latestReceipt: receipt,
    attemptSeries: {
      seriesId: attemptId, agentId: "planner", stateId: "planning", inputRevision: "recovered-plan",
      maxAttempts: 3, consumed: 1,
      current: { attemptId, status: "succeeded", startedAt: before.updatedAt },
    },
  });
  assert.equal((await reconcileTicket(f.d as never, f.ref)).stateId, "plan-review");
  const gateRequest = f.starts.at(-1) as import("../../src/runtime/reconcile.ts").AttemptRequest;
  assert.equal(gateRequest.mode, "human-input");
  assert.equal(gateRequest.sourceComment?.id, "24");
  assert.equal(f.counts().creates, 1);
});

test("completed migrated gate revisions do not obscure downstream agent recovery", async (t) => {
  for (const stage of ["development", "review"] as const) {
    for (const completedDevelopment of stage === "review" ? [true] : [false, true]) {
      await t.test(`${stage}, development publication: ${completedDevelopment}`, async (t) => {
        const f = await migrationFixture(t);
        const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
        const { readFile } = await import("node:fs/promises");
        const { parse } = await import("yaml");
        f.source.flow = parse(await readFile("config/flows/development.yaml", "utf8"));
        f.target.flow = structuredClone(f.source.flow);
        f.snapshot.labels = ["agent-flow:managed", "agent-flow:development", "agent-stage:plan-review"];
        f.snapshot.comments[1]!.body = "/agent-flow migrate --pr 8 --to latest";
        await reconcileTicket(f.d as never, f.ref);
        const marker = `<!-- agent-flow:v1 {"config":"${f.target.revision}","controller":"${f.d.controllerId}"} -->`;
        f.snapshot.comments.push(
          f.comment("20", "Changes requested: include recovery details."),
          f.comment("21", marker + "\nRevised plan with recovery details."),
          f.comment("22", "Changes requested: include restart validation."),
          f.comment("23", marker + "\nRevised plan including recovery and restart validation."),
          f.comment("24", "Approved"),
        );
        if (completedDevelopment) f.snapshot.comments.push(f.comment("25", marker + "\nDevelopment complete on the selected PR."));
        f.snapshot.labels = ["agent-flow:managed", "agent-flow:development", "agent-stage:" + stage];
        await f.reset();
        const result = await reconcileTicket(f.d as never, f.ref);
        assert.equal(result.stateId, stage);
        assert.equal(result.configRevision, f.target.revision);
        const request = f.starts.at(-1) as import("../../src/runtime/reconcile.ts").AttemptRequest;
        assert.equal(request.stateId, stage);
        assert.equal(request.mode, "stage");
        for (const id of ["21", "23"]) {
          assert.equal(request.publicationKeys.some((key) => JSON.parse(key)[4] === id), true);
        }
        if (completedDevelopment) {
          assert.equal(request.publicationKeys.some((key) => JSON.parse(key)[4] === "25"), stage === "review");
        }
        assert.equal(f.counts().creates, 1);
        for (const comment of f.snapshot.comments.filter((comment) => ["22", "24"].includes(comment.id))) {
          comment.actor = { login: "outsider", providerId: "2" };
        }
        f.d.provider.permission = async (...args: unknown[]) =>
          (args[1] as { login: string }).login === "outsider" ? "read" : "write";
        await f.reset();
        const unauthorized = await reconcileTicket(f.d as never, f.ref);
        assert.equal(unauthorized.stateId, null);
        assert.equal(unauthorized.recoveryDisposition, "ambiguous");
      });
    }
  }
});

test("completed migrated development and review rework recovers after SQLite loss", async (t) => {
  for (const replay of ["development", "review"]) {
    for (const changedHead of [false, true]) {
      for (const recorded of ["development", "development-with-result", "review", "awaiting-merge"]) {
        const stage = recorded === "development-with-result" ? "development" : recorded;
        await t.test(`${replay} replay, ${recorded}, changed head: ${changedHead}`, async (t) => {
          const f = await migrationFixture(t);
          const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
          f.snapshot.comments[1]!.body = `/agent-flow migrate --pr 8 --to latest --resume-from ${replay}`;
          await reconcileTicket(f.d as never, f.ref);
          const marker = `<!-- agent-flow:v1 {"config":"${f.target.revision}","controller":"${f.d.controllerId}"} -->`;
          const oldHead = f.selected.headSha;
          if (replay === "development") f.snapshot.comments.push(f.comment("20", marker + "\nInitial development complete."));
          const review = (id: string, headSha: string, verdict: string) => ({
            id, headSha, verdict, actor: f.selected.actor,
            body: `${marker}\n<!-- agent-flow-review:v1 head=${headSha} verdict=${verdict} -->`,
            submittedAt: f.comment(id, "").createdAt,
            url: `https://github.com/owner/repo/pull/8#pullrequestreview-${id}`,
          });
          f.reviews.push(review("21", oldHead, "changes-requested"));
          if (changedHead) {
            f.snapshot.comments.push(f.comment("22", marker + "\nSecond development iteration complete."));
            f.reviews.push(review("23", oldHead, "changes-requested"));
            Object.assign(f.selected, { headSha: "2".repeat(40) });
            f.snapshot.changeRequest = f.selected;
          }
          if (recorded !== "development") {
            f.snapshot.comments.push(f.comment("24", marker + "\nCorrected development complete."));
          }
          if (stage === "awaiting-merge") f.reviews.push(review("25", f.selected.headSha, "approved"));
          f.snapshot.labels = ["agent-flow:managed", "agent-flow:development", "agent-stage:" + stage];
          await f.reset();
          const result = await reconcileTicket(f.d as never, f.ref);
          assert.equal(result.stateId, stage);
          assert.equal(result.configRevision, f.target.revision);
          const control = f.d.writeControl.load!(f.ref)!.value.control!;
          assert.equal(control.changeRequest?.number, 8);
          assert.equal(control.changeRequest?.headSha, f.selected.headSha);
          assert.equal(f.counts().creates, 1);
          if (recorded === "development-with-result") {
            const request = f.starts.at(-1) as import("../../src/runtime/reconcile.ts").AttemptRequest;
            assert.equal(request.publicationKeys.some((key) => JSON.parse(key)[4] === "24"), false);
            assert.equal(request.publicationKeys.some((key) => JSON.parse(key)[4] === "20"), replay === "development");
          }
          if (stage === "awaiting-merge") {
            for (const invalid of replay === "review" ? ["head", "verdict", "authorization", "missing"] : ["head", "verdict", "authorization"]) {
              const rejection = f.reviews[0]!;
              const original = structuredClone(rejection);
              if (invalid === "head") rejection.headSha = "unverified";
              if (invalid === "verdict") rejection.verdict = "commented";
              if (invalid === "authorization") {
                rejection.actor = { login: "outsider", providerId: "2" };
                f.d.provider.permission = async (...args: unknown[]) =>
                  (args[1] as { login: string }).login === "outsider" ? "read" : "write";
              }
              if (invalid === "missing") f.reviews.shift();
              await f.reset();
              const ambiguous = await reconcileTicket(f.d as never, f.ref);
              assert.equal(ambiguous.stateId, null, invalid);
              assert.equal(ambiguous.recoveryDisposition, "ambiguous", invalid);
              if (invalid === "missing") f.reviews.unshift(rejection);
              Object.assign(rejection, original);
            }
          }
        });
      }
    }
  }
});

test("migrated CI retries recover the latest development completion after SQLite loss", async (t) => {
  for (const stage of ["development", "review", "awaiting-merge"]) {
    await t.test(stage, async (t) => {
      const f = await migrationFixture(t);
      const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
      await reconcileTicket(f.d as never, f.ref);
      const marker = `<!-- agent-flow:v1 {"config":"${f.target.revision}","controller":"${f.d.controllerId}"} -->`;
      f.snapshot.comments.push(
        f.comment("20", marker + "\nDevelopment complete before required CI failed."),
        f.comment("21", marker + "\nFirst CI correction complete."),
        f.comment("22", marker + "\nFinal CI correction complete."),
      );
      if (stage === "awaiting-merge") f.reviews.push({
        id: "23", headSha: f.selected.headSha, verdict: "approved", actor: f.selected.actor,
        body: `${marker}\n<!-- agent-flow-review:v1 head=${f.selected.headSha} verdict=approved -->`,
        submittedAt: f.comment("23", "").createdAt,
        url: "https://github.com/owner/repo/pull/8#pullrequestreview-23",
      });
      f.snapshot.labels = ["agent-flow:managed", "agent-flow:development", "agent-stage:" + stage];
      await f.reset();
      const result = await reconcileTicket(f.d as never, f.ref);
      assert.equal(result.stateId, stage);
      assert.equal(result.configRevision, f.target.revision);
      if (stage === "development") {
        const request = f.starts.at(-1) as import("../../src/runtime/reconcile.ts").AttemptRequest;
        assert.equal(request.publicationKeys.some((key) => JSON.parse(key)[4] === "22"), false);
        for (const id of ["20", "21"]) {
          assert.equal(request.publicationKeys.some((key) => JSON.parse(key)[4] === id), true);
        }
      }
      f.snapshot.comments.find((comment) => comment.id === "21")!.actor = { login: "outsider", providerId: "2" };
      f.d.provider.permission = async (...args: unknown[]) =>
        (args[1] as { login: string }).login === "outsider" ? "read" : "write";
      await f.reset();
      const unauthorized = await reconcileTicket(f.d as never, f.ref);
      assert.equal(unauthorized.recoveryDisposition, "ambiguous");
      assert.equal(unauthorized.stateId, null);
    });
  }
});

test("migrated approvals superseded by a head change recover through merge wait", async (t) => {
  for (const stage of ["review", "awaiting-merge"]) {
    await t.test(stage, async (t) => {
      const f = await migrationFixture(t);
      const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
      await reconcileTicket(f.d as never, f.ref);
      const marker = `<!-- agent-flow:v1 {"config":"${f.target.revision}","controller":"${f.d.controllerId}"} -->`;
      f.snapshot.comments.push(f.comment("20", marker + "\nDevelopment complete."));
      const approval = (id: string, headSha: string) => ({
        id, headSha, verdict: "approved", actor: f.selected.actor,
        body: `${marker}\n<!-- agent-flow-review:v1 head=${headSha} verdict=approved -->`,
        submittedAt: f.comment(id, "").createdAt,
        url: `https://github.com/owner/repo/pull/8#pullrequestreview-${id}`,
      });
      f.reviews.push(approval("21", f.selected.headSha));
      Object.assign(f.selected, { headSha: "2".repeat(40) });
      f.snapshot.changeRequest = f.selected;
      f.reviews.push(approval("22", f.selected.headSha));
      f.snapshot.labels = ["agent-flow:managed", "agent-flow:development", "agent-stage:" + stage];
      await f.reset();
      const recovered = await reconcileTicket(f.d as never, f.ref);
      assert.equal(recovered.stateId, stage);
      assert.equal(recovered.configRevision, f.target.revision);
      assert.equal(f.d.writeControl.load!(f.ref)!.value.control!.changeRequest?.headSha, f.selected.headSha);
      assert.equal(f.counts().creates, 1);
      if (stage === "review") {
        const request = f.starts.at(-1) as import("../../src/runtime/reconcile.ts").AttemptRequest;
        assert.equal(request.publicationKeys.some((key) => JSON.parse(key)[4] === "22"), false);
      } else {
        for (const invalid of ["head", "verdict", "authorization", "missing"]) {
          const original = structuredClone(f.reviews[1]!);
          if (invalid === "head") f.reviews[1]!.headSha = "3".repeat(40);
          if (invalid === "verdict") f.reviews[1]!.verdict = "changes-requested";
          if (invalid === "authorization") {
            f.reviews[1]!.actor = { login: "outsider", providerId: "2" };
            f.d.provider.permission = async (...args: unknown[]) =>
              (args[1] as { login: string }).login === "outsider" ? "read" : "write";
          }
          if (invalid === "missing") f.reviews.pop();
          await f.reset();
          const rejected = await reconcileTicket(f.d as never, f.ref);
          assert.equal(rejected.stateId, null, invalid);
          assert.equal(rejected.recoveryDisposition, "ambiguous", invalid);
          f.reviews[1] = original;
        }
      }
    });
  }
});

test("planning replay recovers revised plans at the gate and downstream stages", async (t) => {
  for (const stage of ["plan-review", "development", "development-with-result", "review"] as const) {
    await t.test(stage, async (t) => {
      const f = await migrationFixture(t);
      const { reconcileTicket } = await import("../../src/runtime/reconcile.ts");
      const { readFile } = await import("node:fs/promises");
      const { parse } = await import("yaml");
      f.source.flow = parse(await readFile("config/flows/development.yaml", "utf8"));
      f.target.flow = structuredClone(f.source.flow);
      f.snapshot.comments[1]!.body = "/agent-flow migrate --pr 8 --to latest --resume-from planning";
      await reconcileTicket(f.d as never, f.ref);
      const marker = `<!-- agent-flow:v1 {"config":"${f.target.revision}","controller":"${f.d.controllerId}"} -->`;
      f.snapshot.comments.push(
        f.comment("20", marker + "\nPlan."),
        f.comment("21", "Changes requested: include restart validation."),
        f.comment("22", marker + "\nRevised plan."),
        f.comment("23", "Changes requested: include recovery details."),
        f.comment("24", marker + "\nFinal revised plan."),
        f.comment("25", "Approved"),
      );
      const recorded = stage === "development-with-result" ? "development" : stage;
      if (stage === "development-with-result" || stage === "review") {
        f.snapshot.comments.push(f.comment("26", marker + "\nDevelopment complete."));
      }
      f.snapshot.labels = ["agent-flow:managed", "agent-flow:development", "agent-stage:" + recorded];
      await f.reset();
      const result = await reconcileTicket(f.d as never, f.ref);
      assert.equal(result.configRevision, f.target.revision);
      assert.equal(result.stateId, stage === "plan-review" ? "planning" : recorded);
      const request = f.starts.at(-1) as import("../../src/runtime/reconcile.ts").AttemptRequest;
      assert.equal(request.mode, "stage");
      for (const id of ["20", "22"]) assert.ok(request.publicationKeys.some((key) => JSON.parse(key)[4] === id));
      assert.equal(request.publicationKeys.some((key) => JSON.parse(key)[4] === "24"), stage !== "plan-review");
      assert.equal(request.publicationKeys.some((key) => JSON.parse(key)[4] === "26"), stage === "review");
      assert.equal(f.counts().creates, 1);
      f.snapshot.comments.find((comment) => comment.id === "21")!.actor = { login: "outsider", providerId: "2" };
      f.d.provider.permission = async (...args: unknown[]) =>
        (args[1] as { login: string }).login === "outsider" ? "read" : "write";
      await f.reset();
      assert.equal((await reconcileTicket(f.d as never, f.ref)).recoveryDisposition, "ambiguous");
    });
  }
});
