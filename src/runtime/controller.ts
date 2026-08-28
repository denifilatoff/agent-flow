import type { ProviderAdapter, TicketRef } from "../provider/types.js";
import { createScheduler, type SchedulerSnapshot } from "./scheduler.ts";
import type { AttemptLauncher, ReconcileOutcome } from "./reconcile.ts";

type DiscoveryAdapter = Pick<ProviderAdapter, "kind" | "bootstrap" | "discover">;
export type ControllerLifecycle = "created" | "bootstrapping" | "ready" | "running" | "failed" | "stopped";

const SNAPSHOT_ERROR_LIMIT = 10;

export interface ControllerProvider {
  adapter: DiscoveryAdapter;
  repositories: readonly string[];
}

export interface ControllerDependencies {
  providers: readonly ControllerProvider[];
  concurrency: number;
  reconcile(ref: TicketRef): Promise<ReconcileOutcome>;
  launcher: Pick<AttemptLauncher, "cancel" | "isRunning" | "onSettled">;
  prepareBootstrap?(refs: readonly TicketRef[]): Promise<void>;
  runtimeState?(): Promise<{ mayStartWork: boolean; pollingIntervalSeconds: number; concurrency: number }>;
  pollingIntervalSeconds?: number;
  now?: () => string;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onError?: (error: unknown) => void;
}

export interface Controller {
  bootstrap(): Promise<void>;
  run(signal: AbortSignal): Promise<void>;
  reconcileNow(ref: TicketRef): Promise<void>;
  snapshot(): ControllerSnapshot;
}

export interface ControllerSnapshot {
  lifecycle: ControllerLifecycle;
  repositories: Array<{ provider: string; repository: string; nextWindowStartedAt: string | null }>;
  tickets: ControllerTicketObservation[];
  queue: SchedulerSnapshot;
  activeWork: TicketRef[];
  errors: string[];
}

export interface ControllerTicketObservation extends TicketRef {
  flowInstanceId: string | null;
  stateId: string | null;
  observedAt: string | null;
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

interface ObservedTicket extends ControllerTicketObservation {
  ref: TicketRef;
}

const ticketKey = (ref: TicketRef) => `${ref.provider}:${ref.repository}#${ref.number}`;
const repositoryKey = (provider: ControllerProvider, repository: string) =>
  `${provider.adapter.kind}:${repository}`;

export function createController(dependencies: ControllerDependencies): Controller {
  const now = dependencies.now ?? (() => new Date().toISOString());
  let interval = (dependencies.pollingIntervalSeconds ?? 300) * 1_000;
  const delay = dependencies.delay ?? abortableDelay;
  const repositories = dependencies.providers.flatMap((provider) => provider.repositories.map((repository) => ({
    provider,
    repository,
    key: repositoryKey(provider, repository),
  })));
  const allowed = new Set(repositories.map(({ key }) => key));
  const cursors = new Map<string, string>();
  const flowInstances = new Set<string>();
  const observedTickets = new Map<string, ObservedTicket>();
  const acceptedObservations = new WeakMap<Promise<void>, ObservedTicket>();
  const activeTickets = new Map<string, TicketRef>();
  const errors: string[] = [];
  let lifecycle: ControllerLifecycle = "created";
  let stopping = false;

  if (!Number.isFinite(interval) || interval <= 0) throw new Error("polling interval must be positive");

  const tickets = createScheduler<ObservedTicket>({
    concurrency: dependencies.concurrency,
    key: ({ ref }) => ticketKey(ref),
    run: async (observation) => {
      const { ref } = observation;
      const id = ticketKey(ref);
      try {
        const result = await dependencies.reconcile(ref);
        observation.flowInstanceId = result.flowInstanceId;
        observation.stateId = result.stateId;
        observation.observedAt = now();
        if (result.flowInstanceId) flowInstances.add(result.flowInstanceId);
        if (result.flowInstanceId && result.stateId !== "done" && result.stateId !== "cancelled") {
          activeTickets.set(id, ref);
        } else {
          removeObservation(id, observation);
          activeTickets.delete(id);
        }
      } catch (error) {
        removeObservation(id, observation);
        throw error;
      }
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
  dependencies.launcher.onSettled?.((ref) => {
    if (!stopping) void scheduleTicket(ref).catch(reportError);
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
      } catch (error) {
        const errors = [error];
        await cleanup(errors);
        lifecycle = "failed";
        throw collectedError(errors, "controller bootstrap failed");
      }

      try {
        await dependencies.prepareBootstrap?.([...found.values()]);
      } catch (error) {
        const errors = [error];
        await cleanup(errors);
        lifecycle = "failed";
        throw collectedError(errors, "controller bootstrap failed");
      }
      const results = await Promise.allSettled([...found.values()].map(scheduleTicket));
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length > 0) {
        await cleanup(errors);
        lifecycle = "failed";
        throw collectedError(errors, "controller bootstrap failed");
      }
      lifecycle = "ready";
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
          let mayStartWork = true;
          if (!signal.aborted && dependencies.runtimeState) {
            const state = await dependencies.runtimeState();
            mayStartWork = state.mayStartWork;
            interval = state.pollingIntervalSeconds * 1_000;
            if (!Number.isFinite(interval) || interval <= 0) throw new Error("polling interval must be positive");
            tickets.setConcurrency(state.concurrency);
          }
          if (!signal.aborted && mayStartWork) queueSweep();
        }
      } catch (error) {
        errors.push(error);
      }

      await cleanup(errors);
      lifecycle = "stopped";
      if (errors.length > 0) throw collectedError(errors, "controller shutdown failed");
    },

    async reconcileNow(ref): Promise<void> {
      if (lifecycle !== "ready" && lifecycle !== "running") {
        throw new Error(`controller reconcileNow requires ready or running (current: ${lifecycle})`);
      }
      assertAllowedRef(ref);
      await scheduleTicket(ref);
    },

    snapshot(): ControllerSnapshot {
      return {
        lifecycle,
        repositories: repositories.map(({ provider, repository, key }) => ({
          provider: provider.adapter.kind,
          repository,
          nextWindowStartedAt: cursors.get(key) ?? null,
        })),
        tickets: [...observedTickets.values()].map(copyObservation),
        queue: tickets.snapshot(),
        activeWork: [...activeTickets.values()].map(copyTicket),
        errors: [...errors],
      };
    },
  };

