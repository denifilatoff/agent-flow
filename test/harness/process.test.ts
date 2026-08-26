import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createClaudeAdapter } from "../../src/harness/claude.ts";
import { createCodexAdapter } from "../../src/harness/codex.ts";
import {
  HarnessPreflightError,
  HarnessProcessError,
  runHarnessProcess,
  type CommandRunner,
  type ProcessDependencies,
  type SpawnedProcess,
} from "../../src/harness/process.ts";
import type { CompiledAgent } from "../../src/harness/apm.ts";
import type { HarnessRunInput } from "../../src/harness/types.ts";
import type { AttemptSession } from "../../src/runtime/sessions.ts";
import type { Workspace } from "../../src/runtime/workspaces.ts";

interface SpawnCall {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  child: FakeChild;
}

class FakeChild extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly input: Buffer[] = [];
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      this.input.push(Buffer.from(chunk));
      callback();
    },
  });
  readonly kills: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  exitOnTerm = true;
  closeOnExit = true;

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    if (signal === "SIGKILL" || this.exitOnTerm) {
      queueMicrotask(() => this.finish(null, signal));
    }
    return true;
  }

  finish(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = exitCode;
    this.signalCode = signal;
    if (this.closeOnExit) {
      this.stdout.end();
      this.stderr.end();
    }
    queueMicrotask(() => {
      this.emit("exit", exitCode, signal);
      if (this.closeOnExit) this.emit("close", exitCode, signal);
    });
  }
}

class FakeClock {
  readonly timers = new Map<object, { delay: number; callback: () => void }>();

  setTimeout = (callback: () => void, delay: number): object => {
    const handle = {};
    this.timers.set(handle, { delay, callback });
    return handle;
  };

  clearTimeout = (handle: object): void => {
    this.timers.delete(handle);
  };

  fire(delay: number): void {
    const entry = [...this.timers.entries()].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `missing ${delay} ms timer`);
    this.timers.delete(entry[0]);
    entry[1].callback();
  }
}

function processFixture(clock = new FakeClock()): {
  calls: SpawnCall[];
  children: FakeChild[];
  clock: FakeClock;
  dependencies: ProcessDependencies;
} {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  return {
    calls,
    children,
    clock,
    dependencies: {
      spawn: (file, args, options) => {
        const child = new FakeChild();
        calls.push({ file, args: [...args], cwd: options.cwd, env: { ...options.env }, child });
        children.push(child);
        return child;
      },
      runCommand: async () => ({ stdout: "", stderr: "" }),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  };
}

async function runFixture(target: "codex" | "claude"): Promise<{
  root: string;
  authFile: string;
  configFile: string;
  input: HarnessRunInput;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-flow-process-")));
  const worktree = join(root, "worktree");
  const sessionRoot = join(root, "attempt");
  const harnessSessionDirectory = join(sessionRoot, "harness-session");
  const runtimeDirectory = join(root, "runtime");
  await mkdir(worktree);
  await mkdir(harnessSessionDirectory, { recursive: true });
  await mkdir(runtimeDirectory);

  if (target === "claude") {
    await mkdir(join(runtimeDirectory, ".claude/agents"), { recursive: true });
    await mkdir(join(runtimeDirectory, ".claude/rules"), { recursive: true });
    await writeFile(
      join(runtimeDirectory, ".claude/agents/developer.md"),
      "---\nname: developer\n---\n\nDevelop the change.\n",
    );
    await writeFile(join(runtimeDirectory, ".claude/rules/root.md"), "Follow repository rules.\n");
  }

  const authFile = join(root, target === "codex" ? "auth.json" : ".credentials.json");
  const configFile = join(root, target === "codex" ? "config.toml" : "settings.json");
  await writeFile(authFile, "{}\n", { mode: 0o600 });
  await writeFile(configFile, "{}\n", { mode: 0o600 });
  const session: AttemptSession = {
    root: sessionRoot,
    contextPath: join(sessionRoot, "context.json"),
    receiptPath: join(sessionRoot, "receipt.json"),
    logPath: join(sessionRoot, "harness.log"),
    harnessSessionDirectory,
  };
  await writeFile(session.contextPath, "{}\n");
  await writeFile(session.receiptPath, "");
  await writeFile(session.logPath, "");
  const workspace: Workspace = {
    baseClone: join(root, "base"),
    worktree,
    repository: "owner/repo",
    ticketNumber: 17,
    flowInstanceId: "11111111-1111-4111-8111-111111111111",
  };
  const compiledAgent: CompiledAgent = {
    agentId: "developer",
    target,
    instructions: "Follow repository rules.\n\nDevelop the change.\n",
    runtimeDirectory,
  };
  return {
    root,
    authFile,
    configFile,
    input: {
      workspace,
      session,
      compiledAgent,
      stagePrompt: "Implement ticket 17.",
      timeoutSeconds: 60,
      signal: new AbortController().signal,
    },
  };
}

async function waitForSpawn(calls: SpawnCall[], count = 1): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (calls.length < count && Date.now() < deadline) {
    await delay(1);
  }
  assert.equal(calls.length, count);
}

