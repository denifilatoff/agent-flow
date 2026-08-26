import { isDeepStrictEqual } from "node:util";

import type { ControlState } from "../config/types.js";
import {
  listControlComments,
  parseExpectedControlComment,
  renderControlComment,
} from "../provider/control-comment.ts";
import type { ProviderAdapter, TicketRef } from "../provider/types.js";

export interface ControlWriteExpectation {
  flowInstanceId: string;
  sequence: number;
}

export type ControlWriter = (
  ref: TicketRef,
  expected: ControlWriteExpectation,
  next: ControlState,
) => Promise<ControlState>;

export function createControlWriter(provider: ProviderAdapter): ControlWriter {
  const tails = new Map<string, Promise<void>>();
  return (ref, expected, next) => {
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
  expected: ControlState,
  next: ControlState,
): Promise<ControlState> {
  const readback = await writer(ref, {
    flowInstanceId: expected.flowInstanceId,
    sequence: expected.sequence,
  }, next);
  if (!isDeepStrictEqual(readback, next)) throw new Error("control state readback does not match");
  return readback;
}
