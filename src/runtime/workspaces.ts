import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { gitAuthentication } from "../config/repository.ts";
import type { ProviderCredential } from "../harness/types.ts";
import type { ProviderRepository, TicketRef } from "../provider/types.js";
import {
  assertCanonicalUuid,
  assertSafeDirectory,
  assertSafeFile,
  assertSafeWritableFile,
  ensureSafeDirectory,
  prepareDataRoot,
  removeSafeFile,
} from "./filesystem.ts";

export interface Workspace {
  baseClone: string;
  worktree: string;
  repository: string;
  ticketNumber: number;
  flowInstanceId: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  file: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

interface RepositoryIdentity {
  provider: ProviderRepository["provider"];
  host: string;
  name: string;
  cloneRoot: string;
  cloneUrl: string;
}

interface WorkspaceBinding extends RepositoryIdentity {
  ticketNumber: number;
  flowInstanceId: string;
  baseClone: string;
  worktree: string;
}

const execFile = promisify(execFileCallback);

const runCommand: CommandRunner = async (file, args, options = {}) => {
  const result = await execFile(file, args, {
    cwd: options.cwd,
    encoding: "utf8",
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export class WorkspaceManager {
  readonly #configuredDataDirectory: string;
  readonly #run: CommandRunner;
  readonly #baseClonePreparations = new Map<string, Promise<void>>();
  readonly #flowPreparations = new Map<string, Promise<void>>();

  constructor(dataDirectory: string, run: CommandRunner = runCommand) {
    this.#configuredDataDirectory = resolve(dataDirectory);
    this.#run = run;
  }

  async prepareWorkspace(
    repository: ProviderRepository,
    ticket: TicketRef,
    flowInstanceId: string,
    credential?: ProviderCredential,
  ): Promise<Workspace> {
    assertCanonicalUuid(flowInstanceId, "flow instance ID");
    const identity = repositoryIdentity(repository);
    assertTicket(identity, ticket);
    return this.#withFlowLock(
      flowInstanceId,
      () => this.#prepareWorkspace(repository, ticket, flowInstanceId, identity, credential),
    );
  }

  async #prepareWorkspace(
    repository: ProviderRepository,
    ticket: TicketRef,
    flowInstanceId: string,
    identity: RepositoryIdentity,
    credential?: ProviderCredential,
  ): Promise<Workspace> {
    const dataRoot = await prepareDataRoot(this.#configuredDataDirectory);
    const repositoriesRoot = await ensureSafeDirectory(
      dataRoot,
      join(dataRoot, "repositories"),
      "repositories directory",
    );
    const worktreesRoot = await ensureSafeDirectory(
      dataRoot,
      join(dataRoot, "worktrees"),
      "worktrees directory",
    );

    const baseClone = join(repositoriesRoot, repositoryKey(identity));
    const worktree = join(worktreesRoot, flowInstanceId);
    const bindingPath = `${worktree}.json`;
    const workspace: Workspace = {
      baseClone,
      worktree,
      repository: identity.name,
      ticketNumber: ticket.number,
      flowInstanceId,
    };
    const expectedBinding: WorkspaceBinding = {
      ...identity,
      ticketNumber: ticket.number,
      flowInstanceId,
      baseClone,
      worktree,
    };

    const worktreeExists = await pathExists(worktree);
    const bindingExists = await pathExists(bindingPath);
    if (worktreeExists) {
      await assertSafeDirectory(dataRoot, worktree, "worktree");
      if (!bindingExists) throw new Error(`workspace binding mismatch for flow ${flowInstanceId}`);
      assertBinding(await readBinding(dataRoot, bindingPath), expectedBinding);
      await this.#assertOrigin(worktree, identity);
      return workspace;
    }

    await this.#prepareBaseClone(dataRoot, baseClone, repository, identity, credential);
    let bindingCreated = false;
    if (bindingExists) {
      assertBinding(await readBinding(dataRoot, bindingPath), expectedBinding);
    }
    let worktreeCreated = false;
    try {
      if (!bindingExists) {
        await writeBinding(dataRoot, bindingPath, expectedBinding);
        bindingCreated = true;
      }
      await this.#run("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: baseClone });
      worktreeCreated = true;
      await assertSafeDirectory(dataRoot, worktree, "worktree");
      await this.#assertOrigin(worktree, identity);
      await this.#assertWorktreeBase(dataRoot, worktree, baseClone);
      return workspace;
    } catch (error) {
      let worktreeRemoved = !worktreeCreated;
      if (worktreeCreated) {
        worktreeRemoved = await this.#removeCreatedWorktree(dataRoot, worktree, baseClone)
          .then(() => true, () => false);
      }
      if (bindingCreated && worktreeRemoved) {
        await removeSafeFile(dataRoot, bindingPath, "workspace binding").catch(() => undefined);
      }
      throw error;
    }
  }

  async #withFlowLock<T>(flowInstanceId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#flowPreparations.get(flowInstanceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#flowPreparations.set(flowInstanceId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#flowPreparations.get(flowInstanceId) === current) {
        this.#flowPreparations.delete(flowInstanceId);
      }
    }
  }