test("runs Codex in the worktree with private attempt paths", async (t) => {
  const fixture = await runFixture("codex");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const processes = processFixture();
  const inheritedSecrets = ["GITHUB_TOKEN", "GITLAB_TOKEN", "GH_TOKEN", "GLAB_TOKEN", "OPENAI_API_KEY"];
  const previous = new Map(inheritedSecrets.map((name) => [name, process.env[name]]));
  for (const name of inheritedSecrets) process.env[name] = `SECRET_${name}`;
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const adapter = createCodexAdapter(
    { authFile: fixture.authFile, configFile: fixture.configFile },
    processes.dependencies,
  );

  const pending = adapter.run(fixture.input);
  await waitForSpawn(processes.calls);
  const call = processes.calls[0]!;
  assert.deepEqual([call.file, ...call.args], ["codex", "exec", "--cd", fixture.input.workspace.worktree, "-"]);
  assert.equal(call.cwd, fixture.input.workspace.worktree);
  assert.equal(call.env.AGENT_FLOW_CONTEXT_PATH, fixture.input.session.contextPath);
  assert.equal(call.env.AGENT_FLOW_RECEIPT_PATH, fixture.input.session.receiptPath);
  assert.equal(call.env.HOME, process.env.HOME);
  for (const name of inheritedSecrets) assert.equal(call.env[name], undefined);
  assert.match(call.env.CODEX_HOME!, /harness-session\/codex-/);
  assert.equal(Buffer.concat(call.child.input).toString(), "Follow repository rules.\n\nDevelop the change.\n\nImplement ticket 17.\n");
  call.child.stdout.write("stdout line\n");
  call.child.stderr.write("stderr line\n");
  call.child.finish(0, null);

  assert.deepEqual(await pending, { exitCode: 0, signal: null, timedOut: false });
  assert.equal(await readFile(fixture.input.session.logPath, "utf8"), "stdout line\nstderr line\n");
  assert.equal(await readFile(join(call.env.CODEX_HOME!, "auth.json"), "utf8"), "{}\n");
  assert.equal(await readFile(join(call.env.CODEX_HOME!, "config.toml"), "utf8"), "{}\n");
});

