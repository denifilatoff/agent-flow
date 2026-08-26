import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ConfigBundle } from "./config/load.ts";
import {
  loadPinnedConfig,
  normalizeConfigurationSource,
  prepareConfigurationRepository,
} from "./config/repository.ts";
import { validateSemantics } from "./config/semantic.ts";
import { createClaudeAdapter } from "./harness/claude.ts";
import { createCodexAdapter } from "./harness/codex.ts";
import type { ProcessDependencies } from "./harness/process.ts";
import type { HarnessAdapter } from "./harness/types.ts";
import { createHealthServer, createReadiness } from "./health.ts";
import { createGitHubAdapter } from "./provider/github.ts";
import { createGitLabAdapter } from "./provider/gitlab.ts";
import { createRateLimitedHttpClient } from "./provider/http.ts";
import type { ProviderAdapter, ProviderKind } from "./provider/types.ts";
import { runPreflight, type PreflightDependencies, type ReadyDependencies } from "./preflight.ts";
import { createAttemptRunner, type AttemptRunnerDependencies } from "./runtime/attempt-runner.ts";
import { createControlWriter, type ControlWriter } from "./runtime/control-state.ts";
import { createController, type Controller } from "./runtime/controller.ts";
import { RateLimiter, type RateLimiterClock } from "./runtime/rate-limiter.ts";
import { reconcileTicket, type AttemptLauncher } from "./runtime/reconcile.ts";
import { WorkspaceManager } from "./runtime/workspaces.ts";

type Providers = Partial<Record<ProviderKind, ProviderAdapter>>;
type Harnesses = Partial<Record<"claude" | "codex", HarnessAdapter>>;
type AttemptRunnerOverrides = Partial<Pick<AttemptRunnerDependencies,
  "workspaceManager" | "createSession" | "compileAgent" | "verifyReceipt" | "delay" | "now" | "newId"
>>;

export interface ProductionOverrides {
  harnessProcesses?: Partial<ProcessDependencies>;
  attemptRunner?: AttemptRunnerOverrides;
}

