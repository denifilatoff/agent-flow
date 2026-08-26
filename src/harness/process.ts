import {
  execFile as execFileCallback,
  spawn as spawnChild,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, opendir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";

import type { HarnessTarget } from "../config/types.ts";
import { assertSafeDirectory, assertSafeFile, createSafeDirectory } from "../runtime/filesystem.ts";
import type { AttemptSession } from "../runtime/sessions.ts";
import type { HarnessResult } from "./types.ts";

const MAX_PROMPT_BYTES = 1_048_576;
const TERMINATION_GRACE_MS = 10_000;

export interface SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
}

export interface SpawnOptions extends SpawnOptionsWithoutStdio {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ["pipe", "pipe", "pipe"];
}

export type SpawnRunner = (file: string, args: string[], options: SpawnOptions) => SpawnedProcess;

export type CommandRunner = (
  file: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

type TimerHandle = object;

export interface ProcessDependencies {
  spawn: SpawnRunner;
  runCommand: CommandRunner;
  setTimeout(callback: () => void, delay: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface ProcessSpec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  prompt: string;
  timeoutSeconds: number;
  signal: AbortSignal;
}

export class HarnessPreflightError extends Error {
  readonly code = "HARNESS_PREFLIGHT_FAILED";
  readonly retryable = false;

  constructor(target: HarnessTarget) {
    super(`${target} harness preflight failed`);
    this.name = "HarnessPreflightError";
  }
}

export class HarnessProcessError extends Error {
  readonly code = "HARNESS_PROCESS_FAILED";
  readonly retryable: boolean;

  constructor(target: HarnessTarget, retryable: boolean) {
    super(`${target} harness process failed`);
    this.name = "HarnessProcessError";
    this.retryable = retryable;
  }
}

const execFile = promisify(execFileCallback);

const DEFAULT_DEPENDENCIES: ProcessDependencies = {
  spawn: (file, args, options) => spawnChild(file, args, options),
  runCommand: async (file, args, options = {}) => {
    const result = await execFile(file, args, {
      encoding: "utf8",
      env: options.env,
      maxBuffer: 1_048_576,
      shell: false,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  },
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export function processDependencies(overrides: Partial<ProcessDependencies> = {}): ProcessDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

export function buildPrompt(instructions: string, stagePrompt: string): string {
  const prompt = `${instructions.trim()}\n\n${stagePrompt.trim()}\n`;
  const bytes = Buffer.byteLength(prompt);
  if (bytes > MAX_PROMPT_BYTES) throw new Error(`harness prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  return prompt;
}

export async function createHarnessHome(session: AttemptSession, target: HarnessTarget): Promise<string> {
  const harnessRoot = await assertSafeDirectory(
    session.root,
    session.harnessSessionDirectory,
    "harness session directory",
  );
  return createSafeDirectory(harnessRoot, join(harnessRoot, `${target}-${randomUUID()}`), `${target} harness home`);
}

export async function copyRegularFile(source: string, destination: string, label: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file`);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  await chmod(destination, 0o600);
}

export async function copyRegularTree(source: string, destination: string, label: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a regular directory`);
  await mkdir(destination, { mode: 0o700 });
  const directory = await opendir(source);
  for await (const entry of directory) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const entryInfo = await lstat(sourcePath);
    if (entryInfo.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links`);
    if (entryInfo.isDirectory()) {
      await copyRegularTree(sourcePath, destinationPath, label);
    } else if (entryInfo.isFile()) {
      await copyFile(sourcePath, destinationPath);
      await chmod(destinationPath, 0o600);
    } else {
      throw new Error(`${label} must contain only regular files and directories`);
    }
  }
}

export async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function pathIsFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function preflightHarness(
  target: HarnessTarget,
  authFiles: Array<string | undefined>,
  authEnvironment: NodeJS.ProcessEnv,
  dependencies: ProcessDependencies,
): Promise<void> {
  try {
    for (const source of authFiles) {
      if (source && !(await pathIsFile(source))) throw new Error("missing harness authentication file");
    }
    const file = target;
    await dependencies.runCommand(file, ["--version"], { env: authEnvironment });
    await dependencies.runCommand(
      file,
      target === "codex" ? ["login", "status"] : ["auth", "status"],
      { env: authEnvironment },
    );
  } catch {
    throw new HarnessPreflightError(target);
  }
}

export async function runHarnessProcess(
  target: HarnessTarget,
  spec: ProcessSpec,
  dependencies: ProcessDependencies,
): Promise<HarnessResult> {
  if (!Number.isInteger(spec.timeoutSeconds) || spec.timeoutSeconds < 1 || spec.timeoutSeconds > 86_400) {
    throw new Error("harness timeout must be an integer from 1 to 86400 seconds");
  }
  if (spec.signal.aborted) return { exitCode: null, signal: "SIGTERM", timedOut: false };
  await assertSafeFile(dirname(spec.logPath), spec.logPath, "harness log");
  const log = createWriteStream(spec.logPath, { flags: "a", mode: 0o600 });
  let logFailed = false;
  const logFinished = finished(log).catch(() => { logFailed = true; });
  let child: SpawnedProcess;
  try {
    child = dependencies.spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    log.end();
    await logFinished;
    throw new HarnessProcessError(target, !isMissingBinary(error));
  }

  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.stdin.on("error", () => undefined);
  child.stdin.end(spec.prompt);

  return new Promise<HarnessResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let terminating = false;
    let graceTimer: TimerHandle | undefined;
    const timeoutTimer = dependencies.setTimeout(() => terminate(true), spec.timeoutSeconds * 1_000);

    const cleanup = (): void => {
      dependencies.clearTimeout(timeoutTimer);
      if (graceTimer) dependencies.clearTimeout(graceTimer);
      spec.signal.removeEventListener("abort", abort);
      child.removeListener("close", close);
      child.removeListener("error", processError);
      log.removeListener("error", logError);
      child.stdout.unpipe(log);
      child.stderr.unpipe(log);
    };

    const complete = async (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      error?: HarnessProcessError,
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      cleanup();
      log.end();
      await logFinished;
      if (logFailed) {
        reject(new HarnessProcessError(target, false));
        return;
      }
      if (error) reject(error);
      else resolve({ exitCode, signal, timedOut });
    };

    function terminate(forTimeout: boolean): void {
      if (settled || terminating) return;
      terminating = true;
      timedOut = forTimeout;
      dependencies.clearTimeout(timeoutTimer);
      child.kill("SIGTERM");
      graceTimer = dependencies.setTimeout(() => {
        if (!settled && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, TERMINATION_GRACE_MS);
    }

    function abort(): void {
      terminate(false);
    }

    function close(exitCode: number | null, signal: NodeJS.Signals | null): void {
      void complete(exitCode, signal);
    }

    function processError(error: Error): void {
      void complete(null, null, new HarnessProcessError(target, !isMissingBinary(error)));
    }

    function logError(): void {
      terminate(false);
    }

    child.once("close", close);
    child.once("error", processError);
    log.once("error", logError);
    spec.signal.addEventListener("abort", abort, { once: true });
    if (spec.signal.aborted) abort();
  });
}

function isMissingBinary(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
