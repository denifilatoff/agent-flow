import { StringDecoder } from "node:string_decoder";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AttemptUsage } from "../config/types.ts";
import { assertSafeDirectory, assertSafeFile } from "../runtime/filesystem.ts";
import { resolveUsageCost } from "./usage-cost.ts";

export interface UsageObserver {
  write(chunk: Buffer): void;
  end(): void;
  usage(): AttemptUsage | undefined;
}

/** Bounds individual records without retaining transcript content. */
export class JsonLines {
  invalid = false;
  private readonly decoder = new StringDecoder("utf8");
  private line = "";
  private dropping = false;
  private readonly record: (value: any) => void;
  private readonly limit: number;
  constructor(record: (value: any) => void, limit = 1_048_576) { this.record = record; this.limit = limit; }
  write(chunk: Buffer): void { this.consume(this.decoder.write(chunk)); }
  end(): void {
    this.consume(this.decoder.end());
    if (!this.dropping && this.line) this.parse(this.line);
    this.line = "";
  }
  private consume(text: string): void {
    for (const part of text.split(/(?<=\n)/)) {
      if (!this.dropping) {
        if (Buffer.byteLength(this.line) + Buffer.byteLength(part) > this.limit) {
          this.line = ""; this.dropping = true; this.invalid = true;
        } else this.line += part;
      }
      if (part.endsWith("\n")) {
        if (!this.dropping) this.parse(this.line);
        this.line = ""; this.dropping = false;
      }
    }
  }
  private parse(line: string): void {
    try { this.record(JSON.parse(line)); } catch { this.invalid = true; }
  }
}

export function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function cost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function sum(values: number[]): number | undefined {
  const total = values.reduce((a, b) => a + b, 0);
  return count(total) ? total : undefined;
}

export class ClaudeUsage implements UsageObserver {
  private latest: AttemptUsage | undefined;
  private readonly messages = new Map<string, AttemptUsage>();
  private readonly lines = new JsonLines((record) => this.record(record));
  write(chunk: Buffer): void { this.lines.write(chunk); }
  end(): void { this.lines.end(); }
  usage(): AttemptUsage | undefined {
    if (!this.latest) {
      const partial: AttemptUsage = {};
      for (const key of ["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"] as const) {
        const values = [...this.messages.values()].flatMap((usage) => usage[key] === undefined ? [] : [usage[key]!]);
        if (values.length) {
          const total = sum(values);
          if (total !== undefined) partial[key] = total;
        }
      }
      return Object.keys(partial).length ? partial : undefined;
    }
    if (!this.lines.invalid) return this.latest;
    const { totalTokens: _total, costUsd: _cost, costSource: _source, ...partial } = this.latest;
    return Object.keys(partial).length ? partial : undefined;
  }
  private record(record: any): void {
    // Assistant records expose reliable input/cache counters before completion. Output may
    // still be a placeholder, and these observations never establish whole-attempt coverage.
    if (record?.type === "assistant" && typeof record.message?.id === "string"
      && record.message.id.length > 0 && record.message.id.length <= 255) {
      const session = typeof record.session_id === "string" && record.session_id.length <= 255 ? record.session_id : null;
      const id = JSON.stringify([session, record.message.id]);
      if (!this.messages.has(id) && this.messages.size < 4096) {
        const partial: AttemptUsage = {};
        for (const [key, field] of [["inputTokens", "input_tokens"], ["cacheReadInputTokens", "cache_read_input_tokens"],
          ["cacheCreationInputTokens", "cache_creation_input_tokens"]] as const) {
          if (count(record.message.usage?.[field])) partial[key] = record.message.usage[field];
        }
        if (Object.keys(partial).length) this.messages.set(id, partial);
      }
    }
    if (this.latest && (record?.type === "assistant" || record?.type === "stream_event")) {
      const { totalTokens: _total, costUsd: _cost, costSource: _source, ...partial } = this.latest;
      this.latest = partial;
    }
    if (record?.type !== "result") return;
    const models = record.modelUsage;
    const usage: AttemptUsage = {};
    if (models && typeof models === "object" && !Array.isArray(models)) {
      const entries = Object.entries(models) as Array<[string, Record<string, unknown>]>;
      const categories = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"] as const;
      if (entries.length && entries.every(([model, v]) => model.length <= 255 && v && categories.every((key) => count(v[key])))) {
        for (const key of categories) {
          const total = sum(entries.map(([, v]) => v[key] as number));
          if (total !== undefined) usage[key] = total;
        }
        if (categories.every((key) => usage[key] !== undefined)) {
          usage.totalTokens = sum(categories.map((key) => usage[key]!));
        }
        if (entries.length === 1) usage.model = entries[0]![0];
      }
    }
    if (cost(record.total_cost_usd)) { usage.costUsd = record.total_cost_usd; usage.costSource = "harness"; }
    // Only a single-model aggregate equal to root usage establishes all pricing dimensions here.
    // Mixed-model native totals remain usable; missing child tier/cache detail prevents estimation.
    const root = record.usage;
    const modelsList = models && typeof models === "object" ? Object.entries(models) as Array<[string, any]> : [];
    if (usage.totalTokens !== undefined && modelsList.length === 1 && root?.service_tier === "standard"
      && root.inference_geo === "" && root.server_tool_use?.web_search_requests === 0
      && root.server_tool_use?.web_fetch_requests === 0
      && root.input_tokens === usage.inputTokens && root.output_tokens === usage.outputTokens
      && root.cache_read_input_tokens === usage.cacheReadInputTokens
      && root.cache_creation_input_tokens === usage.cacheCreationInputTokens) {
      const [model, detail] = modelsList[0]!;
      const cache = root.cache_creation;
      if (cache && count(cache.ephemeral_5m_input_tokens) && count(cache.ephemeral_1h_input_tokens)
        && cache.ephemeral_5m_input_tokens + cache.ephemeral_1h_input_tokens === usage.cacheCreationInputTokens) {
        Object.assign(usage, resolveUsageCost(usage, [{ model, inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens, cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreation5mTokens: cache.ephemeral_5m_input_tokens, cacheCreation1hTokens: cache.ephemeral_1h_input_tokens,
          tier: "standard", geography: "global", contextWindow: detail.contextWindow }]));
      }
    }
    // Never use the root-only result.usage as a whole-tree aggregate.
    if (Object.keys(usage).length) this.latest = usage;
  }
}

