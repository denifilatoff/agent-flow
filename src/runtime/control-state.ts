import { isDeepStrictEqual } from "node:util";

import type { ControlState, LocalExecution } from "../config/types.js";
import {
  listControlComments,
  parseExpectedControlComment,
  renderControlComment,
} from "../provider/control-comment.ts";
import type { ProviderAdapter, RecoveryEvidence, TicketRef } from "../provider/types.js";
import type { LocalStore, StoredExecution } from "./local-store.ts";
import type { RecoveryDecision } from "./recovery.ts";

export interface ControlWriter {
  (
  ref: TicketRef,
  expected: ControlState | null,
  next: ControlState,
  publicationKeys?: readonly string[],
  ): Promise<ControlState>;
  load?(ref: TicketRef): StoredExecution | null;
  recordRecovery?(
    ref: TicketRef,
    evidence: RecoveryEvidence,
    decision: RecoveryDecision,
    control?: ControlState | null,
    publicationKeys?: readonly string[],
  ): Promise<StoredExecution>;
}

export function createControlWriter(
  store: LocalStore,
  scope: string,
  controllerId: string,
  now?: () => string,
): ControlWriter;
export function createControlWriter(provider: ProviderAdapter): ControlWriter;
export function createControlWriter(
  source: LocalStore | ProviderAdapter,
  scope?: string,
  controllerId?: string,
  now: () => string = () => new Date().toISOString(),
): ControlWriter {
  if (isLocalStore(source)) {
    if (!scope || !controllerId) throw new Error("local control writer requires scope and controller identity");
    const store = source;
    const writer: ControlWriter = async (ref, expected, next, publicationKeys) => {
      if (next.flowInstanceId !== (expected?.flowInstanceId ?? next.flowInstanceId)
        || next.sequence !== (expected?.sequence ?? -1) + 1) {
        throw new Error("invalid control state update");
      }
      const stored = store.load(scope, ref);
      if (!isDeepStrictEqual(stored?.value.control ?? null, expected)) {
        throw new Error("stale local execution write");
      }
      const value: LocalExecution = {
        ...stored?.value.migrationId ? {migrationId:stored.value.migrationId} : {},
        controllerId,
        observedAt: now(),
        owner: stored?.value.owner ?? null,
        disposition: stored?.value.disposition ?? "ready",
        reason: stored?.value.reason ?? null,
        publicationKeys: publicationKeys === undefined
          ? stored?.value.publicationKeys ?? []
          : [...publicationKeys],
        control: next,
      };
      return store.save(scope, ref, stored?.revision ?? null, value).value.control!;
    };
    writer.load = (ref) => store.load(scope, ref);
    writer.recordRecovery = async (ref, evidence, decision, replacement, baseline) => {
      const stored = store.load(scope, ref);
      if (stored && stored.value.controllerId !== controllerId) {
        throw new Error("local execution belongs to another controller identity");
      }
      const owner = decision.owner ? {
        controllerId: decision.owner.metadata.controller,
        publicationKey: decision.owner.key,
      } : null;
      const disposition: LocalExecution["disposition"] = decision.kind === "foreign"
        ? "foreign"
        : decision.kind === "ambiguous"
          ? "ambiguous"
          : decision.kind === "inactive"
            ? "inactive"
            : "ready";
      const publicationKeys = [...(baseline ?? evidence.publications.map(({ key }) => key))].sort();
      const control = replacement === undefined ? stored?.value.control ?? null : replacement;
      const migrationId=evidence.migration?.id ?? stored?.value.migrationId;
      const comparable = { migrationId, owner, disposition, reason: decision.reason, publicationKeys, control };
      if (stored && isDeepStrictEqual(comparable, {
        migrationId:stored.value.migrationId,
        owner: stored.value.owner,
        disposition: stored.value.disposition,
        reason: stored.value.reason,
        publicationKeys: stored.value.publicationKeys,
        control: stored.value.control,
      })) return stored;

      const revision = stored ? stored.revision + 1 : 0;
      const aligned = control && control.sequence !== revision
        ? { ...control, sequence: revision }
        : control;
      return store.save(scope, ref, stored?.revision ?? null, {
        ...migrationId ? {migrationId} : {},
        controllerId,
        observedAt: now(),
        owner,
        disposition,
        reason: decision.reason,
        publicationKeys,
        control: aligned,
      });
    };
    return writer;
  }

  const provider = source;
  const tails = new Map<string, Promise<void>>();
  return (ref, expected, next) => {
    if (!expected) return Promise.reject(new Error("provider control creation is not supported by the writer"));
    const key = `${ref.provider}:${ref.repository}#${ref.number}`;
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      if (next.flowInstanceId !== expected.flowInstanceId || next.sequence !== expected.sequence + 1) {
        throw new Error("invalid control state update");
      }
      const snapshot = await provider.readTicket(ref);
      const matches = listControlComments(snapshot.comments)
        .filter(({ state }) => state.flowInstanceId === expected.flowInstanceId);
      if (matches.length !== 1 || matches[0]!.state.sequence !== expected.sequence) {
        throw new Error("control state compare-and-swap conflict");
      }
      const id = matches[0]!.comment.id;
      const body = renderControlComment(next);
      const updated = await provider.updateComment(ref, id, body);
      if (updated.id !== id || !parseExpectedControlComment(updated.body, next)) {
        throw new Error("control state update mismatch");
      }
      const readback = await provider.readComment(ref, id);
      const parsed = parseExpectedControlComment(readback.body, next);
      if (readback.id !== id || !parsed) throw new Error("control state readback mismatch");
      return parsed;
    });
    const tail = result.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.finally(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  };
}

export async function writeControlCas(
  writer: ControlWriter,
  ref: TicketRef,
  expected: ControlState | null,
  next: ControlState,
  publicationKeys?: readonly string[],
): Promise<ControlState> {
  const readback = await writer(ref, expected, next, publicationKeys);
  if (!isDeepStrictEqual(readback, next)) throw new Error("control state readback does not match");
  return readback;
}

function isLocalStore(value: LocalStore | ProviderAdapter): value is LocalStore {
  return "load" in value && "save" in value && "close" in value;
}
