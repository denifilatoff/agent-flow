import { createHash, randomUUID } from "node:crypto";

import { validateBundleDocument, type ConfigBundle } from "../config/load.ts";
import type {
  AttemptSeries,
  ControlChangeRequest,
  ControlState,
  FlowDefinition,
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
import { electOwner, parsePublication } from "../provider/publication.ts";
import type {
  Permission,
  ProviderAdapter,
  ProviderComment,
  ProviderTicketSnapshot,
  RecoveryEvidence,
  RequiredChecks,
  TicketRef,
} from "../provider/types.js";
import { recoverMigration, type RecoveredMigration } from "./migration-recovery.ts";
import { isMigrationCommand } from "./migration-request.ts";
import { processMigration } from "./migration.ts";
import { deriveEvent } from "./derive-event.ts";
import { writeControlCas, type ControlWriter } from "./control-state.ts";
import { classifyRecovery, type RecoveryDecision } from "./recovery.ts";

const AUTHORIZED = new Set<Permission>(["write", "maintain", "admin"]);

export interface AttemptRequest {
  migration?: RecoveredMigration;
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
  resolveTarget?(selector:string):Promise<string>;
  validateTarget?(bundle:ConfigBundle):Promise<void>;
  loadCurrent(): Promise<ConfigBundle>;
  loadPinned(revision: string): Promise<ConfigBundle>;
}

export interface ReconcileDependencies {
  migration?: RecoveredMigration;
  provider: ProviderAdapter;
  config: ReconcileConfigSource;
  launcher: AttemptLauncher;
  writeControl: ControlWriter;
  isAllowed?(ref: TicketRef): boolean;
  providerApiUrl?: string;
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
  configRevision: string | null;
  stateKind: FlowState["kind"] | null;
  repositoryUrl: string;
  ticketUrl: string;
  actionUrl: string;
  recoveryDisposition?: "ready" | "waiting" | "foreign" | "ambiguous" | "inactive";
  recoveryReason?: string | null;
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
    const cached = dependencies.writeControl.load?.(ref)?.value.control;
    const pinned = cached && cached.stateId !== "done" && cached.stateId !== "cancelled" ? cached : null;
    const observedEvidence = await providerCall(
      "provider recovery evidence read failed",
      () => provider.readRecoveryEvidence(ref, pinned?.activationLabel),
    );
    if (pinned?.activationLabel && observedEvidence.snapshot.activation.label !== pinned.activationLabel) {
      observedEvidence.snapshot.activation = {
        present: observedEvidence.snapshot.labels.includes(pinned.activationLabel), label: pinned.activationLabel,
        eventId: pinned.activationEventId, actor: pinned.activatedBy, occurredAt: pinned.activatedAt,
      };
    }
    let evidence = currentActivationEvidence(observedEvidence);
    try {
      evidence=await recoverMigration(evidence,revision=>dependencies.config.loadPinned(revision),provider);
      evidence=await processMigration(dependencies,evidence);
    } catch(error) {
      evidence={...evidence,ambiguities:[...evidence.ambiguities,error instanceof Error?error.message:"Migration evidence conflicts"]};
    }
    dependencies={...dependencies,migration:evidence.migration};
    snapshot = evidence.snapshot;
    assertSnapshot(snapshot, ref);
    let decision = classifyRecovery(evidence, dependencies.controllerId!);
    if (dependencies.writeControl.load && dependencies.writeControl.recordRecovery) {
      const result = await reconcileLocal(dependencies, evidence, decision);
      const observed = dependencies.writeControl.load(ref)?.value;
      return { ...result, recoveryDisposition: observed?.disposition, recoveryReason: observed?.reason };
    }
    const controls = recoveryControls(snapshot);
    let deferredResume = false;
    if (decision.kind === "reassess" && decision.owner) {
      try {
        const bundle = await dependencies.config.loadPinned(decision.owner.metadata.config);
        assertBundle(bundle, decision.owner.metadata.config);
        assertAllowed(dependencies, ref);
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
        assertAllowed(dependencies, ref);
        const stage = snapshot.labels.find((label) => label.startsWith("agent-stage:"))!
          .slice("agent-stage:".length);
        if (!bundle.flow.spec.states[stage]) throw new Error("provider stage does not exist in the selected flow");
        deferredResume = stage !== entryStage(bundle.flow, snapshot.activation.label);
      } catch {
        decision = { kind: "ambiguous", owner: null, reason: "configuration or flow is unavailable" };
      }
    }
    if (decision.kind === "inactive" && controls.length === 0) {
      await dependencies.recordRecovery?.(ref, evidence, decision);
      return outcome(null, null, snapshot, false, false, false);
    }
    if (decision.kind === "reassess") {
      await dependencies.recordRecovery?.(ref, evidence, decision);
      return outcome(controls[0] ?? null, null, snapshot, false, false);
    }
    if (decision.kind === "ambiguous" || decision.kind === "foreign") {
      for (const control of controls) {
        if (control.stateId !== "done" && control.stateId !== "cancelled") {
          await launcher.cancel(control.flowInstanceId);
        }
      }
      await dependencies.recordRecovery?.(ref, evidence, decision);
      return outcome(controls[0] ?? null, null, snapshot, false, false, false);
    }
    if (deferredResume) {
      await dependencies.recordRecovery?.(ref, evidence, decision);
      return outcome(null, null, snapshot, false, false);
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
          latest.parsed.state.activationLabel,
        );
      }
      return outcome(latest?.parsed.state ?? null, latest?.bundle ?? null, snapshot, false, false);
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
  const boundary=evidence.migration;
  // A verified receipt supplies the destination when its source's paused label
  // survived the commit. Apply it once; later target pauses keep their own context.
  if (boundary && stored?.value.migrationId !== boundary.id
    && (boundary.receipt.source.stage === "blocked" || boundary.receipt.source.stage === "needs-human")
    && boundary.receipt.source.resume !== null
    && decision.kind === "ambiguous"
    && decision.reason === boundary.receipt.source.stage + " resume target is unavailable"
    && evidence.publications.every((publication) => boundary.receipt.retained.some((retained) => retained.key === publication.key))) {
    decision = { kind: "reassess", owner: decision.owner, reason: null };
  }
  if(boundary && stored?.value.migrationId!==boundary.id && decision.kind!=="foreign" && decision.kind!=="ambiguous" && snapshot.open && snapshot.activation.present) {
    if(control) await dependencies.launcher.cancel(control.flowInstanceId);
    control=null;
  }
  if (control
    && evidence.activeBoundary === "fresh"
    && snapshot.activation.eventId !== null
    && snapshot.activation.eventId !== control.activationEventId) {
    if (control.stateId !== "done" && control.stateId !== "cancelled") {
      await dependencies.launcher.cancel(control.flowInstanceId);
    }
    control = null;
  }
  const mergedWins = (control?.stateId === "awaiting-merge" || control?.stateId === "bug-awaiting-merge")
    && snapshot.changeRequest?.state === "merged";
  const localResume = control !== null && isMissingLocalResume(decision, snapshot, control);

  if (decision.kind === "inactive" && !mergedWins) {
    const owner = control ? electOwner(evidence.publications.filter((publication) =>
      Date.parse(publication.createdAt) >= Date.parse(control!.activatedAt))) : null;
    const foreign = (owner && owner.metadata.controller !== controllerId)
      || stored?.value.disposition === "foreign"
      || (stored?.value.owner && stored.value.owner.controllerId !== controllerId);
    if (control && foreign) {
      await dependencies.launcher.cancel(control.flowInstanceId);
      stored = await writer.recordRecovery!(ref, evidence, {
        kind: "foreign", owner, reason: "Inactive work belongs to another controller; local work stopped without provider changes.",
      }, control);
      return outcome(stored.value.control, null, snapshot, false, false, false);
    }
    if (control && control.stateId !== "done" && control.stateId !== "cancelled") {
      control = await cancelLocal(dependencies, snapshot, control);
    } else if (control) {
      const pinned = await dependencies.config.loadPinned(control.configRevision);
      assertBundle(pinned, control.configRevision);
      await ownLabels(dependencies.provider, ref, snapshot.labels, pinned, control.stateId, true, control.activationLabel);
    }
    stored = await writer.recordRecovery!(ref, evidence, decision, control);
    return outcome(stored.value.control, null, snapshot, control !== null, false, false);
  }
  if ((decision.kind === "ambiguous" && !localResume) || decision.kind === "foreign") {
    if (control && control.stateId !== "done" && control.stateId !== "cancelled") {
      await dependencies.launcher.cancel(control.flowInstanceId);
    }
    stored = await writer.recordRecovery!(ref, evidence, decision, control);
    return outcome(stored.value.control, null, snapshot, false, false, false);
  }

  let bundle: ConfigBundle;
  try {
    if (control) {
      bundle = await configCall(
        "pinned configuration load failed",
        () => dependencies.config.loadPinned(control!.configRevision),
      );
      assertBundle(bundle, control.configRevision);
      if (bundle.flow.metadata.id !== control.flowId) {
        throw new Error("control flow does not match pinned configuration");
      }
      if (decision.owner && decision.owner.metadata.config !== control.configRevision) {
        const conflict: RecoveryDecision = {
          kind: "ambiguous",
          owner: decision.owner,
          reason: "winning configuration does not match local execution",
        };
        stored = await writer.recordRecovery!(ref, evidence, conflict, control);
        return outcome(stored.value.control, null, snapshot, false, false, false);
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
  } catch {
    if (control) await dependencies.launcher.cancel(control.flowInstanceId);
    const unavailable: RecoveryDecision = { kind: "ambiguous", owner: decision.owner,
      reason: "Pinned configuration is unavailable. Restore access to the published configuration commit." };
    stored = await writer.recordRecovery!(ref, evidence, unavailable, control);
    return outcome(stored.value.control, null, snapshot, false, false, false);
  }
  assertAllowed(dependencies, ref);

  if (localResume) {
    if (!hasValidLocalResume(bundle.flow, control!)) {
      stored = await writer.recordRecovery!(ref, evidence, decision, control);
      return outcome(stored.value.control, null, snapshot, false, false, false);
    }
    decision = { kind: decision.owner ? "reassess" : "resume", owner: decision.owner, reason: null };
  }

  if (!control) {
    const freshStart = !evidence.migration && evidence.activeBoundary === "fresh" && evidence.publications.length === 0;
    const entry = entryStage(bundle.flow, snapshot.activation.label);
    let stage = freshStart ? entry : providerStage(snapshot, bundle.flow);
    if(boundary) {
      const sourceLabel=boundary.receipt.source.stage==="bug-awaiting-merge"?"awaiting-merge":boundary.receipt.source.stage;
      if (snapshot.labels.includes("agent-stage:" + sourceLabel)) {
        const sourceIteration = await recoveryIteration(bundle, evidence, stage,
          decision.owner?.metadata.controller ?? null, dependencies.provider, dependencies.providerApiUrl);
        // A stale source label can already identify the replay predecessor for
        // reassessment. Apply that destination before merge-wait review routing.
        if (sourceIteration.kind === "ambiguous"
          || sourceIteration.reassessState === boundary.receipt.start) stage = boundary.receipt.start;
      }
    }
    stage = freshReviewTarget(bundle.flow, stage, evidence, controllerId) ?? stage;
    if (decision.kind === "resume" && evidence.activeBoundary !== "fresh" && stage !== entryStage(bundle.flow, snapshot.activation.label)) {
      await writer.recordRecovery!(ref, evidence, decision, null);
      return outcome(null, null, snapshot, false, false);
    }
    const actor = snapshot.activation.actor;
    const eventId = snapshot.activation.eventId;
    const occurredAt = snapshot.activation.occurredAt;
    if (!actor || !eventId || !occurredAt) {
      await writer.recordRecovery!(ref, evidence, {
        kind: "ambiguous", owner: decision.owner, reason: "activation evidence is unavailable",
      }, null);
      return outcome(null, null, snapshot, false, false, false);
    }
    const permission = await providerCall(
      "provider permission read failed",
      () => dependencies.provider.permission(ref.repository, actor),
    );
    if (!AUTHORIZED.has(permission)) {
      await writer.recordRecovery!(ref, evidence, {
        kind: "ambiguous", owner: decision.owner, reason: "activation actor lacks write permission",
      }, null);
      return outcome(null, null, snapshot, false, false, false);
    }
    const iteration = await recoveryIteration(bundle, evidence, stage, decision.owner?.metadata.controller ?? null, dependencies.provider, dependencies.providerApiUrl);
    if (iteration.kind === "ambiguous") {
      stored = await writer.recordRecovery!(ref, evidence, {
        kind: "ambiguous", owner: decision.owner, reason: iteration.reason,
      }, null, iteration.baselineKeys);
      return outcome(stored.value.control, null, snapshot, false, false, false);
    }
    const timestamp = iteration.humanCutoff ?? now(dependencies);
    const recovered: ControlState = {
      apiVersion: "agent-flow/v1alpha1",
      kind: "ControlState",
      flowInstanceId: boundary?.receipt.workspace ?? dependencies.newFlowInstanceId?.() ?? randomUUID(),
      flowId: bundle.flow.metadata.id,
      configRevision: bundle.revision,
      sequence: 0,
      stateId: iteration.reassessState ?? stage,
      resumeStateId: null,
      activatedBy: actor,
      activatedAt: occurredAt,
      activationEventId: eventId,
      activationLabel: snapshot.activation.label ?? bundle.flow.metadata.activationLabel,
      updatedAt: timestamp,
      attemptSeries: null,
      latestReceipt: null,
      humanGate: null,
      changeRequest: freshStart ? null : normalizedChange(snapshot.changeRequest),
    };
    stored = await writer.recordRecovery!(ref, evidence, decision, recovered, iteration.baselineKeys);
    control = stored.value.control!;
  } else if (!dependencies.launcher.isRunning(control.flowInstanceId)) {
    stored = await writer.recordRecovery!(ref, evidence, decision, control, stored?.value.publicationKeys);
    control = stored.value.control!;
  }

  const observedKeys = markedObjectKeys(bundle, evidence, dependencies.providerApiUrl);
  if (bundle.flow.spec.states[control.stateId]?.kind === "provider-wait") {
    assertChangeIdentity(control.changeRequest, snapshot.changeRequest);
  }
  let reviewRerouted = false;
  const reviewTarget = freshReviewTarget(bundle.flow, control.stateId, evidence, controllerId);
  if (reviewTarget) {
    const next = advanceControlState(control, { stateId: reviewTarget, attemptSeries: null, latestReceipt: null }, now(dependencies));
    await writeExistingControl(dependencies, ref, control, next, observedKeys);
    control = next;
    stored = writer.load!(ref);
    reviewRerouted = true;
  }
  const validated = clearUncommittedReceipt(evidence, control, controllerId, dependencies);
  const receiptChanged = validated !== control;
  if (receiptChanged) {
    await writeExistingControl(dependencies, ref, control, validated, observedKeys);
    control = validated;
  }

  const result = await reconcileControl(
    dependencies,
    snapshot,
    bundle,
    control,
    receiptChanged
      ? observedKeys
      : stored?.value.publicationKeys ?? evidence.publications.map(({ key }) => key),
    true,
    undefined,
    observedKeys,
  );
  return receiptChanged || reviewRerouted ? { ...result, changed: true } : result;
}

function freshReviewTarget(flow: FlowDefinition, stage: string, evidence: RecoveryEvidence, controllerId: string): string | null {
  const state = flow.spec.states[stage];
  if (state?.kind !== "provider-wait" || evidence.snapshot.changeRequest?.state !== "open") return null;
  const approved = evidence.reviews.some((review) => review.verdict === "approved"
    && review.headSha === evidence.snapshot.changeRequest!.headSha
    && evidence.publications.some((publication) => publication.ownershipEligible !== false
      && publication.metadata.controller === controllerId
      && hasPublicationIdentity(publication.key, evidence.snapshot.ref, "review", review.id)));
  const target = state.on?.["change-request-updated"]?.target;
  return !approved && target && flow.spec.states[target]?.resultContract === "review" ? target : null;
}

function clearUncommittedReceipt(
  evidence: RecoveryEvidence,
  control: ControlState,
  controllerId: string,
  dependencies: ReconcileDependencies,
): ControlState {
  const receipt = control.latestReceipt;
  const current = control.attemptSeries?.current;
  if (!receipt || receipt.outcome === "failed" || current?.status !== "succeeded"
    || current.attemptId !== receipt.attemptId) return control;

  const committed = receipt.artifacts.every((artifact) => {
    const id = artifact.kind === "change-request" ? String(artifact.number) : artifact.id;
    const publication = evidence.publications.find((candidate) =>
      hasPublicationIdentity(candidate.key, evidence.snapshot.ref, artifact.kind, id));
    const carried=artifact.kind==="change-request" && evidence.migration?.receipt.change.number===artifact.number;
    if ((!publication && !carried)
      || (artifact.kind === "review" && publication?.ownershipEligible === false)
      || !carried && publication?.metadata.config !== control.configRevision
      || !carried && publication?.metadata.controller !== controllerId) return false;
    if (artifact.kind === "change-request") {
      return evidence.changes.some((change) => change.number === artifact.number
        && change.headSha === artifact.headSha);
    }
    if (artifact.kind === "review") {
      return evidence.reviews.some((review) => review.id === artifact.id
        && review.headSha === artifact.headSha
        && review.verdict === artifact.verdict);
    }
    return true;
  }) && (!receipt.humanGate || evidence.snapshot.comments.some((comment) =>
    comment.id === receipt.humanGate!.sourceCommentId && !isMarked(comment.body)));
  if (committed && (receipt.artifacts.length > 0 || receipt.humanGate)) return control;

  return advanceControlState(control, {
    attemptSeries: control.attemptSeries ? { ...control.attemptSeries, current: null } : null,
    latestReceipt: null,
    humanGate: control.humanGate?.interpretedByAttemptId === receipt.attemptId ? null : control.humanGate,
    changeRequest: normalizedChange(evidence.snapshot.changeRequest),
  }, now(dependencies));
}

function hasPublicationIdentity(
  key: string,
  ref: TicketRef,
  kind: PublicationObjectKind,
  id: string,
): boolean {
  try {
    const value = JSON.parse(key);
    return Array.isArray(value)
      && value.length === 5
      && value[0] === ref.provider
      && typeof value[1] === "string"
      && value[1].length > 0
      && value[2] === ref.repository
      && value[3] === kind
      && value[4] === id;
  } catch {
    return false;
  }
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
  assertAllowed(dependencies, ref);
  const activationLabel = control.activationLabel ?? bundle.flow.metadata.activationLabel;
  const activeSnapshot = {
    ...snapshot,
    activation: {
      present: snapshot.labels.includes(activationLabel),
      label: activationLabel,
      eventId: control.activationEventId,
      actor: control.activatedBy,
      occurredAt: control.activatedAt,
    },
  };
  const configuredState = bundle.flow.spec.states[control.stateId];
  if (configuredState?.kind === "provider-wait") {
    assertChangeIdentity(control.changeRequest, activeSnapshot.changeRequest);
  }
  const mergedWins = configuredState?.kind === "provider-wait"
    && activeSnapshot.changeRequest?.state === "merged";
  if ((!activeSnapshot.activation.present || !activeSnapshot.open) && !mergedWins) {
    return local ? cancelLocalOutcome(dependencies, activeSnapshot, control) : cancel(dependencies, activeSnapshot, legacy!);
  }

  let next = control;
  let changed = false;
  let transitionControl = control;
  let machineEvent = deriveEvent(activeSnapshot, control, bundle.flow);
  // The publication is evidence of agent work; CI is independently read on every poll.
  const required = bundle.flow.spec.requiredChecks;
  const publicationHead = control.latestReceipt?.artifacts.find((artifact) => artifact.kind === "change-request" || artifact.kind === "review");
  if (required && publicationHead && "headSha" in publicationHead
    && publicationHead.headSha !== activeSnapshot.changeRequest?.headSha
    && (machineEvent?.type === "agent-succeeded" && configuredState?.resultContract === "development"
      || machineEvent?.type === "review-approved" && configuredState?.resultContract === "review")) {
    machineEvent = null;
  }
  const gatedSuccess = machineEvent?.type === "agent-succeeded" && ["development", "verification"].includes(configuredState?.resultContract ?? "")
    || machineEvent?.type === "review-approved" && configuredState?.resultContract === "review";
  if (required && gatedSuccess) {
    const change = activeSnapshot.changeRequest;
    let ci: RequiredChecks | null = null;
    try {
      if (change?.state === "open") {
        const candidate = await provider.readRequiredChecks(ref, change);
        const current = await provider.readChangeRequest(ref, change.number);
        if (current.headSha === change.headSha && current.state === "open") ci = candidate;
      }
    } catch { /* Unreadable CI is never passing evidence. Retry on the next poll. */ }
    const checks = ci?.headSha === change?.headSha ? ci?.checks : undefined;
    const failing = checks?.filter((check) => required.includes(check.name) && check.status === "failure") ?? [];
    const passing = checks && required.every((name) => {
      const matches = checks.filter((check) => check.name === name);
      return matches.length > 0 && matches.every((check) => check.status === "success");
    });
    if (!passing && failing.length === 0) {
      await ownLabels(provider, ref, snapshot.labels, bundle, control.stateId, false, control.activationLabel);
      return { ...outcome(control, bundle, activeSnapshot, false, false), recoveryReason: "Waiting for required current-head CI: " + required.join(", ") };
    }
    if (failing.length > 0) {
      const receipt = control.latestReceipt!;
      const series = control.attemptSeries!;
      transitionControl = { ...control,
        latestReceipt: { ...receipt, outcome: "failed", summary: "Required CI failed on " + change!.headSha + ": " + failing.map((check) => check.name).join(", "),
          error: { code: "REQUIRED_CI_FAILED", message: "Fix the required CI checks before completing development." } },
        attemptSeries: { ...series, current: { ...series.current!, status: "failed" } },
      };
      machineEvent = flowEvent(configuredState?.resultContract === "development" && series.consumed >= series.maxAttempts
        ? "attempts-exhausted" : "ci-failed", activeSnapshot, false);
      changed = true;
    }
  }
  if (!machineEvent && control.stateId === "blocked") {
    const source = await firstAuthorizedComment(provider, ref, snapshot, control);
    if (source) machineEvent = flowEvent("authorized-comment", activeSnapshot, true);
  }

  if (machineEvent) {
    const machine = compileFlow(bundle.flow);
    let result = machine.transition({
      stateId: control.stateId,
      resumeStateId: control.resumeStateId,
      event: machineEvent,
    });
    if (!result.changed) {
      throw new Error(`invalid transition from ${control.stateId} for ${machineEvent.type}`);
    }
    if (machineEvent.type === "authorized-comment" || machineEvent.type === "human-answer-accepted") {
      const resumed = { ...control, stateId: result.stateId, resumeStateId: result.resumeStateId };
      const resumedEvent = deriveEvent(activeSnapshot, resumed, bundle.flow);
      if (resumedEvent?.type === "change-request-updated") {
        const rerouted = machine.transition({
          stateId: resumed.stateId,
          resumeStateId: resumed.resumeStateId,
          event: resumedEvent,
        });
        if (!rerouted.changed) throw new Error(`invalid transition from ${resumed.stateId} for ${resumedEvent.type}`);
        result = { ...rerouted, actions: [...result.actions, ...rerouted.actions] };
      }
    }
    next = advanceControlState(transitionControl, {
      stateId: result.stateId,
      resumeStateId: result.resumeStateId,
      attemptSeries: applyAttemptActions(
        transitionControl.attemptSeries,
        result.actions,
        result.stateId === control.stateId,
      ),
      changeRequest: bundle.flow.spec.states[result.stateId]?.kind === "paused"
        ? control.changeRequest
        : normalizedChange(activeSnapshot.changeRequest) ?? control.changeRequest,
    }, now(dependencies));
    await writeExistingControl(dependencies, ref, control, next, observedKeys);
    publicationKeys = observedKeys;
    changed = true;
  } else if (configuredState?.resultContract === "review"
    && activeSnapshot.changeRequest
    && control.changeRequest?.headSha !== activeSnapshot.changeRequest.headSha) {
    next = advanceControlState(control, { changeRequest: normalizedChange(activeSnapshot.changeRequest) }, now(dependencies));
    await writeExistingControl(dependencies, ref, control, next, observedKeys);
    publicationKeys = observedKeys;
    changed = true;
  }

  const removeActivation = next.stateId === "done" || next.stateId === "cancelled";
  await ownLabels(provider, ref, snapshot.labels, bundle, next.stateId, removeActivation, control.activationLabel);
  const started = removeActivation
    ? false
    : await startIfNeeded(dependencies, activeSnapshot, bundle, next, publicationKeys);
  return outcome(next, bundle, activeSnapshot, changed, started);
}

function entryStage(flow: FlowDefinition, label: string | null): string {
  if (!label || label === flow.metadata.activationLabel) return flow.spec.initial;
  const stage = flow.spec.activationRoutes?.[label];
  if (!stage) throw new Error("activation route is not configured in the pinned flow");
  return stage;
}

function providerStage(snapshot: ProviderTicketSnapshot, flow: FlowDefinition): string {
  const stages = snapshot.labels.filter((label) => label.startsWith("agent-stage:"));
  if (stages.length !== 1) throw new Error("provider stage is missing or contradictory");
  const stage = stages[0]!.slice("agent-stage:".length);
  if (stage !== "awaiting-merge") return stage;
  const candidates = Object.keys(flow.spec.states).filter((id) =>
    (id === stage || id === "bug-awaiting-merge")
    && successfulPublicationPath(flow, id, snapshot.activation.label) !== null);
  if (candidates.length !== 1) throw new Error("shared merge-wait stage has ambiguous activation context");
  return candidates[0]!;
}

function currentActivationEvidence(evidence: RecoveryEvidence): RecoveryEvidence {
  const occurredAt = evidence.snapshot.activation.occurredAt;
  if (!evidence.snapshot.activation.present || occurredAt === null) return evidence;
  const boundary = Date.parse(occurredAt);
  if (!Number.isFinite(boundary)) {
    return { ...evidence, ambiguities: [...evidence.ambiguities, "activation time is invalid"] };
  }
  return {
    ...evidence,
    publications: evidence.publications.filter((publication) => {
      const publishedAt = Date.parse(publication.createdAt);
      return !Number.isFinite(publishedAt) || publishedAt >= boundary;
    }),
  };
}

function isMissingLocalResume(
  decision: RecoveryDecision,
  snapshot: ProviderTicketSnapshot,
  control: ControlState,
): boolean {
  if (decision.kind !== "ambiguous"
    || (control.stateId !== "blocked" && control.stateId !== "needs-human")
    || control.resumeStateId === null) return false;
  const stages = snapshot.labels
    .filter((label) => label.startsWith("agent-stage:"))
    .map((label) => label.slice("agent-stage:".length));
  return (decision.reason === `${control.stateId} resume target is unavailable`
      && stages.length === 1 && stages[0] === control.stateId)
    || (decision.reason === "provider stage is missing or contradictory" && stages.length === 0);
}

function hasValidLocalResume(flow: FlowDefinition, control: ControlState): boolean {
  const paused = flow.spec.states[control.stateId];
  const resumed = control.resumeStateId ? flow.spec.states[control.resumeStateId] : undefined;
  const acceptsResume = Object.values(paused?.on ?? {}).some(({ target }) => target === "$resume");
  return paused?.kind === "paused"
    && acceptsResume
    && (resumed?.kind === "agent" || resumed?.kind === "human-gate")
    && Boolean(resumed.agent && resumed.resultContract);
}

type PublicationObjectKind = "comment" | "change-request" | "review";

type RecoveryIteration =
  | { kind: "ready"; baselineKeys: string[]; humanCutoff: string | null; reassessState?: string }
  | { kind: "ambiguous"; baselineKeys: string[]; reason: string };

async function recoveryIteration(
  bundle: ConfigBundle,
  evidence: RecoveryEvidence,
  stage: string,
  ownerController: string | null,
  provider: ProviderAdapter,
  apiUrl?: string,
): Promise<RecoveryIteration> {
  const baselineKeys = markedObjectKeys(bundle, evidence, apiUrl);
  const linked = evidence.snapshot.changeRequest;
  const migration = evidence.migration;
  if (migration?.receipt.start === stage && bundle.flow.spec.states[stage]?.kind === "human-gate") {
    const predecessor = migration.receipt.retained.filter((retained) =>
      bundle.flow.spec.states[retained.stage]?.on?.["agent-succeeded"]?.target === stage);
    const result = predecessor.length === 1 && evidence.snapshot.comments.find((comment) =>
      hasPublicationIdentity(predecessor[0]!.key, evidence.snapshot.ref, "comment", comment.id));
    if (!result) return { kind: "ambiguous", baselineKeys, reason: "Migrated human gate predecessor is unavailable" };
    const input = evidence.snapshot.comments.find((comment) => comment.id === migration.receipt.source.humanInput?.id);
    const cutoff = input && input.createdAt > result.createdAt ? input.createdAt : result.createdAt;
    const later = evidence.publications.filter((publication) =>
      publication.metadata.controller === ownerController
      && !migration.receipt.retained.some((retained) => retained.key === publication.key)
      && publicationObjectKind(publication.key, evidence.snapshot.ref, bundle) !== "change-request")
      .toSorted((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
        || left.key.localeCompare(right.key));
    if (later.length > 0) {
      if (later.some((publication) =>
        publicationObjectKind(publication.key, evidence.snapshot.ref, bundle) !== "comment"
        || !baselineKeys.includes(publication.key))) {
        return { kind: "ambiguous", baselineKeys, reason: "Migrated human gate iteration cannot be isolated" };
      }
      // Revalidate the newest predecessor result before accepting answers to that iteration.
      const candidate = later.at(-1)!;
      return {
        kind: "ready", reassessState: predecessor[0]!.stage,
        baselineKeys: baselineKeys.filter((key) => key !== candidate.key),
        humanCutoff: later.length > 1 ? later.at(-2)!.createdAt : cutoff,
      };
    }
    return { kind: "ready", baselineKeys, humanCutoff: cutoff };
  }
  if (migration?.receipt.start === stage && bundle.flow.spec.states[stage]?.kind === "provider-wait"
    && migration.receipt.retained.length && linked?.headSha === migration.receipt.change.headSha) {
    return { kind: "ready", baselineKeys, humanCutoff: null };
  }
  if (!evidence.migration && bundle.flow.spec.states[stage]?.kind === "provider-wait" && linked?.state === "merged") {
    const linkedPublication = evidence.publications.some((publication) =>
      publication.metadata.controller === ownerController
      && hasPublicationIdentity(publication.key, evidence.snapshot.ref, "change-request", String(linked.number)));
    if (evidence.changes.length !== 1 || !linkedPublication) {
      return { kind: "ambiguous", baselineKeys, reason: "merged change request ownership or identity is unavailable" };
    }
    return { kind: "ready", baselineKeys, humanCutoff: null };
  }
  let active = evidence.publications
    .filter((publication) => !migration?.receipt.retained.some((retained) => retained.key === publication.key))
    .filter(({ metadata }) => ownerController === null || metadata.controller === ownerController)
    .filter((publication) => {
      if (publication.ownershipEligible === false
        && publicationObjectKind(publication.key, evidence.snapshot.ref, bundle) === "review") return false;
      return true;
    })
    .toSorted((left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.key.localeCompare(right.key));
  let recoveryStart = migration?.receipt.start;
  const boundaryState = recoveryStart ? bundle.flow.spec.states[recoveryStart] : undefined;
  const updatedTarget = boundaryState?.on?.["change-request-updated"]?.target;
  const repeatsReviewOnUpdate = boundaryState?.resultContract === "verification"
    || (boundaryState?.kind === "provider-wait" && Boolean(migration?.receipt.retained.length));
  if (migration && repeatsReviewOnUpdate
    && linked && /^[0-9a-f]{40}$/.test(linked.headSha)
    && linked.headSha !== migration.receipt.change.headSha
    && updatedTarget && bundle.flow.spec.states[updatedTarget]?.resultContract === "review") {
    // Verification and retained merge approval cover the receipt's observed
    // head. A later head follows the declared update transition to fresh review.
    recoveryStart = updatedTarget;
    if (boundaryState?.resultContract === "verification") {
      // Completed verification belongs to the preceding head iteration. Retire
      // its authorized diagnostic before matching fresh review/verification;
      // the diagnostic after the current-head review must remain revalidatable.
      while (active[0]) {
        const publication = active[0];
        const kind = publicationObjectKind(publication.key, evidence.snapshot.ref, bundle);
        if (kind !== "comment") break;
        const completion = evidence.snapshot.comments.find((comment) =>
          hasPublicationIdentity(publication.key, evidence.snapshot.ref, "comment", comment.id));
        if (!completion || completion.body.split(/\r?\n/)[1] !== "BUG RECEIPT · VERIFIED") break;
        const permission = await providerCall("provider permission read failed", () =>
          provider.permission(evidence.snapshot.ref.repository, completion.actor));
        if (!AUTHORIZED.has(permission)) break;
        active = active.slice(1);
        const approval = active[0] && evidence.reviews.find((review) =>
          hasPublicationIdentity(active[0]!.key, evidence.snapshot.ref, "review", review.id));
        if (!approval || approval.verdict !== "approved" || approval.headSha === linked.headSha
          || !/^[0-9a-f]{40}$/.test(approval.headSha)) break;
        const reviewerPermission = await providerCall("provider permission read failed", () =>
          provider.permission(evidence.snapshot.ref.repository, approval.actor));
        if (!AUTHORIZED.has(reviewerPermission)) break;
        active = active.slice(1);
      }
    }
  }
  const startState = recoveryStart ? bundle.flow.spec.states[recoveryStart] : undefined;
  const reworkTarget = startState?.on?.["review-changes-requested"]?.target;
  if (migration && startState?.resultContract === "review" && reworkTarget
    && bundle.flow.spec.states[reworkTarget]?.resultContract === "development") {
    // A replay may return to a stage preceding its receipt boundary. Consume
    // only a verified rejection before reconstructing that rework's success path.
    const rejection = active[0] && evidence.reviews.find((review) =>
      hasPublicationIdentity(active[0]!.key, evidence.snapshot.ref, "review", review.id));
    if (rejection?.verdict === "changes-requested" && /^[0-9a-f]{40}$/.test(rejection.headSha)) {
      const permission = await providerCall("provider permission read failed", () =>
        provider.permission(evidence.snapshot.ref.repository, rejection.actor));
      if (AUTHORIZED.has(permission)) {
        active = active.slice(1);
        recoveryStart = reworkTarget;
      }
    }
  }
  const committed = successfulPublicationPath(bundle.flow, stage, evidence.snapshot.activation.label, recoveryStart);
  if (!committed) {
    return { kind: "ambiguous", baselineKeys, reason: "provider stage cannot be reconstructed from the pinned flow" };
  }
  if (migration && migration.receipt.start !== stage
    && bundle.flow.spec.states[migration.receipt.start]?.kind === "human-gate"
    && active.length > committed.length) {
    // A revised gate result is followed by human input before downstream work.
    // Keep a current agent result without that input available for revalidation.
    while (active.length > committed.length
      && publicationObjectKind(active[0]!.key, evidence.snapshot.ref, bundle) === "comment") {
      const resultAt = active[0]!.createdAt;
      const nextAt = active[1]?.createdAt;
      let answered = false;
      for (const comment of evidence.snapshot.comments) {
        if (comment.createdAt <= resultAt || (nextAt && comment.createdAt >= nextAt)
          || isMarked(comment.body) || isMigrationCommand(comment.body)
          || comment.body.includes("<!-- agent-flow-migration-diagnostic:")) continue;
        const permission = await providerCall("provider permission read failed", () =>
          provider.permission(evidence.snapshot.ref.repository, comment.actor));
        if (AUTHORIZED.has(permission)) {
          answered = true;
          break;
        }
      }
      if (!answered) break;
      active = active.slice(1);
    }
  }
  if (migration) {
    for (const [developmentId, development] of Object.entries(bundle.flow.spec.states)) {
      if (development.resultContract !== "development") continue;
      const review = bundle.flow.spec.states[development.on?.["agent-succeeded"]?.target ?? ""];
      if (review?.resultContract !== "review"
        || review.on?.["review-changes-requested"]?.target !== developmentId) continue;
      const prefix = successfulPublicationPath(bundle.flow, developmentId,
        evidence.snapshot.activation.label, recoveryStart);
      if (!prefix || !prefix.every((kind, index) => active[index]
        && publicationObjectKind(active[index]!.key, evidence.snapshot.ref, bundle) === kind)) continue;
      const index = prefix.length;
      // CI retries can publish another completion without a rejection review.
      // Supersede only authorized completions on a configured CI retry path;
      // leave the newest result available for ordinary completion validation.
      const retriesCi = Boolean(bundle.flow.spec.requiredChecks?.length)
        && (development.on?.["ci-failed"]?.target === developmentId
          || review.on?.["ci-failed"]?.target === developmentId);
      while (active[index] && active[index + 1]
        && publicationObjectKind(active[index]!.key, evidence.snapshot.ref, bundle) === "comment") {
        const nextKind = publicationObjectKind(active[index + 1]!.key, evidence.snapshot.ref, bundle);
        if (nextKind === "comment" && retriesCi) {
          const completions = active.slice(index, index + 2).map((publication) =>
            evidence.snapshot.comments.find((comment) =>
              hasPublicationIdentity(publication.key, evidence.snapshot.ref, "comment", comment.id)));
          if (completions.some((completion) => !completion)) break;
          // Intervening human input may belong to a gate revision instead.
          // That boundary must be resolved by the gate logic above.
          if (evidence.snapshot.comments.some((comment) =>
            comment.createdAt > completions[0]!.createdAt
            && comment.createdAt < completions[1]!.createdAt
            && !isMarked(comment.body) && !isMigrationCommand(comment.body))) break;
          const permissions = await Promise.all(completions.map((completion) =>
            providerCall("provider permission read failed", () =>
              provider.permission(evidence.snapshot.ref.repository, completion!.actor))));
          if (!permissions.every((permission) => AUTHORIZED.has(permission))) break;
          active.splice(index, 1);
          continue;
        }
        // A verified rejection closes that completion/review iteration, even
        // when a later correction has moved the PR head.
        if (nextKind !== "review") break;
        const completion = evidence.snapshot.comments.find((comment) =>
          hasPublicationIdentity(active[index]!.key, evidence.snapshot.ref, "comment", comment.id));
        const rejection = evidence.reviews.find((candidate) =>
          hasPublicationIdentity(active[index + 1]!.key, evidence.snapshot.ref, "review", candidate.id));
        if (!completion || rejection?.verdict !== "changes-requested"
          || !/^[0-9a-f]{40}$/.test(rejection.headSha)) break;
        const permissions = await Promise.all([completion.actor, rejection.actor].map((actor) =>
          providerCall("provider permission read failed", () =>
            provider.permission(evidence.snapshot.ref.repository, actor))));
        if (!permissions.every((permission) => AUTHORIZED.has(permission))) break;
        active.splice(index, 2);
      }
    }
  }
  if (bundle.flow.spec.states[stage]?.resultContract === "review") {
    active = active.filter((publication) =>
      publicationObjectKind(publication.key, evidence.snapshot.ref, bundle) !== "review"
      || evidence.reviews.some((review) =>
        hasPublicationIdentity(publication.key, evidence.snapshot.ref, "review", review.id)
        && review.headSha === linked?.headSha));
  }
  if (migration && committed.includes("review") && linked) {
    // A head update repeats review without repeating development. Completed
    // approvals for older heads remain history at downstream stages too.
    const superseded = new Set<string>();
    for (const publication of active) {
      const review = evidence.reviews.find((candidate) =>
        hasPublicationIdentity(publication.key, evidence.snapshot.ref, "review", candidate.id));
      if (!review || review.verdict !== "approved" || review.headSha === linked.headSha
        || !/^[0-9a-f]{40}$/.test(review.headSha)) continue;
      const permission = await providerCall("provider permission read failed", () =>
        provider.permission(evidence.snapshot.ref.repository, review.actor));
      if (AUTHORIZED.has(permission)) superseded.add(publication.key);
    }
    active = active.filter((publication) => !superseded.has(publication.key));
  }
  const kinds = active.map((publication) => publicationObjectKind(publication.key, evidence.snapshot.ref, bundle));
  if (kinds.some((kind) => kind === null) || !active.every(({ key }) => baselineKeys.includes(key))) {
    return { kind: "ambiguous", baselineKeys, reason: "publication identity cannot be verified for the active work" };
  }
  const recorded = bundle.flow.spec.states[stage];
  const predecessors = Object.entries(bundle.flow.spec.states).filter(([, state]) =>
    state.kind === "agent" && state.on?.["agent-succeeded"]?.target === stage
    && resultPublicationKind(state.resultContract,Boolean(evidence.migration)) === "comment");
  if ((recorded?.kind === "human-gate" || recorded?.kind === "provider-wait") && predecessors.length === 1) {
    const predecessor = predecessors[0]![0];
    const prefix = committed.slice(0, -1);
    if (prefix.every((kind, index) => kinds[index] === kind)
      && (active.length === committed.length || active.length === prefix.length)) {
      const candidate = active.length === committed.length ? active.at(-1) : null;
      if (candidate && kinds.at(-1) !== "comment") {
        return { kind: "ambiguous", baselineKeys, reason: "published result cannot be reassessed for the recorded stage" };
      }
      return {
        kind: "ready", reassessState: predecessor,
        baselineKeys: baselineKeys.filter((key) => key !== candidate?.key),
        humanCutoff: prefix.length === 0 ? null : active[prefix.length - 1]!.createdAt,
      };
    }
  }
  if (committed.some((kind, index) => kinds[index] !== kind)) {
    return { kind: "ambiguous", baselineKeys, reason: "published results do not justify the provider stage" };
  }
  const change = evidence.snapshot.changeRequest;
  for (const [index, kind] of committed.entries()) {
    if (kind !== "review") continue;
    const review = evidence.reviews.find(({ id }) => hasPublicationIdentity(active[index]!.key, evidence.snapshot.ref, "review", id));
    if (!review || review.verdict !== "approved" || !change || review.headSha !== change.headSha) {
      return { kind: "ambiguous", baselineKeys, reason: "published review does not approve the linked change request head" };
    }
    const permission = await providerCall("provider permission read failed", () =>
      provider.permission(evidence.snapshot.ref.repository, review.actor));
    if (!AUTHORIZED.has(permission)) {
      return { kind: "ambiguous", baselineKeys, reason: "published review author is not authorized" };
    }
  }
  const state = bundle.flow.spec.states[stage];
  const candidateKind = state?.kind === "agent" ? resultPublicationKind(state.resultContract,Boolean(evidence.migration)) : null;
  let candidateKey: string | null = null;
  if (active.length === committed.length + 1 && candidateKind && kinds.at(-1) === candidateKind) {
    candidateKey = active.at(-1)!.key;
  } else if (active.length !== committed.length) {
    return { kind: "ambiguous", baselineKeys, reason: "current publication iteration cannot be isolated" };
  }
  return {
    kind: "ready",
    baselineKeys: baselineKeys.filter((key) => key !== candidateKey),
    humanCutoff: committed.length === 0 ? null : active[committed.length - 1]!.createdAt,
  };
}

function successfulPublicationPath(flow: FlowDefinition, target: string, activationLabel: string | null,start?:string): PublicationObjectKind[] | null {
  const queue: Array<{ stateId: string; kinds: PublicationObjectKind[]; visited: Set<string> }> = [{
    stateId: start ?? entryStage(flow, activationLabel),
    kinds: [],
    visited: new Set(),
  }];
  const matches: PublicationObjectKind[][] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.stateId === target) {
      matches.push(current.kinds);
      continue;
    }
    if (current.visited.has(current.stateId)) continue;
    const state = flow.spec.states[current.stateId];
    if (!state) continue;
    const visited = new Set(current.visited).add(current.stateId);
    for (const event of ["agent-succeeded", "review-approved", "human-approved", "change-request-merged"] as const) {
      const transition = state.on?.[event];
      if (!transition || transition.target === "$resume") continue;
      const publication = event === "agent-succeeded"
        ? resultPublicationKind(state.resultContract,Boolean(start))
        : event === "review-approved" ? "review" : null;
      queue.push({
        stateId: transition.target,
        kinds: publication ? [...current.kinds, publication] : current.kinds,
        visited,
      });
    }
  }
  if (matches.length !== 1) return null;
  return matches[0]!;
}

function resultPublicationKind(result: ResultContract | undefined,migrated=false): PublicationObjectKind | null {
  if(migrated && result==="development") return "comment";
  if (result === "assessment" || result === "plan" || result === "diagnostic" || result === "verification") return "comment";
  if (result === "development") return "change-request";
  if (result === "review") return "review";
  return null;
}

function markedObjectKeys(_bundle: ConfigBundle, evidence: RecoveryEvidence, apiUrl?: string): string[] {
  const keys = new Set(evidence.publications.map(({ key }) => key));
  const configuredScope = apiUrl ? new URL(apiUrl) : null;
  if (configuredScope) configuredScope.pathname = `${configuredScope.pathname.replace(/\/+$/, "")}/`;
  const scope = configuredScope?.href ?? evidence.publications.map(({ key }) => {
    try { return JSON.parse(key)[1]; } catch { return null; }
  }).find((scope) => typeof scope === "string");
  if (scope) for (const [kind, objects] of [
    ["comment", evidence.snapshot.comments.map((object) => ({ id: object.id, body: object.body }))],
    ["change-request", evidence.changes.map((object) => ({ id: String(object.number), body: object.body }))],
    ["review", evidence.reviews.map((object) => ({ id: object.id, body: object.body }))],
  ] as const) {
    for (const object of objects) if (parsePublication(object.body).kind !== "unmarked") {
      keys.add(JSON.stringify([evidence.snapshot.ref.provider, scope, evidence.snapshot.ref.repository, kind, object.id]));
    }
  }
  if(scope && evidence.migration) for(const id of evidence.migration.receipt.baseline.reviews) keys.add(JSON.stringify([evidence.snapshot.ref.provider,scope,evidence.snapshot.ref.repository,"review",id]));
  return [...keys].sort();
}

function publicationObjectKind(key: string, ref: TicketRef, _bundle: ConfigBundle): PublicationObjectKind | null {
  try {
    const parsed = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length !== 5 || parsed[0] !== ref.provider
      || typeof parsed[1] !== "string" || parsed[2] !== ref.repository
      || typeof parsed[4] !== "string") return null;
    return ["comment", "change-request", "review"].includes(parsed[3]) ? parsed[3] : null;
  } catch { return null; }
}

async function cancelLocalOutcome(
  dependencies: ReconcileDependencies,
  snapshot: ProviderTicketSnapshot,
  control: ControlState,
): Promise<ReconcileOutcome> {
  const cancelled = await cancelLocal(dependencies, snapshot, control);
  const bundle = await dependencies.config.loadPinned(cancelled.configRevision);
  return outcome(cancelled, bundle, snapshot, true, false);
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
  const activationLabel = snapshot.activation.label;
  const previous = history.at(-1);
  if (!actor || !eventId || !occurredAt || !activationLabel) {
    return outcome(previous?.parsed.state ?? null, previous?.bundle ?? null, snapshot, false, false, previous?.terminal);
  }
  const permission = await providerCall(
    "provider permission read failed",
    () => dependencies.provider.permission(snapshot.ref.repository, actor),
  );
  if (!AUTHORIZED.has(permission)) {
    return outcome(previous?.parsed.state ?? null, previous?.bundle ?? null, snapshot, false, false, previous?.terminal);
  }

  const bundle = await configCall("current configuration load failed", () => dependencies.config.loadCurrent());
  assertBundle(bundle, bundle.revision);
  assertAllowed(dependencies, snapshot.ref);
  const route = bundle.flow.spec.activationRoutes?.[activationLabel];
  if (!snapshot.labels.includes(activationLabel)
    || (activationLabel !== bundle.flow.metadata.activationLabel && !route)) {
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
    stateId: route ?? bundle.flow.spec.initial,
    resumeStateId: null,
    activatedBy: actor,
    activatedAt: occurredAt,
    activationEventId: eventId,
    activationLabel,
    updatedAt: timestamp,
    attemptSeries: null,
    latestReceipt: null,
    humanGate: null,
    changeRequest: null,
  };
  await createControl(dependencies.provider, snapshot.ref, control);
  await ownLabels(dependencies.provider, snapshot.ref, snapshot.labels, bundle, control.stateId, false);
  const started = await startIfNeeded(dependencies, snapshot, bundle, control, []);
  return outcome(control, bundle, snapshot, true, started);
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
  return outcome(control, current.bundle, snapshot, true, false);
}

async function loadControls(
  parsed: ParsedControlComment[],
  config: ReconcileConfigSource,
): Promise<LoadedControl[]> {
  const bundles = new Map<string, ConfigBundle>();
  const result: LoadedControl[] = [];
  for (const item of parsed) {
    if (item.state.stateId === "done" || item.state.stateId === "cancelled") {
      const bundle = await config.loadCurrent();
      result.push({ parsed: item, bundle, terminal: true });
      continue;
    }
    let bundle = bundles.get(item.state.configRevision);
    if (!bundle) {
      bundle = await configCall(
        "pinned configuration load failed",
        () => config.loadPinned(item.state.configRevision),
      );
      assertBundle(bundle, item.state.configRevision);
      bundles.set(item.state.configRevision, bundle);
    }
    validateBundleDocument(bundle, "ControlState", item.state);
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

function assertAllowed(dependencies: ReconcileDependencies, ref: TicketRef): void {
  if (dependencies.isAllowed && !dependencies.isAllowed(ref)) {
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
  pinnedActivationLabel?: string,
): Promise<void> {
  const stage = `agent-stage:${stateId === "bug-awaiting-merge" ? "awaiting-merge" : stateId}`;
  const managed = bundle.flow.metadata.managedLabel;
  const activation = [
    bundle.flow.metadata.activationLabel,
    ...Object.keys(bundle.flow.spec.activationRoutes ?? {}),
    ...pinnedActivationLabel ? [pinnedActivationLabel] : [],
  ];
  const remove = labels.filter((label) =>
    (label.startsWith("agent-stage:") && label !== stage)
    || (removeActivation && activation.includes(label)));
  const add = [
    ...labels.includes(managed) ? [] : [managed],
    ...labels.includes(stage) ? [] : [stage],
  ];
  const current = remove.length || add.length
    ? await providerCall(
      "provider controller label update failed",
      () => provider.setControllerLabels(ref, remove, add, activation),
    )
    : labels;
  const stages = current.filter((label) => label.startsWith("agent-stage:"));
  if (!current.includes(managed)
    || stages.length !== 1
    || stages[0] !== stage
    || (removeActivation && activation.some((label) => current.includes(label)))) {
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
        if (snapshot.changeRequest?.state !== "closed" || resume.resultContract !== "review") return false;
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
  const inputRevision = attemptInputRevision(control, snapshot, sourceComment,dependencies.migration?.id);
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
    migration:dependencies.migration,
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
  migrationId?:string,
): string {
  const parts: unknown[] = [
    ["config", control.configRevision],
    ...migrationId ? [["migration",migrationId]] : [],
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
    .filter((candidate) => candidate.createdAt > cutoff && !isMarked(candidate.body) && !isMigrationCommand(candidate.body) && !candidate.body.includes("<!-- agent-flow-migration-diagnostic:"))
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
  if (publications.length === 0) return control.updatedAt;
  return publications.reduce(
    (latest, candidate) => candidate.createdAt > latest ? candidate.createdAt : latest,
    control.activatedAt,
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
  bundle: ConfigBundle | null,
  snapshot: ProviderTicketSnapshot,
  changed: boolean,
  started: boolean,
  runnable = true,
): ReconcileOutcome {
  const terminal = control?.stateId === "done" || control?.stateId === "cancelled";
  if (control && bundle && !terminal && bundle.revision !== control.configRevision) {
    throw new Error("control configuration does not match its pinned bundle");
  }
  const stateKind = control ? terminal ? "final" : bundle?.flow.spec.states[control.stateId]?.kind ?? null : null;
  if (control && bundle && !stateKind) throw new Error("control state does not exist in pinned flow");
  const repositoryUrl = repositoryWebUrl(snapshot.repository);
  const ticketUrl = `${repositoryUrl}${snapshot.ref.provider === "gitlab" ? "/-/issues/" : "/issues/"}${snapshot.ref.number}`;
  return {
    flowInstanceId: control?.flowInstanceId ?? null,
    stateId: control?.stateId ?? null,
    configRevision: control?.configRevision ?? null,
    stateKind: stateKind ?? null,
    repositoryUrl,
    ticketUrl,
    actionUrl: stateKind === "provider-wait" && control?.changeRequest?.url
      ? control.changeRequest.url
      : ticketUrl,
    changed,
    started,
    runnable,
  };
}

function repositoryWebUrl(repository: ProviderTicketSnapshot["repository"]): string {
  const url = new URL(repository.cloneUrl);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");
  return url.href.replace(/\/$/, "");
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
