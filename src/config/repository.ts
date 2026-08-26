import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { loadConfigBundle } from "./load.ts";
import type { ConfigBundle } from "./load.ts";
import { assertSafeDirectory, ensureSafeDirectory, prepareDataRoot } from "../runtime/filesystem.ts";

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
  const { stdout } = await exec("git", ["--no-replace-objects", "-C", repository, ...arguments_], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout as Buffer;
}

export interface GitAuthentication {
  arguments: string[];
  environment: NodeJS.ProcessEnv;
}

export function configurationGitAuthentication(source: string): GitAuthentication {
  const normalized = normalizeConfigurationSource(source);
  const url = isAbsolute(normalized) ? undefined : new URL(normalized);
  const helper = url?.hostname === "github.com" && !url.port
    ? "gh auth git-credential"
    : url?.hostname === "gitlab.com" && !url.port
      ? "glab auth git-credential"
      : undefined;
  const key = url && helper ? `credential.https://${url.hostname}.helper` : undefined;
  return {
    arguments: key ? ["-c", `${key}=`, "-c", `${key}=!${helper}`] : [],
    environment: { GIT_TERMINAL_PROMPT: "0" },
  };
}

interface ConfigurationSource {
  kind: "local" | "remote";
  normalized: string;
}

function configurationSource(source: string): ConfigurationSource {
  if (isAbsolute(source)) return { kind: "local", normalized: resolve(source) };
  if (/\s|\\/.test(source)) throw new Error("configuration repository source is invalid");

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("configuration repository source is invalid");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("configuration repository source is invalid");
  }
  if (url.protocol === "https:" && url.pathname !== "/") {
    return { kind: "remote", normalized: url.href };
  }
  if (url.protocol === "file:" && !url.hostname) {
    return { kind: "remote", normalized: pathToFileURL(resolve(fileURLToPath(url))).href };
  }
  throw new Error("configuration repository source is invalid");
}

export function normalizeConfigurationSource(source: string): string {
  return configurationSource(source).normalized;
}

export interface PreparedConfigurationRepository {
  source: string;
  repository: string;
}

