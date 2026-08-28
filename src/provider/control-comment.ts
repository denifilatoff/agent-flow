import { isDeepStrictEqual } from "node:util";

import { validateDocument } from "../config/schema-validator.ts";
import type { ControlState } from "../config/types.js";

const CONTROL_MARKER = "<!-- agent-flow-control:v1";
const LEGACY_CONTROL_MARKER = `${CONTROL_MARKER} -->`;
const CONTROL_COMMENT = /^<!-- agent-flow-control:v1\n([A-Za-z0-9+/]+={0,2})\n-->\n?$/;
const LEGACY_CONTROL_COMMENT = /^<!-- agent-flow-control:v1 -->\n```json\n([\s\S]+)\n```\n?$/;
const PATCH_FIELDS = new Set<keyof ControlStatePatch>([
  "stateId",
  "resumeStateId",
  "attemptSeries",
  "latestReceipt",
  "humanGate",
  "changeRequest",
]);

export interface ProviderComment {
  id: string;
  body: string;
}

export interface ParsedControlComment {
  comment: ProviderComment;
  state: ControlState;
}

export type ControlStatePatch = Partial<Pick<
  ControlState,
  "stateId" | "resumeStateId" | "attemptSeries" | "latestReceipt" | "humanGate" | "changeRequest"
>>;

export function parseControlComment(body: string): ControlState | null {
  const firstLine = body.split("\n", 1)[0];
  if (firstLine !== CONTROL_MARKER && firstLine !== LEGACY_CONTROL_MARKER) return null;

  const hidden = firstLine === CONTROL_MARKER;
  const match = (hidden ? CONTROL_COMMENT : LEGACY_CONTROL_COMMENT).exec(body);
  if (!match) throw new Error("invalid control comment format");

  let value: unknown;
  try {
    const json = hidden ? Buffer.from(match[1]!, "base64").toString("utf8") : match[1]!;
    if (hidden && Buffer.from(json).toString("base64") !== match[1]) {
      throw new Error("non-canonical base64");
    }
    value = JSON.parse(json);
  } catch (error) {
    throw new Error("invalid control comment JSON", { cause: error });
  }
  return validateDocument<ControlState>("ControlState", value);
}

export function renderControlComment(state: ControlState): string {
  const valid = validateDocument<ControlState>("ControlState", state);
  const payload = Buffer.from(JSON.stringify(valid)).toString("base64");
  return `${CONTROL_MARKER}\n${payload}\n-->\n`;
}

export function parseExpectedControlComment(body: string, expected: ControlState): ControlState | null {
  const canonical = renderControlComment(expected);
  if (body !== canonical && body !== canonical.slice(0, -1)) return null;
  const parsed = parseControlComment(body);
  return parsed && isDeepStrictEqual(parsed, expected) ? parsed : null;
}

export function listControlComments(comments: ProviderComment[]): ParsedControlComment[] {
  const parsed: ParsedControlComment[] = [];
  const flowIds = new Set<string>();
  for (const comment of comments) {
    const state = parseControlComment(comment.body);
    if (!state) continue;
    if (flowIds.has(state.flowInstanceId)) {
      throw new Error(`duplicate control comment for flow ${state.flowInstanceId}`);
    }
    flowIds.add(state.flowInstanceId);
    parsed.push({ comment, state });
  }
  return parsed;
}

export function selectActiveControlComment(
  comments: ParsedControlComment[],
  finalStates: Set<string>,
): ParsedControlComment | null {
  const active = comments.filter(({ state }) => !finalStates.has(state.stateId));
  if (active.length > 1) throw new Error("multiple active control comments");
  return active[0] ?? null;
}

export function advanceControlState(
  current: ControlState,
  patch: ControlStatePatch,
  now: string,
): ControlState {
  const nextSequence = current.sequence + 1;
  if (!Number.isSafeInteger(current.sequence) || !Number.isSafeInteger(nextSequence)) {
    throw new Error("control state sequence must increment to a safe integer");
  }
  for (const field of Object.keys(patch)) {
    if (!PATCH_FIELDS.has(field as keyof ControlStatePatch)) {
      throw new Error(`unsupported control state patch field: ${field}`);
    }
  }
  return validateDocument<ControlState>("ControlState", {
    ...current,
    ...patch,
    sequence: nextSequence,
    updatedAt: now,
  });
}
