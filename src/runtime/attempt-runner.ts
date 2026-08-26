import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import type { ConfigBundle } from "../config/load.js";
import type {
  AgentReceipt,
  Attempt,
  AttemptSeries,
  ControlChangeRequest,
  ControlHumanGate,
  ControlState,
  ControlState as PersistedControl,
} from "../config/types.js";
import { validateDocument } from "../config/schema-validator.ts";
import { compileAgentContext, type CompiledAgent } from "../harness/apm.ts";
import type { HarnessAdapter, HarnessResult } from "../harness/types.ts";
import { advanceControlState, type ControlStatePatch } from "../provider/control-comment.ts";
import type { ProviderAdapter, ProviderArtifact, TicketRef } from "../provider/types.js";
import type { AttemptLauncher, AttemptRequest } from "./reconcile.ts";
import { readAndVerifyReceipt } from "./receipts.ts";
import { createAttemptSession, type AttemptContext } from "./sessions.ts";
import { WorkspaceManager } from "./workspaces.ts";
import { AttemptError, classifyAttemptError, controlError } from "./errors.ts";

export interface ControlWriteExpectation {
  flowInstanceId: string;
  sequence: number;
}

export interface AttemptRunnerDependencies {
  dataDirectory: string;
  provider: ProviderAdapter;
  workspaceManager: Pick<WorkspaceManager, "prepareWorkspace">;
  harnesses: Partial<Record<"claude" | "codex", HarnessAdapter>>;
  writeControl(
    ref: TicketRef,
    expected: ControlWriteExpectation,
    next: ControlState,
  ): Promise<ControlState>;
  createSession?: typeof createAttemptSession;
  compileAgent?: typeof compileAgentContext;
  verifyReceipt?: typeof readAndVerifyReceipt;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => string;
  newId?: () => string;
}

interface ActiveAttempt {
  abort: AbortController;
  attemptId: string | null;
  cancelled: boolean;
  completion: Promise<void>;
  control: ControlState;
  launched: boolean;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: unknown): void;
}

