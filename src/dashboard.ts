import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import type { Dir, Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { RuntimeManager } from "./config/runtime.ts";
import type { ReadyDependencies } from "./preflight.ts";
import type { SecretRedactor } from "./redaction.ts";
import { assertCanonicalUuid, assertSafeDirectory, assertSafeFile } from "./runtime/filesystem.ts";

const SESSION_LIMIT = 100;
const SESSION_SCAN_LIMIT = SESSION_LIMIT + 1;
const FILE_LIMIT = 1_048_576;
const SESSION_FILES = ["harness.log", "decision.json", "context.json"] as const;
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
  | { status: 400 | 404 | 413; body: { available: false; reason:
    "invalid session path" | "session file unavailable" | "session file too large" } };

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
      runtime: {
        concurrency: effective.runtime.concurrency,
        http: { address: effective.runtime.http.address, port: effective.runtime.http.port },
      },
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
            entries.push({
              flowUuid: flow.name,
              attemptUuid: attempt.name,
              modifiedAt: metadata.mtime.toISOString(),
              files: await discoverSessionFiles(sessions, root),
            });
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

export async function readDashboardSessionFile(
  dataDirectory: string,
  flowUuid: string,
  attemptUuid: string,
  file: string,
  redact: SecretRedactor,
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

  let handle: FileHandle | undefined;
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
    if (metadata.size > FILE_LIMIT) return sessionTooLarge();
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > FILE_LIMIT) return sessionTooLarge();
    const raw = buffer.subarray(0, length).toString("utf8");
    const redacted = file.endsWith(".json") ? redactJsonContent(raw, redact) : redact(raw);
    const body = { available: true as const, content: redacted, truncated: false };
    if (Buffer.byteLength(redacted) > FILE_LIMIT || Buffer.byteLength(`${JSON.stringify(body)}\n`) > FILE_LIMIT) {
      return sessionTooLarge();
    }
    return {
      status: 200,
      body,
    };
  } catch {
    return { status: 404, body: { available: false, reason: "session file unavailable" } };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function discoverSessionFiles(sessions: string, root: string): Promise<SessionFile[]> {
  const files: SessionFile[] = [];
  for (const file of SESSION_FILES) {
    try {
      await assertSafeFile(sessions, join(root, file), "session file");
      files.push(file);
    } catch {
      // Fixed allowlist checks advertise only regular files inside the session root.
    }
  }
  return files;
}

async function nextSessionDirent(directory: Dir, scan: { remaining: number; truncated: boolean }): Promise<Dirent | null> {
  if (scan.remaining === 0) {
    if (!scan.truncated && await directory.read() !== null) scan.truncated = true;
    return null;
  }
  const entry = await directory.read();
  if (entry === null) return null;
  scan.remaining -= 1;
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

function redactJsonContent(content: string, redact: SecretRedactor): string {
  try {
    return JSON.stringify(mapJsonStrings(JSON.parse(content), redact), null, 2);
  } catch {
    return redact(content);
  }
}

function mapJsonStrings(value: unknown, redact: SecretRedactor): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => mapJsonStrings(item, redact));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), mapJsonStrings(item, redact)]));
  }
  return value;
}

function sessionTooLarge(): SessionFileResult {
  return { status: 413, body: { available: false, reason: "session file too large" } };
}

function isContained(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

async function resolveLinuxDescriptorPath(fd: number): Promise<string> {
  if (process.platform !== "linux") throw new Error("session descriptor paths are unavailable");
  return realpath(`/proc/self/fd/${fd}`);
}