test("runs Claude with the deployed agent and prompt on stdin", async (t) => {
  const fixture = await runFixture("claude");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const processes = processFixture();
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "SECRET_ANTHROPIC_API_KEY";
  t.after(() => {
    if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
  });
  const adapter = createClaudeAdapter(
    { credentialsFile: fixture.authFile, settingsFile: fixture.configFile },
    processes.dependencies,
  );

  const pending = adapter.run(fixture.input);
  await waitForSpawn(processes.calls);
  const call = processes.calls[0]!;
  assert.deepEqual([call.file, ...call.args], ["claude", "--agent", "developer", "-p"]);
  assert.deepEqual(call.args.filter((argument) => argument.includes("ticket 17")), []);
  assert.match(call.env.CLAUDE_CONFIG_DIR!, /harness-session\/claude-/);
  assert.equal(call.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(Buffer.concat(call.child.input).toString(), "Follow repository rules.\n\nDevelop the change.\n\nImplement ticket 17.\n");
  assert.match(
    await readFile(join(call.env.CLAUDE_CONFIG_DIR!, "agents/developer.md"), "utf8"),
    /name: developer/,
  );
  assert.equal(
    await readFile(join(call.env.CLAUDE_CONFIG_DIR!, "rules/root.md"), "utf8"),
    "Follow repository rules.\n",
  );
  call.child.finish(0, null);
  assert.deepEqual(await pending, { exitCode: 0, signal: null, timedOut: false });
});

test("terminates a cancelled Claude process once", async (t) => {
  const fixture = await runFixture("claude");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const processes = processFixture();
  const abort = new AbortController();
  fixture.input.signal = abort.signal;
  const adapter = createClaudeAdapter({ credentialsFile: fixture.authFile }, processes.dependencies);

  const pending = adapter.run(fixture.input);
  await waitForSpawn(processes.calls);
  abort.abort();

  assert.deepEqual(await pending, { exitCode: null, signal: "SIGTERM", timedOut: false });
  assert.deepEqual(processes.children[0]!.kills, ["SIGTERM"]);
  assert.equal(processes.clock.timers.size, 0);
});

test("kills a timed-out process after one ten-second grace period", async (t) => {
  const fixture = await runFixture("codex");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  fixture.input.timeoutSeconds = 3;
  const processes = processFixture();
  const adapter = createCodexAdapter({ authFile: fixture.authFile }, processes.dependencies);

  const pending = adapter.run(fixture.input);
  await waitForSpawn(processes.calls);
  const child = processes.children[0]!;
  child.exitOnTerm = false;
  processes.clock.fire(3_000);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal([...processes.clock.timers.values()].filter((timer) => timer.delay === 10_000).length, 1);
  processes.clock.fire(10_000);

  assert.deepEqual(await pending, { exitCode: null, signal: "SIGKILL", timedOut: true });
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(processes.clock.timers.size, 0);
});

test("settles after direct-child exit when a descendant retains output descriptors", async (t) => {
  const fixture = await runFixture("codex");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const processes = processFixture();
  const adapter = createCodexAdapter({ authFile: fixture.authFile }, processes.dependencies);

  const pending = adapter.run(fixture.input);
  await waitForSpawn(processes.calls);
  const child = processes.children[0]!;
  child.closeOnExit = false;
  child.stdout.write("before exit\n");
  child.finish(0, null);
  await delay(0);
  child.stdout.write("during drain\n");
  processes.clock.fire(1_000);

  assert.deepEqual(await pending, { exitCode: 0, signal: null, timedOut: false });
  assert.equal(await readFile(fixture.input.session.logPath, "utf8"), "before exit\nduring drain\n");
  assert.equal(processes.clock.timers.size, 0);
});

test("does not signal an exited child when an inherited output stream later fails", async (t) => {
  const fixture = await runFixture("codex");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const processes = processFixture();
  const adapter = createCodexAdapter({ authFile: fixture.authFile }, processes.dependencies);

  const pending = adapter.run(fixture.input);
  await waitForSpawn(processes.calls);
  const child = processes.children[0]!;
  child.closeOnExit = false;
  child.finish(0, null);
  await delay(0);
  child.stdout.emit("error", new Error("late stream failure"));
  processes.clock.fire(1_000);

  await assert.rejects(pending, HarnessProcessError);
  assert.deepEqual(child.kills, []);
});

test("turns stdin, stdout, and stderr failures into sanitized process errors", async (t) => {
  for (const stream of ["stdin", "stdout", "stderr"] as const) {
    const fixture = await runFixture("codex");
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const processes = processFixture();
    const adapter = createCodexAdapter({ authFile: fixture.authFile }, processes.dependencies);
    const pending = adapter.run(fixture.input);
    await waitForSpawn(processes.calls);
    const child = processes.children[0]!;
    const secret = `STREAM_SECRET_${stream}`;

    child[stream].emit("error", Object.assign(new Error(secret), { stdout: secret, stderr: secret }));

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof HarnessProcessError);
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
      return true;
    });
    assert.deepEqual(child.kills, ["SIGTERM"]);
    assert.equal(processes.clock.timers.size, 0);
  }
});

