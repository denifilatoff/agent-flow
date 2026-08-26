import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import { loadConfigBundle, type ConfigBundle } from "../../src/config/load.ts";
import type {
  Actor,
  AgentReceipt,
  AttemptSeries,
  ControlChangeRequest,
  ControlHumanGate,
  ControlState,
} from "../../src/config/types.ts";
import { parseControlComment, renderControlComment } from "../../src/provider/control-comment.ts";
import type {
  DiscoveryPage,
  DiscoveryWindow,
  NormalizedChangeRequest,
  NormalizedReview,
  Permission,
  ProviderAdapter,
  ProviderComment,
  ProviderRepository,
  ProviderTicketSnapshot,
  TicketRef,
} from "../../src/provider/types.ts";
import {
  reconcileTicket,
  type AttemptLauncher,
  type AttemptRequest,
  type ReconcileDependencies,
} from "../../src/runtime/reconcile.ts";
import { deriveEvent } from "../../src/runtime/derive-event.ts";

const SHA = "a".repeat(40);
const OLD_HEAD = "1".repeat(40);
const NEW_HEAD = "2".repeat(40);
const FLOW_1 = "11111111-1111-4111-8111-111111111111";
const FLOW_2 = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const SERIES = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-08-26T12:00:00.000Z";
const TICKET: TicketRef = {
  provider: "github",
  repository: "example-owner/example-repository",
  number: 17,
};
const MAINTAINER: Actor = { login: "maintainer", providerId: "7" };
const OUTSIDER: Actor = { login: "outsider", providerId: "8" };

const BUNDLE = await loadConfigBundle(process.cwd(), "config/controller.example.yaml", SHA);

function repository(): ProviderRepository {
  return {
    provider: "github",
    name: TICKET.repository,
    host: "github.example.test",
    cloneRoot: "https://github.example.test/",
    cloneUrl: `https://github.example.test/${TICKET.repository}.git`,
  };
}

function changeRequest(patch: Partial<NormalizedChangeRequest> = {}): NormalizedChangeRequest {
  return {
    provider: "github",
    repository: TICKET.repository,
    number: 31,
    url: "https://github.example.test/example-owner/example-repository/pull/31",
    headSha: OLD_HEAD,
    state: "open",
    actor: MAINTAINER,
    updatedAt: "2026-08-26T11:30:00.000Z",
    ...patch,
  };
}

function controlChange(patch: Partial<ControlChangeRequest> = {}): ControlChangeRequest {
  const change = changeRequest(patch);
  return {
    provider: change.provider,
    repository: change.repository,
    number: change.number,
    url: change.url,
    headSha: change.headSha,
    state: change.state,
  };
}

function comment(
  id: string,
  body: string,
  actor: Actor = MAINTAINER,
  createdAt = "2026-08-26T11:00:00.000Z",
): ProviderComment {
  return {
    id,
    url: `https://github.example.test/comments/${id}`,
    body,
    actor,
    createdAt,
    updatedAt: createdAt,
  };
}

function snapshot(patch: Partial<ProviderTicketSnapshot> = {}): ProviderTicketSnapshot {
  return {
    ref: TICKET,
    repository: repository(),
    open: true,
    labels: ["bug", "agent-flow:development"],
    updatedAt: "2026-08-26T11:45:00.000Z",
    activation: {
      present: true,
      eventId: "803",
      actor: MAINTAINER,
      occurredAt: "2026-08-26T10:00:00.000Z",
    },
    comments: [],
    changeRequest: null,
    ...patch,
  };
}

function attemptSeries(patch: Partial<AttemptSeries> = {}): AttemptSeries {
  return {
    seriesId: SERIES,
    agentId: "architect",
    stateId: "assessment",
    inputRevision: "ticket:17",
    maxAttempts: 3,
    consumed: 1,
    current: {
      attemptId: ATTEMPT,
      status: "succeeded",
      startedAt: "2026-08-26T10:30:00.000Z",
      finishedAt: "2026-08-26T10:45:00.000Z",
    },
    ...patch,
  };
}

function controlState(patch: Partial<ControlState> = {}): ControlState {
  return {
    apiVersion: "agent-flow/v1alpha1",
    kind: "ControlState",
    flowInstanceId: FLOW_1,
    flowId: "development",
    configRevision: SHA,
    sequence: 0,
    stateId: "assessment",
    resumeStateId: null,
    activatedBy: MAINTAINER,
    activatedAt: "2026-08-26T10:00:00.000Z",
    activationEventId: "803",
    updatedAt: "2026-08-26T10:00:00.000Z",
    attemptSeries: null,
    latestReceipt: null,
    humanGate: null,
    changeRequest: null,
    ...patch,
  };
}

function controlComment(state: ControlState, id = `control-${state.flowInstanceId}`): ProviderComment {
  return comment(id, renderControlComment(state), MAINTAINER, state.updatedAt);
}

