import { dirname, join } from "node:path";

import type { HarnessAdapter, HarnessRunInput, HarnessResult } from "./types.ts";
import {
  buildPrompt,
  copyRegularFile,
  createHarnessHome,
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
    preflight: () => preflightHarness(
      "codex",
      [auth.authFile, auth.configFile],
      { ...process.env, CODEX_HOME: dirname(auth.authFile) },
      dependencies,
    ),
    async run(input: HarnessRunInput): Promise<HarnessResult> {
      assertTarget(input, "codex");
      const prompt = buildPrompt(input.compiledAgent.instructions, input.stagePrompt);
      if (input.signal.aborted) return { exitCode: null, signal: "SIGTERM", timedOut: false };
      const home = await createHarnessHome(input.session, "codex");
      await copyRegularFile(auth.authFile, join(home, "auth.json"), "Codex authentication file");
      if (auth.configFile) {
        await copyRegularFile(auth.configFile, join(home, "config.toml"), "Codex configuration file");
      }
      return runHarnessProcess("codex", {
        file: "codex",
        args: ["exec", "--cd", input.workspace.worktree, "-"],
        cwd: input.workspace.worktree,
        env: {
          ...process.env,
          CODEX_HOME: home,
          AGENT_FLOW_CONTEXT_PATH: input.session.contextPath,
          AGENT_FLOW_RECEIPT_PATH: input.session.receiptPath,
        },
        logPath: input.session.logPath,
        prompt,
        timeoutSeconds: input.timeoutSeconds,
        signal: input.signal,
      }, dependencies);
    },
  };
}

function assertTarget(input: HarnessRunInput, target: "codex"): void {
  if (input.compiledAgent.target !== target) {
    throw new Error(`compiled agent target must be ${target}`);
  }
}
