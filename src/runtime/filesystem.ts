import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function assertCanonicalUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new Error(`${label} must be a canonical UUID`);
}

export async function prepareDataRoot(dataDirectory: string): Promise<string> {
  const root = resolve(dataDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error(`data directory must not be a symbolic link: ${root}`);
  if (!info.isDirectory()) throw new Error(`data directory is not a directory: ${root}`);
  return realpath(root);
}

export async function ensureSafeDirectory(
  root: string,
  path: string,
  label: string,
  mode = 0o700,
): Promise<string> {
  await assertSafeDirectory(root, dirname(path), `${label} parent`);
  try {
    await mkdir(path, { mode });
  } catch (error) {
    if (!(isNodeError(error) && error.code === "EEXIST")) throw error;
  }
  return assertSafeDirectory(root, path, label);
}

export async function createSafeDirectory(
  root: string,
  path: string,
  label: string,
  mode = 0o700,
): Promise<string> {
  await assertSafeDirectory(root, dirname(path), `${label} parent`);
  try {
    await mkdir(path, { mode });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") await assertSafeDirectory(root, path, label);
    throw error;
  }
  return assertSafeDirectory(root, path, label);
}

export async function assertSafeDirectory(root: string, path: string, label: string): Promise<string> {
  const canonical = await assertSafePath(root, path, label, "directory");
  return realpath(canonical);
}

export async function assertSafeFile(root: string, path: string, label: string): Promise<string> {
  return assertSafePath(root, path, label, "file");
}

export async function assertSafeWritableFile(root: string, path: string, label: string): Promise<string> {
  const target = resolve(path);
  assertContained(root, target, label);
  await assertSafeDirectory(root, dirname(target), `${label} parent`);
  try {
    await lstat(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return target;
    throw error;
  }
  return assertSafeFile(root, target, label);
}

export async function removeSafeFile(root: string, path: string, label: string): Promise<void> {
  try {
    await assertSafeFile(root, path, label);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  await rm(path);
}

async function assertSafePath(
  root: string,
  path: string,
  label: string,
  expected: "directory" | "file",
): Promise<string> {
  const target = resolve(path);
  assertContained(root, target, label);
  let current = root;
  const parts = relative(root, target).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`${label} must not contain a symbolic link: ${current}`);
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(`${label} parent is not a directory: ${current}`);
    }
    if (index === parts.length - 1) {
      if (expected === "directory" && !info.isDirectory()) {
        throw new Error(`${label} is not a directory: ${current}`);
      }
      if (expected === "file" && !info.isFile()) {
        throw new Error(`${label} is not a regular file: ${current}`);
      }
    }
  }
  const canonical = await realpath(target);
  assertContained(root, canonical, label);
  return canonical;
}

function assertContained(root: string, path: string, label: string): void {
  const remainder = relative(root, path);
  if (remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))) {
    return;
  }
  throw new Error(`${label} escapes data directory: ${path}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
