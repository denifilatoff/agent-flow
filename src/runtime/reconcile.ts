import { createHash, randomUUID } from "node:crypto";

import type { ConfigBundle } from "../config/load.js";
import type {
  AttemptSeries,
  ControlChangeRequest,
  ControlState,
  FlowState,
  ResultContract,
} from "../config/types.js";
import { compileFlow } from "../flow/compile.ts";
import type { FlowActionName, FlowEvent } from "../flow/types.js";
import {
  advanceControlState,
  listControlComments,
  parseControlComment,
  parseExpectedControlComment,
  renderControlComment,
  type ParsedControlComment,
} from "../provider/control-comment.ts";
import { parsePublication } from "../provider/publication.ts";
import type {
  Permission,
  ProviderAdapter,
  ProviderComment,
  ProviderTicketSnapshot,
  RecoveryEvidence,
  TicketRef,
} from "../provider/types.js";
import { deriveEvent } from "./derive-event.ts";
import { writeControlCas, type ControlWriter } from "./control-state.ts";
import { classifyRecovery, type RecoveryDecision } from "./recovery.ts";

const AUTHORIZED = new Set<Permission>(["write", "maintain", "admin"]);

export interface AttemptRequest {
  ref: TicketRef;
  snapshot: ProviderTicketSnapshot;
  control: ControlState;
  bundle: ConfigBundle;
  stateId: string;
  state: FlowState;
  agentId: string;
  mode: "stage" | "human-input";
  sourceComment: ProviderComment | null;
  resultContract: ResultContract;
  inputRevision: string;
  controllerId: string;
  publicationKeys: readonly string[];
}

export interface AttemptLauncher {
  start(request: AttemptRequest): Promise<void>;
  cancel(flowInstanceId: string): Promise<void>;
  isRunning(flowInstanceId: string): boolean;
  onSettled?(listener: (ref: TicketRef) => void): void;
}

export interface ReconcileConfigSource {
  loadCurrent(): Promise<ConfigBundle>;
  loadPinned(revision: string): Promise<ConfigBundle>;
}

export interface ReconcileDependencies {
  provider: ProviderAdapter;
  config: ReconcileConfigSource;
  launcher: AttemptLauncher;
  writeControl: ControlWriter;
  controllerId?: string;
  recordRecovery?(
    ref: TicketRef,
    evidence: RecoveryEvidence,
    decision: RecoveryDecision,
  ): Promise<void>;
  now?: () => string;
  newFlowInstanceId?: () => string;
}

export interface ReconcileOutcome {
  flowInstanceId: string | null;
  stateId: string | null;
  changed: boolean;
  started: boolean;
  runnable: boolean;
}

interface LoadedControl {
  parsed: ParsedControlComment;
  bundle: ConfigBundle;
  terminal: boolean;
}