function assessmentReceipt(): AgentReceipt {
  return {
    apiVersion: "agent-flow/v1alpha1",
    kind: "AgentReceipt",
    flowInstanceId: FLOW_1,
    attemptId: ATTEMPT,
    outcome: "succeeded",
    summary: "Assessment published.",
    artifacts: [{
      kind: "comment",
      id: "assessment-result",
      url: "https://github.example.test/comments/assessment-result",
      marker: `<!-- agent-flow:v1 flow=${FLOW_1} attempt=${ATTEMPT} artifact=assessment -->`,
      artifactKind: "assessment",
    }],
  };
}

function reviewReceipt(verdict: "approved" | "changes-requested" | "commented" = "approved"): AgentReceipt {
  return {
    apiVersion: "agent-flow/v1alpha1",
    kind: "AgentReceipt",
    flowInstanceId: FLOW_1,
    attemptId: ATTEMPT,
    outcome: "succeeded",
    summary: "Review published.",
    artifacts: [{
      kind: "review",
      id: "review-1",
      url: "https://github.example.test/reviews/1",
      headSha: OLD_HEAD,
      verdict,
    }],
  };
}

function failedReceipt(attemptId = ATTEMPT): AgentReceipt {
  return {
    apiVersion: "agent-flow/v1alpha1",
    kind: "AgentReceipt",
    flowInstanceId: FLOW_1,
    attemptId,
    outcome: "failed",
    summary: "The harness exited.",
    artifacts: [],
    error: { code: "PROCESS_EXIT", message: "The harness exited." },
  };
}

function humanReceipt(verdict: ControlHumanGate["verdict"], sourceCommentId: string): AgentReceipt {
  return {
    apiVersion: "agent-flow/v1alpha1",
    kind: "AgentReceipt",
    flowInstanceId: FLOW_1,
    attemptId: ATTEMPT,
    outcome: "succeeded",
    summary: "Human answer interpreted.",
    artifacts: verdict === "approved" || verdict === "changes-requested" || verdict === "cancelled" ? [] : [{
      kind: "comment",
      id: "clarification",
      url: "https://github.example.test/comments/clarification",
      marker: `<!-- agent-flow:v1 flow=${FLOW_1} attempt=${ATTEMPT} artifact=question -->`,
      artifactKind: "question",
    }],
    humanGate: { sourceCommentId, verdict, notes: ["Keep the note in context."] },
  };
}

function questionReceipt(attemptId = ATTEMPT): AgentReceipt {
  return {
    apiVersion: "agent-flow/v1alpha1",
    kind: "AgentReceipt",
    flowInstanceId: FLOW_1,
    attemptId,
    outcome: "needs-human",
    summary: "The closed change request needs a decision.",
    artifacts: [{
      kind: "comment",
      id: "closed-question",
      url: "https://github.example.test/comments/closed-question",
      marker: `<!-- agent-flow:v1 flow=${FLOW_1} attempt=${attemptId} artifact=question -->`,
      artifactKind: "question",
    }],
  };
}

class FakeProvider implements ProviderAdapter {
  readonly kind = "github" as const;
  readonly events: string[] = [];
  readonly permissions = new Map([[MAINTAINER.login, "maintain" as Permission]]);
  snapshot = snapshot();
  readbackMismatch = false;
  labelReadbackMismatch = false;
  readError: Error | null = null;
  created = 0;
  updated = 0;

  async verifyAuth(): Promise<Actor> { return MAINTAINER; }
  async discover(_repository: string, _window: DiscoveryWindow, _cursor?: string): Promise<DiscoveryPage> {
    return { tickets: [], nextCursor: null };
  }
  async bootstrap(_repository: string): Promise<TicketRef[]> { return []; }
  async readRepository(_repository: string): Promise<ProviderRepository> { return repository(); }
  async readTicket(_ref: TicketRef): Promise<ProviderTicketSnapshot> {
    this.events.push("provider:read-ticket");
    if (this.readError) throw this.readError;
    return structuredClone(this.snapshot);
  }
  async permission(_repository: string, actor: Actor): Promise<Permission> {
    this.events.push(`provider:permission:${actor.login}`);
    return this.permissions.get(actor.login) ?? "read";
  }
  async readComment(_ref: TicketRef, id: string): Promise<ProviderComment> {
    this.events.push("provider:read-control");
    const found = this.snapshot.comments.find((candidate) => candidate.id === id);
    if (!found) throw new Error("comment not found");
    if (!this.readbackMismatch) return structuredClone(found);
    return { ...structuredClone(found), body: `${found.body}tampered` };
  }
  async createComment(_ref: TicketRef, body: string): Promise<ProviderComment> {
    this.events.push("provider:create-control");
    this.created += 1;
    const created = comment(`created-${this.created}`, body, MAINTAINER, NOW);
    this.snapshot.comments.push(created);
    return structuredClone(created);
  }
  async updateComment(_ref: TicketRef, id: string, body: string): Promise<ProviderComment> {
    this.events.push("provider:update-control");
    this.updated += 1;
    const index = this.snapshot.comments.findIndex((candidate) => candidate.id === id);
    assert.notEqual(index, -1);
    this.snapshot.comments[index] = { ...this.snapshot.comments[index]!, body, updatedAt: NOW };
    return structuredClone(this.snapshot.comments[index]!);
  }
  async setControllerLabels(_ref: TicketRef, remove: string[], add: string[]): Promise<string[]> {
    this.events.push("provider:set-labels");
    const removed = new Set(remove);
    this.snapshot.labels = [...new Set([
      ...this.snapshot.labels.filter((label) => !removed.has(label)),
      ...add,
    ])];
    return this.labelReadbackMismatch
      ? this.snapshot.labels.filter((label) => !label.startsWith("agent-stage:"))
      : [...this.snapshot.labels];
  }
  async readChangeRequest(_ref: TicketRef, _number: number): Promise<NormalizedChangeRequest> {
    assert.ok(this.snapshot.changeRequest);
    return structuredClone(this.snapshot.changeRequest);
  }
  async readReview(_ref: TicketRef, _changeNumber: number, _id: string): Promise<NormalizedReview> {
    throw new Error("unused");
  }
}

