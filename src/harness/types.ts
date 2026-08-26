import type { HarnessTarget } from "../config/types.ts";
import type { AttemptSession } from "../runtime/sessions.ts";
import type { Workspace } from "../runtime/workspaces.ts";
import type { CompiledAgent } from "./apm.ts";

export interface HarnessAdapter {
  readonly target: HarnessTarget;
  preflight(): Promise<void>;
  run(input: HarnessRunInput): Promise<HarnessResult>;
}

export interface HarnessRunInput {
  workspace: Workspace;
  session: AttemptSession;
  compiledAgent: CompiledAgent;
  stagePrompt: string;
  timeoutSeconds: number;
  signal: AbortSignal;
}

export interface HarnessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}
