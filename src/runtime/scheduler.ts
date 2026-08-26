interface SchedulerOptions<T> {
  concurrency: number;
  key(value: T): string;
  run(value: T): Promise<void>;
}

export interface Scheduler<T> {
  schedule(value: T): Promise<void>;
  close(): void;
  drain(): Promise<void>;
}

interface Entry<T> {
  value: T;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

export function createScheduler<T>(options: SchedulerOptions<T>): Scheduler<T> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("scheduler concurrency must be a positive integer");
  }

  const pending: Entry<T>[] = [];
  const keyed = new Map<string, Entry<T>>();
  const drained: Array<() => void> = [];
  let active = 0;
  let closed = false;

  return {
    schedule(value): Promise<void> {
      if (closed) return Promise.reject(new Error("scheduler is closed"));
      const id = options.key(value);
      const existing = keyed.get(id);
      if (existing) return existing.promise;

      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const entry = { value, promise, resolve, reject };
      keyed.set(id, entry);
      pending.push(entry);
      pump();
      return promise;
    },

    close(): void {
      if (closed) return;
      closed = true;
      for (const entry of pending.splice(0)) {
        keyed.delete(options.key(entry.value));
        entry.reject(new Error("scheduler closed before work started"));
      }
      if (active === 0) drained.splice(0).forEach((resolve) => resolve());
    },

    drain(): Promise<void> {
      if (active === 0 && pending.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => drained.push(resolve));
    },
  };

  function pump(): void {
    while (active < options.concurrency && pending.length > 0) {
      const entry = pending.shift()!;
      const id = options.key(entry.value);
      active += 1;
      void Promise.resolve().then(() => options.run(entry.value)).then(() => {
        finish(entry, id);
        entry.resolve();
      }, (error: unknown) => {
        finish(entry, id);
        entry.reject(error);
      });
    }
  }

  function finish(entry: Entry<T>, id: string): void {
    if (keyed.get(id) === entry) {
      active -= 1;
      keyed.delete(id);
      pump();
      if (active === 0 && pending.length === 0) drained.splice(0).forEach((resolve) => resolve());
    }
  }
}
