import { lstat, opendir, realpath } from "node:fs/promises";
import type { Dir, Dirent } from "node:fs";
import { join, resolve } from "node:path";

import type { RuntimeManager } from "./config/runtime.ts";
import type { ReadyDependencies } from "./preflight.ts";
import { assertCanonicalUuid, assertSafeDirectory } from "./runtime/filesystem.ts";

const SESSION_LIMIT = 100;
const SESSION_SCAN_LIMIT = SESSION_LIMIT + 1;
export interface DashboardSession {
  flowUuid: string;
  attemptUuid: string;
  modifiedAt: string;
}

export type SessionDiscovery =
  | { available: true; entries: DashboardSession[]; truncated: boolean }
  | { available: false; entries: []; reason: "sessions unavailable" };

export async function createDashboardSnapshot(runtime: RuntimeManager, ready: ReadyDependencies) {
  const effective = runtime.effective();
  return {
    available: true as const,
    status: {
      configurationRepository: effective.configuration.repository,
      configurationRevision: effective.configuration.revision,
      ...runtime.status(),
    },
    runtime: {
      apiVersion: effective.apiVersion,
      kind: effective.kind,
      configuration: { ...effective.configuration },
      provider: {
        type: effective.provider.type,
        apiUrl: effective.provider.apiUrl,
        repositories: [...effective.provider.repositories],
      },
      execution: {
        agents: structuredClone(effective.execution.agents),
        harnesses: Object.keys(effective.execution.harnesses).sort(),
      },
      polling: { ...effective.polling },
      runtime: { concurrency: effective.runtime.concurrency, http: { ...effective.runtime.http } },
    },
    configuration: {
      repository: effective.configuration.repository,
      revision: ready.bundle.revision,
      stackPath: effective.configuration.stack,
      stack: structuredClone(ready.bundle.stack),
    },
    flow: structuredClone(ready.bundle.flow),
    catalog: structuredClone(ready.bundle.catalog),
    preflight: structuredClone(ready.preflight),
    controller: ready.controller.snapshot(),
    sessions: await discoverSessions(effective.runtime.dataDirectory),
  };
}

export async function discoverSessions(dataDirectory: string): Promise<SessionDiscovery> {
  let sessions: string;
  try {
    sessions = await sessionsRoot(dataDirectory);
  } catch {
    return { available: false, entries: [], reason: "sessions unavailable" };
  }

  let flows;
  try {
    flows = await opendir(sessions);
  } catch {
    return { available: false, entries: [], reason: "sessions unavailable" };
  }
  const entries: DashboardSession[] = [];
  const scan = { remaining: SESSION_SCAN_LIMIT, truncated: false };
  try {
    let flow: Dirent | null;
    while ((flow = await nextSessionDirent(flows, scan)) !== null) {
      if (!flow.isDirectory() || !isCanonicalUuid(flow.name)) continue;
      let flowRoot: string;
      try {
        flowRoot = await assertSafeDirectory(sessions, join(sessions, flow.name), "flow session directory");
      } catch {
        continue;
      }
      let attempts: Dir;
      try {
        attempts = await opendir(flowRoot);
      } catch {
        continue;
      }
      try {
        let attempt: Dirent | null;
        while ((attempt = await nextSessionDirent(attempts, scan)) !== null) {
          if (!attempt.isDirectory() || !isCanonicalUuid(attempt.name)) continue;
          try {
            const root = await assertSafeDirectory(sessions, join(flowRoot, attempt.name), "attempt session directory");
            const metadata = await lstat(root);
            entries.push({ flowUuid: flow.name, attemptUuid: attempt.name, modifiedAt: metadata.mtime.toISOString() });
          } catch {
            // A concurrent removal or unsafe entry makes only that diagnostic session unavailable.
          }
        }
      } finally {
        await attempts.close().catch(() => undefined);
      }
    }
  } catch {
    return { available: false, entries: [], reason: "sessions unavailable" };
  } finally {
    await flows.close().catch(() => undefined);
  }
  entries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt)
    || right.flowUuid.localeCompare(left.flowUuid)
    || right.attemptUuid.localeCompare(left.attemptUuid));
  return {
    available: true,
    entries,
    truncated: scan.truncated,
  };
}

async function nextSessionDirent(directory: Dir, scan: { remaining: number; truncated: boolean }): Promise<Dirent | null> {
  if (scan.remaining === 0) return null;
  const entry = await directory.read();
  if (entry === null) return null;
  scan.remaining -= 1;
  if (scan.remaining === 0) scan.truncated = true;
  return entry;
}

async function sessionsRoot(dataDirectory: string): Promise<string> {
  const configured = resolve(dataDirectory);
  const metadata = await lstat(configured);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("data directory is unavailable");
  const dataRoot = await realpath(configured);
  return assertSafeDirectory(dataRoot, join(dataRoot, "sessions"), "sessions directory");
}

function isCanonicalUuid(value: string): boolean {
  try {
    assertCanonicalUuid(value, "session ID");
    return true;
  } catch {
    return false;
  }
}
