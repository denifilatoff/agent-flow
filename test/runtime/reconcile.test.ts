import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { inspect } from "node:util";

import { loadConfigBundle, type ConfigBundle } from "../../src/config/load.ts";
import { parseYaml, validateDocument } from "../../src/config/schema-validator.ts";
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
  RecoveryEvidence,
  TicketRef,
} from "../../src/provider/types.ts";
import {
  createAttemptRunner,
  type AttemptRunnerDependencies,
} from "../../src/runtime/attempt-runner.ts";
import {
  reconcileTicket,
  type AttemptLauncher,
  type AttemptRequest,
  type ReconcileDependencies,
} from "../../src/runtime/reconcile.ts";
import { readDecisionAndBuildReceipt } from "../../src/runtime/receipts.ts";
import { deriveEvent } from "../../src/runtime/derive-event.ts";
import { createControlWriter } from "../../src/runtime/control-state.ts";
import { openLocalStore, providerScope } from "../../src/runtime/local-store.ts";

const SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);
const OLD_HEAD = "1".repeat(40);
const NEW_HEAD = "2".repeat(40);
const FLOW_1 = "11111111-1111-4111-8111-111111111111";
const FLOW_2 = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const SERIES = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-08-26T12:00:00.000Z";
const PROVIDER_CREDENTIAL = {
  provider: "github", name: "GH_TOKEN", value: "fixture-token", apiUrl: "https://api.github.com",
} as const;
const EXECUTION = {
  harness: "claude", model: "fixture-model", reasoning: "high",
  maxAttempts: 3, delaySeconds: 0, timeoutSeconds: 60,
} as const;
const execution = async () => ({ runtimeDigest: "b".repeat(64), executionSnapshot: EXECUTION });
const TICKET: TicketRef = {
  provider: "github",
  repository: "example-owner/example-repository",
  number: 17,
};
const MAINTAINER: Actor = { login: "maintainer", providerId: "7" };
const OUTSIDER: Actor = { login: "outsider", providerId: "8" };

