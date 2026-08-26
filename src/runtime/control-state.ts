import { isDeepStrictEqual } from "node:util";

import type { ControlState } from "../config/types.js";
import type { TicketRef } from "../provider/types.js";

export interface ControlWriteExpectation {
  flowInstanceId: string;
  sequence: number;
}

export type ControlWriter = (
  ref: TicketRef,
  expected: ControlWriteExpectation,
  next: ControlState,
) => Promise<ControlState>;

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