class FakeLauncher implements AttemptLauncher {
  readonly requests: AttemptRequest[] = [];
  readonly cancelled: string[] = [];
  readonly running = new Set<string>();

  async start(request: AttemptRequest): Promise<void> {
    this.requests.push(structuredClone(request));
    this.running.add(request.control.flowInstanceId);
  }

  async cancel(flowInstanceId: string): Promise<void> {
    this.cancelled.push(flowInstanceId);
    this.running.delete(flowInstanceId);
  }

  isRunning(flowInstanceId: string): boolean {
    return this.running.has(flowInstanceId);
  }
}

function dependencies(provider = new FakeProvider(), launcher = new FakeLauncher()): ReconcileDependencies {
  return {
    provider,
    config: {
      loadCurrent: async () => BUNDLE,
      loadPinned: async (revision: string) => {
        assert.equal(revision, SHA);
        return BUNDLE;
      },
    },
    launcher,
    now: () => NOW,
    newFlowInstanceId: () => FLOW_2,
  };
}

function installControl(provider: FakeProvider, state: ControlState): void {
  provider.snapshot.comments.push(controlComment(state));
  provider.snapshot.labels.push(`agent-stage:${state.stateId}`, "agent-flow:managed");
}

test("accepts one authorized activation and owns one stage label", async () => {
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(outcome.stateId, "assessment");
  assert.equal(provider.created, 1);
  assert.deepEqual(
    provider.snapshot.labels.filter((label) => label.startsWith("agent-")),
    ["agent-flow:development", "agent-flow:managed", "agent-stage:assessment"],
  );
  assert.equal(launcher.requests[0]?.agentId, "architect");
  assert.equal(launcher.requests[0]?.mode, "stage");
  assert.equal(launcher.requests[0]?.control.sequence, 0);
  assert.equal(launcher.requests[0]?.control.activationEventId, "803");
  assert.ok(provider.events.indexOf("provider:read-control") < provider.events.indexOf("provider:set-labels"));
});

test("ignores an activation by an actor below write permission", async () => {
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();
  provider.snapshot.activation.actor = OUTSIDER;

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(outcome.stateId, null);
  assert.equal(provider.created, 0);
  assert.equal(provider.updated, 0);
  assert.deepEqual(launcher.requests, []);
  assert.ok(!provider.snapshot.labels.includes("agent-flow:managed"));
});

for (const scenario of [
  { name: "activation removal", patch: { labels: ["bug"], activation: { present: false, eventId: null, actor: null, occurredAt: null } } },
  { name: "ordinary ticket closure", patch: { open: false } },
] as const) {
  test(`cancels on ${scenario.name} and preserves the managed label`, async () => {
    const provider = new FakeProvider();
    const launcher = new FakeLauncher();
    installControl(provider, controlState({ latestReceipt: assessmentReceipt() }));
    Object.assign(provider.snapshot, scenario.patch);
    launcher.running.add(FLOW_1);

    const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

    assert.equal(outcome.stateId, "cancelled");
    assert.deepEqual(launcher.cancelled, [FLOW_1]);
    assert.ok(provider.snapshot.labels.includes("agent-flow:managed"));
    assert.ok(!provider.snapshot.labels.includes("agent-flow:development"));
    assert.deepEqual(
      provider.snapshot.labels.filter((label) => label.startsWith("agent-stage:")),
      ["agent-stage:cancelled"],
    );
  });
}

test("merge completion wins over ticket closure", async () => {
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();
  installControl(provider, controlState({
    stateId: "awaiting-merge",
    changeRequest: controlChange(),
  }));
  provider.snapshot.open = false;
  provider.snapshot.changeRequest = changeRequest({ state: "merged" });

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(outcome.stateId, "done");
  assert.deepEqual(launcher.cancelled, []);
  assert.ok(!provider.snapshot.labels.includes("agent-flow:development"));
  assert.deepEqual(
    provider.snapshot.labels.filter((label) => label.startsWith("agent-stage:")),
    ["agent-stage:done"],
  );
});

