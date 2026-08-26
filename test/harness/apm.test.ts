import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, promisify } from "node:util";
import test from "node:test";

import {
  ApmPreflightError,
  compileAgentContext,
  type ApmCommandRunner,
} from "../../src/harness/apm.ts";

const execFile = promisify(execFileCallback);

async function packageFixture(root: string): Promise<string> {
  const packageDirectory = join(root, "package");
  await mkdir(join(packageDirectory, ".apm/agents"), { recursive: true });
  await mkdir(join(packageDirectory, ".apm/instructions"), { recursive: true });
  await writeFile(join(packageDirectory, "apm.yml"), "name: architect\nversion: 1.0.0\n");
  await writeFile(join(packageDirectory, "apm.lock.yaml"), "lockfile_version: '1'\n");
  await writeFile(join(packageDirectory, ".apm/agents/architect.agent.md"), "# Architect\n");
  await writeFile(join(packageDirectory, ".apm/instructions/architect.instructions.md"), "Assess the ticket.\n");
  return packageDirectory;
}

async function writeClaudeOutput(cwd: string, agentId = "architect"): Promise<void> {
  await mkdir(join(cwd, ".claude/rules"), { recursive: true });
  await mkdir(join(cwd, ".claude/agents"), { recursive: true });
  await writeFile(join(cwd, ".claude/rules/architect.md"), "Assess the ticket.\n");
  await writeFile(
    join(cwd, ".claude/agents/architect.md"),
    `---\nname: ${agentId}\ndescription: Assessment agent.\n---\n\nPublish the assessment.\n`,
  );
}

async function writeCodexOutput(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".codex/agents"), { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), "Assess the ticket.\n");
  await writeFile(
    join(cwd, ".codex/agents/architect.toml"),
    'name = "architect"\ndescription = "Assessment agent."\ndeveloper_instructions = "Publish the assessment.\\n"\n',
  );
}

function fakeCompile(writeOutput: (cwd: string) => Promise<void>): ApmCommandRunner {
  return async (_file, args, options) => {
    if (args[0] === "compile") await writeOutput(options.cwd);
  };
}

function assertPreflight(error: unknown): boolean {
  assert.ok(error instanceof ApmPreflightError);
  assert.equal(error.code, "APM_PREFLIGHT_FAILED");
  assert.equal(error.retryable, false);
  return true;
}

test("runs frozen install and Claude compilation in the copied package", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-apm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDirectory = await packageFixture(root);
  const outputDirectory = join(root, "output");
  await mkdir(outputDirectory);
  const commands: Array<{ file: string; args: string[]; cwd: string }> = [];
  const run: ApmCommandRunner = async (file, args, options) => {
    commands.push({ file, args: [...args], cwd: options.cwd });
    if (args[0] === "compile") await writeClaudeOutput(options.cwd);
  };

  const result = await compileAgentContext("architect", packageDirectory, "claude", outputDirectory, run);

  assert.match(result.instructions, /Assess the ticket/);
  assert.match(result.instructions, /Publish the assessment/);
  assert.equal(result.runtimeDirectory, join(await realpath(outputDirectory), "source"));
  assert.deepEqual(commands, [
    { file: "apm", args: ["install", "--frozen", "--target", "claude"], cwd: result.runtimeDirectory },
    { file: "apm", args: ["compile", "--target", "claude"], cwd: result.runtimeDirectory },
  ]);
  await assert.rejects(access(join(packageDirectory, ".claude")), { code: "ENOENT" });
});

test("reads Codex root and deployed entry-agent instructions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-apm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDirectory = await packageFixture(root);
  const outputDirectory = join(root, "output");
  await mkdir(outputDirectory);

  const result = await compileAgentContext(
    "architect",
    packageDirectory,
    "codex",
    outputDirectory,
    fakeCompile(writeCodexOutput),
  );

  assert.match(result.instructions, /Assess the ticket/);
  assert.match(result.instructions, /Publish the assessment/);
  assert.equal(result.target, "codex");
});

test("rejects a package without a committed lock before running APM", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-apm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDirectory = await packageFixture(root);
  await unlink(join(packageDirectory, "apm.lock.yaml"));
  const outputDirectory = join(root, "output");
  await mkdir(outputDirectory);
  let called = false;

  await assert.rejects(
    compileAgentContext("architect", packageDirectory, "claude", outputDirectory, async () => { called = true; }),
    assertPreflight,
  );
  assert.equal(called, false);
});

test("classifies an APM command failure as non-retryable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-apm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDirectory = await packageFixture(root);
  const outputDirectory = join(root, "output");
  await mkdir(outputDirectory);

  const sentinel = "COMMAND_OUTPUT_SECRET_91b79c";
  await assert.rejects(
    compileAgentContext("architect", packageDirectory, "claude", outputDirectory, async (_file, args) => {
      if (args[0] === "compile") {
        throw Object.assign(new Error(`compile broke: ${sentinel}`), {
          cmd: `apm compile --token ${sentinel}`,
          stdout: sentinel,
          stderr: sentinel,
          code: 23,
          signal: "SIGTERM",
        });
      }
    }),
    (error: unknown) => {
      assertPreflight(error);
      assert.match((error as Error).message, /APM compile failed/);
      assert.equal("cause" in (error as object), false);
      for (const exposed of [
        (error as Error).message,
        JSON.stringify(error),
        inspect(error, { depth: null }),
        inspect(Object.getOwnPropertyDescriptors(error as object), { depth: null }),
      ]) {
        assert.doesNotMatch(exposed, /COMMAND_OUTPUT_SECRET_91b79c|--token|stdout|stderr/);
      }
      return true;
    },
  );
});

