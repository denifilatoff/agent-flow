import { execFile as execFileCallback } from "node:child_process";
import { cp, lstat, opendir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { parse as parseYaml } from "yaml";

import type { HarnessTarget } from "../config/types.js";

export interface CompiledAgent {
  agentId: string;
  target: HarnessTarget;
  instructions: string;
  runtimeDirectory: string;
}

export type ApmCommandRunner = (
  file: string,
  args: string[],
  options: { cwd: string },
) => Promise<void>;

export class ApmPreflightError extends Error {
  readonly code = "APM_PREFLIGHT_FAILED";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "ApmPreflightError";
  }
}

const execFile = promisify(execFileCallback);
const runCommand: ApmCommandRunner = async (file, args, options) => {
  await execFile(file, args, { cwd: options.cwd });
};

export async function compileAgentContext(
  agentId: string,
  packageDirectory: string,
  target: HarnessTarget,
  outputDirectory: string,
  run: ApmCommandRunner = runCommand,
): Promise<CompiledAgent> {
  try {
    assertAgentId(agentId);
    if (target !== "claude" && target !== "codex") {
      throw new Error(`unsupported harness target: ${String(target)}`);
    }

    const packageRoot = await requireDirectory(packageDirectory, "APM package directory");
    const outputRoot = await requireDirectory(outputDirectory, "APM output directory");
    if (pathsOverlap(packageRoot, outputRoot)) {
      throw new Error("APM package and output directories must not overlap");
    }
    await assertRegularTree(packageRoot, "APM package");
    await requireFile(join(packageRoot, "apm.lock.yaml"), "APM lockfile");

    const runtimeDirectory = join(outputRoot, "source");
    await requireMissing(runtimeDirectory, "APM runtime source directory");
    await cp(packageRoot, runtimeDirectory, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    await assertRegularTree(runtimeDirectory, "copied APM package");

    await runApm(run, runtimeDirectory, "install", ["install", "--frozen", "--target", target]);
    await runApm(run, runtimeDirectory, "compile", ["compile", "--target", target]);

    const instructions = target === "claude"
      ? await readClaudeInstructions(runtimeDirectory, agentId)
      : await readCodexInstructions(runtimeDirectory, agentId);
    return { agentId, target, instructions, runtimeDirectory };
  } catch (error) {
    if (error instanceof ApmPreflightError) throw error;
    throw new ApmPreflightError(error instanceof Error ? error.message : "APM compilation failed");
  }
}

async function runApm(
  run: ApmCommandRunner,
  cwd: string,
  phase: "install" | "compile",
  args: string[],
): Promise<void> {
  try {
    await run("apm", args, { cwd });
  } catch {
    throw new ApmPreflightError(`APM ${phase} failed`);
  }
}

async function readClaudeInstructions(runtimeDirectory: string, agentId: string): Promise<string> {
  const agentPath = await requireOnlyAgent(
    join(runtimeDirectory, ".claude/agents"),
    agentId,
    ".md",
  );
  const agent = parseMarkdownAgent(await readFile(agentPath, "utf8"), agentId);
  const claudeRoot = join(runtimeDirectory, "CLAUDE.md");
  const rulesRoot = join(runtimeDirectory, ".claude/rules");
  const hasClaudeRoot = await pathExists(claudeRoot);
  const hasRulesRoot = await pathExists(rulesRoot);
  if (hasClaudeRoot === hasRulesRoot) {
    throw new Error("Claude compilation produced missing or ambiguous root instructions");
  }

  const rootInstructions = hasClaudeRoot
    ? await readNonemptyFile(claudeRoot, "Claude root instructions")
    : await readClaudeRules(rulesRoot);
  return combineInstructions(rootInstructions, agent);
}

async function readClaudeRules(rulesRoot: string): Promise<string> {
  await requireDirectory(rulesRoot, "Claude rules directory");
  const entries = (await readdir(rulesRoot, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0 || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Claude compilation produced malformed root instructions");
  }
  const rules = await Promise.all(entries.map(async (entry) => {
    const source = await readNonemptyFile(join(rulesRoot, entry.name), "Claude rule");
    return stripMarkdownFrontmatter(source);
  }));
  if (rules.some((rule) => !rule.trim())) {
    throw new Error("Claude compilation produced empty root instructions");
  }
  return rules.join("\n\n");
}

async function readCodexInstructions(runtimeDirectory: string, agentId: string): Promise<string> {
  const rootInstructions = await readNonemptyFile(
    join(runtimeDirectory, "AGENTS.md"),
    "Codex root instructions",
  );
  const agentPath = await requireOnlyAgent(join(runtimeDirectory, ".codex/agents"), agentId, ".toml");
  const source = await readFile(agentPath, "utf8");
  const name = readTomlString(source, "name");
  const agent = readTomlString(source, "developer_instructions");
  if (name !== agentId || !agent.trim()) {
    throw new Error(`Codex compilation did not produce entry agent ${agentId}`);
  }
  return combineInstructions(rootInstructions, agent);
}

async function requireOnlyAgent(
  directory: string,
  agentId: string,
  extension: ".md" | ".toml",
): Promise<string> {
  await requireDirectory(directory, "deployed agent directory");
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => extname(entry.name) === extension);
  if (
    entries.length !== 1 ||
    entries[0]!.name !== `${agentId}${extension}` ||
    !entries[0]!.isFile() ||
    entries[0]!.isSymbolicLink()
  ) {
    throw new Error(`APM compilation did not produce exactly one entry agent named ${agentId}`);
  }
  return requireFile(join(directory, entries[0]!.name), "deployed entry agent");
}

function parseMarkdownAgent(source: string, agentId: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error("Claude entry agent has malformed frontmatter");
  let metadata: unknown;
  try {
    metadata = parseYaml(match[1]!);
  } catch (error) {
    throw new Error("Claude entry agent has malformed frontmatter", { cause: error });
  }
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    (metadata as Record<string, unknown>).name !== agentId ||
    !match[2]!.trim()
  ) {
    throw new Error(`Claude compilation did not produce entry agent ${agentId}`);
  }
  return match[2]!.trim();
}

