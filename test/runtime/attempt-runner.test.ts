import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import type { ConfigBundle } from "../../src/config/load.ts";
import type { AgentReceipt, ControlState } from "../../src/config/types.ts";
import { ApmPreflightError } from "../../src/harness/apm.ts";
import { HarnessPreflightError, HarnessProcessError } from "../../src/harness/process.ts";
import type { HarnessAdapter, HarnessResult } from "../../src/harness/types.ts";
import { ProviderHttpError } from "../../src/provider/http.ts";
import type { ProviderAdapter, ProviderTicketSnapshot } from "../../src/provider/types.ts";
import { createAttemptRunner, type AttemptRunnerDependencies } from "../../src/runtime/attempt-runner.ts";
import { InvalidReceiptError, ReceiptReadbackError } from "../../src/runtime/receipts.ts";
import type { AttemptRequest } from "../../src/runtime/reconcile.ts";

const FLOW = "11111111-1111-4111-8111-111111111111";
const SERIES = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_1 = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_2 = "44444444-4444-4444-8444-444444444444";
const REVISION = "a".repeat(40);
const HEAD = "b".repeat(40);
const NOW = "2026-08-26T10:00:00.000Z";
const OK: HarnessResult = { exitCode: 0, signal: null, timedOut: false };

function bundle(maxAttempts = 3): ConfigBundle {
  return {
    revision: REVISION,
    root: "/config",
    controller: {
      apiVersion: "agent-flow/v1alpha1", kind: "ControllerConfig",
      configuration: { repository: "config", flow: "config/flow.yaml", catalog: "config/agents.yaml" },
      providers: { github: { apiUrl: "https://api.github.test", tokenEnv: "GITHUB_TOKEN", repositories: ["owner/repo"] } },
      polling: { intervalSeconds: 30, maxCallsPerMinute: 60, quotaReservePercent: 20 },
      runtime: { concurrency: 4, dataDirectory: "/data", healthPort: 8080 },
    },
    flow: {
      apiVersion: "agent-flow/v1alpha1", kind: "Flow",
      metadata: { id: "development", activationLabel: "agent-flow:development", managedLabel: "agent-flow:managed" },
      spec: { initial: "development", states: {
        development: { kind: "agent", agent: "developer", resultContract: "development" },
        blocked: { kind: "paused" }, done: { kind: "final" },
      } },
    },
    catalog: { apiVersion: "agent-flow/v1alpha1", kind: "AgentCatalog", agents: {
      developer: { package: "agent-packages/developer", target: "codex", retry: {
        maxAttempts, delaySeconds: 7, timeoutSeconds: 90,
      } },
    } },
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
    open: true, labels: ["agent-flow:development", "agent-stage:development"], updatedAt: NOW,
    activation: { present: true, eventId: "event-1", actor, occurredAt: NOW }, comments: [],
    changeRequest: { provider: "github", repository: "owner/repo", number: 8,
      url: "https://github.test/owner/repo/pull/8", headSha: HEAD, state: "open", actor, updatedAt: NOW },
  };
}

function request(options: { bundle?: ConfigBundle; control?: ControlState; inputRevision?: string } = {}): AttemptRequest {
  const configured = options.bundle ?? bundle();
  const ticket = snapshot();
  return { ref: ticket.ref, snapshot: ticket, control: options.control ?? control(), bundle: configured,
    stateId: "development", state: configured.flow.spec.states.development!, agentId: "developer", mode: "stage",
    sourceComment: null, resultContract: "development", inputRevision: options.inputRevision ?? "input:one" };
}

function receipt(attemptId: string, outcome: AgentReceipt["outcome"] = "succeeded"): AgentReceipt {
  if (outcome === "failed") return { apiVersion: "agent-flow/v1alpha1", kind: "AgentReceipt", flowInstanceId: FLOW,
    attemptId, outcome, summary: "failed", artifacts: [], error: { code: "SECRET", message: "token=secret" } };
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
  events: string[]; controls: ControlState[]; attempts: string[]; delays: number[];
  process: ReturnType<typeof deferred<HarnessResult>>;
  runner: ReturnType<typeof createAttemptRunner>; request: AttemptRequest;
}