export async function reconcileTicket(
  dependencies: ReconcileDependencies,
  ref: TicketRef,
): Promise<ReconcileOutcome> {
  const { provider, launcher } = dependencies;
  if (provider.kind !== ref.provider) throw new Error("provider adapter does not match the ticket");

  let snapshot: ProviderTicketSnapshot;
  if (dependencies.controllerId) {
    const evidence = await providerCall(
      "provider recovery evidence read failed",
      () => provider.readRecoveryEvidence(ref),
    );
    snapshot = evidence.snapshot;
    assertSnapshot(snapshot, ref);
    let decision = classifyRecovery(evidence, dependencies.controllerId);
    if (dependencies.writeControl.load && dependencies.writeControl.recordRecovery) {
      return reconcileLocal(dependencies, evidence, decision);
    }
    const controls = recoveryControls(snapshot);
    let deferredResume = false;
    if (decision.kind === "reassess" && decision.owner) {
      try {
        const bundle = await dependencies.config.loadPinned(decision.owner.metadata.config);
        assertBundle(bundle, decision.owner.metadata.config);
        assertAllowed(bundle, ref);
        const stage = snapshot.labels.find((label) => label.startsWith("agent-stage:"))!
          .slice("agent-stage:".length);
        if (!bundle.flow.spec.states[stage]) throw new Error("provider stage does not exist in the winning flow");
      } catch {
        decision = {
          kind: "ambiguous",
          owner: decision.owner,
          reason: "winning configuration or flow is unavailable",
        };
      }
    } else if (decision.kind === "resume" && evidence.activeBoundary === "known" && controls.length === 0) {
      try {
        const bundle = await dependencies.config.loadCurrent();
        assertBundle(bundle, bundle.revision);
        assertAllowed(bundle, ref);
        const stage = snapshot.labels.find((label) => label.startsWith("agent-stage:"))!
          .slice("agent-stage:".length);
        if (!bundle.flow.spec.states[stage]) throw new Error("provider stage does not exist in the selected flow");
        deferredResume = stage !== bundle.flow.spec.initial;
      } catch {
        decision = { kind: "ambiguous", owner: null, reason: "configuration or flow is unavailable" };
      }
    }
    if (decision.kind === "inactive" && controls.length === 0) {
      await dependencies.recordRecovery?.(ref, evidence, decision);
      return outcome(null, false, false, false);
    }
    if (decision.kind === "reassess") {
      await dependencies.recordRecovery?.(ref, evidence, decision);
      return outcome(controls[0] ?? null, false, false);
    }
    if (decision.kind === "ambiguous" || decision.kind === "foreign") {
      for (const control of controls) {
        if (control.stateId !== "done" && control.stateId !== "cancelled") {
          await launcher.cancel(control.flowInstanceId);
        }
      }
      await dependencies.recordRecovery?.(ref, evidence, decision);
      return outcome(controls[0] ?? null, false, false, false);
    }
    if (deferredResume) {
      await dependencies.recordRecovery?.(ref, evidence, decision);
      return outcome(null, false, false);
    }
  } else {
    snapshot = await providerCall("provider ticket read failed", () => provider.readTicket(ref));
  }
  assertSnapshot(snapshot, ref);
  const parsed = listControlComments(snapshot.comments);
  const loaded = await loadControls(parsed, dependencies.config);
  const active = loaded.filter((entry) => !entry.terminal);
  if (active.length > 1) throw new Error("multiple active control comments");

  if (active.length === 0) {
    const latest = loaded.toSorted((left, right) =>
      right.parsed.state.updatedAt.localeCompare(left.parsed.state.updatedAt))[0];
    const seenActivation = snapshot.activation.eventId !== null
      && loaded.some((entry) => entry.parsed.state.activationEventId === snapshot.activation.eventId);
    if (!snapshot.activation.present || (latest && seenActivation)) {
      if (latest) {
        await ownLabels(
          provider,
          ref,
          snapshot.labels,
          latest.bundle,
          latest.parsed.state.stateId,
          true,
        );
      }
      return outcome(latest?.parsed.state ?? null, false, false);
    }
    return activate(dependencies, snapshot, loaded);
  }

  const current = active[0]!;
  return reconcileControl(dependencies, snapshot, current.bundle, current.parsed.state, [], false, current);
}

