import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import type { ConfigBundle } from "../../src/config/load.ts";
import type { DocumentValidator } from "../../src/config/schema-validator.ts";
import type { AgentReceipt, ControlState } from "../../src/config/types.ts";
import { ApmPreflightError } from "../../src/harness/apm.ts";
import { HarnessPreflightError, HarnessProcessError } from "../../src/harness/process.ts";
import type { HarnessAdapter, HarnessResult, ProviderCredential } from "../../src/harness/types.ts";
import { ProviderHttpError } from "../../src/provider/http.ts";
import type { ProviderAdapter, ProviderTicketSnapshot } from "../../src/provider/types.ts";
import { createAttemptRunner, type AttemptRunnerDependencies } from "../../src/runtime/attempt-runner.ts";
import {
  DecisionEvidenceUnavailableError,
  DecisionReadbackError,
  DecisionTrustError,
  InvalidDecisionError,
  type DecisionExpectation,
} from "../../src/runtime/receipts.ts";
import type { AttemptRequest } from "../../src/runtime/reconcile.ts";

const FLOW = "11111111-1111-4111-8111-111111111111";
const SERIES = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_1 = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_2 = "44444444-4444-4444-8444-444444444444";
const REVISION = "a".repeat(40);
const HEAD = "b".repeat(40);
const NOW = "2026-08-26T10:00:00.000Z";
const OK: HarnessResult = { exitCode: 0, signal: null, timedOut: false };

function bundle(maxAttempts = 3): ConfigBundle & { testMaxAttempts: number; testDelaySeconds: number } {
  return {
    revision: REVISION,
    root: "/config",
    stack: { apiVersion: "agent-flow/v1alpha1", kind: "Stack", spec: {
      flow: "config/flow.yaml", catalog: "config/agents.yaml", contracts: [], schemas: [],
    } },
    flow: {
      apiVersion: "agent-flow/v1alpha1", kind: "Flow",
      metadata: { id: "development", activationLabel: "agent-flow:development", managedLabel: "agent-flow:managed" },
      spec: { initial: "development", states: {
        development: { kind: "agent", agent: "developer", resultContract: "development", "on": {
          "agent-succeeded": { target: "done" },
          "agent-needs-human": { target: "blocked" },
        } },
        blocked: { kind: "paused" }, done: { kind: "final" },
      } },
    },
    catalog: { apiVersion: "agent-flow/v1alpha1", kind: "AgentCatalog", agents: {
      developer: { package: "agent-packages/developer" },
    } },
    testMaxAttempts: maxAttempts,
    testDelaySeconds: 7,
  };
}

function control(overrides: Partial<ControlState> = {}): ControlState {
  return {
    apiVersion: "agent-flow/v1alpha1", kind: "ControlState", flowInstanceId: FLOW,
    flowId: "development", configRevision: REVISION, sequence: 4, stateId: "development",
    resumeStateId: null, activatedBy: { login: "owner", providerId: "1" }, activatedAt: NOW,
    activationEventId: "event-1", updatedAt: NOW, attemptSeries: null, latestReceipt: null,
    humanGate: null, changeRequest: null, ...overrides,
  };
}

function snapshot(): ProviderTicketSnapshot {
  const actor = { login: "owner", providerId: "1" };
  return {
    ref: { provider: "github", repository: "owner/repo", number: 7 },
    repository: { provider: "github", name: "owner/repo", host: "github.test", cloneRoot: "/", cloneUrl: "https://github.test/owner/repo.git" },
    title: "Fix the edge case", description: "Handle the documented edge case.",
    open: true, labels: ["agent-flow:development", "agent-stage:development"], updatedAt: NOW,
    activation: {
      present: true, label: "agent-flow:development", eventId: "event-1", actor, occurredAt: NOW,
    }, comments: [],
    changeRequest: { provider: "github", repository: "owner/repo", number: 8,
      url: "https://github.test/owner/repo/pull/8", headSha: HEAD, state: "open", actor, updatedAt: NOW },
  };
}

function request(options: { bundle?: ConfigBundle; control?: ControlState; inputRevision?: string } = {}): AttemptRequest {
  const configured = options.bundle ?? bundle();
  const ticket = snapshot();
  return { ref: ticket.ref, snapshot: ticket, control: options.control ?? control(), bundle: configured,
    stateId: "development", state: configured.flow.spec.states.development!, agentId: "developer", mode: "stage",
    controllerId: FLOW, publicationKeys: [], sourceComment: null, resultContract: "development", inputRevision: options.inputRevision ?? "input:one" };
}

