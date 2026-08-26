import type { ProviderAdapter, TicketRef } from "../provider/types.js";
import { createScheduler } from "./scheduler.ts";
import type { AttemptLauncher, ReconcileOutcome } from "./reconcile.ts";

type DiscoveryAdapter = Pick<ProviderAdapter, "kind" | "bootstrap" | "discover">;
type Lifecycle = "created" | "bootstrapping" | "ready" | "running" | "failed" | "stopped";

export interface ControllerProvider {
  adapter: DiscoveryAdapter;
  repositories: readonly string[];
}

export interface ControllerDependencies {
  providers: readonly ControllerProvider[];
  concurrency: number;
  reconcile(ref: TicketRef): Promise<ReconcileOutcome>;
  launcher: Pick<AttemptLauncher, "cancel" | "isRunning">;
  pollingIntervalSeconds?: number;
  now?: () => string;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onError?: (error: unknown) => void;
}

export interface Controller {
  bootstrap(): Promise<void>;
  run(signal: AbortSignal): Promise<void>;
  reconcileNow(ref: TicketRef): Promise<void>;
}

interface RepositoryScan {
  provider: ControllerProvider;
  repository: string;
  nextWindowStartedAt: string;
}

interface ScanCall {
  scan: RepositoryScan & { windowStartedAt: string };
  tickets: TicketRef[];
}

const ticketKey = (ref: TicketRef) => `${ref.provider}:${ref.repository}#${ref.number}`;
const repositoryKey = (provider: ControllerProvider, repository: string) =>
  `${provider.adapter.kind}:${repository}`;

export function createController(dependencies: ControllerDependencies): Controller {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const interval = (dependencies.pollingIntervalSeconds ?? 300) * 1_000;
  const delay = dependencies.delay ?? abortableDelay;
  const repositories = dependencies.providers.flatMap((provider) => provider.repositories.map((repository) => ({
    provider,
    repository,
    key: repositoryKey(provider, repository),
  })));
  const allowed = new Set(repositories.map(({ key }) => key));
  const cursors = new Map<string, string>();
  const flowInstances = new Set<string>();
  let lifecycle: Lifecycle = "created";
  let stopping = false;

  if (!Number.isFinite(interval) || interval <= 0) throw new Error("polling interval must be positive");

  const tickets = createScheduler<TicketRef>({
    concurrency: dependencies.concurrency,
    key: ticketKey,
    run: async (ref) => {
      const result = await dependencies.reconcile(ref);
      if (result.flowInstanceId) flowInstances.add(result.flowInstanceId);
    },
  });
  const scanCalls = createScheduler<ScanCall>({
    concurrency: 1,
    key: ({ scan }) => repositoryKey(scan.provider, scan.repository),
    run: discoverRepository,
  });
  const scans = createScheduler<RepositoryScan>({
    concurrency: Math.max(1, repositories.length),
    key: ({ provider, repository }) => repositoryKey(provider, repository),
    run: reconcileRepository,
  });

  return {
    async bootstrap(): Promise<void> {
      if (lifecycle !== "created") throw new Error("controller bootstrap may only run once");
      lifecycle = "bootstrapping";
      const startedAt = now();
      const found = new Map<string, TicketRef>();
      try {
        for (const { provider, repository, key } of repositories) {
          for (const ref of await provider.adapter.bootstrap(repository)) {
            assertTicketIdentity(ref, provider.adapter, repository);
            found.set(ticketKey(ref), ref);
          }
          cursors.set(key, startedAt);
        }
        await Promise.all([...found.values()].map((ref) => tickets.schedule(ref)));
        lifecycle = "ready";
      } catch (error) {
        lifecycle = "failed";
        throw error;
      }
    },

    async run(signal): Promise<void> {
      if (lifecycle === "created" || lifecycle === "bootstrapping" || lifecycle === "failed") {
        throw new Error("controller run requires a successful bootstrap");
      }
      if (lifecycle !== "ready") throw new Error("controller run may only run once");
      lifecycle = "running";
      const errors: unknown[] = [];
      try {
        while (!signal.aborted) {
          try {
            await delay(interval, signal);
          } catch (error) {
            if (!signal.aborted) throw error;
          }
          if (!signal.aborted) queueSweep();
        }
      } catch (error) {
        errors.push(error);
      }

      stopping = true;
      scans.close();
      scanCalls.close();
      tickets.close();
      await cancellationPass(errors);
      await settle(scans.drain(), errors);
      await settle(scanCalls.drain(), errors);
      await settle(tickets.drain(), errors);
      await cancellationPass(errors);
      lifecycle = "stopped";
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "controller shutdown failed");
    },

    async reconcileNow(ref): Promise<void> {
      if (lifecycle === "stopped" || lifecycle === "failed") throw new Error(`controller is ${lifecycle}`);
      assertAllowedRef(ref);
      await tickets.schedule(ref);
    },
  };

  function queueSweep(): void {
    const nextWindowStartedAt = now();
    for (const { provider, repository, key } of repositories) {
      if (!cursors.has(key)) continue;
      void scans.schedule({ provider, repository, nextWindowStartedAt })
        .catch(reportError);
    }
  }

  async function reconcileRepository(scan: RepositoryScan): Promise<void> {
    const key = repositoryKey(scan.provider, scan.repository);
    const windowStartedAt = cursors.get(key);
    if (!windowStartedAt) throw new Error("repository discovery cursor is missing");
    const call: ScanCall = { scan: { ...scan, windowStartedAt }, tickets: [] };
    await scanCalls.schedule(call);
    if (stopping) return;
    await Promise.all(call.tickets.map((ref) => tickets.schedule(ref)));
    cursors.set(key, scan.nextWindowStartedAt);
  }

  async function discoverRepository(call: ScanCall): Promise<void> {
    const { scan } = call;
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await scan.provider.adapter.discover(
        scan.repository,
        { updatedAfter: scan.windowStartedAt, overlapSeconds: 1 },
        cursor,
      );
      if (stopping) return;
      for (const ref of page.tickets) {
        assertTicketIdentity(ref, scan.provider.adapter, scan.repository);
        const id = ticketKey(ref);
        if (!seen.has(id)) {
          seen.add(id);
          call.tickets.push(ref);
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
  }

  function assertAllowedRef(ref: TicketRef): void {
    if (!Number.isSafeInteger(ref.number) || ref.number < 1) throw new Error("invalid ticket identity");
    if (!allowed.has(`${ref.provider}:${ref.repository}`)) {
      throw new Error("ticket repository is not allowlisted");
    }
  }

  async function cancellationPass(errors: unknown[]): Promise<void> {
    for (const id of flowInstances) {
      try {
        if (dependencies.launcher.isRunning(id)) await dependencies.launcher.cancel(id);
      } catch (error) {
        errors.push(error);
      }
    }
  }

  function reportError(error: unknown): void {
    try {
      dependencies.onError?.(error);
    } catch {
      // Error reporting must not break the polling chain.
    }
  }
}

function assertTicketIdentity(ref: TicketRef, adapter: DiscoveryAdapter, repository: string): void {
  if (ref.provider !== adapter.kind || ref.repository !== repository
    || !Number.isSafeInteger(ref.number) || ref.number < 1) {
    throw new Error("discovered ticket identity does not match its allowlisted repository");
  }
}

async function settle(promise: Promise<void>, errors: unknown[]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    errors.push(error);
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
