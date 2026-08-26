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
      let receiptPath: string;
      try {
        [contextPath, receiptPath] = await Promise.all([
          assertSafeFile(input.session.root, input.session.contextPath, "attempt context path"),
          assertSafeFile(input.session.root, input.session.receiptPath, "attempt receipt path"),
        ]);
        home = await createHarnessHome(input.session, "codex");
        await seedCodexHome(auth, home);
        environment = harnessEnvironment({
          ...providerCredentialEnvironment(input.providerCredential),
          ...await createCliConfigEnvironment(home),
          CODEX_HOME: home,
          AGENT_FLOW_CONTEXT_PATH: input.session.contextPath,
          AGENT_FLOW_RECEIPT_PATH: input.session.receiptPath,
        });
      } catch {
        throw new HarnessPreflightError("codex");
      }
      const prompt = buildPrompt(
        input.compiledAgent.instructions,
        codexStagePrompt(input.stagePrompt, contextPath, receiptPath),
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

function codexStagePrompt(stagePrompt: string, contextPath: string, receiptPath: string): string {
  return `${stagePrompt.trim()}

When invoking the configured APM entry agent, pass these exact attempt file paths unchanged:
contextPath: ${contextPath}
receiptPath: ${receiptPath}
The entry agent must read contextPath and write its final AgentReceipt to receiptPath.
If that delegated agent does not inherit AGENT_FLOW_CONTEXT_PATH or AGENT_FLOW_RECEIPT_PATH, it may use these literal paths directly.`;
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