const BUNDLE = await loadConfigBundle(process.cwd(), "config/stack.yaml", SHA);
// These recovery fixtures exercise legacy agent-publication pins.
delete BUNDLE.stack.spec.publication;
BUNDLE.flow = validateDocument("Flow", await parseYaml("config/flows/development.yaml"));

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
    title: "Fix the edge case",
    description: "Handle the documented edge case.",
    open: true,
    labels: ["bug", "agent-flow:development"],
    updatedAt: "2026-08-26T11:45:00.000Z",
    activation: {
      present: true,
      label: "agent-flow:development",
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
  stripGitLabFinalNewline = false;
  readError: Error | null = null;
  created = 0;
  updated = 0;
  recoveryEvidence: RecoveryEvidence | null = null;

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
  async readRecoveryEvidence(_ref: TicketRef): Promise<RecoveryEvidence> {
    this.events.push("provider:read-recovery");
    return structuredClone(this.recoveryEvidence ?? {
      snapshot: this.snapshot,
      publications: [],
      changes: [],
      reviews: [],
      ambiguities: [],
      complete: true,
      activeBoundary: "known",
      legacyActive: false,
    });
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
    const storedBody = this.stripGitLabFinalNewline ? body.slice(0, -1) : body;
    const created = comment(`created-${this.created}`, storedBody, MAINTAINER, NOW);
    this.snapshot.comments.push(created);
    return structuredClone(created);
  }
  async updateComment(_ref: TicketRef, id: string, body: string): Promise<ProviderComment> {
    this.events.push("provider:update-control");
    this.updated += 1;
    const index = this.snapshot.comments.findIndex((candidate) => candidate.id === id);
    assert.notEqual(index, -1);
    const storedBody = this.stripGitLabFinalNewline ? body.slice(0, -1) : body;
    this.snapshot.comments[index] = { ...this.snapshot.comments[index]!, body: storedBody, updatedAt: NOW };
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
  async findReview(): Promise<never> { throw new Error("unused"); }
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

function recoveryEvidence(
  provider: FakeProvider,
  publications: RecoveryEvidence["publications"],
  patch: Partial<RecoveryEvidence> = {},
): RecoveryEvidence {
  return {
    snapshot: provider.snapshot,
    publications,
    changes: [],
    reviews: [],
    ambiguities: [],
    complete: true,
    activeBoundary: "known",
    legacyActive: false,
    ...patch,
  };
}

function publicationKey(kind: "comment" | "change-request" | "review", id: string): string {
  return JSON.stringify(["github", "https://api.github.com/", TICKET.repository, kind, id]);
}

async function localRuntime(t: TestContext, provider: FakeProvider, launcher = new FakeLauncher()) {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-reconcile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = openLocalStore(join(directory, "execution.sqlite"));
  t.after(() => store.close());
  const writer = createControlWriter(
    store,
    providerScope("github", "https://api.github.com"),
    FLOW_1,
    () => NOW,
  );
  const configured = dependencies(provider, launcher);
  configured.controllerId = FLOW_1;
  configured.writeControl = writer;
  return { configured, launcher, writer };
}

function dependencies(provider = new FakeProvider(), launcher = new FakeLauncher()): ReconcileDependencies {
  return {
    provider,
    providerApiUrl: "https://api.github.com",
    config: {
      loadCurrent: async () => BUNDLE,
      loadPinned: async (revision: string) => {
        assert.equal(revision, SHA);
        return BUNDLE;
      },
    },
    launcher,
    writeControl: async (ref, expected, next) => {
      const matches = provider.snapshot.comments.filter((candidate) => {
        const parsed = parseControlComment(candidate.body);
        return parsed?.flowInstanceId === expected.flowInstanceId;
      });
      assert.equal(matches.length, 1);
      const comment = matches[0]!;
      const current = parseControlComment(comment.body)!;
      if (current.sequence !== expected.sequence) throw new Error("control sequence conflict");
      await provider.updateComment(ref, comment.id, renderControlComment(next));
      const readback = await provider.readComment(ref, comment.id);
      return parseControlComment(readback.body)!;
    },
    now: () => NOW,
    newFlowInstanceId: () => FLOW_2,
  };
}

async function assertRunnerAccepts(request: AttemptRequest, provider: ProviderAdapter): Promise<void> {
  let current = request.control;
  const runner = createAttemptRunner({
    dataDirectory: "/data",
    provider,
    providerConfig: { apiUrl: PROVIDER_CREDENTIAL.apiUrl, repositories: [request.ref.repository] },
    providerCredential: PROVIDER_CREDENTIAL,
    preparePinnedAgent: async () => ({
      bundle: request.bundle,
      packageDirectory: "/config/agent-packages/developer",
    }),
    execution,
    workspaceManager: { async prepareWorkspace() { return {
      baseClone: "/data/repository", worktree: "/data/worktree", repository: request.ref.repository,
      ticketNumber: request.ref.number, flowInstanceId: request.control.flowInstanceId,
    }; } },
    harnesses: { [EXECUTION.harness]: {
      target: EXECUTION.harness,
      async preflight() {},
      async run(input) {
        return new Promise((resolve) => input.signal.addEventListener("abort", () => resolve({
          exitCode: null, signal: "SIGTERM", timedOut: false,
        }), { once: true }));
      },
    } },
    async writeControl(_ref, expected, next) {
      assert.equal(expected.sequence, current.sequence);
      current = structuredClone(next);
      return structuredClone(current);
    },
    async createSession(_data, _flow, attemptId) { return {
      root: `/data/${attemptId}`, contextPath: `/data/${attemptId}/context.json`,
      decisionPath: `/data/${attemptId}/decision.json`, logPath: `/data/${attemptId}/harness.log`,
      harnessSessionDirectory: `/data/${attemptId}/harness-session`,
    }; },
    async compileAgent(agentId, _package, target) {
      return { agentId, target, instructions: "test", runtimeDirectory: "/runtime" };
    },
    now: () => NOW,
  } satisfies AttemptRunnerDependencies);
  await runner.start(request);
  assert.equal(runner.isRunning(request.control.flowInstanceId), true);
  await runner.cancel(request.control.flowInstanceId);
}

function installControl(provider: FakeProvider, state: ControlState): void {
  provider.snapshot.comments.push(controlComment(state));
  provider.snapshot.labels.push(`agent-stage:${state.stateId}`, "agent-flow:managed");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

test("accepts one authorized activation and owns one stage label", async () => {
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(outcome.stateId, "assessment");
  assert.equal(outcome.repositoryUrl, "https://github.example.test/example-owner/example-repository");
  assert.equal(outcome.ticketUrl, "https://github.example.test/example-owner/example-repository/issues/17");
  assert.equal(outcome.actionUrl, outcome.ticketUrl);
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

test("routes the exact bugfix label to the bugfix branch", async () => {
  const provider = new FakeProvider();
  provider.snapshot.labels = ["bugfix"];
  provider.snapshot.activation.label = "bugfix";
  const launcher = new FakeLauncher();

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(outcome.stateId, "bug-reproduction");
  assert.equal(launcher.requests[0]?.agentId, "bug-investigator");
  assert.ok(provider.snapshot.labels.includes("bugfix"));
});

test("routes by the authorized activation event when both labels are present", async () => {
  const provider = new FakeProvider();
  provider.snapshot.labels = ["bugfix", "agent-flow:development"];
  provider.snapshot.activation.label = "agent-flow:development";
  const launcher = new FakeLauncher();

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(outcome.stateId, "assessment");
  assert.equal(launcher.requests[0]?.agentId, "architect");
  assert.equal(launcher.requests[0]?.control.activationLabel, "agent-flow:development");
});

test("keeps a pinned bugfix flow active when startup activation routes change", async () => {
  const provider = new FakeProvider();
  provider.snapshot.labels = ["bugfix"];
  provider.snapshot.activation = {
    present: false,
    label: null,
    eventId: null,
    actor: null,
    occurredAt: null,
  };
  installControl(provider, controlState({
    stateId: "bug-reproduction",
    activationLabel: "bugfix",
  }));
  const launcher = new FakeLauncher();

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(outcome.stateId, "bug-reproduction");
  assert.equal(launcher.requests[0]?.agentId, "bug-investigator");
  assert.deepEqual(launcher.cancelled, []);
});

test("keeps retry identity pinned to the accepted activation event", async () => {
  async function inputRevision(eventId: string | null): Promise<string> {
    const provider = new FakeProvider();
    provider.snapshot.labels = ["bugfix"];
    provider.snapshot.activation.eventId = eventId;
    installControl(provider, controlState({
      stateId: "bug-reproduction",
      activationLabel: "bugfix",
    }));
    const launcher = new FakeLauncher();

    await reconcileTicket(dependencies(provider, launcher), TICKET);

    return launcher.requests[0]!.inputRevision;
  }

  assert.equal(await inputRevision("new-route-event"), await inputRevision(null));
});

test("accepts a GitLab control creation readback without the final newline", async () => {
  const provider = new FakeProvider();
  provider.stripGitLabFinalNewline = true;
  const launcher = new FakeLauncher();

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(outcome.stateId, "assessment");
  assert.equal(launcher.requests.length, 1);
});

test("ignores an activation by an actor below write permission", async () => {
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();
  provider.snapshot.activation.actor = OUTSIDER;

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.deepEqual(outcome, {
    flowInstanceId: null,
    stateId: null,
    configRevision: null,
    stateKind: null,
    repositoryUrl: "https://github.example.test/example-owner/example-repository",
    ticketUrl: "https://github.example.test/example-owner/example-repository/issues/17",
    actionUrl: "https://github.example.test/example-owner/example-repository/issues/17",
    changed: false,
    started: false,
    runnable: true,
  });
  assert.equal(provider.created, 0);
  assert.equal(provider.updated, 0);
  assert.deepEqual(launcher.requests, []);
  assert.ok(!provider.snapshot.labels.includes("agent-flow:managed"));
});

test("C18/C20 foreign ownership after identity loss cancels local work without provider mutation", async () => {
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();
  installControl(provider, controlState());
  launcher.running.add(FLOW_1);
  provider.recoveryEvidence = recoveryEvidence(provider, [{
      key: "foreign-comment",
      createdAt: "2026-08-26T11:30:00.000Z",
      metadata: { config: SHA, controller: FLOW_2 },
    }]);
  const recorded: string[] = [];
  const configured = dependencies(provider, launcher);
  configured.controllerId = FLOW_1;
  configured.recordRecovery = async (_ref, _evidence, decision) => { recorded.push(decision.kind); };

  const outcome = await reconcileTicket(configured, TICKET);

  assert.equal(outcome.runnable, false);
  assert.equal(outcome.started, false);
  assert.deepEqual(launcher.cancelled, [FLOW_1]);
  assert.deepEqual(recorded, ["foreign"]);
  assert.equal(provider.events.includes("provider:read-ticket"), false);
  assert.equal(provider.events.includes("provider:create-control"), false);
  assert.equal(provider.events.includes("provider:update-control"), false);
  assert.equal(provider.events.includes("provider:set-labels"), false);
});

test("foreign ownership still cancels local work when recording fails", async () => {
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();
  installControl(provider, controlState());
  launcher.running.add(FLOW_1);
  provider.recoveryEvidence = recoveryEvidence(provider, [{
      key: "foreign-comment",
      createdAt: "2026-08-26T11:30:00.000Z",
      metadata: { config: SHA, controller: FLOW_2 },
    }]);
  const configured = dependencies(provider, launcher);
  configured.controllerId = FLOW_1;
  configured.recordRecovery = async () => { throw new Error("local store unavailable"); };

  await assert.rejects(reconcileTicket(configured, TICKET), /local store unavailable/);

  assert.deepEqual(launcher.cancelled, [FLOW_1]);
  assert.equal(provider.events.includes("provider:set-labels"), false);
});

test("C12 a missing winning configuration pauses without falling back to current configuration", async () => {
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();
  provider.snapshot.labels.push("agent-stage:assessment");
  provider.recoveryEvidence = recoveryEvidence(provider, [{
      key: "own-comment",
      createdAt: "2026-08-26T11:30:00.000Z",
      metadata: { config: SHA, controller: FLOW_1 },
    }]);
  let currentLoads = 0;
  const configured = dependencies(provider, launcher);
  configured.controllerId = FLOW_1;
  configured.config = {
    loadCurrent: async () => { currentLoads += 1; return BUNDLE; },
    loadPinned: async () => { throw new Error("missing pinned revision"); },
  };

  const outcome = await reconcileTicket(configured, TICKET);

  assert.equal(outcome.runnable, false);
  assert.equal(outcome.started, false);
  assert.equal(currentLoads, 0);
  assert.deepEqual(launcher.requests, []);
  assert.equal(provider.events.includes("provider:set-labels"), false);
});

test("a stage missing from the winning flow pauses without a provider mutation", async () => {
  const provider = new FakeProvider();
  provider.snapshot.labels.push("agent-stage:review");
  provider.recoveryEvidence = recoveryEvidence(provider, [{
      key: "own-comment",
      createdAt: "2026-08-26T11:30:00.000Z",
      metadata: { config: SHA, controller: FLOW_1 },
    }]);
  const broken = structuredClone(BUNDLE);
  delete broken.flow.spec.states.review;
  const recorded: string[] = [];
  const configured = dependencies(provider);
  configured.controllerId = FLOW_1;
  configured.config = {
    loadCurrent: async () => { throw new Error("current configuration must not load"); },
    loadPinned: async () => broken,
  };
  configured.recordRecovery = async (_ref, _evidence, decision) => { recorded.push(decision.kind); };

  const outcome = await reconcileTicket(configured, TICKET);

  assert.equal(outcome.runnable, false);
  assert.deepEqual(recorded, ["ambiguous"]);
  assert.equal(provider.events.includes("provider:set-labels"), false);
});

test("C4 reassessment does not fabricate a flow transition before local recovery is available", async () => {
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();
  provider.snapshot.labels.push("agent-stage:assessment");
  provider.recoveryEvidence = recoveryEvidence(provider, [{
      key: "own-comment",
      createdAt: "2026-08-26T11:30:00.000Z",
      metadata: { config: SHA, controller: FLOW_1 },
    }]);
  const configured = dependencies(provider, launcher);
  configured.controllerId = FLOW_1;

  const outcome = await reconcileTicket(configured, TICKET);

  assert.equal(outcome.runnable, true);
  assert.equal(outcome.started, false);
  assert.equal(provider.created, 0);
  assert.equal(provider.updated, 0);
  assert.deepEqual(launcher.requests, []);
  assert.equal(provider.events.includes("provider:set-labels"), false);
});

test("a locally verified publication survives the publication-before-label crash window", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-reconcile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = openLocalStore(join(directory, "execution.sqlite"));
  t.after(() => store.close());
  const writer = createControlWriter(
    store,
    providerScope("github", "https://api.github.com"),
    FLOW_1,
    () => NOW,
  );
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  provider.snapshot.labels.push("agent-stage:assessment", "agent-flow:managed");
  provider.snapshot.comments.push(comment("assessment-result", `${marker}\nAssessment complete.`));
  provider.recoveryEvidence = recoveryEvidence(provider, [{
    key: JSON.stringify(["github", "https://api.github.com/", TICKET.repository, "comment", "assessment-result"]),
    createdAt: "2026-08-26T11:30:00.000Z",
    metadata: { config: SHA, controller: FLOW_1 },
  }]);
  await writer(TICKET, null, controlState({
    attemptSeries: attemptSeries(),
    latestReceipt: assessmentReceipt(),
  }));
  const configured = dependencies(provider, launcher);
  configured.controllerId = FLOW_1;
  configured.writeControl = writer;

  const result = await reconcileTicket(configured, TICKET);

  assert.equal(result.stateId, "assessment-review");
  assert.equal(launcher.requests.length, 0);
  assert.equal(writer.load!(TICKET)?.value.control?.stateId, "assessment-review");
  assert.equal(writer.load!(TICKET)?.value.control?.attemptSeries?.consumed, 1);
});

test("a cached successful receipt cannot advance after its provider publication disappears", async (t) => {
  const provider = new FakeProvider();
  provider.snapshot.labels.push("agent-stage:assessment", "agent-flow:managed");
  provider.recoveryEvidence = recoveryEvidence(provider, []);
  const runtime = await localRuntime(t, provider);
  await runtime.writer(TICKET, null, controlState({
    attemptSeries: attemptSeries(),
    latestReceipt: assessmentReceipt(),
  }));

  const result = await reconcileTicket(runtime.configured, TICKET);

  assert.equal(result.stateId, "assessment");
  assert.equal(runtime.launcher.requests.length, 1);
  assert.equal(runtime.launcher.requests[0]?.control.latestReceipt, null);
  assert.equal(runtime.launcher.requests[0]?.control.attemptSeries?.current, null);
  assert.equal(runtime.writer.load!(TICKET)?.value.control?.latestReceipt, null);
});

test("an answer published before recovered stage persistence remains eligible", async (t) => {
  const provider = new FakeProvider();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  const assessment = comment(
    "assessment-result",
    `${marker}\nAssessment complete.`,
    MAINTAINER,
    "2026-08-26T11:30:00.000Z",
  );
  const answer = comment("answer-before-reconcile", "Approved.", MAINTAINER, "2026-08-26T11:40:00.000Z");
  provider.snapshot.labels.push("agent-stage:assessment", "agent-flow:managed");
  provider.snapshot.comments.push(assessment, answer);
  provider.recoveryEvidence = recoveryEvidence(provider, [{
    key: publicationKey("comment", assessment.id),
    createdAt: assessment.createdAt,
    metadata: { config: SHA, controller: FLOW_1 },
  }]);
  const runtime = await localRuntime(t, provider);
  await runtime.writer(TICKET, null, controlState({
    updatedAt: NOW,
    attemptSeries: attemptSeries(),
    latestReceipt: assessmentReceipt(),
  }));

  const result = await reconcileTicket(runtime.configured, TICKET);

  assert.equal(result.stateId, "assessment-review");
  assert.equal(runtime.launcher.requests.length, 1);
  assert.equal(runtime.launcher.requests[0]?.mode, "human-input");
  assert.equal(runtime.launcher.requests[0]?.sourceComment?.id, answer.id);
});

test("a marked publication without local decision state is reassessed by the stage agent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-reconcile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = openLocalStore(join(directory, "execution.sqlite"));
  t.after(() => store.close());
  const writer = createControlWriter(
    store,
    providerScope("github", "https://api.github.com"),
    FLOW_1,
    () => NOW,
  );
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  provider.snapshot.labels.push("agent-stage:assessment", "agent-flow:managed");
  provider.snapshot.comments.push(comment("progress", `${marker}\nPublished work.`));
  provider.recoveryEvidence = recoveryEvidence(provider, [{
    key: JSON.stringify(["github", "https://api.github.com/", TICKET.repository, "comment", "progress"]),
    createdAt: "2026-08-26T11:30:00.000Z",
    metadata: { config: SHA, controller: FLOW_1 },
  }]);
  const configured = dependencies(provider, launcher);
  configured.controllerId = FLOW_1;
  configured.writeControl = writer;

  const result = await reconcileTicket(configured, TICKET);

  assert.equal(result.stateId, "assessment");
  assert.equal(launcher.requests.length, 1);
  assert.equal(launcher.requests[0]?.publicationKeys.length, 0);
  assert.equal(writer.load!(TICKET)?.value.control?.latestReceipt, null);
});

test("a proven fresh activation replaces a terminal local flow without removing activation", async (t) => {
  const provider = new FakeProvider();
  provider.snapshot.activation = {
    present: true,
    eventId: "804",
    actor: MAINTAINER,
    occurredAt: "2026-08-26T11:50:00.000Z",
  };
  provider.snapshot.labels.push("agent-stage:done", "agent-flow:managed");
  provider.snapshot.changeRequest = changeRequest({ state: "merged" });
  provider.recoveryEvidence = recoveryEvidence(provider, [], { activeBoundary: "fresh" });
  const runtime = await localRuntime(t, provider);
  await runtime.writer(TICKET, null, controlState({ stateId: "done" }));

  const result = await reconcileTicket(runtime.configured, TICKET);

  assert.equal(result.flowInstanceId, FLOW_2);
  assert.equal(result.stateId, "assessment");
  assert.equal(runtime.launcher.requests.length, 1);
  assert.equal(runtime.writer.load!(TICKET)?.value.control?.activationEventId, "804");
  assert.equal(runtime.writer.load!(TICKET)?.value.control?.changeRequest, null);
  assert.ok(provider.snapshot.labels.includes("agent-flow:development"));
  assert.ok(provider.snapshot.labels.includes("agent-stage:assessment"));
});

test("a proven fresh activation replaces nonterminal local state from an older activation", async (t) => {
  const provider = new FakeProvider();
  provider.snapshot.activation = {
    present: true,
    eventId: "804",
    actor: MAINTAINER,
    occurredAt: "2026-08-26T11:50:00.000Z",
  };
  provider.snapshot.labels.push("agent-stage:planning", "agent-flow:managed");
  provider.recoveryEvidence = recoveryEvidence(provider, [], { activeBoundary: "fresh" });
  const runtime = await localRuntime(t, provider);
  await runtime.writer(TICKET, null, controlState({
    configRevision: "b".repeat(40),
    stateId: "planning",
    attemptSeries: attemptSeries({ agentId: "planner", stateId: "planning" }),
    latestReceipt: assessmentReceipt(),
  }));

  const result = await reconcileTicket(runtime.configured, TICKET);

  const control = runtime.writer.load!(TICKET)?.value.control;
  assert.equal(result.flowInstanceId, FLOW_2);
  assert.equal(control?.flowInstanceId, FLOW_2);
  assert.equal(control?.activationEventId, "804");
  assert.equal(control?.configRevision, SHA);
  assert.equal(control?.stateId, "assessment");
  assert.equal(control?.attemptSeries, null);
  assert.equal(control?.latestReceipt, null);
  assert.deepEqual(runtime.launcher.cancelled, [FLOW_1]);
  assert.equal(runtime.launcher.requests.length, 1);
});

test("C6/C16 local needs-human and blocked resume context overrides only missing-context ambiguity", async (t) => {
  await t.test("needs-human", async (context) => {
    const provider = new FakeProvider();
    const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
    const question = comment("closed-question", `${marker}\nPlease answer.`, MAINTAINER, "2026-08-26T10:30:00.000Z");
    const answer = comment("answer", "Proceed.", MAINTAINER, "2026-08-26T10:40:00.000Z");
    provider.snapshot.labels.push("agent-stage:needs-human", "agent-flow:managed");
    provider.snapshot.comments.push(question, answer);
    provider.recoveryEvidence = recoveryEvidence(provider, [{
      key: publicationKey("comment", question.id),
      createdAt: question.createdAt,
      metadata: { config: SHA, controller: FLOW_1 },
    }]);
    const runtime = await localRuntime(context, provider);
    await runtime.writer(TICKET, null, controlState({
      stateId: "needs-human",
      resumeStateId: "assessment",
      attemptSeries: attemptSeries(),
      latestReceipt: questionReceipt(),
    }));

    const result = await reconcileTicket(runtime.configured, TICKET);

    assert.equal(result.runnable, true);
    assert.equal(runtime.launcher.requests.length, 1);
    assert.equal(runtime.launcher.requests[0]?.mode, "human-input");
    assert.equal(runtime.launcher.requests[0]?.sourceComment?.id, answer.id);
  });

  await t.test("blocked", async (context) => {
    const provider = new FakeProvider();
    const answer = comment("retry", "Please retry.", MAINTAINER, "2026-08-26T11:00:00.000Z");
    provider.snapshot.labels.push("agent-stage:blocked", "agent-flow:managed");
    provider.snapshot.comments.push(answer);
    provider.recoveryEvidence = recoveryEvidence(provider, []);
    const runtime = await localRuntime(context, provider);
    await runtime.writer(TICKET, null, controlState({
      stateId: "blocked",
      resumeStateId: "assessment",
      attemptSeries: attemptSeries({ consumed: 3, current: {
        attemptId: ATTEMPT,
        status: "failed",
        startedAt: "2026-08-26T10:30:00.000Z",
        finishedAt: "2026-08-26T10:45:00.000Z",
        error: { code: "ATTEMPTS_EXHAUSTED", message: "retry budget exhausted" },
      } }),
    }));

    const result = await reconcileTicket(runtime.configured, TICKET);

    assert.equal(result.stateId, "assessment");
    assert.equal(runtime.launcher.requests.length, 1);
    assert.equal(runtime.launcher.requests[0]?.control.attemptSeries?.consumed, 0);
  });

  await t.test("blocked after a partial stage-label update", async (context) => {
    const provider = new FakeProvider();
    const answer = comment("retry-after-crash", "Please retry.", MAINTAINER, "2026-08-26T11:00:00.000Z");
    provider.snapshot.labels.push("agent-flow:managed");
    provider.snapshot.comments.push(answer);
    provider.recoveryEvidence = recoveryEvidence(provider, []);
    const runtime = await localRuntime(context, provider);
    await runtime.writer(TICKET, null, controlState({
      stateId: "blocked",
      resumeStateId: "assessment",
      attemptSeries: attemptSeries({ consumed: 3, current: {
        attemptId: ATTEMPT,
        status: "failed",
        startedAt: "2026-08-26T10:30:00.000Z",
        finishedAt: "2026-08-26T10:45:00.000Z",
        error: { code: "ATTEMPTS_EXHAUSTED", message: "retry budget exhausted" },
      } }),
    }));

    const result = await reconcileTicket(runtime.configured, TICKET);

    assert.equal(result.stateId, "assessment");
    assert.equal(runtime.launcher.requests.length, 1);
    assert.equal(runtime.launcher.requests[0]?.control.attemptSeries?.consumed, 0);
    assert.ok(provider.snapshot.labels.includes("agent-stage:assessment"));
  });

  await t.test("blocked resumes a human gate", async (context) => {
    const provider = new FakeProvider();
    const retry = comment("retry-review", "Retry the review gate.", MAINTAINER, "2026-08-26T11:00:00.000Z");
    provider.snapshot.labels.push("agent-stage:blocked", "agent-flow:managed");
    provider.snapshot.comments.push(retry);
    provider.recoveryEvidence = recoveryEvidence(provider, []);
    const runtime = await localRuntime(context, provider);
    await runtime.writer(TICKET, null, controlState({
      stateId: "blocked",
      resumeStateId: "assessment-review",
      attemptSeries: attemptSeries({ consumed: 3, current: {
        attemptId: ATTEMPT,
        status: "failed",
        startedAt: "2026-08-26T10:30:00.000Z",
        finishedAt: "2026-08-26T10:45:00.000Z",
        error: { code: "ATTEMPTS_EXHAUSTED", message: "retry budget exhausted" },
      } }),
    }));

    const result = await reconcileTicket(runtime.configured, TICKET);

    assert.equal(result.stateId, "assessment-review");
    assert.equal(result.runnable, true);
    assert.equal(runtime.launcher.requests.length, 0);
    assert.equal(runtime.writer.load!(TICKET)?.value.disposition, "ready");
    assert.equal(runtime.writer.load!(TICKET)?.value.control?.attemptSeries?.consumed, 0);
  });

  await t.test("unrelated ambiguity remains blocking", async (context) => {
    const provider = new FakeProvider();
    provider.snapshot.labels.push("agent-stage:needs-human", "agent-flow:managed");
    provider.recoveryEvidence = recoveryEvidence(provider, [], { complete: false });
    const runtime = await localRuntime(context, provider);
    await runtime.writer(TICKET, null, controlState({
      stateId: "needs-human",
      resumeStateId: "assessment",
      attemptSeries: attemptSeries(),
    }));

    const result = await reconcileTicket(runtime.configured, TICKET);

    assert.equal(result.runnable, false);
    assert.equal(runtime.launcher.requests.length, 0);
    assert.equal(runtime.writer.load!(TICKET)?.value.disposition, "ambiguous");
  });
});

test("reset reassessment isolates a current result when its provider kind is distinct", async (t) => {
  const provider = new FakeProvider();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  const assessment = comment("assessment", `${marker}\nAssessment.`, MAINTAINER, "2026-08-26T10:30:00.000Z");
  const plan = comment("plan", `${marker}\nPlan.`, MAINTAINER, "2026-08-26T11:00:00.000Z");
  const change = changeRequest({
    body: `${marker}\nImplementation.`,
    createdAt: "2026-08-26T11:30:00.000Z",
    updatedAt: "2026-08-26T11:30:00.000Z",
  });
  provider.snapshot.labels.push("agent-stage:development", "agent-flow:managed");
  provider.snapshot.comments.push(assessment, plan);
  provider.snapshot.changeRequest = change;
  provider.recoveryEvidence = recoveryEvidence(provider, [
    ...[assessment, plan].map((published) => ({
      key: publicationKey("comment", published.id),
      createdAt: published.createdAt,
      metadata: { config: SHA, controller: FLOW_1 },
    })),
    {
      key: publicationKey("change-request", String(change.number)),
      createdAt: change.createdAt,
      metadata: { config: SHA, controller: FLOW_1 },
    },
  ], { changes: [change] });
  const runtime = await localRuntime(t, provider);

  const result = await reconcileTicket(runtime.configured, TICKET);

  assert.equal(result.stateId, "development");
  assert.equal(runtime.launcher.requests.length, 1);
  assert.deepEqual(runtime.launcher.requests[0]?.publicationKeys, [
    publicationKey("comment", assessment.id),
    publicationKey("comment", plan.id),
  ]);
});

test("C8 reset reassesses one possible plan but pauses competing iterations", async (t) => {
  for (const includePlan of [false, true]) {
    await t.test(includePlan ? "real plan is present" : "only revised assessment is present", async (context) => {
      const provider = new FakeProvider();
      const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
      const assessment = comment("assessment", `${marker}\nAssessment.`, MAINTAINER, "2026-08-26T10:10:00.000Z");
      const revised = comment(
        "revised-assessment",
        `${marker}\nRevised assessment.`,
        MAINTAINER,
        "2026-08-26T10:50:00.000Z",
      );
      const plan = comment("plan", `${marker}\nPlan.`, MAINTAINER, "2026-08-26T11:30:00.000Z");
      const publications = includePlan ? [assessment, revised, plan] : [assessment, revised];
      provider.snapshot.labels.push("agent-stage:planning", "agent-flow:managed");
      provider.snapshot.comments.push(...publications);
      provider.recoveryEvidence = recoveryEvidence(provider, publications.map((published) => ({
        key: publicationKey("comment", published.id),
        createdAt: published.createdAt,
        metadata: { config: SHA, controller: FLOW_1 },
      })));
      const runtime = await localRuntime(context, provider);

      const result = await reconcileTicket(runtime.configured, TICKET);

      assert.equal(result.runnable, !includePlan);
      assert.equal(runtime.launcher.requests.length, includePlan ? 0 : 1);
      assert.equal(runtime.writer.load!(TICKET)?.value.disposition, includePlan ? "ambiguous" : "ready");
      if (!includePlan) {
        assert.equal(runtime.launcher.requests[0]?.resultContract, "plan");
        assert.ok(!runtime.launcher.requests[0]?.publicationKeys.includes(publicationKey("comment", revised.id)));
      }
      assert.deepEqual(runtime.writer.load!(TICKET)?.value.publicationKeys, publications
        .filter(({ id }) => includePlan || id !== revised.id).map(({ id }) => publicationKey("comment", id)).sort());
    });
  }
});

test("reset baseline excludes publications from an earlier activation", async (t) => {
  const provider = new FakeProvider();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  const old = comment("old-assessment", `${marker}\nOld assessment.`, MAINTAINER, "2026-08-26T10:30:00.000Z");
  provider.snapshot.activation = {
    present: true,
    eventId: "804",
    actor: MAINTAINER,
    occurredAt: "2026-08-26T11:00:00.000Z",
  };
  provider.snapshot.labels.push("agent-stage:assessment", "agent-flow:managed");
  provider.snapshot.comments.push(old);
  provider.recoveryEvidence = recoveryEvidence(provider, [], { activeBoundary: "fresh" });
  const runtime = await localRuntime(t, provider);

  await reconcileTicket(runtime.configured, TICKET);

  assert.equal(runtime.launcher.requests.length, 1);
  assert.deepEqual(runtime.launcher.requests[0]?.publicationKeys, [publicationKey("comment", old.id)]);
});

test("reset pauses when the current publication iteration cannot be isolated", async (t) => {
  const provider = new FakeProvider();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  const publications = ["assessment", "plan-one", "plan-two"].map((id, index) =>
    comment(id, `${marker}\n${id}`, MAINTAINER, `2026-08-26T1${index}:30:00.000Z`));
  provider.snapshot.labels.push("agent-stage:planning", "agent-flow:managed");
  provider.snapshot.comments.push(...publications);
  provider.recoveryEvidence = recoveryEvidence(provider, publications.map((published) => ({
    key: publicationKey("comment", published.id),
    createdAt: published.createdAt,
    metadata: { config: SHA, controller: FLOW_1 },
  })));
  const runtime = await localRuntime(t, provider);

  const result = await reconcileTicket(runtime.configured, TICKET);

  assert.equal(result.runnable, false);
  assert.equal(runtime.launcher.requests.length, 0);
  assert.equal(runtime.writer.load!(TICKET)?.value.disposition, "ambiguous");
});

test("C7 reset reassesses the recorded result before interpreting an existing answer", async (t) => {
  const provider = new FakeProvider();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  const assessment = comment("assessment", `${marker}\nAssessment.`, MAINTAINER, "2026-08-26T10:30:00.000Z");
  const answer = comment("answer", "Approved.", MAINTAINER, "2026-08-26T10:40:00.000Z");
  provider.snapshot.labels.push("agent-stage:assessment-review", "agent-flow:managed");
  provider.snapshot.comments.push(assessment, answer);
  provider.recoveryEvidence = recoveryEvidence(provider, [{
    key: publicationKey("comment", assessment.id),
    createdAt: assessment.createdAt,
    metadata: { config: SHA, controller: FLOW_1 },
  }]);
  const runtime = await localRuntime(t, provider);

  const result = await reconcileTicket(runtime.configured, TICKET);

  assert.equal(result.stateId, "assessment");
  assert.equal(runtime.launcher.requests.length, 1);
  assert.equal(runtime.launcher.requests[0]?.mode, "stage");
  assert.equal(runtime.launcher.requests[0]?.sourceComment, null);
  assert.ok(runtime.launcher.requests[0]?.snapshot.comments.some(({ id }) => id === answer.id));
});

test("C14 an inactive ticket without local work does not create or launch a flow", async () => {
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();
  provider.snapshot.open = false;
  provider.snapshot.labels.push("agent-stage:assessment");
  provider.recoveryEvidence = recoveryEvidence(provider, []);
  const configured = dependencies(provider, launcher);
  configured.controllerId = FLOW_1;

  const outcome = await reconcileTicket(configured, TICKET);

  assert.equal(outcome.runnable, false);
  assert.equal(outcome.started, false);
  assert.equal(provider.created, 0);
  assert.deepEqual(launcher.requests, []);
  assert.equal(provider.events.includes("provider:set-labels"), false);
});

test("an empty store completes a merged change after the provider closes the ticket", async (t) => {
  const provider = new FakeProvider();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  const assessment = comment("assessment", `${marker}\nAssessment.`, MAINTAINER, "2026-08-26T10:10:00.000Z");
  const plan = comment("plan", `${marker}\nPlan.`, MAINTAINER, "2026-08-26T10:20:00.000Z");
  const change = changeRequest({
    body: `${marker}\nImplementation.`,
    state: "merged",
    createdAt: "2026-08-26T10:30:00.000Z",
    updatedAt: "2026-08-26T11:00:00.000Z",
  });
  const review: NormalizedReview = {
    id: "review-1",
    url: "https://github.example.test/reviews/1",
    actor: MAINTAINER,
    submittedAt: "2026-08-26T10:40:00.000Z",
    headSha: OLD_HEAD,
    verdict: "approved",
    body: `${marker}\n<!-- agent-flow-review:v1 head=${OLD_HEAD} verdict=approved -->`,
  };
  provider.snapshot.open = false;
  provider.snapshot.labels.push("agent-stage:awaiting-merge", "agent-flow:managed");
  provider.snapshot.comments.push(assessment, plan);
  provider.snapshot.changeRequest = change;
  provider.recoveryEvidence = recoveryEvidence(provider, [
    ...[assessment, plan].map((published) => ({
      key: publicationKey("comment", published.id),
      createdAt: published.createdAt,
      metadata: { config: SHA, controller: FLOW_1 },
    })),
    {
      key: publicationKey("change-request", String(change.number)),
      createdAt: change.createdAt,
      metadata: { config: SHA, controller: FLOW_1 },
    },
    {
      key: publicationKey("review", review.id),
      createdAt: review.submittedAt,
      metadata: { config: SHA, controller: FLOW_1 },
    },
  ], { changes: [change], reviews: [review] });
  const runtime = await localRuntime(t, provider);

  const result = await reconcileTicket(runtime.configured, TICKET);

  assert.equal(result.stateId, "done");
  assert.equal(result.started, false);
  assert.equal(runtime.writer.load!(TICKET)?.value.control?.stateId, "done");
  assert.equal(provider.snapshot.labels.includes("agent-flow:development"), false);
  assert.ok(provider.snapshot.labels.includes("agent-stage:done"));
});

test("C2 resume does not reset a recovered non-entry stage to the flow initial state", async () => {
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();
  provider.snapshot.labels.push("agent-stage:review");
  provider.recoveryEvidence = recoveryEvidence(provider, []);
  const configured = dependencies(provider, launcher);
  configured.controllerId = FLOW_1;

  const outcome = await reconcileTicket(configured, TICKET);

  assert.equal(outcome.runnable, true);
  assert.equal(outcome.started, false);
  assert.equal(provider.created, 0);
  assert.deepEqual(launcher.requests, []);
  assert.equal(provider.events.includes("provider:set-labels"), false);
});

for (const scenario of [
  { name: "activation removal", patch: { labels: ["bug"], activation: {
    present: false, label: null, eventId: null, actor: null, occurredAt: null,
  } } },
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

test("cancellation has one provider-state owner after the process settles", async () => {
  const provider = new FakeProvider();
  const started = attemptSeries({ current: { attemptId: ATTEMPT, status: "started", startedAt: NOW } });
  installControl(provider, controlState({ attemptSeries: started }));
  provider.snapshot.open = false;
  class OrderedLauncher extends FakeLauncher {
    override async cancel(flowInstanceId: string): Promise<void> {
      provider.events.push("launcher:cancel");
      await super.cancel(flowInstanceId);
    }
  }
  const launcher = new OrderedLauncher();
  launcher.running.add(FLOW_1);

  await reconcileTicket(dependencies(provider, launcher), TICKET);

  const final = parseControlComment(provider.snapshot.comments.find((item) => item.id.startsWith("control-"))!.body)!;
  assert.equal(final.stateId, "cancelled");
  assert.equal(final.sequence, 1);
  assert.equal(final.attemptSeries?.current?.status, "cancelled");
  assert.equal(provider.updated, 1);
  const cancelledAt = provider.events.indexOf("launcher:cancel");
  const updatedAt = provider.events.indexOf("provider:update-control");
  const readBeforeUpdate = provider.events.findIndex((event, index) => index > cancelledAt && event === "provider:read-control");
  assert.ok(cancelledAt < readBeforeUpdate && readBeforeUpdate < updatedAt);
  assert.ok(updatedAt < provider.events.lastIndexOf("provider:read-control"));
});

test("a fresh controller cancels a persisted started attempt without a local process", async () => {
  const provider = new FakeProvider();
  installControl(provider, controlState({ attemptSeries: attemptSeries({
    current: { attemptId: ATTEMPT, status: "started", startedAt: NOW },
  }) }));
  provider.snapshot.open = false;
  const freshLauncher = new FakeLauncher();

  await reconcileTicket(dependencies(provider, freshLauncher), TICKET);

  const final = parseControlComment(provider.snapshot.comments.find((item) => item.id.startsWith("control-"))!.body)!;
  assert.equal(freshLauncher.isRunning(FLOW_1), false);
  assert.deepEqual(freshLauncher.cancelled, [FLOW_1]);
  assert.equal(final.stateId, "cancelled");
  assert.equal(final.attemptSeries?.current?.status, "cancelled");
  assert.equal(final.attemptSeries?.current?.attemptId, ATTEMPT);
});

test("cancellation fails closed if process settlement replaced the control identity", async () => {
  const provider = new FakeProvider();
  installControl(provider, controlState({ attemptSeries: attemptSeries({
    current: { attemptId: ATTEMPT, status: "started", startedAt: NOW },
  }) }));
  provider.snapshot.open = false;
  class ConflictingLauncher extends FakeLauncher {
    override async cancel(flowInstanceId: string): Promise<void> {
      await super.cancel(flowInstanceId);
      const index = provider.snapshot.comments.findIndex((item) => item.id.startsWith("control-"));
      provider.snapshot.comments[index] = controlComment(
        controlState({ flowInstanceId: FLOW_2 }),
        provider.snapshot.comments[index]!.id,
      );
    }
  }

  await assert.rejects(
    reconcileTicket(dependencies(provider, new ConflictingLauncher()), TICKET),
    /readback mismatch after cancellation/,
  );
  assert.equal(provider.updated, 0);
  assert.equal(provider.events.includes("provider:set-labels"), false);
});

test("terminal cancellation does not overwrite a sequence change between reread and CAS", async () => {
  const provider = new FakeProvider();
  installControl(provider, controlState());
  provider.snapshot.open = false;
  const configured = dependencies(provider, new FakeLauncher());
  configured.writeControl = async (_ref, expected) => {
    const index = provider.snapshot.comments.findIndex((item) => item.id.startsWith("control-"));
    const concurrent = parseControlComment(provider.snapshot.comments[index]!.body)!;
    provider.snapshot.comments[index] = controlComment({
      ...concurrent,
      sequence: concurrent.sequence + 1,
      updatedAt: "2026-08-26T12:01:00.000Z",
    }, provider.snapshot.comments[index]!.id);
    if (expected.sequence !== concurrent.sequence + 1) throw new Error("control sequence conflict");
    throw new Error("test expected a sequence conflict");
  };

  await assert.rejects(reconcileTicket(configured, TICKET), /provider control comment update failed/);

  const final = parseControlComment(provider.snapshot.comments.find((item) => item.id.startsWith("control-"))!.body)!;
  assert.equal(final.sequence, 1);
  assert.equal(final.stateId, "assessment");
  assert.ok(provider.snapshot.labels.includes("agent-flow:development"));
});

test("reconciler owns terminal cancellation for an actual running attempt", async () => {
  const provider = new FakeProvider();
  installControl(provider, controlState());
  const runner = createAttemptRunner({
    dataDirectory: "/data",
    provider,
    providerConfig: { apiUrl: PROVIDER_CREDENTIAL.apiUrl, repositories: [TICKET.repository] },
    providerCredential: PROVIDER_CREDENTIAL,
    preparePinnedAgent: async () => ({ bundle: BUNDLE, packageDirectory: "/config/agent-packages/architect" }),
    execution,
    workspaceManager: { async prepareWorkspace() { return {
      baseClone: "/data/repository", worktree: "/data/worktree", repository: TICKET.repository,
      ticketNumber: TICKET.number, flowInstanceId: FLOW_1,
    }; } },
    harnesses: { claude: { target: "claude", async preflight() {}, async run(input) {
      return new Promise((resolve) => input.signal.addEventListener("abort", () => resolve({
        exitCode: null, signal: "SIGTERM", timedOut: false,
      }), { once: true }));
    } } },
    async writeControl(_ref, expected, next) {
      const existing = provider.snapshot.comments.find((item) => item.id.startsWith("control-"))!;
      const parsed = parseControlComment(existing.body)!;
      assert.equal(expected.flowInstanceId, parsed.flowInstanceId);
      assert.equal(expected.sequence, parsed.sequence);
      await provider.updateComment(TICKET, existing.id, renderControlComment(next));
      return parseControlComment((await provider.readComment(TICKET, existing.id)).body)!;
    },
    async createSession(_data, _flow, attemptId) { return {
      root: `/data/${attemptId}`, contextPath: `/data/${attemptId}/context.json`,
      decisionPath: `/data/${attemptId}/decision.json`, logPath: `/data/${attemptId}/harness.log`,
      harnessSessionDirectory: `/data/${attemptId}/harness-session`,
    }; },
    async compileAgent(agentId, _package, target) {
      return { agentId, target, instructions: "test", runtimeDirectory: "/runtime" };
    },
    now: () => NOW,
  });

  await reconcileTicket(dependencies(provider, runner), TICKET);
  assert.equal(runner.isRunning(FLOW_1), true);
  let persisted = parseControlComment(provider.snapshot.comments.find((item) => item.id.startsWith("control-"))!.body)!;
  assert.equal(persisted.attemptSeries?.current?.status, "started");

  provider.snapshot.open = false;
  await reconcileTicket(dependencies(provider, runner), TICKET);

  persisted = parseControlComment(provider.snapshot.comments.find((item) => item.id.startsWith("control-"))!.body)!;
  assert.equal(runner.isRunning(FLOW_1), false);
  assert.equal(persisted.stateId, "cancelled");
  assert.equal(persisted.attemptSeries?.current?.status, "cancelled");
});

test("terminal cancellation overrides an in-flight success from the same attempt", async () => {
  const provider = new FakeProvider();
  installControl(provider, controlState());
  const harnessResult = deferred<{ exitCode: number; signal: null; timedOut: false }>();
  const successCasStarted = deferred<void>();
  const releaseSuccessCas = deferred<void>();
  const abortObserved = deferred<void>();
  const runner = createAttemptRunner({
    dataDirectory: "/data", provider,
    providerConfig: { apiUrl: PROVIDER_CREDENTIAL.apiUrl, repositories: [TICKET.repository] },
    providerCredential: PROVIDER_CREDENTIAL,
    preparePinnedAgent: async () => ({ bundle: BUNDLE, packageDirectory: "/config/agent-packages/architect" }),
    execution,
    workspaceManager: { async prepareWorkspace() { return {
      baseClone: "/data/repository", worktree: "/data/worktree", repository: TICKET.repository,
      ticketNumber: TICKET.number, flowInstanceId: FLOW_1,
    }; } },
    harnesses: { claude: { target: "claude", async preflight() {}, async run(input) {
      input.signal.addEventListener("abort", () => abortObserved.resolve(), { once: true });
      return harnessResult.promise;
    } } },
    async writeControl(ref, expected, next) {
      const existing = provider.snapshot.comments.find((item) => item.id.startsWith("control-"))!;
      const parsed = parseControlComment(existing.body)!;
      assert.equal(expected.sequence, parsed.sequence);
      if (next.attemptSeries?.current?.status === "succeeded") {
        successCasStarted.resolve();
        await releaseSuccessCas.promise;
      }
      await provider.updateComment(ref, existing.id, renderControlComment(next));
      return parseControlComment((await provider.readComment(ref, existing.id)).body)!;
    },
    async createSession(_data, _flow, attemptId) { return {
      root: `/data/${attemptId}`, contextPath: `/data/${attemptId}/context.json`,
      decisionPath: `/data/${attemptId}/decision.json`, logPath: `/data/${attemptId}/harness.log`,
      harnessSessionDirectory: `/data/${attemptId}/harness-session`,
    }; },
    async compileAgent(agentId, _package, target) {
      return { agentId, target, instructions: "test", runtimeDirectory: "/runtime" };
    },
    async verifyDecision(_path, expected) { return {
      apiVersion: "agent-flow/v1alpha1", kind: "AgentReceipt", flowInstanceId: FLOW_1,
      attemptId: expected.attemptId, outcome: "succeeded", summary: "late success",
      artifacts: [{ kind: "change-request", number: 31,
        url: "https://github.example.test/example-owner/example-repository/pull/31",
        headSha: OLD_HEAD, state: "open" }],
    }; },
    now: () => NOW,
  });

  await reconcileTicket(dependencies(provider, runner), TICKET);
  harnessResult.resolve({ exitCode: 0, signal: null, timedOut: false });
  await successCasStarted.promise;
  provider.snapshot.open = false;
  const cancelling = reconcileTicket(dependencies(provider, runner), TICKET);
  await abortObserved.promise;
  releaseSuccessCas.resolve();
  await cancelling;

  const final = parseControlComment(provider.snapshot.comments.find((item) => item.id.startsWith("control-"))!.body)!;
  assert.equal(final.stateId, "cancelled");
  assert.equal(final.attemptSeries?.current?.status, "cancelled");
  assert.equal(final.latestReceipt, null);
  assert.equal(final.humanGate, null);
  assert.equal(final.changeRequest, null);
});

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
    label: "agent-flow:development",
    eventId: "804",
    actor: MAINTAINER,
    occurredAt: "2026-08-26T10:00:00.000Z",
  };

  await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(provider.created, 1);
  assert.equal(provider.updated, 0);
  assert.equal(provider.snapshot.comments.length, 2);
  assert.equal(parseControlComment(provider.snapshot.comments[0]!.body)?.flowInstanceId, FLOW_1);
  assert.equal(parseControlComment(provider.snapshot.comments[1]!.body)?.flowInstanceId, FLOW_2);
  assert.equal(launcher.requests[0]?.control.flowInstanceId, FLOW_2);
});

test("finishes crash-window cleanup instead of reactivating the original label event", async () => {
  const provider = new FakeProvider();
  const launcher = new FakeLauncher();
  const terminal = controlState({ stateId: "done", updatedAt: NOW });
  installControl(provider, terminal);
  provider.snapshot.activation = {
    present: true,
    label: "agent-flow:development",
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

test("keeps terminal history independent from unavailable pinned revisions", async (t) => {
  await t.test("terminal control", async () => {
    const provider = new FakeProvider();
    provider.snapshot.activation = { present: false, eventId: null, actor: null, occurredAt: null };
    installControl(provider, controlState({ configRevision: OLD_SHA, stateId: "done" }));
    const current = structuredClone(BUNDLE);
    current.flow.spec.states.done = { kind: "paused" };
    const deps = dependencies(provider);
    deps.config.loadCurrent = async () => current;
    deps.config.loadPinned = async () => { throw new Error("old revision unavailable"); };

    const outcome = await reconcileTicket(deps, TICKET);

    assert.deepEqual(outcome, {
      flowInstanceId: FLOW_1,
      stateId: "done",
      configRevision: OLD_SHA,
      stateKind: "final",
      repositoryUrl: "https://github.example.test/example-owner/example-repository",
      ticketUrl: "https://github.example.test/example-owner/example-repository/issues/17",
      actionUrl: "https://github.example.test/example-owner/example-repository/issues/17",
      changed: false,
      started: false,
      runnable: true,
    });
  });

  await t.test("unfinished control", async () => {
    const provider = new FakeProvider();
    installControl(provider, controlState({ configRevision: OLD_SHA }));
    const deps = dependencies(provider);
    deps.config.loadPinned = async () => { throw new Error("old revision unavailable"); };

    await assert.rejects(reconcileTicket(deps, TICKET), /pinned configuration load failed/);
  });
});

test("cleans a terminal pinned activation after its route is removed from current configuration", async () => {
  const provider = new FakeProvider();
  provider.snapshot.labels = ["bugfix", "bug"];
  provider.snapshot.activation = { present: false, label: null, eventId: null, actor: null, occurredAt: null };
  installControl(provider, controlState({ stateId: "done", configRevision: OLD_SHA, activationLabel: "bugfix" }));
  const deps = dependencies(provider);
  const current = structuredClone(BUNDLE);
  delete current.flow.spec.activationRoutes;
  deps.config.loadCurrent = async () => current;
  deps.config.loadPinned = async () => { throw new Error("old revision unavailable"); };

  assert.equal((await reconcileTicket(deps, TICKET)).stateId, "done");
  assert.deepEqual(provider.snapshot.labels.toSorted(), ["agent-flow:managed", "agent-stage:done", "bug"]);
});

test("repairs the permanent managed label for terminal history", async () => {
  const provider = new FakeProvider();
  provider.snapshot.activation = { present: false, label: null, eventId: null, actor: null, occurredAt: null };
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

for (const stateId of ["awaiting-merge", "bug-awaiting-merge"]) {
  test(`uses the shared waiting label for ${stateId}`, async () => {
    const provider = new FakeProvider();
    installControl(provider, controlState({ stateId, changeRequest: controlChange() }));
    provider.snapshot.changeRequest = changeRequest();

    await reconcileTicket(dependencies(provider), TICKET);

    assert.deepEqual(
      provider.snapshot.labels.filter((label) => label.startsWith("agent-stage:")),
      ["agent-stage:awaiting-merge"],
    );
  });
}

test("returns bugfix work to bug review when the waiting PR head changes", async () => {
  const provider = new FakeProvider();
  installControl(provider, controlState({
    stateId: "bug-awaiting-merge",
    activationLabel: "bugfix",
    changeRequest: controlChange(),
  }));
  provider.snapshot.labels = ["bugfix", "agent-flow:managed", "agent-stage:awaiting-merge"];
  provider.snapshot.changeRequest = changeRequest({ headSha: NEW_HEAD });
  const launcher = new FakeLauncher();

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.deepEqual({
    stateId: outcome.stateId,
    labels: provider.snapshot.labels.filter((label) => label.startsWith("agent-stage:")),
    agentId: launcher.requests[0]?.agentId,
  }, {
    stateId: "bug-review",
    labels: ["agent-stage:bug-review"],
    agentId: "reviewer",
  });
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
    await assertRunnerAccepts(request, provider);
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
    const paused = await reconcileTicket(dependencies(provider, launcher), TICKET);
    const updated = parseControlComment(provider.snapshot.comments[index]!.body)!;
    assert.equal(paused.changed, true);
    assert.equal(updated.stateId, "needs-human");
    assert.equal(updated.resumeStateId, "review");
    assert.equal(launcher.requests.length, 1);

    const updates = provider.updated;
    const repeated = await reconcileTicket(dependencies(provider, launcher), TICKET);
    const settled = parseControlComment(provider.snapshot.comments[index]!.body)!;
    assert.equal(repeated.changed, false);
    assert.equal(provider.updated, updates);
    assert.equal(settled.resumeStateId, "review");
    assert.deepEqual(settled.latestReceipt, questionReceipt());
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

  await t.test("verification head change", async () => {
    const provider = new FakeProvider();
    installControl(provider, controlState({
      stateId: "bug-verification",
      activationLabel: "bugfix",
      changeRequest: controlChange(),
    }));
    provider.snapshot.labels = ["bugfix", "agent-flow:managed", "agent-stage:bug-verification"];
    provider.snapshot.changeRequest = changeRequest({ headSha: NEW_HEAD });
    const launcher = new FakeLauncher();

    const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

    assert.equal(outcome.stateId, "bug-review");
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

test("derives the event selected by each controller-built receipt", () => {
  const sourceId = "human-source";
  const cases: Array<{ state: ControlState; snapshot?: ProviderTicketSnapshot; event: string }> = [
    {
      state: controlState({ attemptSeries: attemptSeries(), latestReceipt: assessmentReceipt() }),
      event: "agent-succeeded",
    },
    {
      state: controlState({
        stateId: "assessment-review",
        attemptSeries: attemptSeries({ stateId: "assessment-review" }),
        latestReceipt: humanReceipt("changes-requested", sourceId),
      }),
      event: "human-changes-requested",
    },
    ...([
      ["approved", "human-answer-accepted"],
      ["cancelled", "human-answer-cancelled"],
      ["unclear", "human-answer-unclear"],
    ] as const).map(([verdict, event]) => ({
      state: controlState({
        stateId: "needs-human",
        resumeStateId: "review",
        attemptSeries: attemptSeries({ agentId: "reviewer", stateId: "needs-human" }),
        latestReceipt: humanReceipt(verdict, sourceId),
      }),
      event,
    })),
    ...([
      ["approved", "review-approved"],
      ["changes-requested", "review-changes-requested"],
    ] as const).map(([verdict, event]) => ({
      state: controlState({
        stateId: "review",
        attemptSeries: attemptSeries({ agentId: "reviewer", stateId: "review" }),
        latestReceipt: reviewReceipt(verdict),
      }),
      snapshot: snapshot({ changeRequest: changeRequest() }),
      event,
    })),
    {
      state: controlState({
        stateId: "needs-human",
        resumeStateId: "review",
        attemptSeries: attemptSeries({ agentId: "reviewer", stateId: "needs-human" }),
        latestReceipt: questionReceipt(),
      }),
      event: "agent-needs-human",
    },
  ];

  for (const item of cases) {
    assert.equal(deriveEvent(item.snapshot ?? snapshot(), item.state, BUNDLE.flow)?.type, item.event);
  }
});

test("C6 needs-human question stays paused until a later authorized comment", async () => {
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

  const updates = provider.updated;
  const repeated = await reconcileTicket(dependencies(provider, launcher), TICKET);
  const settledBody = provider.snapshot.comments.find((candidate) => candidate.id.startsWith("control-"))!.body;
  assert.equal(repeated.changed, false);
  assert.equal(provider.updated, updates);
  assert.equal(parseControlComment(settledBody)?.resumeStateId, "review");
  assert.deepEqual(launcher.requests, []);

  const later = comment("later-answer", "Reopen it.", MAINTAINER, "2026-08-26T12:04:00.000Z");
  provider.snapshot.comments.push(later);
  await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(launcher.requests.length, 1);
  assert.equal(launcher.requests[0]?.mode, "human-input");
  assert.equal(launcher.requests[0]?.sourceComment?.id, later.id);
  await assertRunnerAccepts(launcher.requests[0]!, provider);
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

test("human cancellation reaches terminal cancelled from both review gates without relaunching", async (t) => {
  for (const [stateId, agentId] of [
    ["assessment-review", "architect"],
    ["plan-review", "planner"],
  ] as const) {
    await t.test(stateId, async () => {
      const provider = new FakeProvider();
      const source = comment("cancel-answer", "Cancel this flow.", MAINTAINER, "2026-08-26T12:02:00.000Z");
      installControl(provider, controlState({
        stateId,
        attemptSeries: attemptSeries({ agentId, stateId }),
        latestReceipt: humanReceipt("cancelled", source.id),
        humanGate: {
          sourceCommentId: source.id,
          actor: source.actor,
          verdict: "cancelled",
          interpretedByAttemptId: ATTEMPT,
          notes: [],
        },
      }));
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
  }
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

test("C18/C19 selects human input only from later unmarked authorized comments", async () => {
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
    comment(
      "agent",
      `Narrative text.\n<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_2}"} -->`,
      MAINTAINER,
      "2026-08-26T10:42:00.000Z",
    ),
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
  await assertRunnerAccepts(launcher.requests[0]!, provider);
});

test("consumes question and unclear receipts at a review gate", async (t) => {
  for (const stateId of ["assessment-review", "plan-review"] as const) {
    for (const verdict of ["question", "unclear"] as const) {
      await t.test(`${stateId}: ${verdict}`, async () => {
        const provider = new FakeProvider();
        const source = comment("answer", "Maybe.", MAINTAINER, "2026-08-26T10:43:00.000Z");
        const gate: ControlHumanGate = {
          sourceCommentId: source.id,
          actor: source.actor,
          verdict,
          interpretedByAttemptId: ATTEMPT,
          notes: ["Clarification needed."],
        };
        const control = controlState({
          stateId,
          attemptSeries: attemptSeries({ stateId, inputRevision: source.id }),
          latestReceipt: humanReceipt(verdict, source.id),
          humanGate: gate,
        });
        installControl(provider, control);
        provider.snapshot.comments.push(source);
        const launcher = new FakeLauncher();

        const first = await reconcileTicket(dependencies(provider, launcher), TICKET);
        const second = await reconcileTicket(dependencies(provider, launcher), TICKET);

        assert.equal(first.stateId, stateId);
        assert.equal(second.changed, false);
        assert.equal(provider.updated, 1);
        const stored = provider.snapshot.comments.find((candidate) => candidate.id.startsWith("control-"))!.body;
        assert.equal(parseControlComment(stored)?.latestReceipt?.humanGate?.verdict, verdict);
        assert.deepEqual(launcher.requests, []);
      });
    }
  }
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

test("unblocks a pinned bugfix flow when the current adapter no longer recognizes its label", async () => {
  const provider = new FakeProvider();
  provider.snapshot.labels = ["bugfix"];
  provider.snapshot.activation = { present: false, label: null, eventId: null, actor: null, occurredAt: null };
  installControl(provider, controlState({
    stateId: "blocked", resumeStateId: "bug-development", activationLabel: "bugfix",
  }));
  provider.snapshot.comments.push(comment("reset", "Retry.", MAINTAINER, "2026-08-26T10:46:00.000Z"));
  const launcher = new FakeLauncher();

  const result = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(result.stateId, "bug-development");
  assert.equal(launcher.requests[0]?.agentId, "bugfixer");
  assert.equal(launcher.requests[0]?.snapshot.activation.label, "bugfix");
});

test("routes a moved verification head back through review when unblocked", async () => {
  const provider = new FakeProvider();
  installControl(provider, controlState({
    stateId: "blocked",
    resumeStateId: "bug-verification",
    activationLabel: "bugfix",
    attemptSeries: attemptSeries({ agentId: "bug-investigator", stateId: "bug-verification" }),
    changeRequest: controlChange(),
  }));
  provider.snapshot.labels = ["bugfix"];
  provider.snapshot.changeRequest = changeRequest({ headSha: NEW_HEAD });
  provider.snapshot.comments.push(comment(
    "unblock",
    "Retry after the head update.",
    MAINTAINER,
    "2026-08-26T12:02:00.000Z",
  ));
  const launcher = new FakeLauncher();

  const outcome = await reconcileTicket(dependencies(provider, launcher), TICKET);

  assert.equal(outcome.stateId, "bug-review");
  assert.equal(launcher.requests[0]?.agentId, "reviewer");
  assert.equal(launcher.requests[0]?.control.changeRequest?.headSha, NEW_HEAD);
});

test("reviews a moved verification head after an accepted human answer", async () => {
  for (const headSha of [OLD_HEAD, NEW_HEAD]) {
    const provider = new FakeProvider();
    installControl(provider, controlState({
      stateId: "needs-human", resumeStateId: "bug-verification", activationLabel: "bugfix",
      attemptSeries: attemptSeries({ agentId: "bug-investigator", stateId: "needs-human" }),
      latestReceipt: humanReceipt("approved", "answer"), changeRequest: controlChange(),
    }));
    provider.snapshot.labels = ["bugfix"];
    provider.snapshot.changeRequest = changeRequest({ headSha });
    const launcher = new FakeLauncher();
    const result = await reconcileTicket(dependencies(provider, launcher), TICKET);
    assert.equal(result.stateId, headSha === NEW_HEAD ? "bug-review" : "bug-verification");
    assert.equal(launcher.requests[0]?.agentId, headSha === NEW_HEAD ? "reviewer" : "bug-investigator");
  }
});

test("preserves the reviewed head through clarification before resuming verification", async () => {
  for (const verdict of ["unclear", "question"] as const) {
    const provider = new FakeProvider();
    installControl(provider, controlState({
      stateId: "needs-human", resumeStateId: "bug-verification", activationLabel: "bugfix",
      attemptSeries: attemptSeries({ agentId: "bug-investigator", stateId: "needs-human" }),
      latestReceipt: humanReceipt(verdict, "answer1"), changeRequest: controlChange(),
    }));
    provider.snapshot.labels = ["bugfix"];
    provider.snapshot.changeRequest = changeRequest({ headSha: NEW_HEAD });
    const launcher = new FakeLauncher();
    const deps = dependencies(provider, launcher);
    await reconcileTicket(deps, TICKET);
    const stored = provider.snapshot.comments.find((comment) => parseControlComment(comment.body))!;
    const paused = parseControlComment(stored.body)!;
    assert.equal(paused.changeRequest?.headSha, OLD_HEAD);
    stored.body = renderControlComment({
      ...paused,
      attemptSeries: attemptSeries({ agentId: "bug-investigator", stateId: "needs-human" }),
      latestReceipt: humanReceipt("approved", "answer2"),
    });
    const result = await reconcileTicket(deps, TICKET);
    assert.equal(result.stateId, "bug-review");
    assert.equal(launcher.requests.at(-1)?.agentId, "reviewer");
  }
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

  for (const [field, value] of [
    ["title", "Fix the other edge case"],
    ["description", "Handle the revised scope."],
  ] as const) {
    await t.test(`new ticket ${field}`, async () => {
      const baselineProvider = new FakeProvider();
      const baselineLauncher = new FakeLauncher();
      await reconcileTicket(dependencies(baselineProvider, baselineLauncher), TICKET);
      const baseline = baselineLauncher.requests[0]!.inputRevision;

      const changedProvider = new FakeProvider();
      installControl(changedProvider, controlState({
        attemptSeries: attemptSeries({ inputRevision: baseline }),
      }));
      changedProvider.snapshot[field] = value;
      const changedLauncher = new FakeLauncher();
      await reconcileTicket(dependencies(changedProvider, changedLauncher), TICKET);

      assert.equal(changedLauncher.requests.length, 1);
      assert.notEqual(changedLauncher.requests[0]!.inputRevision, baseline);
    });
  }

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

    assert.equal(secondLauncher.requests.length, 1);
    assert.equal(secondLauncher.requests[0]!.inputRevision, request.inputRevision);
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

    assert.equal(secondLauncher.requests.length, 1);
    assert.equal(secondLauncher.requests[0]!.inputRevision, request.inputRevision);
    const unchanged = parseControlComment(provider.snapshot.comments[index]!.body)!;
    assert.equal(unchanged.attemptSeries?.inputRevision, request.inputRevision);
  });
});

test("a verified merge completes recovered merge-wait work despite an obsolete negative review", async (t) => {
  const provider = new FakeProvider();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  const assessment = comment("assessment", `${marker}\nAssessment.`, MAINTAINER, "2026-08-26T10:10:00.000Z");
  const plan = comment("plan", `${marker}\nPlan.`, MAINTAINER, "2026-08-26T10:20:00.000Z");
  const change = changeRequest({
    body: `${marker}\nImplementation.`,
    state: "merged",
    createdAt: "2026-08-26T10:30:00.000Z",
    updatedAt: "2026-08-26T11:00:00.000Z",
  });
  const review: NormalizedReview = {
    id: "review-1",
    url: "https://github.example.test/reviews/1",
    actor: MAINTAINER,
    submittedAt: "2026-08-26T10:40:00.000Z",
    headSha: NEW_HEAD,
    verdict: "changes-requested",
    body: `${marker}\n<!-- agent-flow-review:v1 head=${NEW_HEAD} verdict=changes-requested -->`,
  };
  provider.snapshot.open = false;
  provider.snapshot.labels.push("agent-stage:awaiting-merge", "agent-flow:managed");
  provider.snapshot.comments.push(assessment, plan);
  provider.snapshot.changeRequest = change;
  provider.recoveryEvidence = recoveryEvidence(provider, [
    ...[assessment, plan].map((published) => ({
      key: publicationKey("comment", published.id),
      createdAt: published.createdAt,
      metadata: { config: SHA, controller: FLOW_1 },
    })),
    {
      key: publicationKey("change-request", String(change.number)),
      createdAt: change.createdAt,
      metadata: { config: SHA, controller: FLOW_1 },
    },
    {
      key: publicationKey("review", review.id),
      createdAt: review.submittedAt,
      metadata: { config: SHA, controller: FLOW_1 },
    },
  ], { changes: [change], reviews: [review] });
  const runtime = await localRuntime(t, provider);

  const result = await reconcileTicket(runtime.configured, TICKET);

  assert.equal(result.stateId, "done");
  assert.equal(result.started, false);
  assert.equal(runtime.launcher.requests.length, 0);
  assert.equal(runtime.writer.load!(TICKET)?.value.control?.stateId, "done");
  assert.equal(provider.snapshot.labels.includes("agent-flow:development"), false);
  assert.ok(provider.snapshot.labels.includes("agent-stage:done"));
});

test("empty-store recovery returns an open change with a stale review to review", async (t) => {
  const provider = new FakeProvider();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  const assessment = comment("assessment", `${marker}\nAssessment.`, MAINTAINER, "2026-08-26T10:10:00.000Z");
  const plan = comment("plan", `${marker}\nPlan.`, MAINTAINER, "2026-08-26T10:20:00.000Z");
  const change = changeRequest({
    body: `${marker}\nImplementation.`,
    state: "open",
    createdAt: "2026-08-26T10:30:00.000Z",
    updatedAt: "2026-08-26T11:00:00.000Z",
  });
  const review: NormalizedReview = {
    id: "review-1",
    url: "https://github.example.test/reviews/1",
    actor: MAINTAINER,
    submittedAt: "2026-08-26T10:40:00.000Z",
    headSha: NEW_HEAD,
    verdict: "changes-requested",
    body: `${marker}\n<!-- agent-flow-review:v1 head=${NEW_HEAD} verdict=changes-requested -->`,
  };
  provider.snapshot.open = true;
  provider.snapshot.labels.push("agent-stage:awaiting-merge", "agent-flow:managed");
  provider.snapshot.comments.push(assessment, plan);
  provider.snapshot.changeRequest = change;
  provider.recoveryEvidence = recoveryEvidence(provider, [
    ...[assessment, plan].map((published) => ({
      key: publicationKey("comment", published.id),
      createdAt: published.createdAt,
      metadata: { config: SHA, controller: FLOW_1 },
    })),
    {
      key: publicationKey("change-request", String(change.number)),
      createdAt: change.createdAt,
      metadata: { config: SHA, controller: FLOW_1 },
    },
    {
      key: publicationKey("review", review.id),
      createdAt: review.submittedAt,
      metadata: { config: SHA, controller: FLOW_1 },
    },
  ], { changes: [change], reviews: [review] });
  const runtime = await localRuntime(t, provider);

  const result = await reconcileTicket(runtime.configured, TICKET);

  assert.equal(result.stateId, "review");
  assert.equal(result.started, true);
  assert.equal(runtime.launcher.requests[0]?.agentId, "reviewer");
  assert.ok(runtime.launcher.requests[0]?.publicationKeys.includes(publicationKey("review", review.id)));
  assert.equal(provider.snapshot.labels.includes("agent-flow:development"), true);
});

test("empty-store bugfix recovery resolves the shared merge-wait label through its pinned activation route", async (t) => {
  const provider = new FakeProvider();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  const change = changeRequest({ body: `${marker}\nBug fix.`, state: "merged", createdAt: "2026-08-26T10:30:00.000Z" });
  provider.snapshot.labels = ["bugfix", "agent-flow:managed", "agent-stage:awaiting-merge"];
  provider.snapshot.activation.label = "bugfix";
  provider.snapshot.open = false;
  provider.snapshot.changeRequest = change;
  provider.recoveryEvidence = recoveryEvidence(provider, [{
    key: publicationKey("change-request", String(change.number)), createdAt: change.createdAt,
    metadata: { config: SHA, controller: FLOW_1 },
  }], { changes: [change] });
  const runtime = await localRuntime(t, provider);

  const result = await reconcileTicket(runtime.configured, TICKET);

  assert.equal(result.stateId, "done");
  assert.equal(runtime.writer.load!(TICKET)?.value.control?.activationLabel, "bugfix");
  assert.equal(runtime.launcher.requests.length, 0);
  assert.deepEqual(provider.snapshot.labels, ["agent-flow:managed", "agent-stage:done"]);
  assert.equal(provider.created, 0);
  assert.equal(provider.updated, 0);
});

test("an empty store cannot infer merge-wait from an unrelated recorded stage", async (t) => {
  const provider = new FakeProvider();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  const change = changeRequest({ body: `${marker}\nImplementation.`, state: "merged", createdAt: "2026-08-26T10:30:00.000Z" });
  provider.snapshot.labels.push("agent-stage:planning");
  provider.snapshot.changeRequest = change;
  provider.recoveryEvidence = recoveryEvidence(provider, [{
    key: publicationKey("change-request", String(change.number)), createdAt: change.createdAt,
    metadata: { config: SHA, controller: FLOW_1 },
  }], { changes: [change] });
  const runtime = await localRuntime(t, provider);
  const result = await reconcileTicket(runtime.configured, TICKET);
  assert.notEqual(result.stateId, "done");
  assert.equal(runtime.writer.load!(TICKET)?.value.disposition, "ambiguous");
  assert.equal(provider.snapshot.labels.includes("agent-flow:development"), true);
  assert.equal(runtime.launcher.requests.length, 0);
});

test("unavailable winning configuration pauses only its ticket with a visible recovery reason", async (t) => {
  const provider = new FakeProvider();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  const resultComment = comment("assessment", `${marker}\nAssessment.`);
  provider.snapshot.labels.push("agent-stage:assessment");
  provider.snapshot.comments.push(resultComment);
  provider.recoveryEvidence = recoveryEvidence(provider, [{
    key: publicationKey("comment", resultComment.id), createdAt: resultComment.createdAt,
    metadata: { config: SHA, controller: FLOW_1 },
  }]);
  const runtime = await localRuntime(t, provider);
  runtime.configured.config.loadPinned = async () => { throw new Error("secret/path/token"); };
  const result = await reconcileTicket(runtime.configured, TICKET);
  assert.equal(result.recoveryDisposition, "ambiguous");
  assert.equal(result.recoveryReason, "Pinned configuration is unavailable. Restore access to the published configuration commit.");
  assert.equal(result.started, false);
  assert.equal(runtime.launcher.requests.length, 0);
  assert.equal(provider.created, 0);
  assert.equal(provider.updated, 0);
});


test("C2/C7 reassesses a plan before its human gate and retains the existing answer after readback", async (t) => {
  const provider = new FakeProvider();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  const assessment = comment("assessment", `${marker}\nAssessment.`, MAINTAINER, "2026-08-26T10:10:00.000Z");
  const plan = comment("plan", `${marker}\nComplete plan.`, MAINTAINER, "2026-08-26T10:20:00.000Z");
  const answer = comment("approved-plan", "Approved.", MAINTAINER, "2026-08-26T10:25:00.000Z");
  provider.snapshot.labels.push("agent-stage:plan-review", "agent-flow:managed");
  provider.snapshot.comments.push(assessment, plan, answer);
  provider.recoveryEvidence = recoveryEvidence(provider, [assessment, plan].map((published) => ({
    key: publicationKey("comment", published.id), createdAt: published.createdAt,
    metadata: { config: SHA, controller: FLOW_1 },
  })));
  const runtime = await localRuntime(t, provider);

  const reassessed = await reconcileTicket(runtime.configured, TICKET);

  assert.equal(reassessed.stateId, "planning");
  const request = runtime.launcher.requests[0]!;
  assert.equal(request.resultContract, "plan");
  assert.equal(request.mode, "stage");
  assert.ok(!request.publicationKeys.includes(publicationKey("comment", plan.id)));
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-reassess-decision-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "decision.json");
  await writeFile(path, JSON.stringify({ event: "agent-succeeded" }));
  const receipt = await readDecisionAndBuildReceipt(path, {
    flow: request.bundle.flow, stateId: request.stateId, mode: request.mode,
    resultContract: request.resultContract, flowInstanceId: request.control.flowInstanceId,
    attemptId: ATTEMPT, configRevision: SHA, controllerId: FLOW_1,
    publicationKeys: request.publicationKeys, ticket: TICKET,
    pinnedChangeRequest: null, sourceComment: null,
  }, provider, false);
  assert.equal(receipt.artifacts[0]?.kind === "comment" && receipt.artifacts[0].id, plan.id);
  const before = runtime.writer.load!(TICKET)!.value.control!;
  await runtime.writer(TICKET, before, { ...before, sequence: before.sequence + 1,
    updatedAt: NOW, latestReceipt: receipt,
    attemptSeries: attemptSeries({ stateId: "planning", agentId: "planner" }),
  });
  runtime.launcher.running.clear();
  const gate = await reconcileTicket(runtime.configured, TICKET);
  assert.equal(gate.stateId, "plan-review");
  assert.equal(runtime.launcher.requests.at(-1)?.mode, "human-input");
  assert.equal(runtime.launcher.requests.at(-1)?.sourceComment?.id, answer.id);
  assert.deepEqual(provider.snapshot.comments.map(({ id }) => id), [assessment.id, plan.id, answer.id]);
  assert.equal(provider.created, 0);
  assert.equal(provider.updated, 0);
});

test("a marked question at plan-review is reassessed without treating an approval as plan completion", async (t) => {
  const provider = new FakeProvider();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  const assessment = comment("assessment", `${marker}\nAssessment.`, MAINTAINER, "2026-08-26T10:10:00.000Z");
  const plan = comment("plan", `${marker}\nWhich design should the plan use?`, MAINTAINER, "2026-08-26T10:20:00.000Z");
  const answer = comment("approved-plan", "Approved.", MAINTAINER, "2026-08-26T10:25:00.000Z");
  provider.snapshot.labels.push("agent-stage:plan-review", "agent-flow:managed");
  provider.snapshot.comments.push(assessment, plan, answer);
  provider.recoveryEvidence = recoveryEvidence(provider, [assessment, plan].map((published) => ({
    key: publicationKey("comment", published.id), createdAt: published.createdAt,
    metadata: { config: SHA, controller: FLOW_1 },
  })));
  const runtime = await localRuntime(t, provider);

  const reassessed = await reconcileTicket(runtime.configured, TICKET);

  assert.equal(reassessed.stateId, "planning");
  const request = runtime.launcher.requests[0]!;
  assert.equal(request.resultContract, "plan");
  assert.equal(request.mode, "stage");
  assert.ok(!request.publicationKeys.includes(publicationKey("comment", plan.id)));
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-reassess-decision-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "decision.json");
  await writeFile(path, JSON.stringify({ event: "agent-needs-human" }));
  const receipt = await readDecisionAndBuildReceipt(path, {
    flow: request.bundle.flow, stateId: request.stateId, mode: request.mode,
    resultContract: request.resultContract, flowInstanceId: request.control.flowInstanceId,
    attemptId: ATTEMPT, configRevision: SHA, controllerId: FLOW_1,
    publicationKeys: request.publicationKeys, ticket: TICKET,
    pinnedChangeRequest: null, sourceComment: null,
  }, provider, false);
  assert.equal(receipt.artifacts[0]?.kind === "comment" && receipt.artifacts[0].id, plan.id);
  const before = runtime.writer.load!(TICKET)!.value.control!;
  await runtime.writer(TICKET, before, { ...before, sequence: before.sequence + 1,
    updatedAt: NOW, latestReceipt: receipt,
    attemptSeries: attemptSeries({ stateId: "planning", agentId: "planner" }),
  });
  runtime.launcher.running.clear();
  const gate = await reconcileTicket(runtime.configured, TICKET);
  assert.equal(gate.stateId, "needs-human");
  assert.equal(runtime.writer.load!(TICKET)?.value.control?.resumeStateId, "planning");
  assert.notEqual(gate.stateId, "development");
  assert.equal(runtime.launcher.requests.at(-1)?.resultContract, "human-gate");
  assert.equal(runtime.launcher.requests.at(-1)?.sourceComment?.id, answer.id);
  assert.deepEqual(provider.snapshot.comments.map(({ id }) => id), [assessment.id, plan.id, answer.id]);
  assert.equal(provider.created, 0);
  assert.equal(provider.updated, 0);
});

test("local recovery preserves a pinned bugfix activation when startup routes omit its label", async (t) => {
  const provider = new FakeProvider();
  provider.snapshot.labels = ["bugfix", "agent-flow:managed", "agent-stage:bug-development"];
  provider.snapshot.activation = { present: false, label: null, eventId: null, actor: null, occurredAt: null };
  provider.recoveryEvidence = recoveryEvidence(provider, []);
  const runtime = await localRuntime(t, provider);
  await runtime.writer(TICKET, null, controlState({ stateId: "bug-development", activationLabel: "bugfix" }));

  const result = await reconcileTicket(runtime.configured, TICKET);

  assert.equal(result.stateId, "bug-development");
  assert.equal(result.started, true);
  assert.equal(runtime.launcher.requests[0]?.agentId, "bugfixer");
  assert.equal(runtime.launcher.requests[0]?.snapshot.activation.present, true);
  assert.ok(provider.snapshot.labels.includes("bugfix"));
  assert.equal(runtime.launcher.cancelled.length, 0);
});

test("C3 planning reassesses an existing plan beside its earlier assessment without republishing", async (t) => {
  const provider = new FakeProvider();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  const assessment = comment("assessment", `${marker}\nAssessment.`, MAINTAINER, "2026-08-26T10:10:00.000Z");
  const plan = comment("plan", `${marker}\nComplete plan.`, MAINTAINER, "2026-08-26T10:20:00.000Z");
  const answer = comment("approved-plan", "Approved.", MAINTAINER, "2026-08-26T10:25:00.000Z");
  provider.snapshot.labels.push("agent-stage:planning", "agent-flow:managed");
  provider.snapshot.comments.push(assessment, plan, answer);
  provider.recoveryEvidence = recoveryEvidence(provider, [assessment, plan].map((published) => ({
    key: publicationKey("comment", published.id), createdAt: published.createdAt,
    metadata: { config: SHA, controller: FLOW_1 },
  })));
  const runtime = await localRuntime(t, provider);

  const reassessed = await reconcileTicket(runtime.configured, TICKET);

  assert.equal(reassessed.stateId, "planning");
  const request = runtime.launcher.requests[0]!;
  assert.equal(request.resultContract, "plan");
  assert.equal(request.mode, "stage");
  assert.ok(!request.publicationKeys.includes(publicationKey("comment", plan.id)));
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-reassess-decision-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "decision.json");
  await writeFile(path, JSON.stringify({ event: "agent-succeeded" }));
  const receipt = await readDecisionAndBuildReceipt(path, {
    flow: request.bundle.flow, stateId: request.stateId, mode: request.mode,
    resultContract: request.resultContract, flowInstanceId: request.control.flowInstanceId,
    attemptId: ATTEMPT, configRevision: SHA, controllerId: FLOW_1,
    publicationKeys: request.publicationKeys, ticket: TICKET,
    pinnedChangeRequest: null, sourceComment: null,
  }, provider, false);
  assert.equal(receipt.artifacts[0]?.kind === "comment" && receipt.artifacts[0].id, plan.id);
  const before = runtime.writer.load!(TICKET)!.value.control!;
  await runtime.writer(TICKET, before, { ...before, sequence: before.sequence + 1,
    updatedAt: NOW, latestReceipt: receipt,
    attemptSeries: attemptSeries({ stateId: "planning", agentId: "planner" }),
  });
  runtime.launcher.running.clear();
  const gate = await reconcileTicket(runtime.configured, TICKET);
  assert.equal(gate.stateId, "plan-review");
  assert.equal(runtime.launcher.requests.at(-1)?.mode, "human-input");
  assert.equal(runtime.launcher.requests.at(-1)?.sourceComment?.id, answer.id);
  assert.deepEqual(provider.snapshot.comments.map(({ id }) => id), [assessment.id, plan.id, answer.id]);
  assert.equal(provider.created, 0);
  assert.equal(provider.updated, 0);
});

test("a warm restart preserves the unfinished attempt baseline so its published result can be reused", async (t) => {
  const provider = new FakeProvider();
  const marker = `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`;
  const published = comment("published-before-crash", `${marker}\nCompleted assessment.`);
  provider.snapshot.labels.push("agent-stage:assessment");
  provider.snapshot.comments.push(published);
  provider.recoveryEvidence = recoveryEvidence(provider, [{
    key: publicationKey("comment", published.id), createdAt: published.createdAt,
    metadata: { config: SHA, controller: FLOW_1 },
  }]);
  const runtime = await localRuntime(t, provider);
  await runtime.writer(TICKET, null, controlState({ attemptSeries: attemptSeries({
    current: { attemptId: ATTEMPT, status: "started", startedAt: NOW },
  }) }), []);
  await reconcileTicket(runtime.configured, TICKET);
  assert.equal(runtime.launcher.requests.length, 1);
  assert.deepEqual(runtime.launcher.requests[0]?.publicationKeys, []);
});

test("an inactive losing controller stops locally without rewriting the winner's done label", async (t) => {
  const provider = new FakeProvider();
  provider.snapshot.labels = ["agent-flow:managed", "agent-stage:done"];
  provider.snapshot.activation.present = false;
  provider.snapshot.open = false;
  provider.recoveryEvidence = recoveryEvidence(provider, [{
    key: publicationKey("comment", "foreign-owner"), createdAt: NOW,
    metadata: { config: SHA, controller: FLOW_2 },
  }]);
  const runtime = await localRuntime(t, provider);
  await runtime.writer(TICKET, null, controlState());
  const result = await reconcileTicket(runtime.configured, TICKET);
  assert.equal(result.started, false);
  assert.equal(provider.events.includes("provider:set-labels"), false);
  assert.deepEqual(provider.snapshot.labels, ["agent-flow:managed", "agent-stage:done"]);
  assert.equal(runtime.launcher.requests.length, 0);
  assert.deepEqual(runtime.launcher.cancelled, [FLOW_1]);
});

test("retries owned cancellation label cleanup after its local state was already committed", async (t) => {
  const provider = new FakeProvider();
  provider.snapshot.labels = ["agent-flow:managed", "agent-stage:assessment"];
  provider.snapshot.activation.present = false;
  const runtime = await localRuntime(t, provider);
  await runtime.writer(TICKET, null, controlState());
  const update = provider.setControllerLabels.bind(provider);
  provider.setControllerLabels = async () => { throw new Error("transient labels failure"); };
  await assert.rejects(reconcileTicket(runtime.configured, TICKET), /label update failed/);
  provider.setControllerLabels = update;
  await reconcileTicket(runtime.configured, TICKET);
  assert.equal(runtime.writer.load!(TICKET)?.value.control?.stateId, "cancelled");
  assert.deepEqual(provider.snapshot.labels, ["agent-flow:managed", "agent-stage:cancelled"]);
  assert.equal(runtime.launcher.requests.length, 0);
});

test("an edited review approval returns warm local merge-wait work to fresh review", async (t) => {
  const provider = new FakeProvider();
  const change = changeRequest({ body: `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`, createdAt: "2026-08-26T10:15:00.000Z" });
  provider.snapshot.labels.push("agent-stage:awaiting-merge");
  provider.snapshot.changeRequest = change;
  provider.recoveryEvidence = recoveryEvidence(provider, [{
    key: publicationKey("change-request", String(change.number)), createdAt: change.createdAt,
    metadata: { config: SHA, controller: FLOW_1 },
  }, {
    key: publicationKey("review", "edited-review"), createdAt: "2026-08-26T10:30:00.000Z",
    metadata: { config: SHA, controller: FLOW_1 }, ownershipEligible: false,
  }], { changes: [change], reviews: [] });
  const runtime = await localRuntime(t, provider);
  await runtime.writer(TICKET, null, controlState({ stateId: "awaiting-merge", changeRequest: controlChange() }));
  const result = await reconcileTicket(runtime.configured, TICKET);
  assert.equal(result.stateId, "review");
  assert.equal(runtime.launcher.requests[0]?.agentId, "reviewer");
  assert.ok(runtime.launcher.requests[0]?.publicationKeys.includes(publicationKey("review", "edited-review")));
  assert.equal(provider.snapshot.labels.includes("agent-flow:development"), true);
});

test("warm review rerouting rejects a replacement linked change request before changing state", async (t) => {
  const provider = new FakeProvider();
  const replacement = changeRequest({ number: 32,
    url: "https://github.example.test/example-owner/example-repository/pull/32",
    body: `<!-- agent-flow:v1 {"config":"${SHA}","controller":"${FLOW_1}"} -->`,
    createdAt: "2026-08-26T10:15:00.000Z",
  });
  provider.snapshot.labels.push("agent-stage:awaiting-merge");
  provider.snapshot.changeRequest = replacement;
  provider.recoveryEvidence = recoveryEvidence(provider, [{
    key: publicationKey("change-request", "32"), createdAt: replacement.createdAt,
    metadata: { config: SHA, controller: FLOW_1 },
  }], { changes: [replacement] });
  const runtime = await localRuntime(t, provider);
  await runtime.writer(TICKET, null, controlState({ stateId: "awaiting-merge", changeRequest: controlChange() }));
  await assert.rejects(reconcileTicket(runtime.configured, TICKET), /change request identity/);
  assert.equal(runtime.launcher.requests.length, 0);
  assert.equal(provider.events.includes("provider:set-labels"), false);
  assert.equal(runtime.writer.load!(TICKET)?.value.control?.changeRequest?.number, 31);
  assert.equal(runtime.writer.load!(TICKET)?.value.control?.stateId, "awaiting-merge");
});
