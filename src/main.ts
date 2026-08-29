import type { Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ConfigBundle } from "./config/load.ts";
import {
  loadPinnedConfig,
  normalizeConfigurationSource,
  prepareConfigurationRepository,
  configurationGitAuthentication,
  stagePinnedPackage,
} from "./config/repository.ts";
import { validateSemantics } from "./config/semantic.ts";
import { providerTokenEnvironment } from "./config/provider-credentials.ts";
import { RuntimeManager, readSecretFile } from "./config/runtime.ts";
import { createClaudeAdapter } from "./harness/claude.ts";
import { createCodexAdapter } from "./harness/codex.ts";
import type { ProcessDependencies } from "./harness/process.ts";
import type { HarnessAdapter } from "./harness/types.ts";
import { createHealthServer, createOperationalStatus } from "./health.ts";
import { createGitHubAdapter } from "./provider/github.ts";
import { createGitLabAdapter } from "./provider/gitlab.ts";
import { createRateLimitedHttpClient } from "./provider/http.ts";
import { listControlComments } from "./provider/control-comment.ts";
import type { ProviderAdapter, ProviderKind } from "./provider/types.ts";
import { createStartupRedactor } from "./redaction.ts";
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
  "workspaceManager" | "createSession" | "compileAgent" | "verifyDecision" | "delay" | "now" | "newId"
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
  createRuntime(): Promise<RuntimeManager>;
  createPreflightDependencies(runtime: RuntimeManager): StartupPreflightDependencies;
  readSecretFile(path: string): Promise<string>;
  runPreflight(dependencies: PreflightDependencies): Promise<ReadyDependencies>;
  signals: SignalSource;
  reportError(message: string): void;
}

export interface StartupPreflightDependencies extends PreflightDependencies {
  registerStartupSecret(value: string | Buffer): void;
}

const DEFAULT_MAIN_DEPENDENCIES: MainDependencies = {
  createHealthServer,
  createRuntime: () => RuntimeManager.create(),
  createPreflightDependencies: createProductionDependencies,
  readSecretFile,
  runPreflight,
  signals: process,
  reportError: (message) => console.error(message),
};

export async function main(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: MainDependencies = DEFAULT_MAIN_DEPENDENCIES,
): Promise<number> {
  let runtime: RuntimeManager;
  try {
    runtime = await dependencies.createRuntime();
  } catch {
    dependencies.reportError("agent-flow startup failed: runtime configuration load failed");
    return 1;
  }
  const http = runtime.effective().runtime.http;
  let preflightDependencies: StartupPreflightDependencies;
  let operatorPassword: string;
  try {
    operatorPassword = await dependencies.readSecretFile(http.authFile);
    if (Buffer.byteLength(operatorPassword) > 4_096) throw new Error("operator password is too large");
    preflightDependencies = dependencies.createPreflightDependencies(runtime);
    preflightDependencies.registerStartupSecret(operatorPassword);
  } catch {
    dependencies.reportError("agent-flow startup failed: operator authentication load failed");
    return 1;
  }
  const readiness = createOperationalStatus(runtime);
  const server = dependencies.createHealthServer(http.address, http.port, readiness, operatorPassword);
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
      ready = await dependencies.runPreflight(preflightDependencies);
    } catch (error) {
      dependencies.reportError(`agent-flow startup failed: ${boundedMessage(error)}`);
      exitCode = 1;
    }
    if (ready) {
      readiness.bindReady(ready);
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
  runtime: RuntimeManager,
  rateLimiterClock?: RateLimiterClock,
  overrides: ProductionOverrides = {},
) {
  const configured = runtime.effective();
  const configSource = normalizeConfigurationSource(configured.configuration.repository);
  const dataDirectory = resolve(configured.runtime.dataDirectory);
  const stackPath = configured.configuration.stack;
  const requestedRevision = configured.configuration.revision;
  let current: ConfigBundle | undefined;
  let prepared: ReturnType<typeof prepareConfigurationRepository> | undefined;
  const pinned = new Map<string, ConfigBundle>();
  let loadedCredential: import("./harness/types.ts").ProviderCredential | undefined;
  const startupRedactor = createStartupRedactor();
  const credential = readSecretFile(configured.provider.tokenFile).then((value) => {
    startupRedactor.register(value);
    return {
      provider: configured.provider.type,
      name: providerTokenEnvironment(configured.provider.type, configured.provider.apiUrl),
      value,
      apiUrl: configured.provider.apiUrl,
    };
  });

  const load = async (revision?: string): Promise<ConfigBundle> => {
    const cached = revision ? pinned.get(revision.toLowerCase()) : undefined;
    if (cached) return cached;
    prepared ??= prepareConfigurationRepository(
      configSource,
      dataDirectory,
      configurationGitAuthentication(configSource, await credential),
    );
    const { repository } = await prepared;
    const bundle = await loadPinnedConfig(repository, dataDirectory, revision, stackPath);
    pinned.set(bundle.revision, bundle);
    return bundle;
  };

  return {
    async loadConfig() {
      if (current) return current;
      const candidate = await load(requestedRevision);
      current = candidate;
      return current;
    },
    async createProviders(): Promise<Providers> {
      const providers: Providers = {};
      const kind = configured.provider.type;
      const limiter = new RateLimiter(configured.polling, rateLimiterClock);
      const providerCredential = await credential;
      loadedCredential = providerCredential;
      const client = createRateLimitedHttpClient(
        new URL(configured.provider.apiUrl),
        () => ({ authorization: `Bearer ${providerCredential.value}` }),
        limiter,
        globalThis.fetch,
        async () => {
          await runtime.reload();
          limiter.update(runtime.effective().polling);
        },
      );
      providers[kind] = kind === "github"
        ? createGitHubAdapter(configured.provider, client)
        : createGitLabAdapter(configured.provider, client);
      return providers;
    },
    async providerEnvironment(): Promise<NodeJS.ProcessEnv> {
      const providerCredential = await credential;
      return { PATH: process.env.PATH, [providerCredential.name]: providerCredential.value };
    },
    createHarnesses(): Harnesses {
      return {
        ...(configured.execution.harnesses.codex
          ? { codex: createCodexAdapter(
              { authFile: configured.execution.harnesses.codex.authFile },
              overrides.harnessProcesses,
              startupRedactor.register,
            ) }
          : {}),
        ...(configured.execution.harnesses.claude
          ? { claude: createClaudeAdapter(
              { credentialsFile: configured.execution.harnesses.claude.authFile },
              overrides.harnessProcesses,
              startupRedactor.register,
            ) }
          : {}),
      };
    },
    createController(bundle: ConfigBundle, providers: Providers, harnesses: Harnesses): Controller {
      if (!loadedCredential) throw new Error("provider credential is not loaded");
      return composeController(bundle, providers, harnesses, load, runtime, loadedCredential, overrides);
    },
    redactSessionContent: startupRedactor.redact,
    registerStartupSecret: startupRedactor.register,
    runtime,
  };
}