test("returns an immediate cancellation without spawning", async (t) => {
  const fixture = await runFixture("codex");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const processes = processFixture();
  const abort = new AbortController();
  abort.abort();
  fixture.input.signal = abort.signal;
  const adapter = createCodexAdapter({ authFile: fixture.authFile }, processes.dependencies);

  assert.deepEqual(await adapter.run(fixture.input), {
    exitCode: null,
    signal: "SIGTERM",
    timedOut: false,
  });
  assert.equal(processes.calls.length, 0);
});

test("rechecks cancellation after opening the log and before spawn", async (t) => {
  const fixture = await runFixture("codex");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const processes = processFixture();
  const controller = new AbortController();
  let reads = 0;
  const signal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === "aborted") {
        reads += 1;
        return reads > 1;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const result = await runHarnessProcess("codex", {
    file: "codex",
    args: ["exec", "--cd", fixture.input.workspace.worktree, "-"],
    cwd: fixture.input.workspace.worktree,
    env: { PATH: process.env.PATH },
    logPath: fixture.input.session.logPath,
    prompt: "prompt\n",
    timeoutSeconds: 60,
    signal,
  }, processes.dependencies);

  assert.deepEqual(result, { exitCode: null, signal: "SIGTERM", timedOut: false });
  assert.equal(processes.calls.length, 0);
  await appendFile(fixture.input.session.logPath, "closed\n");
});

test("uses a new process and target home for every run", async (t) => {
  const fixture = await runFixture("codex");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const processes = processFixture();
  const adapter = createCodexAdapter({ authFile: fixture.authFile }, processes.dependencies);

  const first = adapter.run(fixture.input);
  await waitForSpawn(processes.calls);
  processes.children[0]!.finish(0, null);
  await first;
  const second = adapter.run(fixture.input);
  await waitForSpawn(processes.calls, 2);
  processes.children[1]!.finish(0, null);
  await second;

  assert.equal(processes.calls.length, 2);
  assert.notEqual(processes.calls[0]!.env.CODEX_HOME, processes.calls[1]!.env.CODEX_HOME);
});

test("rejects unbounded prompts before spawning", async (t) => {
  const fixture = await runFixture("codex");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const processes = processFixture();
  fixture.input.stagePrompt = "x".repeat(1_048_577);
  const adapter = createCodexAdapter({ authFile: fixture.authFile }, processes.dependencies);

  await assert.rejects(adapter.run(fixture.input), /prompt exceeds 1048576 bytes/);
  assert.equal(processes.calls.length, 0);
});

test("preflight verifies the binary and isolated authentication source", async (t) => {
  const fixture = await runFixture("codex");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const mountedAuth = join(fixture.root, "mounted-codex-secret");
  await rename(fixture.authFile, mountedAuth);
  await writeFile(fixture.authFile, "{\"source\":\"unrelated\"}\n");
  await writeFile(mountedAuth, "{\"source\":\"mounted\"}\n");
  const commands: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const runCommand: CommandRunner = async (file, args, options = {}) => {
    commands.push({ file, args: [...args], env: options.env });
    assert.equal(
      await readFile(join(options.env!.CODEX_HOME!, "auth.json"), "utf8"),
      "{\"source\":\"mounted\"}\n",
    );
    return { stdout: "", stderr: "" };
  };
  const processes = processFixture();
  processes.dependencies.runCommand = runCommand;
  const adapter = createCodexAdapter({ authFile: mountedAuth }, processes.dependencies);

  await adapter.preflight();

  assert.deepEqual(commands.map(({ file, args }) => [file, ...args]), [
    ["codex", "--version"],
    ["codex", "login", "status"],
  ]);
  assert.notEqual(commands[0]!.env!.CODEX_HOME, dirname(mountedAuth));
  assert.equal(commands[0]!.env!.CODEX_HOME, commands[1]!.env!.CODEX_HOME);
  await assert.rejects(access(commands[0]!.env!.CODEX_HOME!), { code: "ENOENT" });
});

