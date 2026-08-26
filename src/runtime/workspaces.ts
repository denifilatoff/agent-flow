import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

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
  options?: { cwd?: string },
) => Promise<CommandResult>;

interface RepositoryIdentity {
  provider: ProviderRepository["provider"];
  host: string;
  name: string;
  remotePath: string;
}

interface WorkspaceBinding extends RepositoryIdentity {
  ticketNumber: number;
  flowInstanceId: string;
  baseClone: string;
  worktree: string;
}

const execFile = promisify(execFileCallback);

const runCommand: CommandRunner = async (file, args, options = {}) => {
  const result = await execFile(file, args, { cwd: options.cwd, encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr };
};

export class WorkspaceManager {
  readonly #configuredDataDirectory: string;
  readonly #run: CommandRunner;
  readonly #baseClonePreparations = new Map<string, Promise<void>>();

  constructor(dataDirectory: string, run: CommandRunner = runCommand) {
    this.#configuredDataDirectory = resolve(dataDirectory);
    this.#run = run;
  }

  async prepareWorkspace(
    repository: ProviderRepository,
    ticket: TicketRef,
    flowInstanceId: string,
  ): Promise<Workspace> {
    assertCanonicalUuid(flowInstanceId, "flow instance ID");
    const identity = repositoryIdentity(repository);
    assertTicket(identity, ticket);
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
    if (!worktreeExists && bindingExists) {
      throw new Error(`workspace binding mismatch for flow ${flowInstanceId}`);
    }
    if (worktreeExists) {
      await assertSafeDirectory(dataRoot, worktree, "worktree");
      if (bindingExists) {
        assertBinding(await readBinding(dataRoot, bindingPath), expectedBinding);
      } else {
        await this.#prepareBaseClone(dataRoot, baseClone, repository, identity);
        await this.#assertOrigin(worktree, identity);
        await this.#assertWorktreeBase(dataRoot, worktree, baseClone);
        await writeBinding(dataRoot, bindingPath, expectedBinding);
      }
      await this.#assertOrigin(worktree, identity);
      return workspace;
    }

    await this.#prepareBaseClone(dataRoot, baseClone, repository, identity);
    let created = false;
    try {
      await this.#run("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: baseClone });
      created = true;
      await assertSafeDirectory(dataRoot, worktree, "worktree");
      await this.#assertOrigin(worktree, identity);
      await this.#assertWorktreeBase(dataRoot, worktree, baseClone);
      await writeBinding(dataRoot, bindingPath, expectedBinding);
      return workspace;
    } catch (error) {
      if (created) {
        await this.#removeCreatedWorktree(dataRoot, worktree, baseClone).catch(() => undefined);
      }
      await removeSafeFile(dataRoot, bindingPath, "workspace binding").catch(() => undefined);
      throw error;
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
  ): Promise<void> {
    let preparation = this.#baseClonePreparations.get(baseClone);
    if (!preparation) {
      preparation = (async () => {
        if (!(await pathExists(baseClone))) {
          await assertSafeWritableFile(dataRoot, baseClone, "base clone path");
          const executable = identity.provider === "github" ? "gh" : "glab";
          await this.#run(executable, ["repo", "clone", repository.cloneUrl, baseClone]);
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
    const actual = parseRemoteIdentity(result.stdout);
    if (
      actual.host !== expected.host ||
      !samePath(actual.path, expected.remotePath, expected.provider)
    ) {
      throw new Error(
        `repository identity mismatch: expected ${expected.host}/${expected.remotePath}, ` +
        `received ${actual.host}/${actual.path}`,
      );
    }
  }
}

function repositoryIdentity(repository: ProviderRepository): RepositoryIdentity {
  const host = normalizeHost(repository.host);
  const name = normalizePath(repository.name);
  const clone = parseRemoteIdentity(repository.cloneUrl);
  if (clone.host !== host || !pathEndsWithRepository(clone.path, name, repository.provider)) {
    throw new Error(
      `repository identity mismatch: expected ${host}/.../${name}, received ${clone.host}/${clone.path}`,
    );
  }
  return { provider: repository.provider, host, name, remotePath: clone.path };
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

function parseRemoteIdentity(remote: string): { host: string; path: string } {
  const value = remote.trim();
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
  if (scp && !value.includes("://")) {
    return { host: normalizeHost(scp[1]!), path: normalizePath(scp[2]!) };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`invalid repository remote: ${value}`, { cause: error });
  }
  return { host: normalizeHost(url.host), path: normalizePath(decodeURIComponent(url.pathname)) };
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

function pathEndsWithRepository(
  path: string,
  repository: string,
  provider: ProviderRepository["provider"],
): boolean {
  const left = provider === "github" ? path.toLowerCase() : path;
  const right = provider === "github" ? repository.toLowerCase() : repository;
  return left === right || left.endsWith(`/${right}`);
}

function repositoryKey(identity: RepositoryIdentity): string {
  return createHash("sha256")
    .update(`${identity.provider}\0${identity.host}\0${identity.remotePath}`)
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
  await writeFile(path, `${JSON.stringify(binding)}\n`, { flag: "wx", mode: 0o600 });
  await assertSafeFile(dataRoot, path, "workspace binding");
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
