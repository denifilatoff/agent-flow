import { dirname, join } from "node:path";

import type { HarnessAdapter, HarnessRunInput, HarnessResult } from "./types.ts";
import {
  buildPrompt,
  copyRegularFile,
  copyRegularTree,
  createHarnessHome,
  pathIsDirectory,
  pathIsFile,
  preflightHarness,
  processDependencies,
  runHarnessProcess,
  type ProcessDependencies,
} from "./process.ts";

export interface ClaudeAuthSources {
  credentialsFile: string;
  settingsFile?: string;
}

export function createClaudeAdapter(
  auth: ClaudeAuthSources,
  dependencyOverrides: Partial<ProcessDependencies> = {},
): HarnessAdapter {
  const dependencies = processDependencies(dependencyOverrides);
  return {
    target: "claude",
    preflight: () => preflightHarness(
      "claude",
      [auth.credentialsFile, auth.settingsFile],
      { ...process.env, CLAUDE_CONFIG_DIR: dirname(auth.credentialsFile) },
      dependencies,
    ),
    async run(input: HarnessRunInput): Promise<HarnessResult> {
      assertTarget(input, "claude");
      const prompt = buildPrompt(input.compiledAgent.instructions, input.stagePrompt);
      if (input.signal.aborted) return { exitCode: null, signal: "SIGTERM", timedOut: false };
      const home = await createHarnessHome(input.session, "claude");
      await copyRegularFile(
        auth.credentialsFile,
        join(home, ".credentials.json"),
        "Claude authentication file",
      );
      if (auth.settingsFile) {
        await copyRegularFile(auth.settingsFile, join(home, "settings.json"), "Claude settings file");
      }
      const runtime = input.compiledAgent.runtimeDirectory;
      await copyRegularFile(
        join(runtime, ".claude/agents", `${input.compiledAgent.agentId}.md`),
        join(home, "agents", `${input.compiledAgent.agentId}.md`),
        "Claude deployed agent",
      );
      const rules = join(runtime, ".claude/rules");
      const rootInstructions = join(runtime, "CLAUDE.md");
      if (await pathIsDirectory(rules)) {
        await copyRegularTree(rules, join(home, "rules"), "Claude rules");
      } else if (await pathIsFile(rootInstructions)) {
        await copyRegularFile(rootInstructions, join(home, "CLAUDE.md"), "Claude root instructions");
      } else {
        throw new Error("Claude runtime has no root instructions");
      }
      return runHarnessProcess("claude", {
        file: "claude",
        args: ["--agent", input.compiledAgent.agentId, "-p"],
        cwd: input.workspace.worktree,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: home,
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

function assertTarget(input: HarnessRunInput, target: "claude"): void {
  if (input.compiledAgent.target !== target) {
    throw new Error(`compiled agent target must be ${target}`);
  }
}
