import {
  execFile as execFileCallback,
  spawn as spawnChild,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { HarnessTarget } from "../config/types.ts";
import { isProviderTokenEnvironment } from "../config/provider-credentials.ts";
import { assertSafeFile, createSafeDirectory } from "../runtime/filesystem.ts";
import type { AttemptSession } from "../runtime/sessions.ts";
import type { HarnessResult, ProviderCredential } from "./types.ts";

const MAX_PROMPT_BYTES = 1_048_576;
const MAX_ENVIRONMENT_VALUE_BYTES = 4_096;
const MAX_CREDENTIAL_BYTES = 65_536;
const SAFE_ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/;
const POST_EXIT_DRAIN_MS = 1_000;
const SIGNAL_FAILURE_SETTLE_MS = 1_000;
const TERMINATION_GRACE_MS = 10_000;
const INHERITED_ENVIRONMENT = [
  "PATH",
  // HOME lets agents use the operator's pre-authorized gh/glab config. Harness state has a separate target home.
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

export interface SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "exit" | "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  removeListener(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
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

export function harnessEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENVIRONMENT) {
    const value = process.env[name];
    if (value !== undefined && safeEnvironmentValue(value)) environment[name] = value;
  }
  if (!environment.PATH) throw new Error("PATH is required for harness execution");
  for (const [name, value] of Object.entries(overrides)) {
    if (!SAFE_ENVIRONMENT_NAME.test(name)) throw new Error(`invalid harness environment name: ${name}`);
    if (!safeEnvironmentValue(value)) throw new Error(`invalid harness environment value: ${name}`);
    environment[name] = value;
  }
  return environment;
}

export async function providerCredentialEnvironment(
  credential: ProviderCredential,
  _glabConfigDirectory: string,
  _dependencies: ProcessDependencies,
): Promise<Record<string, string>> {
  if (!isProviderTokenEnvironment(credential.provider, credential.name)) {
    throw new Error("unsupported provider credential environment");
  }
  return { [credential.name]: credential.value };
}

export async function createHarnessHome(_session: AttemptSession, target: HarnessTarget): Promise<string> {
  const harnessRoot = join(tmpdir(), "agent-flow");
  await mkdir(harnessRoot, { recursive: true, mode: 0o700 });
  return realpath(await mkdtemp(join(harnessRoot, `${target}-`)));
}

export async function readRegularFile(source: string, label: string): Promise<Buffer> {
  const sourceHandle = await openRegularSource(source, label);
  try {
    const metadata = await sourceHandle.stat();
    if (metadata.size > MAX_CREDENTIAL_BYTES) throw new Error(`${label} exceeds the maximum size`);
    const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await sourceHandle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_CREDENTIAL_BYTES) throw new Error(`${label} exceeds the maximum size`);
    return buffer.subarray(0, length);
  } finally {
    await sourceHandle.close();
  }
}

export async function createCliConfigEnvironment(
  home: string,
): Promise<Record<"GH_CONFIG_DIR" | "GLAB_CONFIG_DIR", string>> {
  const root = await createSafeDirectory(home, join(home, "cli-config"), "CLI configuration directory");
  const [github, gitlab] = await Promise.all([
    createSafeDirectory(root, join(root, "gh"), "GitHub CLI configuration directory"),
    createSafeDirectory(root, join(root, "glab"), "GitLab CLI configuration directory"),
  ]);
  return { GH_CONFIG_DIR: github, GLAB_CONFIG_DIR: gitlab };
}

export async function copyRegularFile(source: string, destination: string, label: string): Promise<void> {
  // Production auth sources are read-only mounts. Component checks plus O_NOFOLLOW and inode comparison protect this
  // file boundary without introducing a separate filesystem sandbox.
  const sourceHandle = await openRegularSource(source, label);
  let destinationHandle: FileHandle | undefined;
  let destinationCreated = false;
  let copied = false;
  try {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    destinationCreated = true;
    await pipeline(
      sourceHandle.createReadStream(),
      destinationHandle.createWriteStream(),
    );
    copied = true;
  } finally {
    await sourceHandle.close().catch(() => undefined);
    if (destinationHandle) await destinationHandle.close().catch(() => undefined);
    if (destinationCreated && !copied) await unlink(destination).catch(() => undefined);
  }
}

