import { join } from "node:path";

import type { HarnessAdapter, HarnessRunInput, HarnessResult } from "./types.ts";
import {
  HarnessPreflightError,
  buildPrompt,
  copyRegularFile,
  copyRegularTree,
  createCliConfigEnvironment,
  createHarnessHome,
  harnessEnvironment,
  pathIsDirectory,
  pathIsFile,
  providerCredentialEnvironment,
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
    preflight: () => preflightHarness("claude", (home) => seedClaudeAuth(auth, home), dependencies),
    async run(input: HarnessRunInput): Promise<HarnessResult> {
      assertTarget(input, "claude");
      const prompt = buildPrompt(
        input.compiledAgent.instructions,
        claudeStagePrompt(input.stagePrompt, input.session.contextPath, input.session.decisionPath),
      );
      if (input.signal.aborted) return { exitCode: null, signal: "SIGTERM", timedOut: false };
      let home: string;
      let environment: NodeJS.ProcessEnv;
      try {
        home = await createHarnessHome(input.session, "claude");
        await seedClaudeAuth(auth, home);
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
        const skills = join(runtime, ".claude/skills");
        if (await pathIsDirectory(skills)) {
          await copyRegularTree(skills, join(home, "skills"), "Claude skills");
        }
        const cliConfig = await createCliConfigEnvironment(home);
        environment = harnessEnvironment({
          ...await providerCredentialEnvironment(
            input.providerCredential,
            cliConfig.GLAB_CONFIG_DIR,
            dependencies,
          ),
          ...cliConfig,
          CLAUDE_CONFIG_DIR: home,
          AGENT_FLOW_CONTEXT_PATH: input.session.contextPath,
          AGENT_FLOW_DECISION_PATH: input.session.decisionPath,
        });
      } catch {
        throw new HarnessPreflightError("claude");
      }
      return runHarnessProcess("claude", {
        file: "claude",
        args: ["--agent", input.compiledAgent.agentId, "-p"],
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

function claudeStagePrompt(stagePrompt: string, contextPath: string, decisionPath: string): string {
  return `${stagePrompt.trim()}

Parse this JSON object and pass both string values unchanged when invoking the configured APM entry agent:
${JSON.stringify({ contextPath, decisionPath })}
The entry agent must read contextPath and write one AgentDecision to decisionPath.
If that delegated agent does not inherit AGENT_FLOW_CONTEXT_PATH or AGENT_FLOW_DECISION_PATH, it may use these parsed paths directly.`;
}

async function seedClaudeAuth(auth: ClaudeAuthSources, home: string): Promise<void> {
  await copyRegularFile(
    auth.credentialsFile,
    join(home, ".credentials.json"),
    "Claude authentication file",
  );
  if (auth.settingsFile) {
    await copyRegularFile(auth.settingsFile, join(home, "settings.json"), "Claude settings file");
  }
}

function assertTarget(input: HarnessRunInput, target: "claude"): void {
  if (input.compiledAgent.target !== target) {
    throw new Error(`compiled agent target must be ${target}`);
  }
}