export function createAttemptRunner(dependencies: AttemptRunnerDependencies): AttemptLauncher {
  const active = new Map<string, ActiveAttempt>();
  const createSession = dependencies.createSession ?? createAttemptSession;
  const compileAgent = dependencies.compileAgent ?? compileAgentContext;
  const verifyReceipt = dependencies.verifyReceipt ?? readAndVerifyReceipt;
  const delay = dependencies.delay ?? ((milliseconds) =>
    new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds)));
  const now = dependencies.now ?? (() => new Date().toISOString());
  const newId = dependencies.newId ?? randomUUID;

  return {
    async start(request): Promise<void> {
      const config = validateRequest(request, dependencies);
      const flowId = request.control.flowInstanceId;
      if (active.has(flowId) || shouldNotStart(request, config.retry.maxAttempts)) return;

      let resolveReady!: () => void;
      let rejectReady!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const running: ActiveAttempt = {
        abort: new AbortController(),
        attemptId: null,
        cancelled: false,
        completion: Promise.resolve(),
        control: request.control,
        launched: false,
        ready,
        resolveReady,
        rejectReady,
      };
      active.set(flowId, running);
      const job = runSeries(request, config, running);
      running.completion = job.catch((error: unknown) => {
        if (!running.launched) running.rejectReady(error);
      }).finally(() => {
        if (!running.launched) running.resolveReady();
        if (active.get(flowId) === running) active.delete(flowId);
      });
      await running.ready;
    },

    async cancel(flowInstanceId): Promise<void> {
      const running = active.get(flowInstanceId);
      if (!running) return;
      running.cancelled = true;
      running.abort.abort();
      await running.completion;
    },

    isRunning(flowInstanceId): boolean {
      return active.has(flowInstanceId);
    },
  };

  async function runSeries(
    request: AttemptRequest,
    config: ReturnType<typeof validateRequest>,
    running: ActiveAttempt,
  ): Promise<void> {
    let control = request.control;
    let series = matchingSeries(control.attemptSeries, request)
      ? control.attemptSeries!
      : newSeries(request, config.retry.maxAttempts, newId());

    if (series.current?.status === "failed" && series.consumed >= series.maxAttempts) {
      await persistBlocked(
        dependencies,
        now(),
        request,
        running,
        control,
        series,
        series.current.error ?? {
          code: "ATTEMPT_BUDGET_EXHAUSTED",
          message: "attempt retry budget exhausted",
        },
      );
      running.resolveReady();
      return;
    }

    while (series.consumed < series.maxAttempts) {
      if (running.cancelled) return;
      const attempt: Attempt = {
        attemptId: newId(),
        status: "started",
        startedAt: now(),
      };
      running.attemptId = attempt.attemptId;
      series = { ...series, consumed: series.consumed + 1, current: attempt };
      control = await persist(dependencies, now(), request, running, control, { attemptSeries: series });

      if (running.cancelled) {
        await persistCancelled(dependencies, now(), request, running, control, series, attempt);
        return;
      }

      try {
        const workspace = await dependencies.workspaceManager.prepareWorkspace(
          request.snapshot.repository,
          request.ref,
          control.flowInstanceId,
        );
        assertCurrent(running, series, attempt);
        const context = attemptContext(request, control);
        const session = await createSession(
          dependencies.dataDirectory,
          control.flowInstanceId,
          attempt.attemptId,
          context,
        );
        assertCurrent(running, series, attempt);
        const compiled = await compileAgent(
          request.agentId,
          config.packageDirectory,
          config.target,
          session.harnessSessionDirectory,
        );
        assertCompiled(compiled, request.agentId, config.target);
        const harness = dependencies.harnesses[config.target];
        if (!harness || harness.target !== config.target) {
          throw new AttemptError("HARNESS_NOT_CONFIGURED", "configured harness is unavailable", false);
        }
        const resultPromise = harness.run({
          workspace,
          session,
          compiledAgent: compiled,
          stagePrompt: stagePrompt(request),
          timeoutSeconds: config.retry.timeoutSeconds,
          signal: running.abort.signal,
        });
        if (!running.launched) {
          running.launched = true;
          running.resolveReady();
        }
        const result = await resultPromise;
        if (running.cancelled || running.abort.signal.aborted) {
          await persistCancelled(dependencies, now(), request, running, control, series, attempt);
          return;
        }
        assertProcessResult(result);
        const receipt = await verifyReceipt(
          session.receiptPath,
          {
            flowInstanceId: control.flowInstanceId,
            attemptId: attempt.attemptId,
            resultContract: request.resultContract,
            ticket: request.ref,
            pinnedHeadSha: request.snapshot.changeRequest?.headSha ?? null,
          },
          dependencies.provider,
          running.cancelled,
        );
        if (running.cancelled || running.abort.signal.aborted) {
          await persistCancelled(dependencies, now(), request, running, control, series, attempt);
          return;
        }
        if (receipt.outcome === "failed") {
          throw new AttemptError("AGENT_REPORTED_FAILURE", "agent reported a technical failure", true);
        }
        series = {
          ...series,
          current: { ...attempt, status: "succeeded", finishedAt: now() },
        };
        await persist(
          dependencies,
          now(),
          request,
          running,
          control,
          successPatch(request, control, series, receipt),
        );
        return;
      } catch (error) {
        if (running.cancelled || running.abort.signal.aborted) {
          await persistCancelled(dependencies, now(), request, running, control, series, attempt);
          return;
        }
        const classified = classifyAttemptError(error);
        const failedSeries: AttemptSeries = {
          ...series,
          current: {
            ...attempt,
            status: "failed",
            finishedAt: now(),
            error: controlError(classified),
          },
        };
        const exhausted = failedSeries.consumed >= failedSeries.maxAttempts;
        if (!classified.retryable || exhausted) {
          await persistBlocked(
            dependencies,
            now(),
            request,
            running,
            control,
            failedSeries,
            controlError(classified),
          );
          if (!running.launched) throw classified;
          return;
        }
        control = await persist(
          dependencies,
          now(),
          request,
          running,
          control,
          { attemptSeries: failedSeries },
        );
        series = failedSeries;
        await cancellableDelay(config.retry.delaySeconds * 1_000, running, delay);
        if (running.cancelled) return;
      }
    }
  }
}