export async function copyRegularTree(source: string, destination: string, label: string): Promise<void> {
  const sourceRoot = await assertRegularSource(source, "directory", label);
  await mkdir(destination, { mode: 0o700 });
  const directory = await opendir(sourceRoot.path);
  for await (const entry of directory) {
    const sourcePath = join(sourceRoot.path, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links`);
    if (entry.isDirectory()) {
      await copyRegularTree(sourcePath, destinationPath, label);
    } else if (entry.isFile()) {
      await copyRegularFile(sourcePath, destinationPath, label);
    } else {
      throw new Error(`${label} must contain only regular files and directories`);
    }
  }
}

export async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    await assertRegularSource(path, "directory", "source directory");
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function pathIsFile(path: string): Promise<boolean> {
  try {
    await assertRegularSource(path, "file", "source file");
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function preflightHarness(
  target: HarnessTarget,
  seedHome: (home: string) => Promise<void>,
  dependencies: ProcessDependencies,
): Promise<void> {
  let home: string | undefined;
  let failed = false;
  try {
    home = await realpath(await mkdtemp(join(tmpdir(), `agent-flow-${target}-preflight-`)));
    await chmod(home, 0o700);
    await seedHome(home);
    const environment = harnessEnvironment({
      [target === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: home,
    });
    await dependencies.runCommand(target, ["--version"], { env: environment });
    await dependencies.runCommand(
      target,
      target === "codex" ? ["login", "status"] : ["auth", "status"],
      { env: environment },
    );
  } catch {
    failed = true;
  }
  if (home) {
    try {
      await rm(home, { recursive: true, force: true });
    } catch {
      failed = true;
    }
  }
  if (failed) throw new HarnessPreflightError(target);
}

export async function runHarnessProcess(
  target: HarnessTarget,
  spec: ProcessSpec,
  dependencies: ProcessDependencies,
): Promise<HarnessResult> {
  if (!Number.isInteger(spec.timeoutSeconds) || spec.timeoutSeconds < 1 || spec.timeoutSeconds > 86_400) {
    throw new Error("harness timeout must be an integer from 1 to 86400 seconds");
  }
  if (spec.signal.aborted) return cancelledResult();
  await assertSafeFile(dirname(spec.logPath), spec.logPath, "harness log");
  const logHandle = await open(
    spec.logPath,
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
  );
  if (spec.signal.aborted) {
    await logHandle.close();
    return cancelledResult();
  }
  const log = logHandle.createWriteStream({ autoClose: true });
  let logFailed = false;
  const logFinished = finished(log).catch(() => { logFailed = true; });
  if (spec.signal.aborted) {
    log.end();
    await logFinished;
    return cancelledResult();
  }

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

  return new Promise<HarnessResult>((resolveResult, rejectResult) => {
    const processStarted = child.pid !== undefined;
    let settled = false;
    let timedOut = false;
    let terminating = false;
    let exited = false;
    let failure: HarnessProcessError | undefined;
    let graceTimer: TimerHandle | undefined;
    let drainTimer: TimerHandle | undefined;
    let terminalTimer: TimerHandle | undefined;
    const timeoutTimer = dependencies.setTimeout(() => terminate(true), spec.timeoutSeconds * 1_000);

    const stopLifecycle = (): void => {
      dependencies.clearTimeout(timeoutTimer);
      if (graceTimer) dependencies.clearTimeout(graceTimer);
      if (drainTimer) dependencies.clearTimeout(drainTimer);
      if (terminalTimer) dependencies.clearTimeout(terminalTimer);
      spec.signal.removeEventListener("abort", abort);
      child.removeListener("exit", exit);
      child.removeListener("close", close);
      child.stdout.unpipe(log);
      child.stderr.unpipe(log);
    };

    const guardLateErrors = (): void => {
      child.removeListener("error", processError);
      child.on("error", ignoreError);
      for (const stream of [child.stdin, child.stdout, child.stderr, log]) {
        stream.removeListener("error", streamError);
        stream.on("error", ignoreError);
      }
    };

    const complete = async (exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      if (settled) return;
      settled = true;
      stopLifecycle();
      log.end();
      await logFinished;
      if (logFailed) failure = new HarnessProcessError(target, false);
      guardLateErrors();
      if (failure) rejectResult(failure);
      else resolveResult({ exitCode, signal, timedOut });
    };

    function terminate(forTimeout: boolean): void {
      if (settled || terminating) return;
      if (exited || child.exitCode !== null || child.signalCode !== null) {
        exit(child.exitCode, child.signalCode);
        return;
      }
      terminating = true;
      timedOut = forTimeout;
      dependencies.clearTimeout(timeoutTimer);
      graceTimer = dependencies.setTimeout(escalate, TERMINATION_GRACE_MS);
      signalChild("SIGTERM");
    }

    function escalate(): void {
      if (settled) return;
      if (exited || child.exitCode !== null || child.signalCode !== null) {
        exit(child.exitCode, child.signalCode);
        return;
      }
      terminalTimer = dependencies.setTimeout(() => {
        failure ??= new HarnessProcessError(target, false);
        void complete(child.exitCode, child.signalCode);
      }, SIGNAL_FAILURE_SETTLE_MS);
      signalChild("SIGKILL");
    }

    function signalChild(signal: NodeJS.Signals): void {
      try {
        if (!child.kill(signal)) failure ??= new HarnessProcessError(target, false);
      } catch {
        failure ??= new HarnessProcessError(target, false);
      }
    }

    function abort(): void {
      terminate(false);
    }

    function exit(exitCode: number | null, signal: NodeJS.Signals | null): void {
      exited = true;
      dependencies.clearTimeout(timeoutTimer);
      if (graceTimer) dependencies.clearTimeout(graceTimer);
      if (terminalTimer) dependencies.clearTimeout(terminalTimer);
      if (!drainTimer) {
        drainTimer = dependencies.setTimeout(() => { void complete(exitCode, signal); }, POST_EXIT_DRAIN_MS);
      }
    }

    function close(exitCode: number | null, signal: NodeJS.Signals | null): void {
      void complete(exitCode, signal);
    }

    function processError(error: Error): void {
      failure = new HarnessProcessError(target, processStarted ? false : !isMissingBinary(error));
      if (!processStarted) {
        void complete(null, null);
      } else if (!terminating && !exited) {
        terminate(false);
      }
    }

    function streamError(): void {
      failure ??= new HarnessProcessError(target, false);
      if (!exited) terminate(false);
    }

    child.once("exit", exit);
    child.once("close", close);
    child.on("error", processError);
    child.stdin.on("error", streamError);
    child.stdout.on("error", streamError);
    child.stderr.on("error", streamError);
    log.on("error", streamError);
    spec.signal.addEventListener("abort", abort, { once: true });
    if (spec.signal.aborted) {
      abort();
      return;
    }
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    try {
      child.stdin.end(spec.prompt);
    } catch {
      streamError();
    }
  });
}

async function openRegularSource(source: string, label: string): Promise<FileHandle> {
  const sourcePath = resolve(source);
  const expected = await assertRegularSource(sourcePath, "file", label);
  const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (actual.isFile() && actual.dev === expected.info.dev && actual.ino === expected.info.ino) return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  throw new Error(`${label} changed while opening`);
}

async function assertRegularSource(
  source: string,
  expected: "file" | "directory",
  label: string,
): Promise<{ path: string; info: Awaited<ReturnType<typeof lstat>> }> {
  const sourcePath = resolve(source);
  const root = parse(sourcePath).root;
  let current = root;
  let info = await lstat(root);
  const components = relative(root, sourcePath).split(sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]!);
    info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links`);
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error(`${label} parent must be a directory`);
    }
  }
  if (expected === "file" ? !info.isFile() : !info.isDirectory()) {
    throw new Error(`${label} must be a regular ${expected}`);
  }
  return { path: sourcePath, info };
}

function safeEnvironmentValue(value: string): boolean {
  return !value.includes("\0") && Buffer.byteLength(value) <= MAX_ENVIRONMENT_VALUE_BYTES;
}

function cancelledResult(): HarnessResult {
  return { exitCode: null, signal: "SIGTERM", timedOut: false };
}

function ignoreError(): void {}

function isMissingBinary(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