async function reconcileLocal(
  dependencies: ReconcileDependencies,
  evidence: RecoveryEvidence,
  decision: RecoveryDecision,
): Promise<ReconcileOutcome> {
  const snapshot = evidence.snapshot;
  const ref = snapshot.ref;
  const writer = dependencies.writeControl;
  const controllerId = dependencies.controllerId!;
  let stored = writer.load!(ref);
  if (stored && stored.value.controllerId !== controllerId) {
    throw new Error("local execution belongs to another controller identity");
  }
  let control = stored?.value.control ?? null;
  const mergedWins = control?.stateId === "awaiting-merge" && snapshot.changeRequest?.state === "merged";

  if (decision.kind === "inactive" && !mergedWins) {
    if (control && control.stateId !== "done" && control.stateId !== "cancelled") {
      control = await cancelLocal(dependencies, snapshot, control);
    }
    stored = await writer.recordRecovery!(ref, evidence, decision, control);
    return outcome(stored.value.control, control !== null, false, false);
  }
  if (decision.kind === "ambiguous" || decision.kind === "foreign") {
    if (control && control.stateId !== "done" && control.stateId !== "cancelled") {
      await dependencies.launcher.cancel(control.flowInstanceId);
    }
    stored = await writer.recordRecovery!(ref, evidence, decision, control);
    return outcome(stored.value.control, false, false, false);
  }

  let bundle: ConfigBundle;
  if (control) {
    bundle = await configCall(
      "pinned configuration load failed",
      () => dependencies.config.loadPinned(control!.configRevision),
    );
    assertBundle(bundle, control.configRevision);
    if (decision.owner && decision.owner.metadata.config !== control.configRevision) {
      const conflict: RecoveryDecision = {
        kind: "ambiguous",
        owner: decision.owner,
        reason: "winning configuration does not match local execution",
      };
      stored = await writer.recordRecovery!(ref, evidence, conflict, control);
      return outcome(stored.value.control, false, false, false);
    }
  } else {
    bundle = decision.owner
      ? await configCall(
        "pinned configuration load failed",
        () => dependencies.config.loadPinned(decision.owner!.metadata.config),
      )
      : await configCall("current configuration load failed", () => dependencies.config.loadCurrent());
    assertBundle(bundle, decision.owner?.metadata.config ?? bundle.revision);
  }
  assertAllowed(bundle, ref);

  if (!control) {
    const stage = evidence.activeBoundary === "fresh" ? bundle.flow.spec.initial : providerStage(snapshot);
    if (decision.kind === "resume" && evidence.activeBoundary !== "fresh" && stage !== bundle.flow.spec.initial) {
      await writer.recordRecovery!(ref, evidence, decision, null);
      return outcome(null, false, false);
    }
    const actor = snapshot.activation.actor;
    const eventId = snapshot.activation.eventId;
    const occurredAt = snapshot.activation.occurredAt;
    if (!actor || !eventId || !occurredAt) {
      await writer.recordRecovery!(ref, evidence, {
        kind: "ambiguous", owner: decision.owner, reason: "activation evidence is unavailable",
      }, null);
      return outcome(null, false, false, false);
    }
    const permission = await providerCall(
      "provider permission read failed",
      () => dependencies.provider.permission(ref.repository, actor),
    );
    if (!AUTHORIZED.has(permission)) {
      await writer.recordRecovery!(ref, evidence, {
        kind: "ambiguous", owner: decision.owner, reason: "activation actor lacks write permission",
      }, null);
      return outcome(null, false, false, false);
    }
    const timestamp = now(dependencies);
    const recovered: ControlState = {
      apiVersion: "agent-flow/v1alpha1",
      kind: "ControlState",
      flowInstanceId: dependencies.newFlowInstanceId?.() ?? randomUUID(),
      flowId: bundle.flow.metadata.id,
      configRevision: bundle.revision,
      sequence: 0,
      stateId: stage,
      resumeStateId: null,
      activatedBy: actor,
      activatedAt: occurredAt,
      activationEventId: eventId,
      updatedAt: timestamp,
      attemptSeries: null,
      latestReceipt: null,
      humanGate: null,
      changeRequest: normalizedChange(snapshot.changeRequest),
    };
    stored = await writer.recordRecovery!(ref, evidence, decision, recovered, decision.kind === "reassess" ? [] : undefined);
    control = stored.value.control!;
  }

  return reconcileControl(
    dependencies,
    snapshot,
    bundle,
    control,
    stored?.value.publicationKeys ?? evidence.publications.map(({ key }) => key),
    true,
    undefined,
    evidence.publications.map(({ key }) => key),
  );
}