function fixture(options: {
  request?: AttemptRequest; results?: Array<HarnessResult | Error | Promise<HarnessResult>>;
  verify?: (attemptId: string) => Promise<AgentReceipt>; write?: AttemptRunnerDependencies["writeControl"];
  ids?: string[]; compileError?: Error; delay?: (milliseconds: number) => Promise<void>;
} = {}): Fixture {
  const events: string[] = [], controls: ControlState[] = [], attempts: string[] = [], delays: number[] = [];
  const process = deferred<HarnessResult>();
  const configuredRequest = options.request ?? request();
  const results = [...(options.results ?? [process.promise])];
  let current = configuredRequest.control;
  const ids = [...(options.ids ?? [SERIES, ATTEMPT_1, ATTEMPT_2])];
  const harness: HarnessAdapter = { target: "codex", async preflight() {}, async run(input) {
    events.push("harness:spawn");
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
    dataDirectory: "/data", provider: { kind: "github" } as ProviderAdapter,
    workspaceManager: { async prepareWorkspace() { events.push("workspace:prepare"); return {
      baseClone: "/data/repositories/repo", worktree: "/data/worktrees/flow", repository: "owner/repo",
      ticketNumber: 7, flowInstanceId: FLOW,
    }; } }, harnesses: { codex: harness }, writeControl,
    async createSession(_data, _flow, attemptId, context) { attempts.push(attemptId); events.push("session:create");
      assert.equal(context.controlState.attemptSeries?.current?.attemptId, attemptId); return {
        root: `/data/sessions/${attemptId}`, contextPath: `/data/sessions/${attemptId}/context.json`,
        receiptPath: `/data/sessions/${attemptId}/receipt.json`, logPath: `/data/sessions/${attemptId}/harness.log`,
        harnessSessionDirectory: `/data/sessions/${attemptId}/harness-session`,
      }; },
    async compileAgent(agentId, packageDirectory, target) { events.push("apm:compile");
      assert.equal(packageDirectory, "/config/agent-packages/developer");
      if (options.compileError) throw options.compileError;
      return { agentId, target, instructions: "instructions", runtimeDirectory: "/runtime" }; },
    async verifyReceipt(_path, expected) { events.push("receipt:verify");
      return options.verify?.(expected.attemptId) ?? receipt(expected.attemptId); },
    async delay(milliseconds) { delays.push(milliseconds); events.push("delay"); await options.delay?.(milliseconds); },
    now: () => NOW, newId: () => ids.shift()!,
  });
  return { events, controls, attempts, delays, process, runner, request: configuredRequest };
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
  assert.deepEqual(subject.events.slice(0, 6), ["control:update-started", "control:readback", "workspace:prepare",
    "session:create", "apm:compile", "harness:spawn"]);
  assert.equal(subject.controls[0]!.attemptSeries?.consumed, 1);
  subject.process.resolve(OK); await waitIdle(subject);
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
  assert.equal(subject.controls.at(-1)!.attemptSeries?.current?.status, "succeeded");
  assert.equal(subject.controls.at(-1)!.attemptSeries?.consumed, 2);
});

test("retries timeout, retryable harness, and transient receipt readback failures", async () => {
  const cases: Array<HarnessResult | Error> = [
    { exitCode: null, signal: "SIGTERM", timedOut: true }, new HarnessProcessError("codex", true),
    new ReceiptReadbackError(),
  ];
  for (const first of cases) {
    let verifyCalls = 0;
    const providerCase = first instanceof ReceiptReadbackError;
    const subject = fixture({ results: providerCase ? [OK, OK] : [first, OK], verify: async (attemptId) => {
      verifyCalls += 1; if (providerCase && verifyCalls === 1) throw first; return receipt(attemptId);
    } });
    await subject.runner.start(subject.request); await waitIdle(subject);
    assert.deepEqual(subject.delays, [7_000]);
    assert.equal(subject.controls.at(-1)!.attemptSeries?.current?.status, "succeeded");
    assert.equal(JSON.stringify(subject.controls).includes("secret"), false);
  }
});

test("blocks non-retryable harness and receipt failures without leaking messages", async () => {
  const cases: Array<{ result?: Error; verify?: () => Promise<AgentReceipt>; code: string }> = [
    { result: new HarnessPreflightError("codex"), code: "HARNESS_PREFLIGHT_FAILED" },
    { result: new HarnessProcessError("codex", false), code: "HARNESS_PROCESS_FAILED" },
    { verify: async () => { throw new InvalidReceiptError("token=secret"); }, code: "INVALID_RECEIPT" },
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
  const disallowed = bundle();
  disallowed.controller.providers.github!.repositories = ["owner/other"];
  const badRevision = request({ control: control({ configRevision: "c".repeat(40) }) });
  for (const invalid of [request({ bundle: disallowed }), badRevision]) {
    const subject = fixture({ request: invalid });
    await assert.rejects(subject.runner.start(subject.request));
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
  const subject = fixture({ results: [OK], verify: async (attemptId) => receipt(attemptId, "needs-human") });
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
  const subject = fixture(); await subject.runner.start(subject.request);
  const cancelling = subject.runner.cancel(FLOW);
  subject.process.resolve({ exitCode: null, signal: "SIGTERM", timedOut: false });
  await cancelling;
  assert.equal(subject.runner.isRunning(FLOW), false);
  assert.equal(subject.controls.at(-1)!.attemptSeries?.current?.status, "started");
  await subject.runner.cancel(FLOW);
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
  assert.equal(subject.controls[0]!.attemptSeries?.seriesId, SERIES);
  assert.equal(subject.controls[0]!.attemptSeries?.consumed, 1);
  assert.equal(subject.controls[0]!.attemptSeries?.current?.status, "failed");
  assert.equal(subject.controls[0]!.attemptSeries?.current?.error?.code, "CONTROLLER_RESTARTED");
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
  assert.equal(subject.controls[0]!.attemptSeries?.seriesId, SERIES);
  assert.equal(subject.controls[0]!.attemptSeries?.consumed, 2);
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
    configured.catalog.agents.developer!.retry.delaySeconds = 3_600;
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
    assert.deepEqual(subject.delays, [3_600_000]);
    assert.equal(subject.events.includes("harness:spawn"), false);
    await subject.runner.cancel(FLOW);
    assert.equal(subject.runner.isRunning(FLOW), false);
  }
});