export class CodexUsage implements UsageObserver {
  rootId: string | undefined;
  completed = false;
  private readonly lines = new JsonLines((record) => {
    if (record?.type === "thread.started" && typeof record.thread_id === "string") this.rootId ??= record.thread_id;
    if (record?.type === "turn.completed") this.completed = true;
    if (record?.type === "turn.failed") this.completed = false;
  });
  write(chunk: Buffer): void { this.lines.write(chunk); }
  end(): void { this.lines.end(); }
  usage(): AttemptUsage | undefined { return undefined; }
}

interface CodexThread {
  id: string; parent?: string; boundary: number; finished: boolean;
  counters?: Record<string, number>; valid: boolean;
}
const codexCategories = {
  inputTokens: "input_tokens", outputTokens: "output_tokens", cachedInputTokens: "cached_input_tokens",
  cacheCreationInputTokens: "cache_write_input_tokens", reasoningOutputTokens: "reasoning_output_tokens",
} as const;

export async function collectCodexUsage(home: string, decoder: CodexUsage): Promise<AttemptUsage | undefined> {
  if (!decoder.rootId) return undefined;
  const threads = new Map<string, CodexThread>();
  let covered = true; let files = 0; let bytes = 0;
  async function visit(directory: string, depth = 0): Promise<void> {
    if (depth > 5) { covered = false; return; }
    await assertSafeDirectory(home, directory, "usage session directory");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++files > 2048) { covered = false; return; }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) { covered = false; continue; }
      if (entry.isDirectory()) { await visit(path, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      await assertSafeFile(home, path, "usage session file");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const size = (await file.stat()).size; bytes += size;
        if (size > 16_777_216 || bytes > 67_108_864) { covered = false; continue; }
        let thread: CodexThread | undefined;
        const lines = new JsonLines((record) => {
          const p = record?.payload;
          if (!p || typeof p !== "object") return;
          if (!thread && record.type === "session_meta" && typeof p.id === "string") {
            thread = { id: p.id, parent: p.parent_thread_id, boundary: p.subagent_history_start_ordinal ?? -1,
              finished: false, valid: !p.parent_thread_id || p.history_mode === "paginated" };
            if (threads.has(p.id)) { covered = false; thread.valid = false; }
            else threads.set(p.id, thread);
            return;
          }
          if (!thread || record.type !== "event_msg") return;
          if (thread.boundary >= 0 && (!count(record.ordinal) || record.ordinal < thread.boundary)) return;
          if (p.type === "task_started") thread.finished = false;
          if (p.type === "task_complete") thread.finished = true;
          if (p.type !== "token_count" || !p.info) return;
          const counters = p.info.total_token_usage;
          if (!counters || !Object.values(codexCategories).every((key) => count(counters[key]))) {
            thread.valid = false; return;
          }
          if (thread.counters && Object.values(codexCategories).some((key) => counters[key] < thread!.counters![key]!)) {
            thread.valid = false; return;
          }
          thread.counters = counters;
        });
        for await (const chunk of file.createReadStream({ autoClose: false })) lines.write(chunk as Buffer);
        lines.end();
        if (lines.invalid && thread) thread.valid = false;
      } finally { await file.close(); }
    }
  }
  try { await visit(join(home, "sessions")); } catch { covered = false; }
  const included = new Set([decoder.rootId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const thread of threads.values()) if (thread.parent && included.has(thread.parent) && !included.has(thread.id)) {
      included.add(thread.id); changed = true;
    }
  }
  const own = [...included].map((id) => threads.get(id));
  const observed = own.filter((thread): thread is CodexThread => !!thread?.counters);
  if (!observed.length) return undefined;
  const usage: AttemptUsage = {};
  for (const [key, field] of Object.entries(codexCategories)) {
    const total = sum(observed.map((thread) => thread.counters![field]!));
    if (total !== undefined) usage[key as keyof typeof codexCategories] = total;
  }
  if (covered && decoder.completed && own.every((thread) => thread?.valid && thread.finished && thread.counters)) {
    usage.totalTokens = sum([usage.inputTokens!, usage.outputTokens!]);
  }
  return usage;
}