async function reconcileControl(
  dependencies: ReconcileDependencies,
  snapshot: ProviderTicketSnapshot,
  bundle: ConfigBundle,
  control: ControlState,
  publicationKeys: readonly string[],
  local: boolean,
  legacy?: LoadedControl,
  observedKeys: readonly string[] = publicationKeys,
): Promise<ReconcileOutcome> {
  const { provider, launcher } = dependencies;
  const ref = snapshot.ref;
  assertAllowed(bundle, ref);
  if (control.stateId === "awaiting-merge") assertChangeIdentity(control.changeRequest, snapshot.changeRequest);
  const mergedWins = control.stateId === "awaiting-merge" && snapshot.changeRequest?.state === "merged";
  if ((!snapshot.activation.present || !snapshot.open) && !mergedWins) {
    return local ? cancelLocalOutcome(dependencies, snapshot, control) : cancel(dependencies, snapshot, legacy!);
  }

  let next = control;
  let changed = false;
  let machineEvent = deriveEvent(snapshot, control, bundle.flow);
  if (!machineEvent && control.stateId === "blocked") {
    const source = await firstAuthorizedComment(provider, ref, snapshot, control);
    if (source) machineEvent = flowEvent("authorized-comment", snapshot, true);
  }
  if (machineEvent) {
    const result = compileFlow(bundle.flow).transition({
      stateId: control.stateId,
      resumeStateId: control.resumeStateId,
      event: machineEvent,
    });
    if (!result.changed) throw new Error(`invalid transition from ${control.stateId} for ${machineEvent.type}`);
    next = advanceControlState(control, {
      stateId: result.stateId,
      resumeStateId: result.resumeStateId,
      attemptSeries: applyAttemptActions(control.attemptSeries, result.actions, result.stateId === control.stateId),
      changeRequest: normalizedChange(snapshot.changeRequest) ?? control.changeRequest,
    }, now(dependencies));
    await writeExistingControl(dependencies, ref, control, next, observedKeys);
    publicationKeys = observedKeys;
    changed = true;
  } else if (control.stateId === "review" && snapshot.changeRequest
    && control.changeRequest?.headSha !== snapshot.changeRequest.headSha) {
    next = advanceControlState(control, { changeRequest: normalizedChange(snapshot.changeRequest) }, now(dependencies));
    await writeExistingControl(dependencies, ref, control, next, observedKeys);
    publicationKeys = observedKeys;
    changed = true;
  }

  const removeActivation = next.stateId === "done" || next.stateId === "cancelled";
  await ownLabels(provider, ref, snapshot.labels, bundle, next.stateId, removeActivation);
  const started = removeActivation
    ? false
    : await startIfNeeded(dependencies, snapshot, bundle, next, publicationKeys);
  return outcome(next, changed, started);
}

function providerStage(snapshot: ProviderTicketSnapshot): string {
  const stages = snapshot.labels.filter((label) => label.startsWith("agent-stage:"));
  if (stages.length !== 1) throw new Error("provider stage is missing or contradictory");
  return stages[0]!.slice("agent-stage:".length);
}

async function cancelLocalOutcome(
  dependencies: ReconcileDependencies,
  snapshot: ProviderTicketSnapshot,
  control: ControlState,
): Promise<ReconcileOutcome> {
  const cancelled = await cancelLocal(dependencies, snapshot, control);
  return outcome(cancelled, true, false);
}

async function cancelLocal(
  dependencies: ReconcileDependencies,
  snapshot: ProviderTicketSnapshot,
  control: ControlState,
): Promise<ControlState> {
  await dependencies.launcher.cancel(control.flowInstanceId);
  const latest = dependencies.writeControl.load?.(snapshot.ref)?.value.control;
  if (!latest || latest.flowInstanceId !== control.flowInstanceId) {
    throw new Error("local control changed during cancellation");
  }
  const timestamp = now(dependencies);
  const current = latest.attemptSeries?.current;
  const attemptSeries = current?.status === "started" && latest.attemptSeries ? {
    ...latest.attemptSeries,
    current: { ...current, status: "cancelled" as const, finishedAt: timestamp },
  } : latest.attemptSeries;
  const cancelled = advanceControlState(latest, {
    stateId: "cancelled",
    resumeStateId: null,
    attemptSeries,
    changeRequest: normalizedChange(snapshot.changeRequest) ?? latest.changeRequest,
  }, timestamp);
  await writeExistingControl(dependencies, snapshot.ref, latest, cancelled);
  const bundle = await dependencies.config.loadPinned(cancelled.configRevision);
  assertBundle(bundle, cancelled.configRevision);
  await ownLabels(dependencies.provider, snapshot.ref, snapshot.labels, bundle, "cancelled", true);
  return cancelled;
}