  function scheduleTicket(ref: TicketRef): Promise<void> {
    const id = ticketKey(ref);
    const observation: ObservedTicket = {
      ref,
      ...copyTicket(ref),
      flowInstanceId: null,
      stateId: null,
      observedAt: null,
    };
    const scheduled = tickets.schedule(observation);
    const accepted = acceptedObservations.get(scheduled) ?? observation;
    acceptedObservations.set(scheduled, accepted);
    observedTickets.set(id, accepted);
    return scheduled.catch((error: unknown) => {
      removeObservation(id, accepted);
      throw error;
    });
  }

  function removeObservation(id: string, observation: ObservedTicket): void {
    if (observedTickets.get(id) === observation) observedTickets.delete(id);
  }

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
    const found = new Map(call.tickets.map((ref) => [ticketKey(ref), ref]));
    for (const ref of activeTickets.values()) {
      if (ref.provider === scan.provider.adapter.kind && ref.repository === scan.repository) {
        found.set(ticketKey(ref), ref);
      }
    }
    await Promise.all([...found.values()].map(scheduleTicket));
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

  async function cleanup(errors: unknown[]): Promise<void> {
    stopping = true;
    scans.close();
    scanCalls.close();
    tickets.close();
    await cancellationPass(errors);
    await settle(scans.drain(), errors);
    await settle(scanCalls.drain(), errors);
    await settle(tickets.drain(), errors);
    await cancellationPass(errors);
  }

  function reportError(error: unknown): void {
    errors.push("controller error");
    if (errors.length > SNAPSHOT_ERROR_LIMIT) errors.shift();
    try {
      dependencies.onError?.(error);
    } catch {
      // Error reporting must not break the polling chain.
    }
  }
}

function copyTicket(ref: TicketRef): TicketRef {
  return { ...ref };
}

function copyObservation(observation: ObservedTicket): ControllerTicketObservation {
  const { ref: _ref, ...copy } = observation;
  return copy;
}

function collectedError(errors: unknown[], message: string): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
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
