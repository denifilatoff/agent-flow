import { join } from "node:path";

import { assertSafeFile } from "../runtime/filesystem.ts";
import type { HarnessAdapter, HarnessRunInput, HarnessResult } from "./types.ts";
import {
  HarnessPreflightError,
  buildPrompt,
  copyRegularFile,
  createCliConfigEnvironment,
  createHarnessHome,
  harnessEnvironment,
  providerCredentialEnvironment,
  preflightHarness,
  processDependencies,
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
): HarnessAdapter {
  const dependencies = processDependencies(dependencyOverrides);
  return {
    target: "codex",
    preflight: () => preflightHarness("codex", (home) => seedCodexHome(auth, home), dependencies),
    async run(input: HarnessRunInput): Promise<HarnessResult> {
      assertTarget(input, "codex");
      if (input.signal.aborted) return { exitCode: null, signal: "SIGTERM", timedOut: false };
      let home: string;
      let environment: NodeJS.ProcessEnv;
      let contextPath: string;
      let decisionPath: string;
      try {
        [contextPath, decisionPath] = await Promise.all([
          assertSafeFile(input.session.root, input.session.contextPath, "attempt context path"),
          assertSafeFile(input.session.root, input.session.decisionPath, "attempt decision path"),
        ]);
        home = await createHarnessHome(input.session, "codex");
        await seedCodexHome(auth, home);
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
        throw new HarnessPreflightError("codex");
      }
      const prompt = buildPrompt(
        input.compiledAgent.instructions,
        codexStagePrompt(input.stagePrompt, contextPath, decisionPath),
      );
      return runHarnessProcess("codex", {
        file: "codex",
        args: [
          "exec",
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
    },
  };
}

function codexStagePrompt(stagePrompt: string, contextPath: string, decisionPath: string): string {
  return `${stagePrompt.trim()}

Parse this JSON object and pass both string values unchanged when invoking the configured APM entry agent:
${JSON.stringify({ contextPath, decisionPath })}
The entry agent must read contextPath and write one AgentDecision to decisionPath.
If that delegated agent does not inherit AGENT_FLOW_CONTEXT_PATH or AGENT_FLOW_DECISION_PATH, it may use these parsed paths directly.`;
}

async function seedCodexHome(auth: CodexAuthSources, home: string): Promise<void> {
  await copyRegularFile(auth.authFile, join(home, "auth.json"), "Codex authentication file");
  if (auth.configFile) {
    await copyRegularFile(auth.configFile, join(home, "config.toml"), "Codex configuration file");
  }
}

function assertTarget(input: HarnessRunInput, target: "codex"): void {
  if (input.compiledAgent.target !== target) {
    throw new Error(`compiled agent target must be ${target}`);
  }
}
