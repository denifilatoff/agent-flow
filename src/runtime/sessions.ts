import { open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ControlState } from "../config/types.js";
import type {
  ProviderArtifact,
  ProviderTicketSnapshot,
} from "../provider/types.js";
import {
  assertCanonicalUuid,
  assertSafeFile,
  assertSafeWritableFile,
  createSafeDirectory,
  ensureSafeDirectory,
  prepareDataRoot,
  removeSafeFile,
} from "./filesystem.ts";

export interface AttemptContext {
  ticket: ProviderTicketSnapshot;
  controlState: ControlState;
  artifacts: ProviderArtifact[];
  mode: "stage" | "human-input";
}

export interface AttemptSession {
  root: string;
  contextPath: string;
  decisionPath: string;
  logPath: string;
  harnessSessionDirectory: string;
}

export async function createAttemptSession(
  dataDirectory: string,
  flowInstanceId: string,
  attemptId: string,
  context: AttemptContext,
): Promise<AttemptSession> {
  assertCanonicalUuid(flowInstanceId, "flow instance ID");
  assertCanonicalUuid(attemptId, "attempt ID");
  const dataRoot = await prepareDataRoot(dataDirectory);
  const sessions = await ensureSafeDirectory(dataRoot, join(dataRoot, "sessions"), "sessions directory");
  const flowRoot = await ensureSafeDirectory(sessions, join(sessions, flowInstanceId), "flow session directory");
  let root: string;
  try {
    root = await createSafeDirectory(flowRoot, join(flowRoot, attemptId), "attempt session directory");
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`attempt session already exists: ${join(flowRoot, attemptId)}`);
    }
    throw error;
  }
  const session: AttemptSession = {
    root,
    contextPath: join(root, "context.json"),
    decisionPath: join(root, "decision.json"),
    logPath: join(root, "harness.log"),
    harnessSessionDirectory: join(root, "harness-session"),
  };

  await publishContext(root, session.contextPath, context);
  await assertSafeWritableFile(root, session.decisionPath, "decision path");
  await writeFile(session.decisionPath, "", { flag: "wx", mode: 0o600 });
  await assertSafeWritableFile(root, session.logPath, "harness log path");
  await writeFile(session.logPath, "", { flag: "wx", mode: 0o600 });
  session.harnessSessionDirectory = await createSafeDirectory(
    root,
    session.harnessSessionDirectory,
    "harness session directory",
  );
  return session;
}

async function publishContext(root: string, contextPath: string, context: AttemptContext): Promise<void> {
  const temporaryPath = join(root, ".context.json.tmp");
  await assertSafeWritableFile(root, temporaryPath, "temporary context path");
  const handle = await open(temporaryPath, "wx", 0o600);
  let closed = false;
  try {
    await handle.writeFile(`${JSON.stringify(context, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    closed = true;
    await assertSafeWritableFile(root, contextPath, "context path");
    await rename(temporaryPath, contextPath);
    await assertSafeFile(root, contextPath, "context path");
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await removeSafeFile(root, temporaryPath, "temporary context path").catch(() => undefined);
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