  async removeWorkspace(workspace: Workspace, terminal: boolean, processRunning: boolean): Promise<void> {
    if (!terminal || processRunning) return;
    assertCanonicalUuid(workspace.flowInstanceId, "flow instance ID");
    const dataRoot = await prepareDataRoot(this.#configuredDataDirectory);
    const worktreesRoot = await assertSafeDirectory(
      dataRoot,
      join(dataRoot, "worktrees"),
      "worktrees directory",
    );
    const repositoriesRoot = await assertSafeDirectory(
      dataRoot,
      join(dataRoot, "repositories"),
      "repositories directory",
    );
    const expectedWorktree = join(worktreesRoot, workspace.flowInstanceId);
    if (resolve(workspace.worktree) !== expectedWorktree) {
      throw new Error(`workspace path mismatch for flow ${workspace.flowInstanceId}`);
    }
    await assertSafeDirectory(dataRoot, expectedWorktree, "worktree");
    await assertSafeDirectory(dataRoot, workspace.baseClone, "base clone");
    const bindingPath = `${expectedWorktree}.json`;
    const binding = await readBinding(dataRoot, bindingPath);
    const expectedBaseClone = join(repositoriesRoot, repositoryKey(binding));
    if (
      binding.flowInstanceId !== workspace.flowInstanceId ||
      binding.name !== workspace.repository ||
      binding.ticketNumber !== workspace.ticketNumber ||
      resolve(binding.baseClone) !== expectedBaseClone ||
      resolve(workspace.baseClone) !== expectedBaseClone ||
      resolve(binding.worktree) !== expectedWorktree
    ) {
      throw new Error(`workspace binding mismatch for flow ${workspace.flowInstanceId}`);
    }
    await this.#assertOrigin(expectedWorktree, binding);
    await this.#assertWorktreeBase(dataRoot, expectedWorktree, workspace.baseClone);
    await this.#run("git", ["worktree", "remove", "--force", expectedWorktree], { cwd: workspace.baseClone });
    await removeSafeFile(dataRoot, bindingPath, "workspace binding");
  }

  async #prepareBaseClone(
    dataRoot: string,
    baseClone: string,
    repository: ProviderRepository,
    identity: RepositoryIdentity,
    credential?: ProviderCredential,
  ): Promise<void> {
    let preparation = this.#baseClonePreparations.get(baseClone);
    if (!preparation) {
      preparation = (async () => {
        if (!(await pathExists(baseClone))) {
          await assertSafeWritableFile(dataRoot, baseClone, "base clone path");
          const executable = identity.provider === "github" ? "gh" : "glab";
          const authentication = gitAuthentication(new URL(identity.cloneUrl), credential);
          await this.#run(executable, [
            "repo",
            "clone",
            repository.cloneUrl,
            baseClone,
            ...(authentication.arguments.length > 0 ? ["--", ...authentication.arguments] : []),
          ], { env: authentication.environment });
        }
      })();
      this.#baseClonePreparations.set(baseClone, preparation);
      try {
        await preparation;
      } finally {
        this.#baseClonePreparations.delete(baseClone);
      }
    } else {
      await preparation;
    }
    await assertSafeDirectory(dataRoot, baseClone, "base clone");
    await this.#assertOrigin(baseClone, identity);
  }

  async #removeCreatedWorktree(dataRoot: string, worktree: string, baseClone: string): Promise<void> {
    await assertSafeDirectory(dataRoot, worktree, "worktree");
    await this.#assertWorktreeBase(dataRoot, worktree, baseClone);
    await this.#run("git", ["worktree", "remove", "--force", worktree], { cwd: baseClone });
  }

  async #assertWorktreeBase(dataRoot: string, worktree: string, baseClone: string): Promise<void> {
    await assertSafeDirectory(dataRoot, worktree, "worktree");
    const result = await this.#run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: worktree,
    });
    const actual = await realpath(result.stdout.trim());
    const expected = await assertSafeDirectory(dataRoot, join(baseClone, ".git"), "base clone Git directory");
    if (actual !== expected) throw new Error(`worktree is not registered to base clone: ${worktree}`);
  }

  async #assertOrigin(directory: string, expected: RepositoryIdentity): Promise<void> {
    const result = await this.#run("git", ["remote", "get-url", "origin"], { cwd: directory });
    const actual = normalizeRepositoryUrl(result.stdout, "repository remote");
    if (actual !== expected.cloneUrl) {
      throw new Error(
        `repository identity mismatch: expected ${expected.cloneUrl}, received ${actual}`,
      );
    }
  }
}

