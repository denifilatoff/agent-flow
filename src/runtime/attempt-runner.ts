import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

import { validateBundleDocument, type ConfigBundle } from "../config/load.ts";
import type {
  AgentReceipt,
  Attempt,
  AttemptSeries,
  ControlChangeRequest,
  ControlHumanGate,
  ControlState,
  ControlState as PersistedControl,
  ExecutionSnapshot,
} from "../config/types.js";
import { validateDocument } from "../config/schema-validator.ts";
import { compileAgentContext, type CompiledAgent } from "../harness/apm.ts";
import type { HarnessAdapter, HarnessResult, ProviderCredential } from "../harness/types.ts";
import { advanceControlState, type ControlStatePatch } from "../provider/control-comment.ts";
import type { ProviderAdapter, ProviderArtifact } from "../provider/types.js";
import type { AttemptLauncher, AttemptRequest } from "./reconcile.ts";
import { renderRuntimePrompt } from "./agent-protocol.ts";
import { readDecisionAndBuildReceipt } from "./receipts.ts";
import { createAttemptSession, type AttemptContext } from "./sessions.ts";
import { WorkspaceManager } from "./workspaces.ts";
import { AttemptError, classifyAttemptError, controlError } from "./errors.ts";
import { writeControlCas, type ControlWriter } from "./control-state.ts";