test("preflights Claude from a canonical isolated credential copy", async (t) => {
  const fixture = await runFixture("claude");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const mountedCredentials = join(fixture.root, "mounted-claude-secret");
  await rename(fixture.authFile, mountedCredentials);
  const commands: string[][] = [];
  let preflightHome = "";
  const processes = processFixture();
  processes.dependencies.runCommand = async (file, args, options = {}) => {
    preflightHome = options.env!.CLAUDE_CONFIG_DIR!;
    assert.equal(await readFile(join(preflightHome, ".credentials.json"), "utf8"), "{}\n");
    assert.equal(options.env!.ANTHROPIC_API_KEY, undefined);
    commands.push([file, ...args]);
    return { stdout: "", stderr: "" };
  };
  const claude = createClaudeAdapter(
    { credentialsFile: mountedCredentials, settingsFile: fixture.configFile },
    processes.dependencies,
  );

  await claude.preflight();

  assert.deepEqual(commands, [["claude", "--version"], ["claude", "auth", "status"]]);
  await assert.rejects(access(preflightHome), { code: "ENOENT" });
});

test("classifies missing or failed authentication as sanitized non-retryable preflight errors", async (t) => {
  const fixture = await runFixture("claude");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const secret = "HARNESS_SECRET_8cad7a";
  const processes = processFixture();
  processes.dependencies.runCommand = async () => {
    throw Object.assign(new Error(`failed: ${secret}`), { stdout: secret, stderr: secret, cmd: `--token ${secret}` });
  };
  const adapter = createClaudeAdapter({ credentialsFile: fixture.authFile }, processes.dependencies);

  await assert.rejects(adapter.preflight(), (error: unknown) => {
    assert.ok(error instanceof HarnessPreflightError);
    assert.equal(error.retryable, false);
    assert.doesNotMatch(JSON.stringify(error), new RegExp(`${secret}|stdout|stderr|--token`));
    return true;
  });
  const missing = createClaudeAdapter(
    { credentialsFile: join(fixture.root, "missing.json") },
    processes.dependencies,
  );
  await assert.rejects(missing.preflight(), (error: unknown) => {
    assert.ok(error instanceof HarnessPreflightError);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("rejects symlinked authentication sources and runtime layout as non-retryable", async (t) => {
  const fixture = await runFixture("codex");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const processes = processFixture();
  const linkedParent = join(fixture.root, "linked-auth");
  const realParent = join(fixture.root, "real-auth");
  await mkdir(realParent);
  await writeFile(join(realParent, "secret"), "{}\n");
  await symlink(realParent, linkedParent, "dir");

  for (const authFile of [join(linkedParent, "secret"), join(fixture.root, "leaf-link")]) {
    if (authFile.endsWith("leaf-link")) await symlink(fixture.authFile, authFile);
    const adapter = createCodexAdapter({ authFile }, processes.dependencies);
    await assert.rejects(adapter.run(fixture.input), (error: unknown) => {
      assert.ok(error instanceof HarnessPreflightError);
      assert.equal(error.retryable, false);
      return true;
    });
  }
  assert.equal(processes.calls.length, 0);

  const claudeFixture = await runFixture("claude");
  t.after(() => rm(claudeFixture.root, { recursive: true, force: true }));
  await rm(join(claudeFixture.input.compiledAgent.runtimeDirectory, ".claude/agents/developer.md"));
  const claude = createClaudeAdapter(
    { credentialsFile: claudeFixture.authFile },
    processes.dependencies,
  );
  await assert.rejects(claude.run(claudeFixture.input), (error: unknown) => {
    assert.ok(error instanceof HarnessPreflightError);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(processes.calls.length, 0);
});