test("rejects missing, mismatched, and ambiguous entry-agent output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-apm-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [name, output] of [
    ["missing", async (cwd: string) => {
      await mkdir(join(cwd, ".claude/rules"), { recursive: true });
      await writeFile(join(cwd, ".claude/rules/architect.md"), "Assess the ticket.\n");
    }],
    ["mismatched", async (cwd: string) => writeClaudeOutput(cwd, "other")],
    ["ambiguous", async (cwd: string) => {
      await writeClaudeOutput(cwd);
      await writeFile(join(cwd, ".claude/agents/other.md"), "---\nname: other\n---\n\nOther.\n");
    }],
  ] as const) {
    const caseRoot = join(root, name);
    await mkdir(caseRoot);
    const packageDirectory = await packageFixture(caseRoot);
    const outputDirectory = join(caseRoot, "output");
    await mkdir(outputDirectory);
    await assert.rejects(
      compileAgentContext("architect", packageDirectory, "claude", outputDirectory, fakeCompile(output)),
      assertPreflight,
    );
  }
});

test("rejects malformed Codex output and missing root instructions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-apm-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [name, output] of [
    ["malformed", async (cwd: string) => {
      await mkdir(join(cwd, ".codex/agents"), { recursive: true });
      await writeFile(join(cwd, "AGENTS.md"), "Assess the ticket.\n");
      await writeFile(join(cwd, ".codex/agents/architect.toml"), 'name = "architect"\ndeveloper_instructions = 7\n');
    }],
    ["missing-root", async (cwd: string) => {
      await mkdir(join(cwd, ".codex/agents"), { recursive: true });
      await writeFile(join(cwd, ".codex/agents/architect.toml"), 'name = "architect"\ndeveloper_instructions = "Work."\n');
    }],
  ] as const) {
    const caseRoot = join(root, name);
    await mkdir(caseRoot);
    const packageDirectory = await packageFixture(caseRoot);
    const outputDirectory = join(caseRoot, "output");
    await mkdir(outputDirectory);
    await assert.rejects(
      compileAgentContext("architect", packageDirectory, "codex", outputDirectory, fakeCompile(output)),
      assertPreflight,
    );
  }
});

test("rejects package symlinks and overlapping output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-apm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDirectory = await packageFixture(root);
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside\n");
  await symlink(outside, join(packageDirectory, ".apm/linked"));
  const outputDirectory = join(root, "output");
  await mkdir(outputDirectory);

  await assert.rejects(
    compileAgentContext("architect", packageDirectory, "claude", outputDirectory, fakeCompile(writeClaudeOutput)),
    assertPreflight,
  );
  await unlink(join(packageDirectory, ".apm/linked"));
  await assert.rejects(
    compileAgentContext("architect", packageDirectory, "claude", packageDirectory, fakeCompile(writeClaudeOutput)),
    assertPreflight,
  );
});

test("compiles every package with explicit receipt artifact discriminators", async (t) => {
  try {
    await execFile("apm", ["--version"]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      t.skip("APM CLI is not installed");
      return;
    }
    throw error;
  }
  const root = await mkdtemp(join(tmpdir(), "agent-flow-apm-real-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packages = [
    ["architect", ["claude", "codex"], /exactly\s+`kind: "comment"`,\s+`id`,\s+`url`,\s+`marker`, and `artifactKind`/],
    ["planner", ["claude", "codex"], /exactly\s+`kind: "comment"`,\s+`id`,\s+`url`,\s+`marker`, and `artifactKind`/],
    ["developer", ["codex"], /exactly\s+`kind: "change-request"`,\s+`number`,\s+`url`,\s+`headSha`, and `state`/],
    ["reviewer", ["codex"], /exactly\s+`kind: "review"`,\s+`id`,\s+`url`,\s+`headSha`, and `verdict`/],
  ] as const;
  for (const [agentId, targets, expected] of packages) {
    for (const target of targets) {
      const outputDirectory = join(root, `${agentId}-${target}`);
      await mkdir(outputDirectory);
      const result = await compileAgentContext(
        agentId,
        join(process.cwd(), `agent-packages/${agentId}`),
        target,
        outputDirectory,
      );
      assert.match(result.instructions, expected);
      assert.match(result.instructions, /only entry agent/);
      if (agentId === "developer" || agentId === "reviewer") {
        assert.match(
          result.instructions,
          /exactly\s+`kind: "comment"`,\s+`id`,\s+`url`,\s+`marker`, and `artifactKind`/,
        );
      }
      await execFile("apm", ["audit", "--ci", "--no-policy"], { cwd: result.runtimeDirectory });
      const packageDirectory = join(process.cwd(), `agent-packages/${agentId}`);
      await assert.rejects(access(join(packageDirectory, target === "claude" ? ".claude" : ".codex")), {
        code: "ENOENT",
      });
      await assert.rejects(access(join(packageDirectory, target === "claude" ? "CLAUDE.md" : "AGENTS.md")), {
        code: "ENOENT",
      });
    }
  }
});