export interface AttemptRunnerDependencies {
  dataDirectory: string;
  provider: ProviderAdapter;
  providerConfig: { apiUrl: string; repositories: string[] };
  providerCredential: ProviderCredential;
  preparePinnedAgent(
    revision: string,
    agentId: string,
    destination: string,
  ): Promise<{ bundle: ConfigBundle; packageDirectory: string }>;
  execution(agentId: string): Promise<{ runtimeDigest: string; executionSnapshot: ExecutionSnapshot }>;
  attemptStarted?(): void;
  attemptFinished?(): void;
  workspaceManager: Pick<WorkspaceManager, "prepareWorkspace">;
  harnesses: Partial<Record<"claude" | "codex", HarnessAdapter>>;
  writeControl: ControlWriter;
  createSession?: typeof createAttemptSession;
  compileAgent?: typeof compileAgentContext;
  verifyDecision?: typeof readDecisionAndBuildReceipt;
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
  const verifyDecision = dependencies.verifyDecision ?? readDecisionAndBuildReceipt;
  const delay = dependencies.delay ?? ((milliseconds) =>
    new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds)));
  const now = dependencies.now ?? (() => new Date().toISOString());
  const newId = dependencies.newId ?? randomUUID;
  let onSettled: ((ref: AttemptRequest["ref"]) => void) | undefined;

  return {
    async start(request): Promise<void> {
      const flowId = request.control.flowInstanceId;
      if (active.has(flowId)) return;
      const persisted = matchingSeries(request.control.attemptSeries, request)
        ? request.control.attemptSeries : null;
      const binding = persisted?.runtimeDigest && persisted.executionSnapshot
        ? { runtimeDigest: persisted.runtimeDigest, executionSnapshot: persisted.executionSnapshot }
        : await dependencies.execution(request.agentId);
      const config = validateRequest(request, dependencies, binding.executionSnapshot);
      if (shouldNotStart(request, binding.executionSnapshot.maxAttempts)) return;

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
      dependencies.attemptStarted?.();
      const job = runSeries(request, config, binding, running);
      running.completion = job.catch((error: unknown) => {
        if (!running.launched) running.rejectReady(classifyAttemptError(error));
      }).finally(() => {
        dependencies.attemptFinished?.();
        if (!running.launched) running.resolveReady();
        if (active.get(flowId) === running) active.delete(flowId);
        if (running.launched && !running.cancelled) onSettled?.(request.ref);
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

    onSettled(listener): void {
      onSettled = listener;
    },
  };

  async function runSeries(
    request: AttemptRequest,
    config: ReturnType<typeof validateRequest>,
    binding: { runtimeDigest: string; executionSnapshot: ExecutionSnapshot },
    running: ActiveAttempt,
  ): Promise<void> {
    let control = request.control;
    let series = matchingSeries(control.attemptSeries, request)
      ? control.attemptSeries!
      : newSeries(request, binding, newId());

    if (!series.runtimeDigest || !series.executionSnapshot) {
      series = { ...series, runtimeDigest: binding.runtimeDigest, executionSnapshot: binding.executionSnapshot };
      control = await persist(dependencies, now(), request, running, control, { attemptSeries: series });
    }

    if (series.current?.status === "started") {
      const interrupted: AttemptSeries = {
        ...series,
        current: {
          ...series.current,
          status: "failed",
          finishedAt: now(),
          error: {
            code: "CONTROLLER_RESTARTED",
            message: "attempt was interrupted by a controller restart",
          },
        },
      };
      if (interrupted.consumed >= interrupted.maxAttempts) {
        await persistBlocked(
          dependencies,
          now(),
          request,
          running,
          control,
          interrupted,
          interrupted.current!.error!,
        );
        running.resolveReady();
        return;
      }
      control = await persist(
        dependencies,
        now(),
        request,
        running,
        control,
        { attemptSeries: interrupted },
      );
      series = interrupted;
      running.resolveReady();
      await cancellableDelay(config.executionSnapshot.delaySeconds * 1_000, running, delay);
      if (running.cancelled) return;
    } else if (series.current?.status === "failed" && series.consumed < series.maxAttempts) {
      running.resolveReady();
      await cancellableDelay(config.executionSnapshot.delaySeconds * 1_000, running, delay);
      if (running.cancelled) return;
    }

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

      if (running.cancelled) return;

      try {
        const workspace = await dependencies.workspaceManager.prepareWorkspace(
          request.snapshot.repository,
          request.ref,
          control.flowInstanceId,
          dependencies.providerCredential,
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
        const prepared = await dependencies.preparePinnedAgent(
          control.configRevision,
          request.agentId,
          join(session.root, "pinned-package"),
        );
        const pinnedState = selectedState(prepared.bundle, control);
        if (!pinnedState) {
          throw new AttemptError("CONFIGURATION_INVALID", "attempt state is missing from pinned configuration", false);
        }
        validateRequest(
          { ...request, bundle: prepared.bundle, state: pinnedState },
          dependencies,
          config.executionSnapshot,
        );
        const compiled = await compileAgent(
          request.agentId,
          prepared.packageDirectory,
          config.executionSnapshot.harness,
          session.harnessSessionDirectory,
        );
        assertCompiled(compiled, request.agentId, config.executionSnapshot.harness);
        const harness = dependencies.harnesses[config.executionSnapshot.harness];
        if (!harness || harness.target !== config.executionSnapshot.harness) {
          throw new AttemptError("HARNESS_NOT_CONFIGURED", "configured harness is unavailable", false);
        }
        const prompt = renderRuntimePrompt({
          flow: request.bundle.flow,
          stateId: request.stateId,
          mode: request.mode,
          resultContract: request.resultContract,
          flowInstanceId: control.flowInstanceId,
          attemptId: attempt.attemptId,
          contextPath: session.contextPath,
          decisionPath: session.decisionPath,
          changeRequest: request.snapshot.changeRequest,
          sourceComment: request.sourceComment,
        });
        const resultPromise = harness.run({
          workspace,
          session,
          compiledAgent: compiled,
          stagePrompt: prompt,
          timeoutSeconds: config.executionSnapshot.timeoutSeconds,
          signal: running.abort.signal,
          providerCredential: config.providerCredential,
          execution: config.executionSnapshot,
        });
        if (!running.launched) {
          running.launched = true;
          running.resolveReady();
        }
        const result = await resultPromise;
        if (running.cancelled || running.abort.signal.aborted) return;
        assertProcessResult(result);
        const receipt = await verifyDecision(
          session.decisionPath,
          {
            flow: request.bundle.flow,
            stateId: request.stateId,
            mode: request.mode,
            resultContract: request.resultContract,
            flowInstanceId: control.flowInstanceId,
            attemptId: attempt.attemptId,
            ticket: request.ref,
            startedAt: attempt.startedAt,
            sourceComment: request.sourceComment,
            pinnedChangeRequest: request.snapshot.changeRequest,
          },
          dependencies.provider,
          running.cancelled,
          (kind, value) => validateBundleDocument(request.bundle, kind, value),
        );
        if (running.cancelled || running.abort.signal.aborted) return;
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
        if (running.cancelled || running.abort.signal.aborted) return;
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
        await cancellableDelay(config.executionSnapshot.delaySeconds * 1_000, running, delay);
        if (running.cancelled) return;
      }
    }
  }
}

function validateRequest(
  request: AttemptRequest,
  dependencies: AttemptRunnerDependencies,
  executionSnapshot: ExecutionSnapshot,
) {
  validateBundleDocument<PersistedControl>(request.bundle, "ControlState", request.control);
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
    || selectedState(bundle, control) !== request.state
    || request.state.agent !== request.agentId) {
    throw new AttemptError("CONFIGURATION_INVALID", "attempt does not match pinned configuration", false);
  }
  if (!snapshot.open || !snapshot.activation.present || request.state.kind === "final") {
    throw new AttemptError("FLOW_NOT_ACTIVE", "flow is not active", false);
  }
  const providerConfig = dependencies.providerConfig;
  if (!providerConfig.repositories.includes(ref.repository)) {
    throw new AttemptError("REPOSITORY_NOT_ALLOWED", "repository is not allowlisted", false);
  }
  const providerCredential = dependencies.providerCredential;
  if (providerCredential.provider !== ref.provider
    || providerCredential.apiUrl !== providerConfig.apiUrl) {
    throw new AttemptError("PROVIDER_CREDENTIAL_INVALID", "provider credential does not match", false);
  }
  const agent = bundle.catalog.agents[request.agentId];
  if (!agent) throw new AttemptError("AGENT_NOT_CONFIGURED", "agent is not configured", false);
  assertModeContract(request);
  const packageDirectory = safePackageDirectory(bundle, agent.package);
  return { ...agent, packageDirectory, providerCredential, executionSnapshot };
}

function selectedState(bundle: ConfigBundle, control: ControlState) {
  if (control.stateId !== "needs-human") return bundle.flow.spec.states[control.stateId];
  return control.resumeStateId ? bundle.flow.spec.states[control.resumeStateId] : undefined;
}

function assertModeContract(request: AttemptRequest): void {
  if (request.control.stateId === "needs-human") {
    if (!request.control.resumeStateId) {
      throw new AttemptError("CONFIGURATION_INVALID", "paused attempt has no resume state", false);
    }
    if (request.mode === "human-input") {
      if (!request.sourceComment || request.resultContract !== "human-gate") {
        throw new AttemptError("CONFIGURATION_INVALID", "human input attempt contract is invalid", false);
      }
    } else if (request.sourceComment || request.resultContract !== request.state.resultContract) {
      throw new AttemptError("CONFIGURATION_INVALID", "paused stage attempt contract is invalid", false);
    }
    return;
  }
  if (request.state.kind === "human-gate") {
    if (request.mode !== "human-input" || !request.sourceComment || request.resultContract !== "human-gate") {
      throw new AttemptError("CONFIGURATION_INVALID", "human gate attempt contract is invalid", false);
    }
  } else if (request.mode !== "stage" || request.sourceComment || request.resultContract !== request.state.resultContract) {
    throw new AttemptError("CONFIGURATION_INVALID", "agent stage attempt contract is invalid", false);
  }
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
  return series!.current?.status === "succeeded"
    || series!.current?.status === "cancelled";
}

function matchingSeries(series: AttemptSeries | null, request: AttemptRequest): boolean {
  return series?.agentId === request.agentId
    && series.stateId === request.stateId
    && series.inputRevision === request.inputRevision;
}

function newSeries(
  request: AttemptRequest,
  binding: { runtimeDigest: string; executionSnapshot: ExecutionSnapshot },
  seriesId: string,
): AttemptSeries {
  return {
    seriesId,
    agentId: request.agentId,
    stateId: request.stateId,
    inputRevision: request.inputRevision,
    runtimeDigest: binding.runtimeDigest,
    executionSnapshot: binding.executionSnapshot,
    maxAttempts: binding.executionSnapshot.maxAttempts,
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
  const readback = await writeControlCas(dependencies.writeControl, request.ref, control, next);
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
