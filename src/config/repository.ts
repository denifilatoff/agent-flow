import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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

interface GitProviderCredential {
  provider: "github" | "gitlab";
  name: string;
  value: string;
  apiUrl: string;
}

export function gitAuthentication(url?: URL, credential?: GitProviderCredential): GitAuthentication {
  const credentialMatches = url?.protocol === "https:" && credential
    && url.hostname.toLowerCase() === providerGitHostname(credential);
  const helper = credentialMatches
    ? credential.provider === "github" ? "gh auth git-credential" : "glab auth git-credential"
    : url?.protocol === "https:" && url.hostname === "github.com" && !url.port
      ? "gh auth git-credential"
      : url?.protocol === "https:" && url.hostname === "gitlab.com" && !url.port
        ? "glab auth git-credential"
        : undefined;
  const key = url && helper ? `credential.https://${url.hostname}.helper` : undefined;
  return {
    arguments: key ? ["-c", `${key}=`, "-c", `${key}=!${helper}`] : [],
    environment: {
      GIT_TERMINAL_PROMPT: "0",
      ...(credentialMatches ? { [credential.name]: credential.value } : {}),
    },
  };
}

export function configurationGitAuthentication(
  source: string,
  credential?: GitProviderCredential,
): GitAuthentication {
  const normalized = normalizeConfigurationSource(source);
  return gitAuthentication(isAbsolute(normalized) ? undefined : new URL(normalized), credential);
}

function providerGitHostname(credential: GitProviderCredential): string {
  const hostname = new URL(credential.apiUrl).hostname.toLowerCase();
  if (credential.provider !== "github") return hostname;
  if (hostname === "api.github.com") return "github.com";
  return hostname.startsWith("api.") && hostname.endsWith(".ghe.com") ? hostname.slice(4) : hostname;
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
  authenticationOverride?: GitAuthentication,
): Promise<PreparedConfigurationRepository> {
  const configured = configurationSource(source);
  if (configured.kind === "local") {
    return { source: configured.normalized, repository: configured.normalized };
  }

  const dataRoot = await prepareDataRoot(dataDirectory);
  const target = resolve(dataRoot, "config-repository");
  const authentication = authenticationOverride ?? configurationGitAuthentication(configured.normalized);
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
    } catch {}
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
    await git(repository, [
      "-c", "fsck.skipList=/dev/null",
      "fsck", "--strict", "--full", "--no-dangling", "--no-reflogs", sha,
    ]);
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
  objectId: string;
  type: string;
  path: string;
}

function treeEntries(output: Buffer, requiredRoots = ROOTS): TreeEntry[] {
  const entries = output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(record);
      if (!match) throw new Error("invalid Git tree entry");
      const [, mode, type, objectId, path] = match;
      if (mode === "120000" || type !== "blob" || !isSafePath(path)) {
        throw new Error(`unsafe Git tree entry ${path}`);
      }
      return { mode, objectId, type, path };
    });
  if (!requiredRoots.every((root) => entries.some((entry) => entry.path.startsWith(root)))) {
    throw new Error("Git tree is missing a required configuration root");
  }
  return entries;
}

export async function stagePinnedPackage(
  materializedRoot: string,
  revision: string,
  packagePath: string,
  destination: string,
): Promise<string> {
  if (!SHA.test(revision) || !packagePath.startsWith("agent-packages/") || !isSafePath(packagePath)) {
    throw new Error("pinned agent package identity is invalid");
  }
  const repository = resolve(materializedRoot, ".source.git");
  const normalized = revision.toLowerCase();
  if (await resolveRevision(repository, normalized) !== normalized) {
    throw new Error("pinned agent package revision does not match");
  }
  const verifyObjects = () => git(repository, [
    "-c", "fsck.skipList=/dev/null",
    "fsck", "--strict", "--full", "--no-dangling", "--no-reflogs", normalized,
  ]);
  await verifyObjects();
  const prefix = `${packagePath}/`;
  const entries = treeEntries(
    await git(repository, ["ls-tree", "-r", "-z", "--full-tree", normalized, "--", packagePath]),
    [prefix],
  );
  await verifyObjects();
  const output = resolve(destination);
  await mkdir(output);
  try {
    for (const entry of entries) {
      const target = resolve(output, entry.path.slice(prefix.length));
      if (!isInside(output, target)) throw new Error(`unsafe Git tree entry ${entry.path}`);
      await mkdir(dirname(target), { recursive: true });
      const content = await git(repository, ["show", `${normalized}:${entry.path}`]);
      const objectId = createHash("sha1")
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest("hex");
      if (objectId !== entry.objectId) throw new Error(`pinned Git blob ${entry.path} failed verification`);
      await writeFile(target, content, { flag: "wx" });
    }
    return output;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
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

  return createMaterialization(repository, sha, configRoot, target);
}

async function createMaterialization(
  repository: string,
  sha: string,
  configRoot: string,
  target: string,
): Promise<string> {
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

async function restoreMaterialization(target: string, sha: string, configRoot: string): Promise<string> {
  const entry = await lstat(target);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`materialization directory ${target} is incomplete`);
  }
  const retainedRepository = resolve(target, ".source.git");
  try {
    if (await resolveRevision(retainedRepository, sha) !== sha) {
      throw new Error("revision mismatch");
    }
  } catch {
    throw new Error(`materialization directory ${target} is incomplete`);
  }

  const repair = await mkdtemp(resolve(configRoot, `.${sha}.repair.`));
  const stale = resolve(repair, "stale");
  await rename(target, stale);
  try {
    const restored = await createMaterialization(resolve(stale, ".source.git"), sha, configRoot, target);
    await rm(repair, { recursive: true, force: true });
    return restored;
  } catch (error) {
    try {
      await rename(stale, target);
    } catch {}
    await rm(repair, { recursive: true, force: true });
    throw error;
  }
}

export async function loadPinnedConfig(
  repository: string,
  dataDirectory: string,
  requested?: string,
  stackPath = "config/stack.yaml",
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
        return loadConfigBundle(materialized, stackPath, normalized);
      }
      try {
        const restored = await restoreMaterialization(materialized, normalized, configRoot);
        return loadConfigBundle(restored, stackPath, normalized);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }
  const revision = await resolveRevision(repository, requested);
  const root = await materializeRevision(repository, revision, dataDirectory);
  return loadConfigBundle(root, stackPath, revision);
}