test("reactivation creates a new flow and preserves terminal control history", async () => {
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();
  installControl(provider, controlState({ stateId: "done" }));
  provider.snapshot.activation = {
    present: true,
    eventId: "804",
    actor: MAINTAINER,
    occurredAt: "2026-08-26T10:00:00.000Z",
  };

  await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(provider.created, 1);
  assert.equal(provider.updated, 0);
  assert.equal(provider.snapshot.comments.length, 2);
  assert.ok(provider.snapshot.comments[0]?.body.includes(FLOW_1));
  assert.ok(provider.snapshot.comments[1]?.body.includes(FLOW_2));
  assert.equal(launcher.requests[0]?.control.flowInstanceId, FLOW_2);
});

test("finishes crash-window cleanup instead of reactivating the original label event", async () => {
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();
  const terminal = controlState({ stateId: "done", updatedAt: NOW });
  installControl(provider, terminal);
  provider.snapshot.activation = {
    present: true,
    eventId: "803",
    actor: MAINTAINER,
    occurredAt: "2026-08-26T13:00:00.000Z",
  };

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(outcome.flowInstanceId, FLOW_1);
  assert.equal(outcome.stateId, "done");
  assert.equal(provider.created, 0);
  assert.ok(!provider.snapshot.labels.includes("agent-flow:development"));
  assert.deepEqual(launcher.requests, []);
});

test("repairs the permanent managed label for terminal history", async () => {
  const provider = new FakeProvider();
  provider.snapshot.activation = { present: false, eventId: null, actor: null, occurredAt: null };
  provider.snapshot.labels = ["bug", "agent-stage:planning"];
  provider.snapshot.comments.push(controlComment(controlState({ stateId: "done" })));

  const outcome = await reconcileTicket(dependencies(provider), TICKET);

  assert.equal(outcome.stateId, "done");
  assert.ok(provider.snapshot.labels.includes("agent-flow:managed"));
  assert.deepEqual(
    provider.snapshot.labels.filter((label) => label.startsWith("agent-stage:")),
    ["agent-stage:done"],
  );
});

test("fails closed on duplicate flow comments and multiple active flows", async (t) => {
  await t.test("duplicate flow comments", async () => {
    const provider = new FakeProvider();
    const first = controlComment(controlState(), "one");
    provider.snapshot.comments.push(first, { ...first, id: "two" });
    const launcher = new FakeLauncher();

    await assert.rejects(reconcileTicket(dependencies(provider, launcher), TICKET), /duplicate control comment/);
    assert.equal(provider.created + provider.updated, 0);
    assert.deepEqual(launcher.requests, []);
    assert.ok(!provider.events.includes("provider:set-labels"));
  });

  await t.test("multiple active flows", async () => {
    const provider = new FakeProvider();
    provider.snapshot.comments.push(
      controlComment(controlState(), "one"),
      controlComment(controlState({ flowInstanceId: FLOW_2, stateId: "planning" }), "two"),
    );
    const launcher = new FakeLauncher();

    await assert.rejects(reconcileTicket(dependencies(provider, launcher), TICKET), /multiple active/);
    assert.equal(provider.created + provider.updated, 0);
    assert.deepEqual(launcher.requests, []);
    assert.ok(!provider.events.includes("provider:set-labels"));
  });
});

test("repairs multiple old stage labels to exactly one", async () => {
  const provider = new FakeProvider();
  installControl(provider, controlState());
  provider.snapshot.labels.push("agent-stage:planning", "agent-stage:blocked");
  const launcher = new FakeLauncher();
  launcher.running.add(FLOW_1);

  await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.deepEqual(
    provider.snapshot.labels.filter((label) => label.startsWith("agent-stage:")),
    ["agent-stage:assessment"],
  );
});

test("enters needs-human for a closed change and reviews a new head", async (t) => {
  await t.test("closed, unmerged change", async () => {
    const provider = new FakeProvider();
    installControl(provider, controlState({ stateId: "awaiting-merge", changeRequest: controlChange() }));
    provider.snapshot.changeRequest = changeRequest({ state: "closed" });
    const launcher = new FakeLauncher();

    const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

    assert.equal(outcome.stateId, "needs-human");
    assert.equal(launcher.requests[0]?.agentId, "reviewer");
    assert.equal(launcher.requests[0]?.mode, "stage");
    assert.equal(launcher.requests[0]?.resultContract, "review");
    assert.ok(launcher.requests[0]?.inputRevision);

    launcher.running.delete(FLOW_1);
    const index = provider.snapshot.comments.findIndex((candidate) => candidate.id.startsWith("control-"));
    const state = parseControlComment(provider.snapshot.comments[index]!.body)!;
    const request = launcher.requests[0]!;
    provider.snapshot.comments[index] = controlComment({
      ...state,
      sequence: state.sequence + 1,
      updatedAt: "2026-08-26T12:01:00.000Z",
      attemptSeries: attemptSeries({
        agentId: "reviewer",
        stateId: "needs-human",
        inputRevision: request.inputRevision,
      }),
      latestReceipt: questionReceipt(),
    }, provider.snapshot.comments[index]!.id);
    await reconcileTicket(dependencies(provider, launcher), TICKET);
    assert.equal(launcher.requests.length, 1);
  });

  await t.test("head change", async () => {
    const provider = new FakeProvider();
    installControl(provider, controlState({ stateId: "awaiting-merge", changeRequest: controlChange() }));
    provider.snapshot.changeRequest = changeRequest({ headSha: NEW_HEAD });
    const launcher = new FakeLauncher();

    const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

    assert.equal(outcome.stateId, "review");
    assert.equal(launcher.requests[0]?.agentId, "reviewer");
    assert.equal(launcher.requests[0]?.snapshot.changeRequest?.headSha, NEW_HEAD);
  });
});