function stripMarkdownFrontmatter(source: string): string {
  if (!source.startsWith("---")) return source.trim();
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error("Claude rule has malformed frontmatter");
  try {
    const metadata: unknown = parseYaml(match[1]!);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error("frontmatter must be a mapping");
    }
  } catch (error) {
    throw new Error("Claude rule has malformed frontmatter", { cause: error });
  }
  return match[2]!.trim();
}

function readTomlString(source: string, key: string): string {
  const matches = [...source.matchAll(new RegExp(`^${key}\\s*=\\s*(.+)$`, "gm"))];
  if (matches.length !== 1) throw new Error(`Codex entry agent has malformed ${key}`);
  try {
    const value: unknown = JSON.parse(matches[0]![1]!.trim());
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    return value;
  } catch (error) {
    throw new Error(`Codex entry agent has malformed ${key}`, { cause: error });
  }
}

function combineInstructions(root: string, agent: string): string {
  if (!root.trim() || !agent.trim()) throw new Error("APM compilation produced empty instructions");
  return `${root.trim()}\n\n${agent.trim()}\n`;
}

async function assertRegularTree(directory: string, label: string): Promise<void> {
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links: ${path}`);
    if (info.isDirectory()) {
      await assertRegularTree(path, label);
    } else if (!info.isFile()) {
      throw new Error(`${label} must contain only regular files and directories: ${path}`);
    }
  }
}

async function requireDirectory(path: string, label: string): Promise<string> {
  const resolved = resolve(path);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is not a regular directory: ${resolved}`);
  return realpath(resolved);
}

async function requireFile(path: string, label: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  return path;
}

async function readNonemptyFile(path: string, label: string): Promise<string> {
  await requireFile(path, label);
  const source = await readFile(path, "utf8");
  if (!source.trim()) throw new Error(`${label} is empty: ${path}`);
  return source;
}

async function requireMissing(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists: ${path}`);
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

function pathsOverlap(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}

function contains(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function assertAgentId(agentId: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(agentId) || basename(agentId) !== agentId) {
    throw new Error(`invalid agent ID: ${agentId}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