function validateRequest(request: AttemptRequest, dependencies: AttemptRunnerDependencies) {
  validateDocument<PersistedControl>("ControlState", request.control);
  const { bundle, control, ref, snapshot } = request;
  if (dependencies.provider.kind !== ref.provider
    || snapshot.ref.provider !== ref.provider
    || snapshot.ref.repository !== ref.repository
    || snapshot.ref.number !== ref.number
    || snapshot.repository.provider !== ref.provider
    || snapshot.repository.name !== ref.repository) {
    throw new AttemptError("TICKET_IDENTITY_INVALID", "ticket identity does not match", false);
  }
  if (control.configRevision !== bundle.revision
    || control.flowId !== bundle.flow.metadata.id
    || request.stateId !== control.stateId
    || bundle.flow.spec.states[control.stateId] !== request.state
    || request.state.agent !== request.agentId) {
    throw new AttemptError("CONFIGURATION_INVALID", "attempt does not match pinned configuration", false);
  }
  if (!snapshot.open || !snapshot.activation.present || request.state.kind === "final") {
    throw new AttemptError("FLOW_NOT_ACTIVE", "flow is not active", false);
  }
  const providerConfig = bundle.controller.providers[ref.provider];
  if (!providerConfig?.repositories.includes(ref.repository)) {
    throw new AttemptError("REPOSITORY_NOT_ALLOWED", "repository is not allowlisted", false);
  }
  const agent = bundle.catalog.agents[request.agentId];
  if (!agent) throw new AttemptError("AGENT_NOT_CONFIGURED", "agent is not configured", false);
  const packageDirectory = safePackageDirectory(bundle, agent.package);
  return { ...agent, packageDirectory };
}

function safePackageDirectory(bundle: ConfigBundle, packagePath: string): string {
  const root = resolve(bundle.root);
  const candidate = resolve(root, packagePath);
  const child = relative(root, candidate);
  if (child === "" || child.startsWith("..") || isAbsolute(child)) {
    throw new AttemptError("AGENT_PACKAGE_INVALID", "agent package path is invalid", false);
  }
  return candidate;
}

function shouldNotStart(request: AttemptRequest, maxAttempts: number): boolean {
  const series = request.control.attemptSeries;
  if (!matchingSeries(series, request)) return false;
  if (series!.maxAttempts !== maxAttempts) {
    throw new AttemptError("RETRY_POLICY_MISMATCH", "persisted retry policy does not match configuration", false);
  }
  return series!.current?.status === "started"
    || series!.current?.status === "succeeded"
    || series!.current?.status === "cancelled";
}

function matchingSeries(series: AttemptSeries | null, request: AttemptRequest): boolean {
  return series?.agentId === request.agentId
    && series.stateId === request.stateId
    && series.inputRevision === request.inputRevision;
}

function newSeries(request: AttemptRequest, maxAttempts: number, seriesId: string): AttemptSeries {
  return {
    seriesId,
    agentId: request.agentId,
    stateId: request.stateId,
    inputRevision: request.inputRevision,
    maxAttempts,
    consumed: 0,
    current: null,
  };
}

async function persist(
  dependencies: AttemptRunnerDependencies,
  timestamp: string,
  request: AttemptRequest,
  running: ActiveAttempt,
  control: ControlState,
  patch: ControlStatePatch,
): Promise<ControlState> {
  if (running.control.sequence !== control.sequence) {
    throw new AttemptError("CONTROL_CONFLICT", "control state changed concurrently", false);
  }
  const next = advanceControlState(control, patch, timestamp);
  const readback = await dependencies.writeControl(
    request.ref,
    { flowInstanceId: control.flowInstanceId, sequence: control.sequence },
    next,
  );
  if (JSON.stringify(readback) !== JSON.stringify(next)) {
    throw new AttemptError("CONTROL_READBACK_MISMATCH", "control state readback does not match", false);
  }
  running.control = readback;
  return readback;
}

function attemptContext(request: AttemptRequest, controlState: ControlState): AttemptContext {
  const artifacts: ProviderArtifact[] = [...request.snapshot.comments];
  if (request.snapshot.changeRequest) artifacts.push(request.snapshot.changeRequest);
  return { ticket: request.snapshot, controlState, artifacts, mode: request.mode };
}