test("derives explicit cancellation from a needs-human answer", () => {
  const verdict = "cancelled" as const;
  const source = comment("cancel-answer", "Cancel this flow.", MAINTAINER, "2026-08-26T12:02:00.000Z");
  const control = controlState({
    stateId: "needs-human",
    resumeStateId: "review",
    attemptSeries: attemptSeries({ agentId: "reviewer", stateId: "needs-human" }),
    latestReceipt: humanReceipt(verdict, source.id),
    humanGate: {
      sourceCommentId: source.id,
      actor: source.actor,
      verdict,
      interpretedByAttemptId: ATTEMPT,
      notes: [],
    },
  });

  assert.equal(deriveEvent(snapshot(), control, BUNDLE.flow)?.type, "human-answer-cancelled");
});

test("derives the needs-human question verdict as the unclear self-loop", () => {
  const source = comment("question-answer", "Can you explain the options?", MAINTAINER, "2026-08-26T12:02:00.000Z");
  const control = controlState({
    stateId: "needs-human",
    resumeStateId: "review",
    attemptSeries: attemptSeries({ agentId: "reviewer", stateId: "needs-human" }),
    latestReceipt: humanReceipt("question", source.id),
    humanGate: {
      sourceCommentId: source.id,
      actor: source.actor,
      verdict: "question",
      interpretedByAttemptId: ATTEMPT,
      notes: [],
    },
  });

  assert.equal(deriveEvent(snapshot(), control, BUNDLE.flow)?.type, "human-answer-unclear");
});

test("needs-human question stays paused until a later authorized comment", async () => {
  const provider = new FakeProvider();
  const source = comment("question-answer", "Can you explain the options?", MAINTAINER, "2026-08-26T12:02:00.000Z");
  const clarification = comment(
    "clarification",
    `<!-- agent-flow:v1 flow=${FLOW_1} attempt=${ATTEMPT} artifact=question -->\nPlease choose reopen or cancel.`,
    MAINTAINER,
    "2026-08-26T12:03:00.000Z",
  );
  installControl(provider, controlState({
    stateId: "needs-human",
    resumeStateId: "review",
    attemptSeries: attemptSeries({ agentId: "reviewer", stateId: "needs-human" }),
    latestReceipt: humanReceipt("question", source.id),
    humanGate: {
      sourceCommentId: source.id,
      actor: source.actor,
      verdict: "question",
      interpretedByAttemptId: ATTEMPT,
      notes: [],
    },
    changeRequest: controlChange({ state: "closed" }),
  }));
  provider.snapshot.changeRequest = changeRequest({ state: "closed" });
  provider.snapshot.comments.push(source, clarification);
  const launcher = new FakeLauncher();

  const paused = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(paused.stateId, "needs-human");
  assert.deepEqual(launcher.requests, []);
  const controlCommentBody = provider.snapshot.comments.find((candidate) => candidate.id.startsWith("control-"))!.body;
  assert.equal(parseControlComment(controlCommentBody)?.humanGate?.verdict, "question");

  const later = comment("later-answer", "Reopen it.", MAINTAINER, "2026-08-26T12:04:00.000Z");
  provider.snapshot.comments.push(later);
  await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(launcher.requests.length, 1);
  assert.equal(launcher.requests[0]?.mode, "human-input");
  assert.equal(launcher.requests[0]?.sourceComment?.id, later.id);
});

test("human cancellation reaches terminal cancelled without relaunching reviewer", async () => {
  const verdict = "cancelled" as const;
  const provider = new FakeProvider();
  const source = comment("cancel-answer", "Cancel this flow.", MAINTAINER, "2026-08-26T12:02:00.000Z");
  installControl(provider, controlState({
    stateId: "needs-human",
    resumeStateId: "review",
    attemptSeries: attemptSeries({ agentId: "reviewer", stateId: "needs-human" }),
    latestReceipt: humanReceipt(verdict, source.id),
    humanGate: {
      sourceCommentId: source.id,
      actor: source.actor,
      verdict,
      interpretedByAttemptId: ATTEMPT,
      notes: [],
    },
    changeRequest: controlChange({ state: "closed" }),
  }));
  provider.snapshot.changeRequest = changeRequest({ state: "closed" });
  provider.snapshot.comments.push(source);
  const launcher = new FakeLauncher();

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(outcome.stateId, "cancelled");
  assert.ok(provider.snapshot.labels.includes("agent-flow:managed"));
  assert.ok(!provider.snapshot.labels.includes("agent-flow:development"));
  assert.deepEqual(
    provider.snapshot.labels.filter((label) => label.startsWith("agent-stage:")),
    ["agent-stage:cancelled"],
  );
  assert.deepEqual(launcher.requests, []);
});

