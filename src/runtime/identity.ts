import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, link, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isCanonicalUuid } from "../provider/publication.ts";
import { assertSafeWritableFile, prepareDataRoot, removeSafeFile } from "./filesystem.ts";

const MAX_IDENTITY_BYTES = 128;

export async function loadControllerId(directory: string): Promise<string> {
  const root = await prepareDataRoot(directory);
  const identityPath = join(root, "controller-id");
  const temporaryPath = join(root, `.controller-id-${randomUUID()}`);
  await assertSafeWritableFile(root, temporaryPath, "temporary controller ID path");
  try {
    await writeFile(temporaryPath, `${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
    try {
      await link(temporaryPath, identityPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
  } finally {
    await removeSafeFile(root, temporaryPath, "temporary controller ID path");
  }
  return readControllerId(identityPath);
}

async function readControllerId(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new Error("controller ID path must not be a symbolic link", { cause: error });
    }
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw new Error("controller ID path must be a regular file");
    const buffer = Buffer.alloc(MAX_IDENTITY_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) throw new Error("controller ID is too large");
    const id = buffer.subarray(0, bytesRead).toString("utf8").trim();
    if (!isCanonicalUuid(id)) throw new Error("controller ID must be a canonical UUID");
    return id;
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
