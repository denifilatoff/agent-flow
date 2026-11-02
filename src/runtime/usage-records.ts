import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateDocument } from "../config/schema-validator.ts";
import type { AgentReceipt } from "../config/types.ts";
import { assertSafeFile, assertSafeWritableFile, removeSafeFile } from "./filesystem.ts";

export async function readUsageJson(root: string, name: string): Promise<unknown> {
  const path = join(root, name);
  await assertSafeFile(root, path, "usage record");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await file.stat()).size > 1_048_576) throw new Error("usage record exceeds size limit");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

export async function writeUsageJson(root: string, name: string, value: unknown): Promise<void> {
  const target = await assertSafeWritableFile(root, join(root, name), "usage record");
  const temporary = join(root, `.usage-${randomUUID()}.tmp`);
  await assertSafeWritableFile(root, temporary, "temporary usage record");
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
    await file.close();
    await assertSafeWritableFile(root, target, "usage record");
    await rename(temporary, target);
  } catch (error) {
    await file.close().catch(() => undefined);
    await removeSafeFile(root, temporary, "temporary usage record").catch(() => undefined);
    throw error;
  }
}

export async function archiveReceipt(root: string, receipt: AgentReceipt): Promise<void> {
  validateDocument("AgentReceipt", receipt);
  let existing: unknown;
  try { existing = await readUsageJson(root, "receipt.json"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing) {
    validateDocument("AgentReceipt", existing);
    if (!isDeepStrictEqual(existing, receipt)) throw new Error("archived attempt receipt is immutable");
    return;
  }
  await writeUsageJson(root, "receipt.json", receipt);
}
