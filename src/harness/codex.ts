import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertSafeFile } from "../runtime/filesystem.ts";
import type { HarnessAdapter, HarnessRunInput, HarnessResult } from "./types.ts";
import {
  HarnessPreflightError,
  buildPrompt,
  createCliConfigEnvironment,
  createHarnessHome,
  harnessEnvironment,
  providerCredentialEnvironment,
  preflightHarness,
  processDependencies,
  readRegularFile,
  runHarnessProcess,
  type ProcessDependencies,
} from "./process.ts";

export interface CodexAuthSources {
  authFile: string;
  configFile?: string;
}

export function createCodexAdapter(
  auth: CodexAuthSources,
  dependencyOverrides: Partial<ProcessDependencies> = {},
  registerCredential: (value: Buffer) => void = () => undefined,
): HarnessAdapter {
  const dependencies = processDependencies(dependencyOverrides);
  let authFile: Promise<Buffer> | undefined;
  let configFile: Promise<Buffer> | undefined;
  const loadAuth = () => authFile ??= readRegularFile(auth.authFile, "Codex authentication file").then((value) => {
    registerCredential(value);
    return value;
  });
  const loadConfig = () => auth.configFile
    ? configFile ??= readFile(auth.configFile)
    : undefined;
  return {
    target: "codex",
    preflight: () => preflightHarness("codex", (home) => seedCodexHome(loadAuth(), loadConfig(), home), dependencies),
    async run(input: HarnessRunInput): Promise<HarnessResult> {
      assertTarget(input, "codex");
      if (input.signal.aborted) return { exitCode: null, signal: "SIGTERM", timedOut: false };
      let home: string | undefined;
      let environment: NodeJS.ProcessEnv;
      let contextPath: string;
      let decisionPath: string;
      try {
        [contextPath, decisionPath] = await Promise.all([
          assertSafeFile(input.session.root, input.session.contextPath, "attempt context path"),
          assertSafeFile(input.session.root, input.session.decisionPath, "attempt decision path"),
        ]);
        home = await createHarnessHome(input.session, "codex");
        await seedCodexHome(loadAuth(), loadConfig(), home);
        const cliConfig = await createCliConfigEnvironment(home);
        environment = harnessEnvironment({
          ...await providerCredentialEnvironment(
            input.providerCredential,
            cliConfig.GLAB_CONFIG_DIR,
            dependencies,
          ),
          ...cliConfig,
          CODEX_HOME: home,
          AGENT_FLOW_CONTEXT_PATH: contextPath,
          AGENT_FLOW_DECISION_PATH: decisionPath,
        });
      } catch {
        if (home) await rm(home, { recursive: true, force: true });
        throw new HarnessPreflightError("codex");
      }
      const prompt = buildPrompt(
        input.compiledAgent.instructions,
        codexStagePrompt(
        input.stagePrompt,
        contextPath,
        decisionPath,
      ),
      );
      try {
        if (!home) throw new HarnessPreflightError("codex");
        return await runHarnessProcess("codex", {
        file: "codex",
        args: [
          "exec",
          "--model", input.execution.model,
          "--config", `model_reasoning_effort=${JSON.stringify(input.execution.reasoning)}`,
          "--approve-for-me",
          "--add-dir",
          input.session.root,
          "--cd",
          input.workspace.worktree,
          "-",
        ],
        cwd: input.workspace.worktree,
        env: environment,
        logPath: input.session.logPath,
        prompt,
        timeoutSeconds: input.timeoutSeconds,
        signal: input.signal,
        }, dependencies);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  };
}

function codexStagePrompt(
  stagePrompt: string,
  contextPath: string,
  decisionPath: string,
): string {
  return `${stagePrompt.trim()}

Parse this JSON object and pass both string values unchanged when invoking the configured APM entry agent:
${JSON.stringify({ contextPath, decisionPath })}
The entry agent must read contextPath and write one AgentDecision to decisionPath.
If that delegated agent does not inherit AGENT_FLOW_CONTEXT_PATH or AGENT_FLOW_DECISION_PATH, it may use these parsed paths directly.`;
}

async function seedCodexHome(auth: Promise<Buffer>, config: Promise<Buffer> | undefined, home: string): Promise<void> {
  await writeFile(join(home, "auth.json"), await auth, { flag: "wx", mode: 0o600 });
  if (config) await writeFile(join(home, "config.toml"), await config, { flag: "wx", mode: 0o600 });
}

function assertTarget(input: HarnessRunInput, target: "codex"): void {
  if (input.compiledAgent.target !== target) {
    throw new Error(`compiled agent target must be ${target}`);
  }
}
