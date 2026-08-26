import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { loadConfigBundle } from "./load.ts";
import type { ConfigBundle } from "./load.ts";

const exec = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/i;
const ROOTS = ["config/", "schemas/v1/", "agent-packages/"];

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function isSafePath(path: string): boolean {
  return ROOTS.some((root) => path.startsWith(root)) &&
    !isAbsolute(path) && !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

async function git(repository: string, arguments_: string[]): Promise<Buffer> {
  const { stdout } = await exec("git", ["-C", repository, ...arguments_], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  return stdout as Buffer;
}

async function completeDirectory(path: string, sha: string): Promise<boolean> {
  try {
    const directory = await lstat(path);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    for (const root of ["config", "schemas", "schemas/v1", "agent-packages"]) {
      const entry = await lstat(resolve(path, root));
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    }
    const marker = await lstat(resolve(path, ".complete"));
    return marker.isFile() && !marker.isSymbolicLink() && (await readFile(resolve(path, ".complete"), "utf8")) === `${sha}\n`;
  } catch {
    return false;
  }
}

interface TreeEntry {
  mode: string;
  type: string;
  path: string;
}

function treeEntries(output: Buffer): TreeEntry[] {
  const entries = output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+) (\w+) [0-9a-f]{40}\t(.+)$/.exec(record);
      if (!match) throw new Error("invalid Git tree entry");
      const [, mode, type, path] = match;
      if (mode === "120000" || type !== "blob" || !isSafePath(path)) {
        throw new Error(`unsafe Git tree entry ${path}`);
      }
      return { mode, type, path };
    });
  if (!ROOTS.every((root) => entries.some((entry) => entry.path.startsWith(root)))) {
    throw new Error("Git tree is missing a required configuration root");
  }
  return entries;
}

export async function resolveRevision(repository: string, requested?: string): Promise<string> {
  if (requested !== undefined && !SHA.test(requested)) {
    throw new Error("requested revision must be a 40-character SHA");
  }

  const revision = (await git(repository, ["rev-parse", "--verify", `${requested ?? "HEAD"}^{commit}`])).toString("utf8").trim();
  if (!SHA.test(revision)) throw new Error("Git did not resolve a 40-character commit SHA");
  return revision;
}

export async function materializeRevision(repository: string, revision: string, dataDirectory: string): Promise<string> {
  const sha = await resolveRevision(repository, revision);
  const target = resolve(dataDirectory, "config", sha);
  if (await completeDirectory(target, sha)) return target;

  try {
    await lstat(target);
    throw new Error(`materialization directory ${target} is incomplete`);
  } catch (error) {
    if (!(error instanceof Error) || !/ENOENT/.test(String((error as NodeJS.ErrnoException).code))) throw error;
  }

  const entries = treeEntries(await git(repository, ["ls-tree", "-r", "-z", "--full-tree", sha, "--", "config", "schemas/v1", "agent-packages"]));
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(resolve(parent, `.${sha}.`));

  try {
    for (const entry of entries) {
      const destination = resolve(temporary, entry.path);
      if (!isInside(temporary, destination)) throw new Error(`unsafe Git tree entry ${entry.path}`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await git(repository, ["show", `${sha}:${entry.path}`]));
    }
    await writeFile(resolve(temporary, ".complete"), `${sha}\n`);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (await completeDirectory(target, sha)) return target;
    throw error;
  }

  return target;
}

export async function loadPinnedConfig(
  repository: string,
  dataDirectory: string,
  requested?: string,
): Promise<ConfigBundle> {
  const revision = await resolveRevision(repository, requested);
  const root = await materializeRevision(repository, revision, dataDirectory);
  return loadConfigBundle(root, "config/controller.example.yaml", revision);
}