async function activate(
  dependencies: ReconcileDependencies,
  snapshot: ProviderTicketSnapshot,
  history: LoadedControl[],
): Promise<ReconcileOutcome> {
  const actor = snapshot.activation.actor;
  const eventId = snapshot.activation.eventId;
  const occurredAt = snapshot.activation.occurredAt;
  if (!actor || !eventId || !occurredAt) return outcome(history.at(-1)?.parsed.state ?? null, false, false);
  const permission = await providerCall(
    "provider permission read failed",
    () => dependencies.provider.permission(snapshot.ref.repository, actor),
  );
  if (!AUTHORIZED.has(permission)) return outcome(history.at(-1)?.parsed.state ?? null, false, false);

  const bundle = await configCall("current configuration load failed", () => dependencies.config.loadCurrent());
  assertBundle(bundle, bundle.revision);
  assertAllowed(bundle, snapshot.ref);
  if (!snapshot.labels.includes(bundle.flow.metadata.activationLabel)) {
    throw new Error("activation snapshot does not match controller labels");
  }

  const timestamp = now(dependencies);
  const control: ControlState = {
    apiVersion: "agent-flow/v1alpha1",
    kind: "ControlState",
    flowInstanceId: dependencies.newFlowInstanceId?.() ?? randomUUID(),
    flowId: bundle.flow.metadata.id,
    configRevision: bundle.revision,
    sequence: 0,
    stateId: bundle.flow.spec.initial,
    resumeStateId: null,
    activatedBy: actor,
    activatedAt: occurredAt,
    activationEventId: eventId,
    updatedAt: timestamp,
    attemptSeries: null,
    latestReceipt: null,
    humanGate: null,
    changeRequest: null,
  };
  await createControl(dependencies.provider, snapshot.ref, control);
  await ownLabels(dependencies.provider, snapshot.ref, snapshot.labels, bundle, control.stateId, false);
  const started = await startIfNeeded(dependencies, snapshot, bundle, control, []);
  return outcome(control, true, started);
}

async function cancel(
  dependencies: ReconcileDependencies,
  snapshot: ProviderTicketSnapshot,
  current: LoadedControl,
): Promise<ReconcileOutcome> {
  const beforeCancel = current.parsed.state;
  const hadActiveProcess = dependencies.launcher.isRunning(beforeCancel.flowInstanceId);
  const activeAttemptId = hadActiveProcess ? beforeCancel.attemptSeries?.current?.attemptId ?? null : null;
  const activeSeriesId = activeAttemptId ? beforeCancel.attemptSeries?.seriesId ?? null : null;
  const persistedStartedId = beforeCancel.attemptSeries?.current?.status === "started"
    ? beforeCancel.attemptSeries.current.attemptId
    : null;
  const persistedStartedSeriesId = persistedStartedId ? beforeCancel.attemptSeries?.seriesId ?? null : null;
  await dependencies.launcher.cancel(beforeCancel.flowInstanceId);
  const readback = await providerCall(
    "provider control comment readback failed",
    () => dependencies.provider.readComment(snapshot.ref, current.parsed.comment.id),
  );
  const latest = parseControlComment(readback.body);
  if (readback.id !== current.parsed.comment.id
    || !latest
    || latest.flowInstanceId !== current.parsed.state.flowInstanceId
    || latest.flowId !== current.parsed.state.flowId
    || latest.configRevision !== current.parsed.state.configRevision
    || latest.activationEventId !== current.parsed.state.activationEventId
    || latest.sequence < current.parsed.state.sequence) {
    throw new Error("control comment readback mismatch after cancellation");
  }
  const timestamp = now(dependencies);
  const currentAttempt = latest.attemptSeries?.current;
  if (activeAttemptId && (currentAttempt?.attemptId !== activeAttemptId
    || latest.attemptSeries?.seriesId !== activeSeriesId)) {
    throw new Error("active attempt changed during cancellation");
  }
  if (!activeAttemptId && persistedStartedId && (currentAttempt?.attemptId !== persistedStartedId
    || latest.attemptSeries?.seriesId !== persistedStartedSeriesId)) {
    throw new Error("persisted started attempt changed during cancellation");
  }
  const cancelAttempt = activeAttemptId !== null
    || (persistedStartedId !== null && currentAttempt?.status === "started");
  const attemptSeries = cancelAttempt && latest.attemptSeries && currentAttempt ? {
    ...latest.attemptSeries,
    current: { ...currentAttempt, status: "cancelled" as const, finishedAt: timestamp },
  } : latest.attemptSeries;
  const lateReceipt = activeAttemptId !== null && latest.latestReceipt?.attemptId === activeAttemptId;
  const control = advanceControlState(latest, {
    stateId: "cancelled",
    resumeStateId: null,
    attemptSeries,
    latestReceipt: lateReceipt ? beforeCancel.latestReceipt : latest.latestReceipt,
    humanGate: lateReceipt ? beforeCancel.humanGate : latest.humanGate,
    changeRequest: lateReceipt
      ? beforeCancel.changeRequest
      : normalizedChange(snapshot.changeRequest) ?? latest.changeRequest,
  }, timestamp);
  await writeExistingControl(dependencies, snapshot.ref, latest, control);
  await ownLabels(dependencies.provider, snapshot.ref, snapshot.labels, current.bundle, "cancelled", true);
  return outcome(control, true, false);
}