test("fails closed when an awaiting-merge snapshot replaces the linked change identity", async (t) => {
  for (const state of ["open", "merged"] as const) {
    await t.test(state, async () => {
      const provider = new FakeProvider();
      installControl(provider, controlState({ stateId: "awaiting-merge", changeRequest: controlChange() }));
      provider.snapshot.changeRequest = changeRequest({
        number: 99,
        url: "https://github.example.test/example-owner/example-repository/pull/99",
        headSha: NEW_HEAD,
        state,
      });
      const launcher = new FakeLauncher();

      await assert.rejects(reconcileTicket(dependencies(provider, launcher), TICKET), /change request identity/);
      assert.equal(provider.updated, 0);
      assert.deepEqual(launcher.requests, []);
      assert.ok(!provider.events.includes("provider:set-labels"));
    });
  }
});

test("rejects a merged change request at a different reviewed head", async () => {
  const provider = new FakeProvider();
  installControl(provider, controlState({ stateId: "awaiting-merge", changeRequest: controlChange() }));
  provider.snapshot.changeRequest = changeRequest({ headSha: NEW_HEAD, state: "merged" });
  const launcher = new FakeLauncher();

  await assert.rejects(reconcileTicket(dependencies(provider, launcher), TICKET), /reviewed head/);
  assert.equal(provider.updated, 0);
  assert.deepEqual(launcher.requests, []);
  assert.ok(!provider.events.includes("provider:set-labels"));
});

test("selects the first later unmarked authorized human comment", async () => {
  const provider = new FakeProvider();
  const receipt = assessmentReceipt();
  const assessment = comment(
    "assessment-result",
    receipt.artifacts[0]!.kind === "comment" ? receipt.artifacts[0].marker : "",
    MAINTAINER,
    "2026-08-26T10:40:00.000Z",
  );
  const control = controlState({
    stateId: "assessment-review",
    attemptSeries: attemptSeries(),
    latestReceipt: receipt,
  });
  provider.snapshot.comments.push(
    controlComment(control),
    assessment,
    comment("outsider", "LGTM", OUTSIDER, "2026-08-26T10:41:00.000Z"),
    comment("agent", "<!-- agent-flow:v1 flow=x attempt=y artifact=question -->", MAINTAINER, "2026-08-26T10:42:00.000Z"),
    comment("answer", "Approved; spelling is nonblocking.", MAINTAINER, "2026-08-26T10:43:00.000Z"),
    comment("later", "This is later.", MAINTAINER, "2026-08-26T10:44:00.000Z"),
  );
  provider.snapshot.labels.push("agent-flow:managed", "agent-stage:assessment-review");
  const launcher = new FakeLauncher();

  await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(launcher.requests.length, 1);
  assert.equal(launcher.requests[0]?.mode, "human-input");
  assert.equal(launcher.requests[0]?.sourceComment?.id, "answer");
  assert.equal(launcher.requests[0]?.resultContract, "human-gate");
});

test("keeps an unclear human verdict at the gate without relaunching the same input", async () => {
  const provider = new FakeProvider();
  const source = comment("answer", "Maybe.", MAINTAINER, "2026-08-26T10:43:00.000Z");
  const gate: ControlHumanGate = {
    sourceCommentId: source.id,
    actor: source.actor,
    verdict: "unclear",
    interpretedByAttemptId: ATTEMPT,
    notes: ["Clarification needed."],
  };
  const control = controlState({
    stateId: "assessment-review",
    attemptSeries: attemptSeries({ stateId: "assessment-review", inputRevision: source.id }),
    latestReceipt: humanReceipt("unclear", source.id),
    humanGate: gate,
  });
  installControl(provider, control);
  provider.snapshot.comments.push(source);
  const launcher = new FakeLauncher();

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(outcome.stateId, "assessment-review");
  assert.equal(provider.updated, 1);
  assert.deepEqual(launcher.requests, []);
});

