import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ConfigBundle } from "./config/load.js";
import { validateSemantics } from "./config/semantic.ts";
import type { HarnessTarget } from "./config/types.js";
import type { HarnessAdapter } from "./harness/types.js";
import type { ProviderKind, ProviderAdapter } from "./provider/types.js";
import type { Controller } from "./runtime/controller.js";
import { ensureSafeDirectory, prepareDataRoot } from "./runtime/filesystem.ts";
import { loadControllerId } from "./runtime/identity.ts";
import { openLocalStore, providerScope, type LocalStore } from "./runtime/local-store.ts";

type Providers = Partial<Record<ProviderKind, ProviderAdapter>>;
type Harnesses = Partial<Record<HarnessTarget, HarnessAdapter>>;
type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface PreflightDependencies {
  loadConfig(): Promise<ConfigBundle>;
  createProviders(bundle: ConfigBundle): Providers;
  createHarnesses(bundle: ConfigBundle): Harnesses;
  createController(
    bundle: ConfigBundle,
    providers: Providers,
    harnesses: Harnesses,
    runtime: StartupRuntime,
  ): Controller;
  validateConfig?: (bundle: ConfigBundle) => Promise<void>;
  prepareDirectories?: (dataDirectory: string) => Promise<void>;
  loadControllerId?: (dataDirectory: string) => Promise<string>;
  openLocalStore?: (path: string) => LocalStore;
  runCommand?: CommandRunner;
}

export interface StartupRuntime {
  controllerId: string;
  store: LocalStore;
  providerScopes: Partial<Record<ProviderKind, string>>;
}

export interface ReadyDependencies {
  bundle: ConfigBundle;
  providers: Providers;
  harnesses: Harnesses;
  controller: Controller;
  store: LocalStore;
}

const execFile = promisify(execFileCallback);
const defaultCommand: CommandRunner = async (file, args) => {
  const result = await execFile(file, args, { encoding: "utf8", maxBuffer: 1_048_576, shell: false });
  return { stdout: result.stdout, stderr: result.stderr };
};

export async function runPreflight(dependencies: PreflightDependencies): Promise<ReadyDependencies> {
  const bundle = await checked("configuration load failed", dependencies.loadConfig);
  await checked("configuration validation failed", () =>
    (dependencies.validateConfig ?? validateSemantics)(bundle));
  await checked("data directory preflight failed", () =>
    (dependencies.prepareDirectories ?? prepareDirectories)(bundle.controller.runtime.dataDirectory));

  const controllerId = await checked("controller identity load failed", () =>
    (dependencies.loadControllerId ?? loadControllerId)(bundle.controller.runtime.dataDirectory));
  const store = await checked("local execution store open failed", async () =>
    (dependencies.openLocalStore ?? openLocalStore)(join(bundle.controller.runtime.dataDirectory, "execution.sqlite")));
  try {
    const providerScopes = await checked("provider configuration failed", async () =>
      Object.fromEntries((["github", "gitlab"] as const).flatMap((kind) => {
        const config = bundle.controller.providers[kind];
        return config ? [[kind, providerScope(kind, config.apiUrl)]] : [];
      })));
    const providers = await checked("provider configuration failed", async () => dependencies.createProviders(bundle));
    for (const kind of ["github", "gitlab"] as const) {
      if (bundle.controller.providers[kind]) {
        const adapter = providers[kind];
        if (!adapter || adapter.kind !== kind) throw new Error(`${kind} provider configuration failed`);
        await checked(`${kind} REST authentication failed`, () => adapter.verifyAuth());
      }
    }

    const run = dependencies.runCommand ?? defaultCommand;
    for (const [kind, executable] of [["github", "gh"], ["gitlab", "glab"]] as const) {
      const config = bundle.controller.providers[kind];
      if (config) {
        const hostname = providerHostname(kind, config.apiUrl);
        await checked(
          `${kind} agent authentication failed`,
          () => run(executable, ["auth", "status", "--hostname", hostname]),
        );
      }
    }
    await checked("git executable preflight failed", () => run("git", ["--version"]));
    await checked("apm executable preflight failed", () => run("apm", ["--version"]));

    const harnesses = await checked("harness configuration failed", async () => dependencies.createHarnesses(bundle));
    const targets = new Set(Object.values(bundle.catalog.agents).map((agent) => agent.target));
    for (const target of [...targets].sort()) {
      const harness = harnesses[target];
      if (!harness || harness.target !== target) throw new Error(`${target} harness configuration failed`);
      await checked(`${target} harness preflight failed`, () => harness.preflight());
    }

    const controller = await checked(
      "controller configuration failed",
      async () => dependencies.createController(bundle, providers, harnesses, {
        controllerId,
        store,
        providerScopes,
      }),
    );
    await checked("controller bootstrap failed", () => controller.bootstrap());
    return { bundle, providers, harnesses, controller, store };
  } catch (error) {
    try {
      store.close();
    } catch {
      // Preserve the startup failure that caused cleanup.
    }
    throw error;
  }
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