function composeController(
  bundle: ConfigBundle,
  providers: Providers,
  harnesses: Harnesses,
  loadPinned: (revision?: string) => Promise<ConfigBundle>,
  runtime: RuntimeManager,
  credential: import("./harness/types.ts").ProviderCredential,
  overrides: ProductionOverrides,
): Controller {
  const configured = runtime.effective();
  const dataDirectory = configured.runtime.dataDirectory;
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
      providerConfig: configured.provider,
      providerCredential: credential,
      async preparePinnedAgent(revision, agentId, destination) {
        const pinned = await loadPinned(revision);
        const agent = pinned.catalog.agents[agentId];
        if (!agent) throw new Error("agent is not configured in the pinned catalog");
        const packageDirectory = await stagePinnedPackage(
          pinned.root,
          pinned.revision,
          agent.package,
          destination,
        );
        return { bundle: pinned, packageDirectory };
      },
      execution: (agentId) => runtime.execution(agentId),
      attemptStarted: () => runtime.attemptStarted(),
      attemptFinished: () => runtime.attemptFinished(),
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
    onSettled(listener) {
      for (const runner of Object.values(runners)) runner.onSettled?.(listener);
    },
  };

  return createController({
    providers: [{ adapter: providers[configured.provider.type]!, repositories: configured.provider.repositories }],
    concurrency: configured.runtime.concurrency,
    pollingIntervalSeconds: configured.polling.intervalSeconds,
    async runtimeState() {
      await runtime.reload();
      const effective = runtime.effective();
      return {
        mayStartWork: runtime.mayStartWork(),
        pollingIntervalSeconds: effective.polling.intervalSeconds,
        concurrency: effective.runtime.concurrency,
      };
    },
    async prepareBootstrap(refs) {
      const revisions = new Set<string>([bundle.revision]);
      for (const ref of refs) {
        const provider = providers[ref.provider];
        if (!provider) throw new Error("ticket provider is not configured");
        const snapshot = await provider.readTicket(ref);
        for (const { state } of listControlComments(snapshot.comments)) {
          if (state.stateId !== "done" && state.stateId !== "cancelled") revisions.add(state.configRevision);
        }
      }
      for (const revision of revisions) {
        const pinned = revision === bundle.revision ? bundle : await loadPinned(revision);
        runtime.bindCatalog(await validateSemantics(pinned));
      }
    },
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
            if (revision === bundle.revision) return bundle;
            const pinned = await loadPinned(revision);
            runtime.bindCatalog(await validateSemantics(pinned));
            return pinned;
          },
        },
        isAllowed: (candidate) => candidate.provider === configured.provider.type
          && configured.provider.repositories.includes(candidate.repository),
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
