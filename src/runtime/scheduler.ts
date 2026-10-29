interface SchedulerOptions<T> {
  concurrency: number;
  key(value: T): string;
  run(value: T): Promise<void>;
}

export interface Scheduler<T> {
  schedule(value: T): Promise<void>;
  setConcurrency(concurrency: number): void;
  close(): void;
  drain(): Promise<void>;
  snapshot(): SchedulerSnapshot;
}

export interface SchedulerSnapshot {
  active: number;
  queued: number;
  concurrency: number;
}

interface Entry<T> {
  id: string;
  value: T;
  promise: Promise<void>;
  claimed: boolean;
  started: boolean;
  resolve(): void;
  reject(error: unknown): void;
}

export function createScheduler<T>(options: SchedulerOptions<T>): Scheduler<T> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("scheduler concurrency must be a positive integer");
  }

  const pending: Entry<T>[] = [];
  const keyed = new Map<string, Entry<T>[]>();
  const drained: Array<() => void> = [];
  let active = 0;
  let concurrency = options.concurrency;
  let closed = false;

  return {
    schedule(value): Promise<void> {
      if (closed) return Promise.reject(new Error("scheduler is closed"));
      const id = options.key(value);
      const generations = keyed.get(id) ?? [];
      const latest = generations.at(-1);
      if (latest && !latest.started) return latest.promise;

      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const entry = { id, value, promise, claimed: false, started: false, resolve, reject };
      generations.push(entry);
      keyed.set(id, generations);
      pending.push(entry);
      pump();
      return promise;
    },

    setConcurrency(next): void {
      if (!Number.isInteger(next) || next < 1) throw new Error("scheduler concurrency must be a positive integer");
      concurrency = next;
      pump();
    },

    close(): void {
      if (closed) return;
      closed = true;
      const cancelled = [...keyed.values()].flat().filter((entry) => !entry.started);
      for (const entry of cancelled) {
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
        if (entry.claimed) active -= 1;
        remove(entry);
        entry.reject(new Error("scheduler closed before work started"));
      }
      settleDrain();
    },

    drain(): Promise<void> {
      if (active === 0 && pending.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => drained.push(resolve));
    },

    snapshot(): SchedulerSnapshot {
      return { active, queued: pending.length, concurrency };
    },
  };

  function pump(): void {
    while (active < concurrency) {
      const index = pending.findIndex((entry) => keyed.get(entry.id)?.[0] === entry);
      if (index < 0) return;
      const entry = pending.splice(index, 1)[0]!;
      entry.claimed = true;
      active += 1;
      queueMicrotask(() => start(entry));
    }
  }

  function start(entry: Entry<T>): void {
    if (closed || keyed.get(entry.id)?.[0] !== entry) return;
    entry.started = true;
    let work: Promise<void>;
    try {
      work = options.run(entry.value);
    } catch (error) {
      finish(entry, false, error);
      return;
    }
    void work.then(() => finish(entry, true), (error: unknown) => finish(entry, false, error));
  }

  function finish(entry: Entry<T>, succeeded: boolean, error?: unknown): void {
    active -= 1;
    remove(entry);
    if (!closed) pump();
    settleDrain();
    if (succeeded) entry.resolve();
    else entry.reject(error);
  }

  function remove(entry: Entry<T>): void {
    const generations = keyed.get(entry.id);
    const index = generations?.indexOf(entry) ?? -1;
    if (index >= 0) generations!.splice(index, 1);
    if (generations?.length === 0) keyed.delete(entry.id);
  }

  function settleDrain(): void {
    if (active === 0 && pending.length === 0) drained.splice(0).forEach((resolve) => resolve());
  }
}
