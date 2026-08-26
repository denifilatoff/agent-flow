import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ControlState } from "../config/types.js";
import type {
  ProviderArtifact,
  ProviderTicketSnapshot,
} from "../provider/types.js";

export interface AttemptContext {
  ticket: ProviderTicketSnapshot;
  controlState: ControlState;
  artifacts: ProviderArtifact[];
  mode: "stage" | "human-input";
}

export interface AttemptSession {
  root: string;
  contextPath: string;
  receiptPath: string;
  logPath: string;
  harnessSessionDirectory: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function createAttemptSession(
  dataDirectory: string,
  flowInstanceId: string,
  attemptId: string,
  context: AttemptContext,
): Promise<AttemptSession> {
  assertUuid(flowInstanceId, "flow instance ID");
  assertUuid(attemptId, "attempt ID");
  const sessions = join(resolve(dataDirectory), "sessions");
  const flowRoot = join(sessions, flowInstanceId);
  const root = join(flowRoot, attemptId);
  const session: AttemptSession = {
    root,
    contextPath: join(root, "context.json"),
    receiptPath: join(root, "receipt.json"),
    logPath: join(root, "harness.log"),
    harnessSessionDirectory: join(root, "harness-session"),
  };

  await mkdir(flowRoot, { recursive: true, mode: 0o700 });
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`attempt session already exists: ${root}`);
    }
    throw error;
  }
  await chmod(root, 0o700);
  await writeFile(session.contextPath, `${JSON.stringify(context, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(session.receiptPath, "", { flag: "wx", mode: 0o600 });
  await writeFile(session.logPath, "", { flag: "wx", mode: 0o600 });
  await mkdir(session.harnessSessionDirectory, { mode: 0o700 });
  return session;
}

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new Error(`${label} must be a UUID`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