function assertCompiled(compiled: CompiledAgent, agentId: string, target: "claude" | "codex"): void {
  if (compiled.agentId !== agentId || compiled.target !== target) {
    throw new AttemptError("APM_OUTPUT_INVALID", "compiled agent does not match the catalog", false);
  }
}

function assertProcessResult(result: HarnessResult): void {
  if (result.timedOut) throw new AttemptError("HARNESS_TIMEOUT", "harness timed out", true);
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new AttemptError("HARNESS_EXIT_FAILED", "harness exited unsuccessfully", true);
  }
}

function assertCurrent(running: ActiveAttempt, series: AttemptSeries, attempt: Attempt): void {
  if (running.cancelled || running.attemptId !== attempt.attemptId
    || series.current?.attemptId !== attempt.attemptId) {
    throw new AttemptError("ATTEMPT_CANCELLED", "attempt was cancelled", false);
  }
}

function stagePrompt(request: AttemptRequest): string {
  return `Run the ${request.agentId} agent for flow state ${request.stateId}. Read the supplied context and write the required receipt.`;
}

function successPatch(
  request: AttemptRequest,
  control: ControlState,
  series: AttemptSeries,
  receipt: AgentReceipt,
): ControlStatePatch {
  return {
    attemptSeries: series,
    latestReceipt: receipt,
    humanGate: receipt.humanGate ? humanGate(request, receipt) : control.humanGate,
    changeRequest: receiptChangeRequest(request, receipt) ?? control.changeRequest,
  };
}

function humanGate(request: AttemptRequest, receipt: AgentReceipt): ControlHumanGate {
  if (!receipt.humanGate || !request.sourceComment) {
    throw new AttemptError("HUMAN_GATE_INVALID", "verified human gate has no source comment", false);
  }
  return {
    ...receipt.humanGate,
    actor: request.sourceComment.actor,
    interpretedByAttemptId: receipt.attemptId,
  };
}

function receiptChangeRequest(request: AttemptRequest, receipt: AgentReceipt): ControlChangeRequest | null {
  const artifact = receipt.artifacts.find((candidate) => candidate.kind === "change-request");
  if (!artifact || artifact.kind !== "change-request") return null;
  return {
    provider: request.ref.provider,
    repository: request.ref.repository,
    number: artifact.number,
    url: artifact.url,
    headSha: artifact.headSha,
    state: artifact.state,
  };
}

async function persistBlocked(
  dependencies: AttemptRunnerDependencies,
  timestamp: string,
  request: AttemptRequest,
  running: ActiveAttempt,
  control: ControlState,
  series: AttemptSeries,
  error: { code: string; message: string },
): Promise<void> {
  const current = series.current;
  const failed = current?.status === "failed" ? current : current ? {
    ...current,
    status: "failed" as const,
    finishedAt: timestamp,
    error,
  } : null;
  await persist(dependencies, timestamp, request, running, control, {
    stateId: "blocked",
    resumeStateId: request.stateId,
    attemptSeries: { ...series, current: failed },
  });
}

async function persistCancelled(
  dependencies: AttemptRunnerDependencies,
  timestamp: string,
  request: AttemptRequest,
  running: ActiveAttempt,
  control: ControlState,
  series: AttemptSeries,
  attempt: Attempt,
): Promise<void> {
  if (series.current?.attemptId !== attempt.attemptId || running.attemptId !== attempt.attemptId) return;
  await persist(dependencies, timestamp, request, running, control, {
    attemptSeries: {
      ...series,
      current: { ...attempt, status: "cancelled", finishedAt: timestamp },
    },
  });
}

async function cancellableDelay(
  milliseconds: number,
  running: ActiveAttempt,
  delay: (milliseconds: number) => Promise<void>,
): Promise<void> {
  if (running.cancelled) return;
  await Promise.race([
    delay(milliseconds),
    new Promise<void>((resolveAbort) => {
      running.abort.signal.addEventListener("abort", () => resolveAbort(), { once: true });
    }),
  ]);
}