export async function prepareConfigurationRepository(
  source: string,
  dataDirectory: string,
): Promise<PreparedConfigurationRepository> {
  const configured = configurationSource(source);
  if (configured.kind === "local") {
    return { source: configured.normalized, repository: configured.normalized };
  }

  const dataRoot = await prepareDataRoot(dataDirectory);
  const target = resolve(dataRoot, "config-repository");
  const authentication = configurationGitAuthentication(configured.normalized);
  try {
    const entry = await lstat(target);
    if (entry.isSymbolicLink()) throw new Error("configuration repository must not be a symbolic link");
    if (!entry.isDirectory()) throw new Error("configuration repository is incomplete");
    let origin: string;
    try {
      origin = (await git(target, ["remote", "get-url", "origin"])).toString("utf8").trim();
      const bare = (await git(target, ["rev-parse", "--is-bare-repository"])).toString("utf8").trim();
      const mirror = (await git(target, ["config", "--bool", "remote.origin.mirror"])).toString("utf8").trim();
      if (bare !== "true" || mirror !== "true") throw new Error("not a mirror");
    } catch {
      throw new Error("configuration repository is incomplete");
    }
    if (normalizeConfigurationSource(origin) !== configured.normalized) {
      throw new Error("configuration repository origin does not match the configured source");
    }
    try {
      await exec("git", [...authentication.arguments, "--no-replace-objects", "-C", target, "fetch", "--prune", "origin"], {
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...authentication.environment },
      });
    } catch {
      throw new Error("configuration repository fetch failed");
    }
    return { source: configured.normalized, repository: target };
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }

  const temporaryRoot = await mkdtemp(resolve(dataRoot, ".config-repository."));
  const temporary = resolve(temporaryRoot, "mirror");
  try {
    try {
      await exec("git", [...authentication.arguments, "--no-replace-objects", "clone", "--mirror", configured.normalized, temporary], {
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...authentication.environment },
      });
    } catch {
      throw new Error("configuration repository clone failed");
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  await rm(temporaryRoot, { recursive: true, force: true });
  return { source: configured.normalized, repository: target };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
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
    if (!marker.isFile() || marker.isSymbolicLink() || (await readFile(resolve(path, ".complete"), "utf8")) !== `${sha}\n`) {
      return false;
    }
    const repository = resolve(path, ".source.git");
    const repositoryEntry = await lstat(repository);
    if (!repositoryEntry.isDirectory() || repositoryEntry.isSymbolicLink()) return false;
    if (await resolveRevision(repository, sha) !== sha) return false;
    const entries = treeEntries(await git(repository, ["ls-tree", "-r", "-z", "--full-tree", sha, "--", ...ROOTS]));
    const expectedPaths = entries.map((entry) => entry.path).sort();
    const actualPaths = (await Promise.all(ROOTS.map((root) => listMaterializedFiles(path, root.slice(0, -1)))))
      .flat()
      .sort();
    if (expectedPaths.length !== actualPaths.length || expectedPaths.some((entry, index) => entry !== actualPaths[index])) {
      return false;
    }
    for (const entry of entries) {
      const materialized = await readFile(resolve(path, entry.path));
      const pinned = await git(repository, ["show", `${sha}:${entry.path}`]);
      if (!materialized.equals(pinned)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function listMaterializedFiles(root: string, path: string): Promise<string[]> {
  const directory = resolve(root, path);
  const names = await readdir(directory);
  const files: string[] = [];
  for (const name of names) {
    const child = `${path}/${name}`;
    const entry = await lstat(resolve(root, child));
    if (entry.isSymbolicLink()) throw new Error("materialized configuration must not contain symbolic links");
    if (entry.isDirectory()) files.push(...await listMaterializedFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error("materialized configuration contains an unsupported entry");
  }
  return files;
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
  const dataRoot = await prepareDataRoot(dataDirectory);
  const configRoot = await ensureSafeDirectory(dataRoot, resolve(dataRoot, "config"), "configuration directory");
  const target = resolve(configRoot, sha);
  if (await completeDirectory(target, sha)) return target;

  try {
    await lstat(target);
    throw new Error(`materialization directory ${target} is incomplete`);
  } catch (error) {
    if (!(error instanceof Error) || !/ENOENT/.test(String((error as NodeJS.ErrnoException).code))) throw error;
  }

  const entries = treeEntries(await git(repository, ["ls-tree", "-r", "-z", "--full-tree", sha, "--", "config", "schemas/v1", "agent-packages"]));
  const temporary = await mkdtemp(resolve(configRoot, `.${sha}.`));

  try {
    for (const entry of entries) {
      const destination = resolve(temporary, entry.path);
      if (!isInside(temporary, destination)) throw new Error(`unsafe Git tree entry ${entry.path}`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await git(repository, ["show", `${sha}:${entry.path}`]));
    }
    const pinnedRepository = resolve(temporary, ".source.git");
    await exec("git", ["init", "--bare", pinnedRepository], { encoding: "buffer" });
    await git(pinnedRepository, ["fetch", "--depth=1", repository, sha]);
    await git(pinnedRepository, ["update-ref", "refs/heads/pinned", sha]);
    await writeFile(resolve(temporary, ".complete"), `${sha}\n`);
    if (!await completeDirectory(temporary, sha)) throw new Error("materialized configuration verification failed");
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
  controllerPath = "config/controller.example.yaml",
): Promise<ConfigBundle> {
  if (requested !== undefined) {
    if (!SHA.test(requested)) throw new Error("requested revision must be a 40-character SHA");
    const dataRoot = await prepareDataRoot(dataDirectory);
    let configRoot: string | undefined;
    try {
      configRoot = await assertSafeDirectory(dataRoot, resolve(dataRoot, "config"), "configuration directory");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    if (configRoot) {
      const normalized = requested.toLowerCase();
      const materialized = resolve(configRoot, normalized);
      if (await completeDirectory(materialized, normalized)) {
        return loadConfigBundle(materialized, controllerPath, normalized);
      }
    }
  }
  const revision = await resolveRevision(repository, requested);
  const root = await materializeRevision(repository, revision, dataDirectory);
  return loadConfigBundle(root, controllerPath, revision);
}
