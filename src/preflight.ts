import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ConfigBundle } from "./config/load.js";
import type { RuntimeManager } from "./config/runtime.ts";
import { validateSemantics } from "./config/semantic.ts";
import type { HarnessTarget } from "./config/types.js";
import type { HarnessAdapter } from "./harness/types.js";
import type { ProviderKind, ProviderAdapter } from "./provider/types.js";
import type { SecretRedactor } from "./redaction.ts";
import type { Controller } from "./runtime/controller.js";
import { ensureSafeDirectory, prepareDataRoot } from "./runtime/filesystem.ts";

type Providers = Partial<Record<ProviderKind, ProviderAdapter>>;
type Harnesses = Partial<Record<HarnessTarget, HarnessAdapter>>;
type CommandRunner = (file: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;

export interface PreflightDependencies {
  runtime: RuntimeManager;
  loadConfig(): Promise<ConfigBundle>;
  createProviders(bundle: ConfigBundle): Providers | Promise<Providers>;
  providerEnvironment(): Promise<NodeJS.ProcessEnv>;
  createHarnesses(bundle: ConfigBundle): Harnesses;
  createController(bundle: ConfigBundle, providers: Providers, harnesses: Harnesses): Controller;
  redactSessionContent?: SecretRedactor;
  validateConfig?: (bundle: ConfigBundle) => Promise<void>;
  prepareDirectories?: (dataDirectory: string) => Promise<void>;
  runCommand?: CommandRunner;
}

export interface ReadyDependencies {
  bundle: ConfigBundle;
  providers: Providers;
  harnesses: Harnesses;
  controller: Controller;
  redactSessionContent: SecretRedactor;
  preflight: {
    status: "ready";
    provider: ProviderKind;
    harnesses: HarnessTarget[];
    configurationRevision: string;
  };
}

const execFile = promisify(execFileCallback);
const defaultCommand: CommandRunner = async (file, args, options = {}) => {
  const result = await execFile(file, args, {
    encoding: "utf8", maxBuffer: 1_048_576, shell: false, env: options.env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export async function runPreflight(dependencies: PreflightDependencies): Promise<ReadyDependencies> {
  const bundle = await checked("configuration load failed", dependencies.loadConfig);
  const runtime = dependencies.runtime.effective();
  await checked("configuration validation failed", async () => {
    const harnesses = dependencies.validateConfig
      ? (await dependencies.validateConfig(bundle), Object.fromEntries(
          Object.keys(bundle.catalog.agents).map((agentId) => [agentId, ["claude", "codex"] as const]),
        ))
      : await validateSemantics(bundle);
    dependencies.runtime.bindCatalog(harnesses);
  });
  await checked("data directory preflight failed", () =>
    (dependencies.prepareDirectories ?? prepareDirectories)(runtime.runtime.dataDirectory));

  const providers = await checked("provider configuration failed", async () => dependencies.createProviders(bundle));
  const kind = runtime.provider.type;
  const adapter = providers[kind];
  if (!adapter || adapter.kind !== kind) throw new Error(`${kind} provider configuration failed`);
  await checked(`${kind} REST authentication failed`, () => adapter.verifyAuth());

  const run = dependencies.runCommand ?? defaultCommand;
  const executable = kind === "github" ? "gh" : "glab";
  const hostname = providerHostname(kind, runtime.provider.apiUrl);
  await checked(
    `${kind} agent authentication failed`,
    async () => run(executable, ["auth", "status", "--hostname", hostname], {
      env: await dependencies.providerEnvironment(),
    }),
  );
  await checked("git executable preflight failed", () => run("git", ["--version"]));
  await checked("apm executable preflight failed", () => run("apm", ["--version"]));

  const harnesses = await checked("harness configuration failed", async () => dependencies.createHarnesses(bundle));
  const targets = new Set(Object.keys(runtime.execution.harnesses) as HarnessTarget[]);
  for (const target of [...targets].sort()) {
    const harness = harnesses[target];
    if (!harness || harness.target !== target) throw new Error(`${target} harness configuration failed`);
    await checked(`${target} harness preflight failed`, () => harness.preflight());
  }

  const controller = await checked(
    "controller configuration failed",
    async () => dependencies.createController(bundle, providers, harnesses),
  );
  await checked("controller bootstrap failed", () => controller.bootstrap());
  return {
    bundle,
    providers,
    harnesses,
    controller,
    redactSessionContent: dependencies.redactSessionContent ?? unavailableRedactor,
    preflight: {
      status: "ready",
      provider: kind,
      harnesses: [...targets].sort(),
      configurationRevision: bundle.revision,
    },
  };
}

function unavailableRedactor(): never {
  throw new Error("session redaction unavailable");
}

async function prepareDirectories(dataDirectory: string): Promise<void> {
  const root = await prepareDataRoot(dataDirectory);
  for (const name of ["config", "repositories", "worktrees", "sessions"] as const) {
    const directory = await ensureSafeDirectory(root, join(root, name), `${name} directory`);
    const probe = join(directory, `.preflight-${process.pid}-${randomUUID()}`);
    let handle;
    try {
      handle = await open(probe, "wx", 0o600);
      await handle.sync();
    } finally {
      if (handle) {
        await handle.close().catch(() => undefined);
        await unlink(probe);
      }
    }
  }
}

function providerHostname(kind: ProviderKind, apiUrl: string): string {
  const hostname = new URL(apiUrl).hostname;
  return kind === "github" && hostname === "api.github.com" ? "github.com" : hostname;
}

async function checked<T>(message: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(message);
  }
}