function repositoryIdentity(repository: ProviderRepository): RepositoryIdentity {
  const host = normalizeHost(repository.host);
  const name = normalizePath(repository.name);
  const cloneRoot = normalizeRepositoryUrl(repository.cloneRoot, "repository clone root");
  const root = new URL(cloneRoot);
  if (!root.pathname.endsWith("/") || root.host !== host) {
    throw new Error(
      `repository identity mismatch: clone root ${cloneRoot} does not match host ${host}`,
    );
  }
  const expected = new URL(root);
  expected.pathname += `${name}.git`;
  const cloneUrl = normalizeRepositoryUrl(repository.cloneUrl, "repository clone URL");
  if (cloneUrl !== expected.href) {
    throw new Error(
      `repository identity mismatch: expected ${expected.href}, received ${cloneUrl}`,
    );
  }
  return { provider: repository.provider, host, name, cloneRoot, cloneUrl };
}

function assertTicket(repository: RepositoryIdentity, ticket: TicketRef): void {
  if (
    ticket.provider !== repository.provider ||
    !samePath(ticket.repository, repository.name, repository.provider) ||
    !Number.isSafeInteger(ticket.number) ||
    ticket.number < 1
  ) {
    throw new Error(`ticket does not belong to ${repository.provider}:${repository.name}`);
  }
}

function normalizeRepositoryUrl(value: string, label: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new Error(`invalid ${label}: ${trimmed}`, { cause: error });
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.host ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`invalid ${label}: ${trimmed}`);
  }
  return url.href;
}

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!normalized || normalized !== host.toLowerCase() || /[/\\@]/.test(normalized)) {
    throw new Error(`invalid repository host: ${host}`);
  }
  return normalized;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const segments = normalized.split("/");
  if (
    segments.length < 2 ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))
  ) {
    throw new Error(`invalid repository path: ${path}`);
  }
  return normalized;
}

function repositoryKey(identity: RepositoryIdentity): string {
  return createHash("sha256")
    .update(`${identity.provider}\0${identity.cloneUrl}`)
    .digest("hex");
}

function samePath(left: string, right: string, provider: ProviderRepository["provider"]): boolean {
  return provider === "github" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readBinding(dataRoot: string, path: string): Promise<WorkspaceBinding> {
  await assertSafeFile(dataRoot, path, "workspace binding");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid workspace binding: ${path}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid workspace binding: ${path}`);
  }
  return value as WorkspaceBinding;
}

async function writeBinding(dataRoot: string, path: string, binding: WorkspaceBinding): Promise<void> {
  await assertSafeWritableFile(dataRoot, path, "workspace binding path");
  let written = false;
  try {
    await writeFile(path, `${JSON.stringify(binding)}\n`, { flag: "wx", mode: 0o600 });
    written = true;
    await assertSafeFile(dataRoot, path, "workspace binding");
  } catch (error) {
    if (written) await removeSafeFile(dataRoot, path, "workspace binding").catch(() => undefined);
    throw error;
  }
}

function assertBinding(actual: WorkspaceBinding, expected: WorkspaceBinding): void {
  for (const key of Object.keys(expected) as Array<keyof WorkspaceBinding>) {
    if (actual[key] !== expected[key]) {
      throw new Error(`workspace binding mismatch for flow ${expected.flowInstanceId}`);
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