interface SignalSource {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface MainDependencies {
  createHealthServer: typeof createHealthServer;
  createPreflightDependencies(environment: NodeJS.ProcessEnv, healthPort: number): PreflightDependencies;
  runPreflight(dependencies: PreflightDependencies): Promise<ReadyDependencies>;
  signals: SignalSource;
  reportError(message: string): void;
}

const DEFAULT_MAIN_DEPENDENCIES: MainDependencies = {
  createHealthServer,
  createPreflightDependencies: createProductionDependencies,
  runPreflight,
  signals: process,
  reportError: (message) => console.error(message),
};

export async function main(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: MainDependencies = DEFAULT_MAIN_DEPENDENCIES,
): Promise<number> {
  let port: number;
  try {
    port = positiveInteger(environment.AGENT_FLOW_HEALTH_PORT ?? "8080", "health port");
  } catch {
    dependencies.reportError("agent-flow startup failed: invalid health port");
    return 1;
  }
  const readiness = createReadiness();
  const server = dependencies.createHealthServer(port, readiness);
  try {
    await listening(server);
  } catch {
    dependencies.reportError("agent-flow startup failed: health server failed");
    return 1;
  }

  const abort = new AbortController();
  const stop = () => abort.abort();
  dependencies.signals.once("SIGINT", stop);
  dependencies.signals.once("SIGTERM", stop);
  let exitCode = 0;
  let ready: ReadyDependencies | undefined;
  try {
    try {
      ready = await dependencies.runPreflight(dependencies.createPreflightDependencies(environment, port));
    } catch (error) {
      dependencies.reportError(`agent-flow startup failed: ${boundedMessage(error)}`);
      exitCode = 1;
    }
    if (ready) {
      if (!abort.signal.aborted) readiness.markReady();
      try {
        await ready.controller.run(abort.signal);
      } catch {
        dependencies.reportError("agent-flow runtime failed");
        exitCode = 1;
      }
    }
  } finally {
    readiness.markNotReady();
    dependencies.signals.removeListener("SIGINT", stop);
    dependencies.signals.removeListener("SIGTERM", stop);
    try {
      await close(server);
    } catch {
      dependencies.reportError("agent-flow health server shutdown failed");
      exitCode = 1;
    }
  }
  return exitCode;
}

export function createProductionDependencies(
  environment: NodeJS.ProcessEnv,
  healthPort: number,
  rateLimiterClock?: RateLimiterClock,
  overrides: ProductionOverrides = {},
) {
  const configSource = normalizeConfigurationSource(environment.AGENT_FLOW_CONFIG_REPOSITORY ?? "/config");
  const dataDirectory = resolve(environment.AGENT_FLOW_DATA_DIRECTORY ?? "/data");
  const controllerPath = environment.AGENT_FLOW_CONTROLLER_CONFIG ?? "config/controller.example.yaml";
  const requestedRevision = environment.AGENT_FLOW_CONFIG_REVISION;
  let current: ConfigBundle | undefined;
  let prepared: ReturnType<typeof prepareConfigurationRepository> | undefined;
  const pinned = new Map<string, ConfigBundle>();

  const load = async (revision?: string): Promise<ConfigBundle> => {
    const cached = revision ? pinned.get(revision.toLowerCase()) : undefined;
    if (cached) return cached;
    prepared ??= prepareConfigurationRepository(configSource, dataDirectory);
    const { repository } = await prepared;
    const bundle = await loadPinnedConfig(repository, dataDirectory, revision, controllerPath);
    pinned.set(bundle.revision, bundle);
    return bundle;
  };

  return {
    async loadConfig() {
      if (current) return current;
      const candidate = await load(requestedRevision);
      if (normalizeConfigurationSource(candidate.controller.configuration.repository) !== configSource
        || resolve(candidate.controller.runtime.dataDirectory) !== dataDirectory
        || candidate.controller.runtime.healthPort !== healthPort) {
        pinned.delete(candidate.revision);
        throw new Error("runtime paths do not match startup configuration");
      }
      current = candidate;
      return current;
    },
    createProviders(bundle: ConfigBundle): Providers {
      const providers: Providers = {};
      for (const kind of ["github", "gitlab"] as const) {
        const config = bundle.controller.providers[kind];
        if (!config) continue;
        const limiter = new RateLimiter(bundle.controller.polling, rateLimiterClock);
        const client = createRateLimitedHttpClient(
          new URL(config.apiUrl),
          () => ({ authorization: `Bearer ${requiredEnvironment(environment, config.tokenEnv)}` }),
          limiter,
        );
        providers[kind] = kind === "github"
          ? createGitHubAdapter(config, client)
          : createGitLabAdapter(config, client);
      }
      return providers;
    },
    createHarnesses(): Harnesses {
      const home = requiredEnvironment(environment, "HOME");
      const codexRoot = environment.CODEX_HOME ?? join(home, ".codex");
      const claudeRoot = environment.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
      const codexConfig = join(codexRoot, "config.toml");
      const claudeSettings = join(claudeRoot, "settings.json");
      return {
        codex: createCodexAdapter({
          authFile: join(codexRoot, "auth.json"),
          ...(existsSync(codexConfig) ? { configFile: codexConfig } : {}),
        }, overrides.harnessProcesses),
        claude: createClaudeAdapter({
          credentialsFile: join(claudeRoot, ".credentials.json"),
          ...(existsSync(claudeSettings) ? { settingsFile: claudeSettings } : {}),
        }, overrides.harnessProcesses),
      };
    },
    createController(bundle: ConfigBundle, providers: Providers, harnesses: Harnesses): Controller {
      return composeController(bundle, providers, harnesses, load, dataDirectory, environment, overrides);
    },
  };
}

function composeController(
  bundle: ConfigBundle,
  providers: Providers,
  harnesses: Harnesses,
  loadPinned: (revision?: string) => Promise<ConfigBundle>,
  dataDirectory: string,
  environment: NodeJS.ProcessEnv,
  overrides: ProductionOverrides,
): Controller {
  const { workspaceManager = new WorkspaceManager(dataDirectory), ...attemptRunnerOverrides } =
    overrides.attemptRunner ?? {};
  const writers: Partial<Record<ProviderKind, ControlWriter>> = {};
  const runners: Partial<Record<ProviderKind, AttemptLauncher>> = {};

  for (const kind of ["github", "gitlab"] as const) {
    const provider = providers[kind];
    if (!provider) continue;
    const writeControl = createControlWriter(provider);
    writers[kind] = writeControl;
    runners[kind] = createAttemptRunner({
      ...attemptRunnerOverrides,
      dataDirectory,
      provider,
      providerCredential: (name, apiUrl) => ({
        provider: kind,
        name,
        value: requiredEnvironment(environment, name),
        apiUrl,
      }),
      workspaceManager,
      harnesses,
      writeControl,
    });
  }

  const launcher: AttemptLauncher = {
    start: (request) => requiredRunner(runners, request.ref.provider).start(request),
    async cancel(flowInstanceId) {
      await Promise.all(Object.values(runners).map((runner) => runner.cancel(flowInstanceId)));
    },
    isRunning: (flowInstanceId) => Object.values(runners).some((runner) => runner.isRunning(flowInstanceId)),
  };

  return createController({
    providers: (["github", "gitlab"] as const).flatMap((kind) => {
      const adapter = providers[kind];
      const repositories = bundle.controller.providers[kind]?.repositories;
      return adapter && repositories ? [{ adapter, repositories }] : [];
    }),
    concurrency: bundle.controller.runtime.concurrency,
    pollingIntervalSeconds: bundle.controller.polling.intervalSeconds,
    launcher,
    reconcile: (ref) => {
      const provider = providers[ref.provider];
      const writeControl = writers[ref.provider];
      if (!provider || !writeControl) throw new Error("ticket provider is not configured");
      return reconcileTicket({
        provider,
        launcher: requiredRunner(runners, ref.provider),
        writeControl,
        config: {
          loadCurrent: async () => bundle,
          loadPinned: async (revision) => {
            const pinned = await loadPinned(revision);
            await validateSemantics(pinned);
            return pinned;
          },
        },
      }, ref);
    },
    onError: () => console.error("agent-flow reconciliation failed"),
  });
}

function requiredRunner(
  runners: Partial<Record<ProviderKind, AttemptLauncher>>,
  kind: ProviderKind,
): AttemptLauncher {
  const runner = runners[kind];
  if (!runner) throw new Error("ticket provider is not configured");
  return runner;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`required environment variable is missing: ${name}`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return Number(value);
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "preflight failed";
  return message.replace(/[\r\n]+/g, " ").slice(0, 256);
}

function listening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise<void>((resolveListening, reject) => {
    const ready = () => {
      server.removeListener("error", failed);
      resolveListening();
    };
    const failed = (error: Error) => {
      server.removeListener("listening", ready);
      reject(error);
    };
    server.once("listening", ready);
    server.once("error", failed);
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