async function loadControls(
  parsed: ParsedControlComment[],
  config: ReconcileConfigSource,
): Promise<LoadedControl[]> {
  const bundles = new Map<string, ConfigBundle>();
  const result: LoadedControl[] = [];
  for (const item of parsed) {
    let bundle = bundles.get(item.state.configRevision);
    if (!bundle) {
      bundle = await configCall(
        "pinned configuration load failed",
        () => config.loadPinned(item.state.configRevision),
      );
      assertBundle(bundle, item.state.configRevision);
      bundles.set(item.state.configRevision, bundle);
    }
    if (bundle.flow.metadata.id !== item.state.flowId) throw new Error("control flow does not match pinned configuration");
    const state = bundle.flow.spec.states[item.state.stateId];
    if (!state) throw new Error("control state does not exist in pinned flow");
    result.push({ parsed: item, bundle, terminal: state.kind === "final" });
  }
  return result;
}

function assertBundle(bundle: ConfigBundle, revision: string): void {
  if (bundle.revision !== revision || !/^[0-9a-f]{40}$/.test(bundle.revision)) {
    throw new Error("configuration revision does not match the requested commit");
  }
  if (!bundle.flow.spec.states[bundle.flow.spec.initial]) {
    throw new Error("pinned flow does not contain its initial state");
  }
}

function assertAllowed(bundle: ConfigBundle, ref: TicketRef): void {
  if (!bundle.controller.providers[ref.provider]?.repositories.includes(ref.repository)) {
    throw new Error("ticket repository is not in the pinned allowlist");
  }
}

function assertSnapshot(snapshot: ProviderTicketSnapshot, ref: TicketRef): void {
  if (snapshot.ref.provider !== ref.provider
    || snapshot.ref.repository !== ref.repository
    || snapshot.ref.number !== ref.number
    || snapshot.repository.provider !== ref.provider
    || snapshot.repository.name !== ref.repository) {
    throw new Error("provider ticket snapshot does not match the requested ticket");
  }
}

