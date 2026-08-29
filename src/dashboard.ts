import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { RuntimeManager } from "./config/runtime.ts";
import type { ReadyDependencies } from "./preflight.ts";
import { assertCanonicalUuid, assertSafeDirectory, assertSafeFile } from "./runtime/filesystem.ts";

const SESSION_LIMIT = 100;
const FILE_LIMIT = 1_048_576;
const SESSION_FILES = ["context.json", "decision.json", "harness.log"] as const;
type SessionFile = typeof SESSION_FILES[number];
type SessionFileOpener = (path: string, flags: number) => Promise<FileHandle>;
export type DescriptorPathResolver = (fd: number, expectedPath: string) => Promise<string>;

export interface DashboardSession {
  flowUuid: string;
  attemptUuid: string;
  modifiedAt: string;
  files: SessionFile[];
}

export type SessionDiscovery =
  | { available: true; entries: DashboardSession[]; truncated: boolean }
  | { available: false; entries: []; reason: "sessions unavailable" };

export type SessionFileResult =
  | { status: 200; body: { available: true; content: string; truncated: boolean } }
  | { status: 400 | 404; body: { available: false; reason: "invalid session path" | "session file unavailable" } };

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
    flows = await readdir(sessions, { withFileTypes: true });
  } catch {
    return { available: false, entries: [], reason: "sessions unavailable" };
  }
  const entries: DashboardSession[] = [];
  for (const flow of flows) {
    if (!flow.isDirectory() || !isCanonicalUuid(flow.name)) continue;
    let flowRoot: string;
    try {
      flowRoot = await assertSafeDirectory(sessions, join(sessions, flow.name), "flow session directory");
    } catch {
      continue;
    }
    const attempts = await readdir(flowRoot, { withFileTypes: true }).catch(() => []);
    for (const attempt of attempts) {
      if (!attempt.isDirectory() || !isCanonicalUuid(attempt.name)) continue;
      try {
        const root = await assertSafeDirectory(sessions, join(flowRoot, attempt.name), "attempt session directory");
        const metadata = await lstat(root);
        const files: SessionFile[] = [];
        for (const file of SESSION_FILES) {
          const info = await lstat(join(root, file)).catch(() => null);
          if (info?.isFile() && !info.isSymbolicLink()) files.push(file);
        }
        entries.push({ flowUuid: flow.name, attemptUuid: attempt.name, modifiedAt: metadata.mtime.toISOString(), files });
      } catch {
        // A concurrent removal or unsafe entry makes only that diagnostic session unavailable.
      }
    }
  }
  entries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt)
    || right.flowUuid.localeCompare(left.flowUuid)
    || right.attemptUuid.localeCompare(left.attemptUuid));
  return {
    available: true,
    entries: entries.slice(0, SESSION_LIMIT),
    truncated: entries.length > SESSION_LIMIT,
  };
}

export async function readDashboardSessionFile(
  dataDirectory: string,
  flowUuid: string,
  attemptUuid: string,
  file: string,
  openFile: SessionFileOpener = (path, flags) => open(path, flags),
  resolveDescriptorPath: DescriptorPathResolver = resolveLinuxDescriptorPath,
): Promise<SessionFileResult> {
  try {
    assertCanonicalUuid(flowUuid, "flow UUID");
    assertCanonicalUuid(attemptUuid, "attempt UUID");
  } catch {
    return { status: 400, body: { available: false, reason: "invalid session path" } };
  }
  if (!SESSION_FILES.includes(file as SessionFile)) {
    return { status: 400, body: { available: false, reason: "invalid session path" } };
  }

  let handle;
  try {
    const sessions = await sessionsRoot(dataDirectory);
    const flowRoot = await assertSafeDirectory(sessions, join(sessions, flowUuid), "flow session directory");
    const attemptRoot = await assertSafeDirectory(sessions, join(flowRoot, attemptUuid), "attempt session directory");
    const candidate = await assertSafeFile(sessions, join(attemptRoot, file), "session file");
    handle = await openFile(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("session file is not regular");
    const descriptorPath = await resolveDescriptorPath(handle.fd, candidate);
    if (!isContained(sessions, descriptorPath) || descriptorPath !== candidate) {
      throw new Error("session descriptor does not match the requested file");
    }
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return {
      status: 200,
      body: {
        available: true,
        content: buffer.subarray(0, Math.min(length, FILE_LIMIT)).toString("utf8"),
        truncated: length > FILE_LIMIT || metadata.size > FILE_LIMIT,
      },
    };
  } catch {
    return { status: 404, body: { available: false, reason: "session file unavailable" } };
  } finally {
    await handle?.close().catch(() => undefined);
  }
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

function isContained(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

async function resolveLinuxDescriptorPath(fd: number): Promise<string> {
  if (process.platform !== "linux") throw new Error("session descriptor paths are unavailable");
  return realpath(`/proc/self/fd/${fd}`);
}