test("an authorized blocked comment resets the series and resumes the stage", async () => {
  const provider = new FakeProvider();
  const control = controlState({
    stateId: "blocked",
    resumeStateId: "development",
    attemptSeries: attemptSeries({
      agentId: "developer",
      stateId: "development",
      consumed: 3,
      current: {
        attemptId: ATTEMPT,
        status: "failed",
        startedAt: "2026-08-26T10:30:00.000Z",
        finishedAt: "2026-08-26T10:45:00.000Z",
        error: { code: "PROCESS_EXIT", message: "Agent exited." },
      },
    }),
  });
  installControl(provider, control);
  provider.snapshot.comments.push(comment("reset", "Retry with the updated credentials.", MAINTAINER, "2026-08-26T10:46:00.000Z"));
  const launcher = new FakeLauncher();

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(outcome.stateId, "development");
  assert.equal(launcher.requests[0]?.agentId, "developer");
  assert.equal(launcher.requests[0]?.control.attemptSeries?.consumed, 0);
  assert.equal(launcher.requests[0]?.control.attemptSeries?.current, null);
});

test("rejects an event that the current XState state cannot accept", async () => {
  const provider = new FakeProvider();
  installControl(provider, controlState({
    stateId: "planning",
    attemptSeries: attemptSeries({ agentId: "planner", stateId: "planning" }),
    latestReceipt: reviewReceipt(),
  }));
  const launcher = new FakeLauncher();

  await assert.rejects(reconcileTicket(dependencies(provider, launcher), TICKET), /invalid transition/);
  assert.equal(provider.updated, 0);
  assert.deepEqual(launcher.requests, []);
  assert.ok(!provider.events.includes("provider:set-labels"));
});

test("fails before labels and launch when control or label readback differs", async (t) => {
  await t.test("control readback", async () => {
    const provider = new FakeProvider();
    provider.readbackMismatch = true;
    const launcher = new FakeLauncher();

    await assert.rejects(reconcileTicket(dependencies(provider, launcher), TICKET), /control comment readback mismatch/);
    assert.ok(!provider.events.includes("provider:set-labels"));
    assert.deepEqual(launcher.requests, []);
  });

  await t.test("label readback", async () => {
    const provider = new FakeProvider();
    provider.labelReadbackMismatch = true;
    const launcher = new FakeLauncher();

    await assert.rejects(reconcileTicket(dependencies(provider, launcher), TICKET), /controller label readback mismatch/);
    assert.deepEqual(launcher.requests, []);
  });
});

test("ignores a result that appears after cancellation", async () => {
  const provider = new FakeProvider();
  provider.snapshot.labels = ["agent-flow:managed", "agent-stage:cancelled"];
  provider.snapshot.activation = { present: false, eventId: null, actor: null, occurredAt: null };
  provider.snapshot.comments.push(controlComment(controlState({
    stateId: "cancelled",
    latestReceipt: assessmentReceipt(),
    attemptSeries: attemptSeries(),
  })));
  const launcher = new FakeLauncher();

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(outcome.stateId, "cancelled");
  assert.equal(provider.updated, 0);
  assert.deepEqual(launcher.requests, []);
  assert.deepEqual(launcher.cancelled, []);
});

test("sanitizes provider and configuration failures", async (t) => {
  await t.test("provider", async () => {
    const provider = new FakeProvider();
    provider.readError = new Error("token ghp_secret");
    const error = await reconcileTicket(dependencies(provider), TICKET).catch((caught: unknown) => caught);
    assert.match(String(error), /provider ticket read failed/);
    assert.doesNotMatch(inspect(error, { depth: null, showHidden: true }), /ghp_secret/);
    assert.doesNotMatch(inspect(Object.getOwnPropertyDescriptors(error as object), { depth: null }), /ghp_secret/);
  });

  await t.test("configuration", async () => {
    const provider = new FakeProvider();
    installControl(provider, controlState());
    const deps = dependencies(provider);
    deps.config.loadPinned = async () => { throw new Error("https://user:secret@example.test"); };
    const error = await reconcileTicket(deps, TICKET).catch((caught: unknown) => caught);
    assert.match(String(error), /pinned configuration load failed/);
    assert.doesNotMatch(inspect(error, { depth: null, showHidden: true }), /user:secret/);
    assert.doesNotMatch(inspect(Object.getOwnPropertyDescriptors(error as object), { depth: null }), /user:secret/);
  });
});

