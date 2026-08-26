import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { ProviderRepository, TicketRef } from "../provider/types.js";

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
}

interface WorkspaceBinding extends RepositoryIdentity {
  ticketNumber: number;
  flowInstanceId: string;
  baseClone: string;
  worktree: string;
}

const execFile = promisify(execFileCallback);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const runCommand: CommandRunner = async (file, args, options = {}) => {
  const result = await execFile(file, args, { cwd: options.cwd, encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr };
};

export class WorkspaceManager {
  readonly #dataDirectory: string;
  readonly #run: CommandRunner;
  readonly #baseClonePreparations = new Map<string, Promise<void>>();

  constructor(dataDirectory: string, run: CommandRunner = runCommand) {
    this.#dataDirectory = resolve(dataDirectory);
    this.#run = run;
  }

  async prepareWorkspace(
    repository: ProviderRepository,
    ticket: TicketRef,
    flowInstanceId: string,
  ): Promise<Workspace> {
    assertUuid(flowInstanceId, "flow instance ID");
    const identity = repositoryIdentity(repository);
    assertTicket(identity, ticket);

    const repositoryKey = createHash("sha256")
      .update(`${identity.provider}\0${identity.host}\0${identity.name}`)
      .digest("hex");
    const baseClone = join(this.#dataDirectory, "repositories", repositoryKey);
    const worktree = join(this.#dataDirectory, "worktrees", flowInstanceId);
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

    await mkdir(join(this.#dataDirectory, "repositories"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.#dataDirectory, "worktrees"), { recursive: true, mode: 0o700 });

    const worktreeExists = await pathExists(worktree);
    const bindingExists = await pathExists(bindingPath);
    if (worktreeExists !== bindingExists) {
      throw new Error(`workspace binding mismatch for flow ${flowInstanceId}`);
    }
    if (worktreeExists) {
      await assertDirectory(worktree, "worktree");
      assertBinding(await readBinding(bindingPath), expectedBinding);
      await this.#assertOrigin(worktree, identity);
      return workspace;
    }

    await this.#prepareBaseClone(baseClone, repository, identity);
    await this.#run("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: baseClone });
    await this.#assertOrigin(worktree, identity);
    await writeFile(bindingPath, `${JSON.stringify(expectedBinding)}\n`, { flag: "wx", mode: 0o600 });
    return workspace;
  }

  async removeWorkspace(workspace: Workspace, terminal: boolean, processRunning: boolean): Promise<void> {
    if (!terminal || processRunning) return;
    assertUuid(workspace.flowInstanceId, "flow instance ID");
    const expectedWorktree = join(this.#dataDirectory, "worktrees", workspace.flowInstanceId);
    if (resolve(workspace.worktree) !== expectedWorktree) {
      throw new Error(`workspace path mismatch for flow ${workspace.flowInstanceId}`);
    }
    const bindingPath = `${expectedWorktree}.json`;
    const binding = await readBinding(bindingPath);
    if (
      binding.flowInstanceId !== workspace.flowInstanceId ||
      binding.name !== workspace.repository ||
      binding.ticketNumber !== workspace.ticketNumber ||
      resolve(binding.baseClone) !== resolve(workspace.baseClone) ||
      resolve(binding.worktree) !== expectedWorktree
    ) {
      throw new Error(`workspace binding mismatch for flow ${workspace.flowInstanceId}`);
    }
    await this.#run("git", ["worktree", "remove", expectedWorktree], { cwd: workspace.baseClone });
    await rm(bindingPath);
  }

  async #prepareBaseClone(
    baseClone: string,
    repository: ProviderRepository,
    identity: RepositoryIdentity,
  ): Promise<void> {
    let preparation = this.#baseClonePreparations.get(baseClone);
    if (!preparation) {
      preparation = (async () => {
        if (!(await pathExists(baseClone))) {
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
    await assertDirectory(baseClone, "base clone");
    await this.#assertOrigin(baseClone, identity);
  }

  async #assertOrigin(directory: string, expected: RepositoryIdentity): Promise<void> {
    const result = await this.#run("git", ["remote", "get-url", "origin"], { cwd: directory });
    const actual = parseRemoteIdentity(result.stdout);
    if (actual.host !== expected.host || !sameRepository(actual.name, expected.name, expected.provider)) {
      throw new Error(
        `repository identity mismatch: expected ${expected.host}/${expected.name}, received ${actual.host}/${actual.name}`,
      );
    }
  }
}

function repositoryIdentity(repository: ProviderRepository): RepositoryIdentity {
  const host = normalizeHost(repository.host);
  const name = normalizeName(repository.name);
  const clone = parseRemoteIdentity(repository.cloneUrl);
  if (clone.host !== host || !sameRepository(clone.name, name, repository.provider)) {
    throw new Error(
      `repository identity mismatch: expected ${host}/${name}, received ${clone.host}/${clone.name}`,
    );
  }
  return { provider: repository.provider, host, name };
}

function assertTicket(repository: RepositoryIdentity, ticket: TicketRef): void {
  if (
    ticket.provider !== repository.provider ||
    !sameRepository(ticket.repository, repository.name, repository.provider) ||
    !Number.isSafeInteger(ticket.number) ||
    ticket.number < 1
  ) {
    throw new Error(`ticket does not belong to ${repository.provider}:${repository.name}`);
  }
}

function parseRemoteIdentity(remote: string): { host: string; name: string } {
  const value = remote.trim();
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
  if (scp && !value.includes("://")) {
    return { host: normalizeHost(scp[1]!), name: normalizeName(scp[2]!) };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`invalid repository remote: ${value}`, { cause: error });
  }
  return { host: normalizeHost(url.host), name: normalizeName(decodeURIComponent(url.pathname)) };
}

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!normalized || normalized !== host.toLowerCase() || /[/\\@]/.test(normalized)) {
    throw new Error(`invalid repository host: ${host}`);
  }
  return normalized;
}

function normalizeName(name: string): string {
  const normalized = name.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const segments = normalized.split("/");
  if (
    normalized !== name.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "") ||
    segments.length < 2 ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))
  ) {
    throw new Error(`invalid repository name: ${name}`);
  }
  return normalized;
}

function sameRepository(left: string, right: string, provider: ProviderRepository["provider"]): boolean {
  return provider === "github" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new Error(`${label} must be a UUID`);
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

async function assertDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a directory: ${path}`);
}

async function readBinding(path: string): Promise<WorkspaceBinding> {
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