function receipt(attemptId: string, outcome: "succeeded" | "needs-human" = "succeeded"): AgentReceipt {
  return { apiVersion: "agent-flow/v1alpha1", kind: "AgentReceipt", flowInstanceId: FLOW, attemptId, outcome,
    summary: "done", artifacts: outcome === "needs-human" ? [{ kind: "comment", id: "9",
      url: "https://github.test/owner/repo/issues/7#issuecomment-9",
      marker: `<!-- agent-flow:v1 flow=${FLOW} attempt=${attemptId} artifact=question -->`, artifactKind: "question" }] :
      [{ kind: "change-request", number: 8, url: "https://github.test/owner/repo/pull/8", headSha: HEAD, state: "open" }] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

interface Fixture {
  events: string[]; controls: ControlState[]; attempts: string[]; delays: number[]; prompts: string[];
  verifications: Array<{ path: string; expected: DecisionExpectation; cancelled: boolean; validate: DocumentValidator }>;
  process: ReturnType<typeof deferred<HarnessResult>>;
  runner: ReturnType<typeof createAttemptRunner>; request: AttemptRequest;
}

function fixture(options: {
  request?: AttemptRequest; results?: Array<HarnessResult | Error | Promise<HarnessResult>>;
  verify?: (path: string, expected: DecisionExpectation, cancelled: boolean) => Promise<AgentReceipt>;
  write?: AttemptRunnerDependencies["writeControl"];
  ids?: string[]; compileError?: Error; delay?: (milliseconds: number) => Promise<void>;
  providerCredential?: ProviderCredential; onSettled?: (ref: AttemptRequest["ref"]) => void;
  execution?: AttemptRunnerDependencies["execution"];
  preparePinnedAgent?: AttemptRunnerDependencies["preparePinnedAgent"];
  packageDirectory?: string;
  archive?: (receipt: AgentReceipt) => Promise<void>;
  dataDirectory?: string;
  decisionEvent?: "agent-succeeded" | "agent-needs-human";
  provider?: ProviderAdapter;
} = {}): Fixture {
  const events: string[] = [], controls: ControlState[] = [], attempts: string[] = [], delays: number[] = [];
  const prompts: string[] = [];
  const verifications: Fixture["verifications"] = [];
  const process = deferred<HarnessResult>();
  const configuredRequest = options.request ?? request();
  const results = [...(options.results ?? [process.promise])];
  let current = configuredRequest.control;
  const ids = [...(options.ids ?? [SERIES, ATTEMPT_1, ATTEMPT_2])];
  const harness: HarnessAdapter = { target: "codex", async preflight() {}, async run(input) {
    events.push("harness:spawn");
    if (options.dataDirectory) {
      await writeFile(input.session.decisionPath, JSON.stringify({ event: options.decisionEvent ?? "agent-needs-human" }));
      await writeFile(join(input.session.root, "prepared-comment.txt"), "Please clarify the ticket.");
    }
    prompts.push(input.stagePrompt);
    assert.deepEqual(input.providerCredential, {
      provider: "github", name: "GH_TOKEN", value: "github-ticket-token", apiUrl: "https://api.github.com",
    });
    const value = results.shift() ?? OK;
    if (value instanceof Error) throw value;
    if (value instanceof Promise) return value;
    return input.signal.aborted ? { exitCode: null, signal: "SIGTERM", timedOut: false } : value;
  } };
  const writeControl = options.write ?? (async (_ref, expected, next) => {
    events.push(next.attemptSeries?.current?.status === "started" ? "control:update-started" : "control:update");
    assert.equal(expected.flowInstanceId, FLOW); assert.equal(expected.sequence, current.sequence);
    assert.equal(next.sequence, current.sequence + 1); current = structuredClone(next); controls.push(current);
    events.push("control:readback"); return structuredClone(current);
  });
  const runner = createAttemptRunner({
    archiveReceipt: async (_root, value) => options.archive?.(value),
    dataDirectory: options.dataDirectory ?? "/data", provider: options.provider ?? { kind: "github" } as ProviderAdapter,
    providerConfig: { apiUrl: "https://api.github.com", repositories: ["owner/repo"] },
    providerCredential: options.providerCredential
      ?? {
        provider: "github", name: "GH_TOKEN", value: "github-ticket-token", apiUrl: "https://api.github.com",
      },
    execution: options.execution ?? (async () => ({ runtimeDigest: "d".repeat(64), executionSnapshot: {
      harness: "codex", model: "test-model", reasoning: "high",
      maxAttempts: (configuredRequest.bundle as ReturnType<typeof bundle>).testMaxAttempts ?? 3,
      delaySeconds: (configuredRequest.bundle as ReturnType<typeof bundle>).testDelaySeconds ?? 7,
      timeoutSeconds: 90,
    } })),
    preparePinnedAgent: options.preparePinnedAgent ?? (async (revision, agentId) => {
      events.push("config:stage");
      assert.equal(revision, REVISION);
      assert.equal(agentId, "developer");
      return { bundle: configuredRequest.bundle, packageDirectory: "/config/agent-packages/developer" };
    }),
    workspaceManager: { async prepareWorkspace(...args: unknown[]) {
      assert.deepEqual(args[3], {
        provider: "github", name: "GH_TOKEN", value: "github-ticket-token", apiUrl: "https://api.github.com",
      });
      events.push("workspace:prepare"); return {
      baseClone: "/data/repositories/repo", worktree: "/data/worktrees/flow", repository: "owner/repo",
      ticketNumber: 7, flowInstanceId: FLOW,
    }; } }, harnesses: { codex: harness }, writeControl,
    async createSession(_data, _flow, attemptId, context) { attempts.push(attemptId); events.push("session:create");
      if (options.dataDirectory) {
        const root = join(options.dataDirectory, "sessions", FLOW, attemptId);
        await mkdir(root, { recursive: true });
        return { root, contextPath: join(root, "context.json"), decisionPath: join(root, "decision.json"),
          logPath: join(root, "harness.log"), harnessSessionDirectory: join(root, "harness-session") };
      }
      assert.equal(context.controlState.attemptSeries?.current?.attemptId, attemptId);
      assert.equal(inspect(context).includes("github-ticket-token"), false); return {
        root: `/data/sessions/${attemptId}`, contextPath: `/data/sessions/${attemptId}/context.json`,
        decisionPath: `/data/sessions/${attemptId}/decision.json`, logPath: `/data/sessions/${attemptId}/harness.log`,
        harnessSessionDirectory: `/data/sessions/${attemptId}/harness-session`,
      }; },
    async compileAgent(agentId, packageDirectory, target) { events.push("apm:compile");
      assert.equal(packageDirectory, options.packageDirectory ?? "/config/agent-packages/developer");
      if (options.compileError) throw options.compileError;
      return { agentId, target, instructions: "instructions", runtimeDirectory: "/runtime" }; },
    async verifyDecision(path, expected, _provider, cancelled, validate) { events.push("decision:verify");
      verifications.push({ path, expected, cancelled, validate });
      return options.verify?.(path, expected, cancelled) ?? receipt(expected.attemptId); },
    async delay(milliseconds) { delays.push(milliseconds); events.push("delay"); await options.delay?.(milliseconds); },
    now: () => NOW, newId: () => ids.shift()!,
  });
  if (options.onSettled) runner.onSettled?.(options.onSettled);
  return { events, controls, attempts, delays, prompts, verifications, process, runner, request: configuredRequest };
}

async function waitIdle(subject: Fixture): Promise<void> {
  for (let index = 0; subject.runner.isRunning(FLOW) && index < 100; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(subject.runner.isRunning(FLOW), false);
}

test("persists and reads back started before a background launch", async () => {
  const subject = fixture(); await subject.runner.start(subject.request);
  assert.equal(subject.runner.isRunning(FLOW), true);
  assert.deepEqual(subject.events.slice(0, 7), ["control:update-started", "control:readback", "workspace:prepare",
    "session:create", "config:stage", "apm:compile", "harness:spawn"]);
  assert.equal(subject.controls[0]!.attemptSeries?.consumed, 1);
  assert.equal(subject.controls[0]!.attemptSeries?.runtimeDigest, "d".repeat(64));
  assert.equal(subject.controls[0]!.attemptSeries?.executionSnapshot?.model, "test-model");
  subject.process.resolve(OK); await waitIdle(subject);
  assert.match(subject.prompts[0]!, new RegExp(`/data/sessions/${ATTEMPT_1}/context\\.json`));
  assert.match(subject.prompts[0]!, new RegExp(`/data/sessions/${ATTEMPT_1}/decision\\.json`));
  assert.match(subject.prompts[0]!, new RegExp(`"config":"${REVISION}","controller":"${FLOW}"`));
  assert.equal(subject.verifications[0]?.path, `/data/sessions/${ATTEMPT_1}/decision.json`);
  assert.equal(typeof subject.verifications[0]?.validate, "function");
  assert.deepEqual({
    flow: subject.verifications[0]?.expected.flow,
    stateId: subject.verifications[0]?.expected.stateId,
    mode: subject.verifications[0]?.expected.mode,
    resultContract: subject.verifications[0]?.expected.resultContract,
    flowInstanceId: subject.verifications[0]?.expected.flowInstanceId,
    attemptId: subject.verifications[0]?.expected.attemptId,
    ticket: subject.verifications[0]?.expected.ticket,
    configRevision: subject.verifications[0]?.expected.configRevision,
    controllerId: subject.verifications[0]?.expected.controllerId,
    publicationKeys: subject.verifications[0]?.expected.publicationKeys,
    sourceComment: subject.verifications[0]?.expected.sourceComment,
    pinnedChangeRequest: subject.verifications[0]?.expected.pinnedChangeRequest,
  }, {
    flow: subject.request.bundle.flow,
    stateId: "development",
    mode: "stage",
    resultContract: "development",
    flowInstanceId: FLOW,
    attemptId: ATTEMPT_1,
    ticket: subject.request.ref,
    configRevision: REVISION,
    controllerId: FLOW,
    publicationKeys: [],
    sourceComment: null,
    pinnedChangeRequest: subject.request.snapshot.changeRequest,
  });
  assert.deepEqual(subject.controls.at(-1)?.latestReceipt, receipt(ATTEMPT_1));
});

test("archives usage across process and decision failures without accumulating retries", async () => {
  for (const failure of ["exit", "timeout", "signal", "process", "decision", "readback"]) {
    const archived: AgentReceipt[] = [];
    const processError = new HarnessProcessError("codex", true);
    processError.usage = { totalTokens: 12 };
    const failed = failure === "process" ? processError : { ...OK, usage: { totalTokens: 12 },
      ...(failure === "exit" ? { exitCode: 1 } : {}), ...(failure === "timeout" ? { timedOut: true } : {}),
      ...(failure === "signal" ? { exitCode: null, signal: "SIGTERM" as const } : {}) };
    let verifies = 0;
    const subject = fixture({ results: [failed, { ...OK, usage: { totalTokens: 3 } }],
      archive: async (value) => { archived.push(value); }, verify: async (_path, expected) => {
        if (++verifies === 1 && failure === "decision") throw new InvalidDecisionError("Invalid decision.");
        if (verifies === 1 && failure === "readback") throw new DecisionReadbackError();
        return receipt(expected.attemptId);
      } });
    await subject.runner.start(subject.request); await waitIdle(subject);
    assert.equal(archived.length, 2, failure);
    assert.equal(archived[0]?.outcome, "failed", failure);
    assert.deepEqual(archived[0]?.artifacts, []);
    assert.equal(archived[0]?.usage?.totalTokens, 12);
    assert.equal(archived[1]?.usage?.totalTokens, 3);
    assert.equal(subject.controls.at(-1)?.latestReceipt?.usage?.totalTokens, 3);
  }
});

test("telemetry storage failure does not launch another harness", async () => {
  const subject = fixture({ results: [{ ...OK, usage: { totalTokens: 5 } }],
    archive: async () => { throw new Error("storage failed"); } });
  await subject.runner.start(subject.request); await waitIdle(subject);
  assert.equal(subject.attempts.length, 1);
  assert.equal(subject.controls.at(-1)?.attemptSeries?.current?.status, "succeeded");
});

test("cancellation archives available usage without a receipt transition", async () => {
  const archived: AgentReceipt[] = [];
  const subject = fixture({ archive: async (value) => { archived.push(value); } });
  await subject.runner.start(subject.request);
  const cancelling = subject.runner.cancel(FLOW);
  subject.process.resolve({ exitCode: null, signal: "SIGTERM", timedOut: false, usage: { inputTokens: 17 } });
  await cancelling;
  assert.equal(archived[0]?.usage?.inputTokens, 17);
  assert.equal(archived[0]?.error?.code, "ATTEMPT_CANCELLED");
  assert.equal(subject.controls.at(-1)?.latestReceipt, null);
});

test("stages a private pinned package before compiling each retry", async () => {
  const verified = { ...bundle(), root: "/verified" };
  let stages = 0;
  const subject = fixture({
    results: [{ exitCode: 17, signal: null, timedOut: false }, OK],
    preparePinnedAgent: async (revision, agentId, destination) => {
      stages += 1;
      assert.equal(revision, REVISION);
      assert.equal(agentId, "developer");
      assert.match(destination, /\/pinned-package$/);
      return { bundle: verified, packageDirectory: "/verified/agent-packages/developer" };
    },
    packageDirectory: "/verified/agent-packages/developer",
  });

  await subject.runner.start(subject.request);
  await waitIdle(subject);

  assert.equal(stages, 2);
  assert.equal(subject.events.filter((event) => event === "apm:compile").length, 2);
});

test("wakes the ticket after a background attempt settles", async () => {
  const settled: string[] = [];
  const subject = fixture({ onSettled: (ref) => settled.push(`${ref.provider}:${ref.repository}#${ref.number}`) });
  await subject.runner.start(subject.request);
  assert.deepEqual(settled, []);
  subject.process.resolve(OK);
  await waitIdle(subject);
  assert.deepEqual(settled, ["github:owner/repo#7"]);
});

test("suppresses a second start while the first process is active", async () => {
  const subject = fixture(); await subject.runner.start(subject.request); await subject.runner.start(subject.request);
  assert.equal(subject.events.filter((event) => event === "harness:spawn").length, 1);
  subject.process.resolve(OK); await waitIdle(subject);
});

test("retries with injected delay and a fresh session", async () => {
  const subject = fixture({ results: [{ exitCode: 17, signal: null, timedOut: false }, OK] });
  await subject.runner.start(subject.request); await waitIdle(subject);
  assert.deepEqual(subject.delays, [7_000]); assert.deepEqual(subject.attempts, [ATTEMPT_1, ATTEMPT_2]);
  assert.ok(subject.prompts[0]?.includes(ATTEMPT_1)); assert.ok(subject.prompts[1]?.includes(ATTEMPT_2));
  assert.equal(subject.controls.at(-1)!.attemptSeries?.current?.status, "succeeded");
  assert.equal(subject.controls.at(-1)!.attemptSeries?.consumed, 2);
});

test("passes the canonical ticket and excluded comment IDs to the runtime prompt", async () => {
  const configured = request();
  configured.publicationKeys = [
    JSON.stringify(["github", "https://api.github.com/", "owner/repo", "comment", "101"]),
    JSON.stringify(["github", "https://api.github.com/", "owner/repo", "review", "701"]),
  ];
  const subject = fixture({ request: configured, results: [OK] });
  await subject.runner.start(subject.request);
  await waitIdle(subject);

  assert.match(subject.prompts[0]!, /Result and question comments belong on ticket github owner\/repo#7/);
  assert.match(subject.prompts[0]!, /Do not reuse these existing comment IDs as result or question evidence: 101\./);
  assert.doesNotMatch(subject.prompts[0]!, /comment IDs as result or question evidence: 701/);
});

test("tells an evidence retry to repair publication without exposing raw failure text", async () => {
  let calls = 0;
  const subject = fixture({ results: [OK, OK], verify: async (_path, expected) => {
    if (calls++ === 0) throw new DecisionEvidenceUnavailableError("secret-provider-response");
    return receipt(expected.attemptId);
  } });
  await subject.runner.start(subject.request);
  await waitIdle(subject);

  assert.doesNotMatch(subject.prompts[0]!, /Previous attempt failed/);
  assert.match(subject.prompts[1]!, /Previous attempt failed with DECISION_EVIDENCE_UNAVAILABLE/);
  assert.match(subject.prompts[1]!, /Repair the required provider publication/);
  assert.doesNotMatch(subject.prompts.join("\n"), /secret-provider-response/);
  assert.equal(subject.controls.at(-1)!.attemptSeries?.current?.status, "succeeded");
});

test("retries process and decision failures with a fresh session", async () => {
  const cases: Array<HarnessResult | Error> = [
    { exitCode: null, signal: "SIGTERM", timedOut: true }, new HarnessProcessError("codex", true),
    new InvalidDecisionError("decision file could not be read"),
    new InvalidDecisionError("decision contains invalid JSON"),
    new DecisionEvidenceUnavailableError("provider decision evidence is unavailable"),
    new DecisionReadbackError(),
  ];
  for (const first of cases) {
    let verifyCalls = 0;
    const decisionCase = first instanceof InvalidDecisionError
      || first instanceof DecisionEvidenceUnavailableError
      || first instanceof DecisionReadbackError;
    const subject = fixture({ results: decisionCase ? [OK, OK] : [first, OK], verify: async (_path, expected) => {
      verifyCalls += 1; if (decisionCase && verifyCalls === 1) throw first; return receipt(expected.attemptId);
    } });
    await subject.runner.start(subject.request); await waitIdle(subject);
    assert.deepEqual(subject.delays, [7_000]);
    assert.deepEqual(subject.attempts, [ATTEMPT_1, ATTEMPT_2]);
    assert.equal(subject.controls.at(-1)!.attemptSeries?.current?.status, "succeeded");
    assert.equal(JSON.stringify(subject.controls).includes("secret"), false);
  }
});

test("blocks non-retryable harness and decision trust failures without delay", async () => {
  const cases: Array<{ result?: Error; verify?: () => Promise<AgentReceipt>; code: string }> = [
    { result: new HarnessPreflightError("codex"), code: "HARNESS_PREFLIGHT_FAILED" },
    { result: new HarnessProcessError("codex", false), code: "HARNESS_PROCESS_FAILED" },
    { verify: async () => { throw new DecisionTrustError("token=secret"); }, code: "DECISION_TRUST_FAILED" },
  ];
  for (const item of cases) {
    const subject = fixture({ results: [item.result ?? OK], verify: item.verify ? async () => item.verify!() : undefined });
    await subject.runner.start(subject.request); await waitIdle(subject);
    const final = subject.controls.at(-1)!;
    assert.equal(final.stateId, "blocked"); assert.equal(final.resumeStateId, "development");
    assert.equal(final.attemptSeries?.current?.error?.code, item.code);
    assert.equal(JSON.stringify(final).includes("secret"), false); assert.deepEqual(subject.delays, []);
  }
});

test("blocks APM configuration failures before spawning a harness", async () => {
  const subject = fixture({ compileError: new ApmPreflightError("APM install failed") });
  await assert.rejects(subject.runner.start(subject.request), /APM preflight failed/);
  await waitIdle(subject);
  assert.equal(subject.controls.at(-1)!.stateId, "blocked");
  assert.equal(subject.controls.at(-1)!.attemptSeries?.current?.error?.code, "APM_PREFLIGHT_FAILED");
  assert.equal(subject.events.includes("harness:spawn"), false);
});

test("rejects invalid pinned identity and allowlist before consuming an attempt", async () => {
  const badRevision = request({ control: control({ configRevision: "c".repeat(40) }) });
  for (const invalid of [badRevision]) {
    const subject = fixture({ request: invalid });
    await assert.rejects(subject.runner.start(subject.request));
    assert.equal(subject.controls.length, 0);
    assert.equal(subject.events.includes("workspace:prepare"), false);
  }
});

test("rejects a credential that does not match the active provider configuration", async () => {
  for (const providerCredential of [
    { provider: "gitlab", name: "OAUTH_TOKEN", value: "gitlab-token", apiUrl: "https://gitlab.com/api/v4" },
    { provider: "github", name: "GITHUB_TOKEN", value: "github-token", apiUrl: "https://wrong.test/api/v3" },
  ] as const) {
    const subject = fixture({ providerCredential });
    await assert.rejects(subject.runner.start(subject.request), /provider credential does not match/);
    assert.equal(subject.controls.length, 0);
    assert.equal(subject.events.includes("workspace:prepare"), false);
  }
});

test("blocks when retry budget is exhausted", async () => {
  const configured = bundle(2);
  const subject = fixture({ request: request({ bundle: configured }),
    results: [{ exitCode: 1, signal: null, timedOut: false }, { exitCode: 2, signal: null, timedOut: false }] });
  await subject.runner.start(subject.request); await waitIdle(subject);
  const final = subject.controls.at(-1)!;
  assert.equal(final.stateId, "blocked"); assert.equal(final.attemptSeries?.consumed, 2);
  assert.equal(final.attemptSeries?.current?.status, "failed");
});

test("accepts needs-human as succeeded without another attempt", async () => {
  const subject = fixture({ results: [OK], verify: async (_path, expected) =>
    receipt(expected.attemptId, "needs-human") });
  await subject.runner.start(subject.request); await waitIdle(subject);
  const final = subject.controls.at(-1)!;
  assert.equal(final.stateId, "development"); assert.equal(final.attemptSeries?.current?.status, "succeeded");
  assert.equal(final.attemptSeries?.consumed, 1); assert.equal(final.latestReceipt?.outcome, "needs-human");
});

test("blocked reset reuses series ID; new input creates a fresh series", async () => {
  const reset = control({ attemptSeries: { seriesId: SERIES, agentId: "developer", stateId: "development",
    inputRevision: "input:one", maxAttempts: 3, consumed: 0, current: null } });
  const resumed = fixture({ request: request({ control: reset }), ids: [ATTEMPT_1], results: [OK] });
  await resumed.runner.start(resumed.request); await waitIdle(resumed);
  assert.equal(resumed.controls[0]!.attemptSeries?.seriesId, SERIES);
  const old = control({ attemptSeries: { seriesId: SERIES, agentId: "developer", stateId: "development",
    inputRevision: "input:old", maxAttempts: 3, consumed: 2, current: { attemptId: ATTEMPT_1, status: "failed",
      startedAt: NOW, finishedAt: NOW, error: { code: "HARNESS_TIMEOUT", message: "harness timed out" } } } });
  const changed = fixture({ request: request({ control: old, inputRevision: "input:new" }),
    ids: ["55555555-5555-4555-8555-555555555555", ATTEMPT_2], results: [OK] });
  await changed.runner.start(changed.request); await waitIdle(changed);
  assert.notEqual(changed.controls[0]!.attemptSeries?.seriesId, SERIES);
  assert.equal(changed.controls[0]!.attemptSeries?.consumed, 1);
});

test("cancel aborts the live job without owning provider state", async () => {
  let settled = 0;
  const subject = fixture({ onSettled: () => { settled += 1; } }); await subject.runner.start(subject.request);
  const cancelling = subject.runner.cancel(FLOW);
  subject.process.resolve({ exitCode: null, signal: "SIGTERM", timedOut: false });
  await cancelling;
  assert.equal(subject.runner.isRunning(FLOW), false);
  assert.equal(subject.controls.at(-1)!.attemptSeries?.current?.status, "started");
  assert.equal(settled, 0);
  await subject.runner.cancel(FLOW);
});

test("cancellation ignores a decision that finishes after the attempt", async () => {
  const verification = deferred<AgentReceipt>();
  const verifying = deferred<void>();
  const subject = fixture({ results: [OK], verify: async () => {
    verifying.resolve();
    return verification.promise;
  } });
  await subject.runner.start(subject.request);
  await verifying.promise;

  const cancelling = subject.runner.cancel(FLOW);
  verification.resolve(receipt(ATTEMPT_1));
  await cancelling;

  assert.equal(subject.controls.at(-1)?.attemptSeries?.current?.status, "started");
  assert.equal(subject.controls.at(-1)?.latestReceipt, null);
  assert.equal(subject.events.filter((event) => event === "decision:verify").length, 1);
});

test("rejects started-control CAS conflict before workspace and spawn", async () => {
  const subject = fixture({ write: async () => { throw new Error("sequence conflict token=secret"); } });
  await assert.rejects(subject.runner.start(subject.request), (error: unknown) => {
    assert.equal((error as { code: string }).code, "ATTEMPT_CONFIGURATION_FAILED");
    assert.equal(inspect(error).includes("secret"), false);
    return true;
  });
  assert.equal(subject.runner.isRunning(FLOW), false);
  assert.equal(subject.events.includes("workspace:prepare"), false);
  assert.equal(subject.events.includes("harness:spawn"), false);
});

test("does not relaunch persisted succeeded or cancelled attempts", async () => {
  for (const status of ["succeeded", "cancelled"] as const) {
    const existing = control({ attemptSeries: { seriesId: SERIES, agentId: "developer", stateId: "development",
      inputRevision: "input:one", maxAttempts: 3, consumed: 1,
      current: { attemptId: ATTEMPT_1, status, startedAt: NOW } } });
    const subject = fixture({ request: request({ control: existing }) });
    await subject.runner.start(subject.request);
    assert.equal(subject.events.length, 0); assert.equal(subject.runner.isRunning(FLOW), false);
  }
});

test("recovers a persisted started attempt in the same retry series", async () => {
  const existing = control({ attemptSeries: { seriesId: SERIES, agentId: "developer", stateId: "development",
    inputRevision: "input:one", maxAttempts: 3, consumed: 1,
    current: { attemptId: ATTEMPT_1, status: "started", startedAt: NOW } } });
  const subject = fixture({ request: request({ control: existing }), ids: [ATTEMPT_2], results: [OK] });
  await subject.runner.start(subject.request); await waitIdle(subject);
  assert.equal(subject.controls[1]!.attemptSeries?.seriesId, SERIES);
  assert.equal(subject.controls[1]!.attemptSeries?.consumed, 1);
  assert.equal(subject.controls[1]!.attemptSeries?.current?.status, "failed");
  assert.equal(subject.controls[1]!.attemptSeries?.current?.error?.code, "CONTROLLER_RESTARTED");
  assert.deepEqual(subject.delays, [7_000]);
  assert.equal(subject.controls.at(-1)!.attemptSeries?.consumed, 2);
});

test("resumes a persisted retryable failure after delay without resetting budget", async () => {
  const existing = control({ attemptSeries: { seriesId: SERIES, agentId: "developer", stateId: "development",
    inputRevision: "input:one", maxAttempts: 3, consumed: 1,
    current: { attemptId: ATTEMPT_1, status: "failed", startedAt: NOW, finishedAt: NOW,
      error: { code: "HARNESS_TIMEOUT", message: "harness timed out" } } } });
  const subject = fixture({ request: request({ control: existing }), ids: [ATTEMPT_2], results: [OK] });
  await subject.runner.start(subject.request); await waitIdle(subject);
  assert.deepEqual(subject.delays, [7_000]);
  assert.equal(subject.controls.at(-1)!.attemptSeries?.seriesId, SERIES);
  assert.equal(subject.controls.at(-1)!.attemptSeries?.consumed, 2);
});

test("blocks an exhausted persisted started attempt without spawning", async () => {
  const configured = bundle(1);
  const existing = control({ attemptSeries: { seriesId: SERIES, agentId: "developer", stateId: "development",
    inputRevision: "input:one", maxAttempts: 1, consumed: 1,
    current: { attemptId: ATTEMPT_1, status: "started", startedAt: NOW } } });
  const subject = fixture({ request: request({ bundle: configured, control: existing }) });
  await subject.runner.start(subject.request); await waitIdle(subject);
  assert.equal(subject.controls.at(-1)!.stateId, "blocked");
  assert.equal(subject.controls.at(-1)!.attemptSeries?.current?.error?.code, "CONTROLLER_RESTARTED");
  assert.equal(subject.events.includes("harness:spawn"), false);
});

test("sanitizes a transient initial control persistence failure", async () => {
  const raw = new ProviderHttpError("token=secret", 503, true, { token: "secret" }, { authorization: "secret" });
  const subject = fixture({ write: async () => { throw raw; } });
  await assert.rejects(subject.runner.start(subject.request), (error: unknown) => {
    assert.equal((error as { code: string }).code, "PROVIDER_TRANSIENT");
    assert.equal((error as { retryable: boolean }).retryable, true);
    assert.equal(inspect(error, { showHidden: true }).includes("secret"), false);
    assert.equal(JSON.stringify(error).includes("secret"), false);
    assert.equal(inspect(Object.getOwnPropertyDescriptors(error as object), { showHidden: true }).includes("secret"), false);
    assert.equal("cause" in (error as object), false);
    return true;
  });
  assert.equal(subject.runner.isRunning(FLOW), false);
});

test("restart and failed recovery resolve readiness before a deferred retry delay", async () => {
  for (const status of ["started", "failed"] as const) {
    const never = deferred<void>();
    const configured = bundle();
    configured.testDelaySeconds = 3_600;
    const current = status === "started"
      ? { attemptId: ATTEMPT_1, status, startedAt: NOW }
      : { attemptId: ATTEMPT_1, status, startedAt: NOW, finishedAt: NOW,
        error: { code: "HARNESS_TIMEOUT", message: "harness timed out" } };
    const existing = control({ attemptSeries: { seriesId: SERIES, agentId: "developer", stateId: "development",
      inputRevision: "input:one", maxAttempts: 3, consumed: 1, current } });
    const subject = fixture({ request: request({ bundle: configured, control: existing }),
      ids: [ATTEMPT_2], delay: () => never.promise });

    await subject.runner.start(subject.request);

    assert.equal(subject.runner.isRunning(FLOW), true);
    assert.equal(subject.controls[0]!.attemptSeries?.runtimeDigest, "d".repeat(64));
    assert.equal(subject.controls[0]!.attemptSeries?.executionSnapshot?.model, "test-model");
    assert.deepEqual(subject.delays, [3_600_000]);
    assert.equal(subject.events.includes("harness:spawn"), false);
    await subject.runner.cancel(FLOW);
    assert.equal(subject.runner.isRunning(FLOW), false);
  }
});

test("passes the surviving control's activation pin to result verification", async () => {
  const subject = fixture({ request: request({ control: control({ activationLabel: "bugfix" }) }) });
  await subject.runner.start(subject.request);
  subject.process.resolve(OK);
  await waitIdle(subject);
  assert.equal(subject.verifications[0]?.expected.activationLabel, "bugfix");
});


test("restart delivers a completed prepared attempt without another harness launch or retry charge", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "runner-prepared-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const configured = request();
  configured.bundle.stack.spec.publication = "controller-prepared-v1";
  let published: { id: string; url: string; body: string; createdAt: string } | undefined;
  let creates = 0;
  const provider = { kind: "github", readTicket: async () => ({ ...snapshot(), comments: published ? [published] : [] }),
    createComment: async (_ref: unknown, body: string) => {
      creates++;
      published = { id: "9", url: "https://github.test/comment/9", body, createdAt: NOW };
      throw new Error("uncertain create");
    }, readComment: async () => published } as unknown as ProviderAdapter;
  const first = fixture({ request: configured, dataDirectory, provider, results: [{ ...OK, usage: { totalTokens: 27 } }] });
  await first.runner.start(first.request);
  await new Promise<void>((resolve) => first.runner.onSettled!(resolve));
  const retained = first.controls.at(-1)!;
  assert.equal(retained.attemptSeries?.current?.status, "started");
  assert.equal(first.attempts.length, 1);
  const second = fixture({ request: request({ bundle: configured.bundle, control: retained }), dataDirectory, provider,
    verify: async (_path, expected) => receipt(expected.attemptId, "needs-human") });
  await second.runner.start(second.request);
  for (let i = 0; second.runner.isRunning(FLOW) && i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(second.runner.isRunning(FLOW), false);
  assert.equal(second.attempts.length, 0);
  assert.equal(second.events.includes("harness:spawn"), false);
  assert.equal(second.controls.at(-1)?.attemptSeries?.consumed, 1);
  assert.equal(second.controls.at(-1)?.latestReceipt?.usage?.totalTokens, 27);
  assert.equal(second.controls.at(-1)?.attemptSeries?.current?.status, "succeeded");
  assert.equal(creates, 1);
});


test("prepared results classify verification failures and archive accounting on launch and restart", async (t) => {
  for (const resumed of [false, true]) {
    for (const decisionEvent of ["agent-needs-human", "agent-succeeded"] as const) {
      for (const error of [new DecisionTrustError("secret"), new DecisionEvidenceUnavailableError("missing evidence"),
        new InvalidDecisionError("invalid result")]) {
        const dataDirectory = await mkdtemp(join(tmpdir(), "runner-verification-"));
        t.after(() => rm(dataDirectory, { recursive: true, force: true }));
        const configured = request({ bundle: bundle(error instanceof DecisionTrustError ? 3 : 1) });
        configured.bundle.stack.spec.publication = "controller-prepared-v1";
        let published: { id: string; url: string; body: string; createdAt: string } | undefined;
        let creates = 0;
        const provider = { kind: "github", readTicket: async () => ({ ...snapshot(), comments: published ? [published] : [] }),
          createComment: async (_ref: unknown, body: string) => {
            creates++;
            published = { id: "9", url: "https://github.test/comment/9", body, createdAt: NOW };
            if (resumed) throw new Error("uncertain create");
            return published;
          }, readComment: async () => published } as unknown as ProviderAdapter;
        const archived: AgentReceipt[] = [];
        const first = fixture({ request: configured, dataDirectory, provider, decisionEvent,
          results: [{ ...OK, usage: { totalTokens: 27 } }],
          archive: async (value) => { archived.push(value); }, verify: async () => { throw error; } });
        await first.runner.start(first.request);
        await new Promise<void>((resolve) => first.runner.onSettled!(resolve));
        // PR/native-review results do not create controller comments and fail immediately.
        let subject = first;
        if (resumed && decisionEvent === "agent-needs-human") {
          const retained = first.controls.at(-1)!;
          assert.equal(retained.attemptSeries?.current?.status, "started");
          subject = fixture({ request: request({ bundle: configured.bundle, control: retained }), dataDirectory, provider,
            archive: async (value) => { archived.push(value); }, verify: async () => { throw error; } });
          await subject.runner.start(subject.request);
          for (let i = 0; subject.runner.isRunning(FLOW) && i < 100; i++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          assert.equal(subject.attempts.length, 0);
        }
        assert.equal(subject.controls.at(-1)?.stateId, "blocked");
        assert.equal(subject.controls.at(-1)?.attemptSeries?.current?.status, "failed");
        assert.equal(subject.controls.at(-1)?.attemptSeries?.current?.error?.code, error.code);
        assert.equal(archived.length, 1);
        assert.equal(archived[0]?.error?.code, error.code);
        assert.equal(archived[0]?.usage?.totalTokens, 27);
        assert.deepEqual(archived[0]?.artifacts, []);
        assert.equal(creates, decisionEvent === "agent-needs-human" ? 1 : 0);
      }
    }
  }
});


test("permanent prepared comment rejection blocks and archives accounting without another launch", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "runner-rejection-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const configured = request();
  configured.bundle.stack.spec.publication = "controller-prepared-v1";
  const archived: AgentReceipt[] = [];
  const provider = { kind: "github", readTicket: async () => snapshot(),
    createComment: async () => { throw new ProviderHttpError("forbidden", 403, false, {}, {}); },
  } as unknown as ProviderAdapter;
  const subject = fixture({ request: configured, dataDirectory, provider,
    results: [{ ...OK, usage: { totalTokens: 27 } }], archive: async (value) => { archived.push(value); } });
  await subject.runner.start(subject.request);
  await new Promise<void>((resolve) => subject.runner.onSettled!(resolve));
  assert.equal(subject.controls.at(-1)?.stateId, "blocked");
  assert.equal(subject.controls.at(-1)?.attemptSeries?.current?.error?.code, "PROVIDER_FAILED");
  assert.equal(subject.attempts.length, 1);
  assert.deepEqual(subject.delays, []);
  assert.equal(archived[0]?.usage?.totalTokens, 27);
});

test('unconfirmed process termination keeps the per-flow guard and rejects cancellation until exit',async()=>{
 const {HarnessTerminationError}=await import('../../src/harness/process.ts');
 const termination=deferred<void>(),f=fixture({results:[new HarnessTerminationError('codex',termination.promise)]});
 await f.runner.start(f.request);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.runner.isRunning(FLOW),true);
 await assert.rejects(f.runner.cancel(FLOW),/termination/);
 await f.runner.start(f.request);assert.equal(f.attempts.length,1);
 termination.resolve();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.runner.isRunning(FLOW),false);
});
