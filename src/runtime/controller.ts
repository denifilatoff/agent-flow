import type { ProviderAdapter, TicketRef } from "../provider/types.js";
import { createScheduler } from "./scheduler.ts";
import type { AttemptLauncher, ReconcileOutcome } from "./reconcile.ts";

type DiscoveryAdapter = Pick<ProviderAdapter, "kind" | "bootstrap" | "discover">;

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
  windowStartedAt: string;
  seenTickets: Set<string>;
}

const ticketKey = (ref: TicketRef) => `${ref.provider}:${ref.repository}#${ref.number}`;
const repositoryKey = (scan: RepositoryScan) => `${scan.provider.adapter.kind}:${scan.repository}`;

export function createController(dependencies: ControllerDependencies): Controller {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const interval = (dependencies.pollingIntervalSeconds ?? 300) * 1_000;
  const delay = dependencies.delay ?? abortableDelay;
  const flowInstances = new Set<string>();
  let sweepCursor: string | null = null;
  let sweep: Promise<void> | null = null;
  let stopping = false;

  if (!Number.isFinite(interval) || interval <= 0) {
    throw new Error("polling interval must be positive");
  }

  const tickets = createScheduler<TicketRef>({
    concurrency: dependencies.concurrency,
    key: ticketKey,
    run: async (ref) => {
      const result = await dependencies.reconcile(ref);
      if (result.flowInstanceId) flowInstances.add(result.flowInstanceId);
    },
  });
  const scans = createScheduler<RepositoryScan>({
    concurrency: 1,
    key: repositoryKey,
    run: scanRepository,
  });

  const controller: Controller = {
    async bootstrap(): Promise<void> {
      const startedAt = now();
      const found = new Map<string, TicketRef>();
      for (const provider of dependencies.providers) {
        for (const repository of provider.repositories) {
          for (const ref of await provider.adapter.bootstrap(repository)) {
            assertTicketIdentity(ref, provider.adapter, repository);
            found.set(ticketKey(ref), ref);
          }
        }
      }
      await Promise.all([...found.values()].map((ref) => tickets.schedule(ref)));
      sweepCursor = startedAt;
    },

    async run(signal): Promise<void> {
      try {
        while (!signal.aborted) {
          try {
            await delay(interval, signal);
          } catch (error) {
            if (!signal.aborted) throw error;
          }
          if (signal.aborted) break;
          queueSweep();
        }
      } finally {
        stopping = true;
        scans.close();
        tickets.close();
        await cancelTracked();
        if (sweep) await sweep;
        await scans.drain();
        await tickets.drain();
        await cancelTracked();
      }
    },

    reconcileNow(ref): Promise<void> {
      return tickets.schedule(ref);
    },
  };
  return controller;

  function queueSweep(): void {
    if (sweep) return;
    if (sweepCursor === null) sweepCursor = now();
    const windowStartedAt = sweepCursor;
    const nextCursor = now();
    const seenTickets = new Set<string>();
    const jobs = dependencies.providers.flatMap((provider) => provider.repositories.map((repository) =>
      scans.schedule({ provider, repository, windowStartedAt, seenTickets })));
    sweep = Promise.allSettled(jobs).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") dependencies.onError?.(result.reason);
      }
      if (results.every((result) => result.status === "fulfilled")) sweepCursor = nextCursor;
    }).finally(() => { sweep = null; });
  }

  async function scanRepository(scan: RepositoryScan): Promise<void> {
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
        if (scan.seenTickets.has(id)) continue;
        scan.seenTickets.add(id);
        void tickets.schedule(ref).catch((error: unknown) => dependencies.onError?.(error));
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
  }

  async function cancelTracked(): Promise<void> {
    await Promise.all([...flowInstances]
      .filter((id) => dependencies.launcher.isRunning(id))
      .map((id) => dependencies.launcher.cancel(id)));
  }
}

function assertTicketIdentity(ref: TicketRef, adapter: DiscoveryAdapter, repository: string): void {
  if (ref.provider !== adapter.kind || ref.repository !== repository
    || !Number.isSafeInteger(ref.number) || ref.number < 1) {
    throw new Error("discovered ticket identity does not match its allowlisted repository");
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