function recoveryControls(snapshot: ProviderTicketSnapshot): ControlState[] {
  return snapshot.comments
    .map(({ body }) => parseControlComment(body))
    .filter((control): control is ControlState => control !== null)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function createControl(provider: ProviderAdapter, ref: TicketRef, control: ControlState): Promise<void> {
  const body = renderControlComment(control);
  const created = await providerCall("provider control comment create failed", () => provider.createComment(ref, body));
  await assertControlReadback(provider, ref, created.id, control);
}

async function writeExistingControl(
  dependencies: ReconcileDependencies,
  ref: TicketRef,
  expected: ControlState,
  next: ControlState,
  publicationKeys?: readonly string[],
): Promise<void> {
  await providerCall(
    "provider control comment update failed",
    () => writeControlCas(dependencies.writeControl, ref, expected, next, publicationKeys),
  );
}

async function assertControlReadback(
  provider: ProviderAdapter,
  ref: TicketRef,
  commentId: string,
  expected: ControlState,
): Promise<void> {
  const readback = await providerCall(
    "provider control comment readback failed",
    () => provider.readComment(ref, commentId),
  );
  if (readback.id !== commentId || !parseExpectedControlComment(readback.body, expected)) {
    throw new Error("control comment readback mismatch");
  }
}

async function ownLabels(
  provider: ProviderAdapter,
  ref: TicketRef,
  labels: string[],
  bundle: ConfigBundle,
  stateId: string,
  removeActivation: boolean,
): Promise<void> {
  const stage = `agent-stage:${stateId}`;
  const managed = bundle.flow.metadata.managedLabel;
  const activation = bundle.flow.metadata.activationLabel;
  const remove = labels.filter((label) =>
    (label.startsWith("agent-stage:") && label !== stage)
    || (removeActivation && label === activation));
  const add = [
    ...labels.includes(managed) ? [] : [managed],
    ...labels.includes(stage) ? [] : [stage],
  ];
  const current = remove.length || add.length
    ? await providerCall(
      "provider controller label update failed",
      () => provider.setControllerLabels(ref, remove, add),
    )
    : labels;
  const stages = current.filter((label) => label.startsWith("agent-stage:"));
  if (!current.includes(managed)
    || stages.length !== 1
    || stages[0] !== stage
    || (removeActivation && current.includes(activation))) {
    throw new Error("controller label readback mismatch");
  }
}

async function startIfNeeded(
  dependencies: ReconcileDependencies,
  snapshot: ProviderTicketSnapshot,
  bundle: ConfigBundle,
  control: ControlState,
  publicationKeys: readonly string[],
): Promise<boolean> {
  if (dependencies.launcher.isRunning(control.flowInstanceId)) return false;

  const configured = bundle.flow.spec.states[control.stateId];
  if (!configured) throw new Error("control state does not exist in pinned flow");
  let state = configured;
  let agentId = configured.agent;
  let mode: AttemptRequest["mode"] = "stage";
  let sourceComment: ProviderComment | null = null;
  let resultContract = configured.resultContract;

  if (configured.kind === "human-gate" || control.stateId === "needs-human") {
    sourceComment = await firstAuthorizedComment(dependencies.provider, snapshot.ref, snapshot, control);
    if (control.stateId === "needs-human") {
      const resume = control.resumeStateId ? bundle.flow.spec.states[control.resumeStateId] : undefined;
      if (!resume?.agent) return false;
      state = resume;
      agentId = resume.agent;
      if (!sourceComment) {
        if (hasAcceptedQuestion(control)) return false;
        if (snapshot.changeRequest?.state !== "closed" || control.resumeStateId !== "review") return false;
        resultContract = resume.resultContract;
      } else {
        mode = "human-input";
        resultContract = "human-gate";
      }
    } else {
      if (!sourceComment) return false;
      mode = "human-input";
      resultContract = "human-gate";
    }
  } else if (configured.kind !== "agent") {
    return false;
  }

  if (!agentId || !resultContract) throw new Error("launchable flow state is missing its agent contract");
  const inputRevision = attemptInputRevision(control, snapshot, sourceComment);
  if (hasAcceptedAttempt(control, agentId, inputRevision)) return false;

  await dependencies.launcher.start({
    ref: snapshot.ref,
    snapshot,
    control,
    bundle,
    stateId: control.stateId,
    state,
    agentId,
    mode,
    sourceComment,
    resultContract,
    inputRevision,
    controllerId: dependencies.controllerId ?? control.flowInstanceId,
    publicationKeys,
  });
  return true;
}

function hasAcceptedAttempt(
  control: ControlState,
  agentId: string,
  inputRevision: string,
): boolean {
  const series = control.attemptSeries;
  const current = series?.current;
  if (!series || !current || series.agentId !== agentId || series.stateId !== control.stateId) return false;
  return series.inputRevision === inputRevision
    && (current.status === "succeeded" || current.status === "cancelled");
}

function attemptInputRevision(
  control: ControlState,
  snapshot: ProviderTicketSnapshot,
  sourceComment: ProviderComment | null,
): string {
  const parts: unknown[] = [
    ["config", control.configRevision],
    ["ticket", snapshot.title, snapshot.description],
  ];
  if (sourceComment) {
    parts.push(["comment", sourceComment.id]);
  } else {
    if (snapshot.changeRequest) {
      parts.push([
        "change",
        snapshot.changeRequest.provider,
        snapshot.changeRequest.repository,
        snapshot.changeRequest.number,
        snapshot.changeRequest.headSha,
        snapshot.changeRequest.state,
      ]);
    }
    if (control.humanGate) parts.push(["human", control.humanGate.sourceCommentId]);
    if (!snapshot.changeRequest && !control.humanGate && snapshot.activation.eventId) {
      parts.push(["activation", snapshot.activation.eventId]);
    }
  }
  return `input:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

function hasAcceptedQuestion(control: ControlState): boolean {
  const current = control.attemptSeries?.current;
  const receipt = control.latestReceipt;
  const awaitingAnswer = receipt?.outcome === "needs-human"
    || receipt?.humanGate?.verdict === "question"
    || receipt?.humanGate?.verdict === "unclear";
  return control.attemptSeries?.stateId === control.stateId
    && (current === null || current?.status === "succeeded" && receipt?.attemptId === current.attemptId)
    && awaitingAnswer
    && receipt !== null;
}

async function firstAuthorizedComment(
  provider: ProviderAdapter,
  ref: TicketRef,
  snapshot: ProviderTicketSnapshot,
  control: ControlState,
): Promise<ProviderComment | null> {
  const cutoff = humanCutoff(snapshot.comments, control);
  const candidates = snapshot.comments
    .filter((candidate) => candidate.createdAt > cutoff && !isMarked(candidate.body))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  for (const candidate of candidates) {
    const permission = await providerCall(
      "provider permission read failed",
      () => provider.permission(ref.repository, candidate.actor),
    );
    if (AUTHORIZED.has(permission)) return candidate;
  }
  return null;
}

function humanCutoff(comments: ProviderComment[], control: ControlState): string {
  const artifactIds = new Set(
    control.latestReceipt?.artifacts
      .filter((artifact) => artifact.kind === "comment")
      .map((artifact) => artifact.kind === "comment" ? artifact.id : "") ?? [],
  );
  const publications = comments.filter((candidate) => artifactIds.has(candidate.id));
  return publications.reduce(
    (latest, candidate) => candidate.createdAt > latest ? candidate.createdAt : latest,
    control.updatedAt,
  );
}

function isMarked(body: string): boolean {
  return parsePublication(body).kind !== "unmarked";
}

function applyAttemptActions(
  series: AttemptSeries | null,
  actions: FlowActionName[],
  selfTransition: boolean,
): AttemptSeries | null {
  if (!series) return null;
  if (actions.includes("reset-retry-budget")) return { ...series, consumed: 0, current: null };
  if (selfTransition && actions.includes("record-receipt")) return { ...series, current: null };
  return series;
}

function normalizedChange(change: ProviderTicketSnapshot["changeRequest"]): ControlChangeRequest | null {
  if (!change) return null;
  return {
    provider: change.provider,
    repository: change.repository,
    number: change.number,
    url: change.url,
    headSha: change.headSha,
    state: change.state,
  };
}

function assertChangeIdentity(
  control: ControlChangeRequest | null,
  snapshot: ProviderTicketSnapshot["changeRequest"],
): void {
  if (!control
    || !snapshot
    || control.provider !== snapshot.provider
    || control.repository !== snapshot.repository
    || control.number !== snapshot.number
    || control.url !== snapshot.url) {
    throw new Error("change request identity does not match the control state");
  }
  if (snapshot.state === "merged" && control.headSha !== snapshot.headSha) {
    throw new Error("merged change request does not match the reviewed head");
  }
}

function flowEvent(
  type: FlowEvent["type"],
  snapshot: ProviderTicketSnapshot,
  authorizedActor: boolean,
): FlowEvent {
  return {
    type,
    authorizedActor,
    activationPresent: snapshot.activation.present,
    ticketOpen: snapshot.open,
    headMatches: false,
    receiptValid: false,
  };
}

function outcome(
  control: ControlState | null,
  changed: boolean,
  started: boolean,
  runnable = true,
): ReconcileOutcome {
  return {
    flowInstanceId: control?.flowInstanceId ?? null,
    stateId: control?.stateId ?? null,
    changed,
    started,
    runnable,
  };
}

function now(dependencies: ReconcileDependencies): string {
  return dependencies.now?.() ?? new Date().toISOString();
}

async function providerCall<T>(message: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(message);
  }
}

async function configCall<T>(message: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(message);
  }
}