test("uses stable semantic attempt input revisions", async (t) => {
  await t.test("same provider input", async () => {
    const provider = new FakeProvider();
    const firstLauncher = new FakeLauncher();
    await reconcileTicket(dependencies(provider, firstLauncher), TICKET);
    const first = firstLauncher.requests[0]!.inputRevision;
    firstLauncher.running.clear();

    const secondLauncher = new FakeLauncher();
    await reconcileTicket(dependencies(provider, secondLauncher), TICKET);

    assert.equal(secondLauncher.requests[0]?.inputRevision, first);
    assert.ok(first.length > 0 && first.length <= 255);
  });

  await t.test("new change-request head", async () => {
    const provider = new FakeProvider();
    installControl(provider, controlState({ stateId: "review", changeRequest: controlChange() }));
    provider.snapshot.changeRequest = changeRequest();
    const firstLauncher = new FakeLauncher();
    await reconcileTicket(dependencies(provider, firstLauncher), TICKET);

    provider.snapshot.changeRequest = changeRequest({ headSha: NEW_HEAD });
    const secondLauncher = new FakeLauncher();
    await reconcileTicket(dependencies(provider, secondLauncher), TICKET);

    assert.notEqual(secondLauncher.requests[0]?.inputRevision, firstLauncher.requests[0]?.inputRevision);
  });

  await t.test("new human comment", async () => {
    async function revision(sourceId: string): Promise<string> {
      const provider = new FakeProvider();
      const receipt = assessmentReceipt();
      const control = controlState({ stateId: "assessment-review", latestReceipt: receipt });
      installControl(provider, control);
      provider.snapshot.comments.push(
        comment("assessment-result", "<!-- agent-flow:v1 flow=x attempt=y artifact=assessment -->", MAINTAINER, "2026-08-26T10:40:00.000Z"),
        comment(sourceId, "Approved.", MAINTAINER, "2026-08-26T10:41:00.000Z"),
      );
      const launcher = new FakeLauncher();
      await reconcileTicket(dependencies(provider, launcher), TICKET);
      return launcher.requests[0]!.inputRevision;
    }

    assert.notEqual(await revision("answer-1"), await revision("answer-2"));
  });

  await t.test("prior-stage output does not become external input", async () => {
    async function revision(attemptId: string): Promise<string> {
      const provider = new FakeProvider();
      const receipt = { ...reviewReceipt(), attemptId };
      installControl(provider, controlState({
        stateId: "development",
        changeRequest: controlChange(),
        attemptSeries: attemptSeries({
          agentId: "reviewer",
          stateId: "review",
          current: {
            attemptId,
            status: "succeeded",
            startedAt: "2026-08-26T10:30:00.000Z",
            finishedAt: "2026-08-26T10:45:00.000Z",
          },
        }),
        latestReceipt: receipt,
      }));
      provider.snapshot.changeRequest = changeRequest();
      const launcher = new FakeLauncher();
      await reconcileTicket(dependencies(provider, launcher), TICKET);
      return launcher.requests[0]!.inputRevision;
    }

    assert.equal(
      await revision("33333333-3333-4333-8333-333333333333"),
      await revision("55555555-5555-4555-8555-555555555555"),
    );
  });

  await t.test("persisting the current started series", async () => {
    const provider = new FakeProvider();
    installControl(provider, controlState({
      stateId: "development",
      changeRequest: controlChange(),
      attemptSeries: attemptSeries({ agentId: "reviewer", stateId: "review" }),
      latestReceipt: reviewReceipt("changes-requested"),
    }));
    provider.snapshot.changeRequest = changeRequest();
    const firstLauncher = new FakeLauncher();
    await reconcileTicket(dependencies(provider, firstLauncher), TICKET);
    const request = firstLauncher.requests[0]!;
    firstLauncher.running.clear();

    const index = provider.snapshot.comments.findIndex((candidate) => candidate.id.startsWith("control-"));
    const state = parseControlComment(provider.snapshot.comments[index]!.body)!;
    provider.snapshot.comments[index] = controlComment({
      ...state,
      attemptSeries: attemptSeries({
        agentId: "developer",
        stateId: "development",
        inputRevision: request.inputRevision,
        current: {
          attemptId: ATTEMPT,
          status: "started",
          startedAt: "2026-08-26T12:01:00.000Z",
        },
      }),
    }, provider.snapshot.comments[index]!.id);
    const secondLauncher = new FakeLauncher();

    await reconcileTicket(dependencies(provider, secondLauncher), TICKET);

    assert.deepEqual(secondLauncher.requests, []);
  });

  await t.test("persisting a failed current attempt", async () => {
    const provider = new FakeProvider();
    installControl(provider, controlState({ stateId: "development", changeRequest: controlChange() }));
    provider.snapshot.changeRequest = changeRequest();
    const firstLauncher = new FakeLauncher();
    await reconcileTicket(dependencies(provider, firstLauncher), TICKET);
    const request = firstLauncher.requests[0]!;
    firstLauncher.running.clear();

    const index = provider.snapshot.comments.findIndex((candidate) => candidate.id.startsWith("control-"));
    const state = parseControlComment(provider.snapshot.comments[index]!.body)!;
    provider.snapshot.comments[index] = controlComment({
      ...state,
      attemptSeries: attemptSeries({
        agentId: "developer",
        stateId: "development",
        inputRevision: request.inputRevision,
        current: {
          attemptId: ATTEMPT,
          status: "failed",
          startedAt: "2026-08-26T12:01:00.000Z",
          finishedAt: "2026-08-26T12:02:00.000Z",
          error: { code: "PROCESS_EXIT", message: "The harness exited." },
        },
      }),
      latestReceipt: failedReceipt(),
    }, provider.snapshot.comments[index]!.id);
    const secondLauncher = new FakeLauncher();

    await reconcileTicket(dependencies(provider, secondLauncher), TICKET);

    assert.deepEqual(secondLauncher.requests, []);
    const unchanged = parseControlComment(provider.snapshot.comments[index]!.body)!;
    assert.equal(unchanged.attemptSeries?.inputRevision, request.inputRevision);
  });
});
