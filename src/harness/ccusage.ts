import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { AttemptUsage } from "../config/types.ts";
import { assertSafeDirectory, assertSafeFile } from "../runtime/filesystem.ts";
import { copyRegularFile, harnessEnvironment, type CommandRunner } from "./process.ts";
import { count, CodexUsage, JsonLines } from "./usage.ts";

interface Counts {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
  totalTokens: number;
  isFallback?: boolean;
  missingPricing?: boolean;
}

interface Session extends Counts {
  sessionId: string;
  costUSD: number;
  models: Record<string, Counts>;
}

const fields = ["inputTokens", "cacheReadTokens", "cacheCreationTokens", "outputTokens", "totalTokens"] as const;
const validAmount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function codexCostErrorCode(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "CCUSAGE_TIMEOUT";
  if (!(error instanceof Error)) return "CCUSAGE_UNAVAILABLE";
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string" && ["EIO", "ENOSPC", "ENOENT", "EACCES", "EROFS"].includes(code)) {
    return "CCUSAGE_IO_FAILED";
  }
  const codes: Record<string, string> = {
    "ccusage model pricing is unavailable": "CCUSAGE_MODEL_UNPRICED",
    "ccusage reported an accounting warning": "CCUSAGE_TOOL_WARNING",
    "ccusage session does not match native cumulative counters": "CCUSAGE_COUNTER_MISMATCH",
    "Codex accounting requires ccusage >=20.0.47 and <21": "CCUSAGE_TOOL_UNSUPPORTED",
    "Codex service tier is unavailable": "CCUSAGE_CONFIG_INVALID",
    "A selected Codex session did not finish": "CCUSAGE_LOGS_INCOMPLETE",
    "A spawned Codex session log is missing": "CCUSAGE_LOGS_INCOMPLETE",
  };
  if (Object.hasOwn(codes, error.message)) return codes[error.message]!;
  if (error.message.startsWith("Codex ")) return "CCUSAGE_LOGS_INVALID";
  if (error.message.startsWith("ccusage ") || error instanceof SyntaxError) return "CCUSAGE_REPORT_INVALID";
  return "CCUSAGE_UNAVAILABLE";
}

function validCounts(value: Counts): boolean {
  return !!value && fields.every((field) => count(value[field]) && value[field] <= 1e12)
    && value.totalTokens === value.inputTokens + value.cacheReadTokens + value.cacheCreationTokens + value.outputTokens
    && (value.reasoningOutputTokens === undefined || (count(value.reasoningOutputTokens)
      && value.reasoningOutputTokens <= value.outputTokens))
    && (value.isFallback === undefined || value.isFallback === false)
    && (value.missingPricing === undefined || value.missingPricing === false);
}

export function decodeCodexCostReport(source: unknown, expected: readonly string[]): AttemptUsage {
  const report = source as { sessions?: Session[]; totals?: Counts & { costUSD: number; unpricedModels?: string[] } };
  if (!report || !Array.isArray(report.sessions) || !report.totals || !expected.length
    || report.sessions.length !== expected.length || !validCounts(report.totals)
    || !validAmount(report.totals.costUSD)
    || (report.totals.unpricedModels !== undefined
      && (!Array.isArray(report.totals.unpricedModels)
        || report.totals.unpricedModels.some((model) => typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model))))) {
    throw new Error("ccusage report is incomplete or unpriced");
  }
  if (report.totals.unpricedModels?.length) throw new Error("ccusage model pricing is unavailable");
  const seen = new Set<string>();
  const models = new Set<string>();
  const sums = Object.fromEntries(fields.map((field) => [field, 0])) as Record<typeof fields[number], number>;
  let cost = 0;
  let reasoning = 0;
  let reasoningComplete = true;
  for (const session of report.sessions) {
    if (!session || !expected.includes(session.sessionId) || seen.has(session.sessionId)
      || !validCounts(session) || !validAmount(session.costUSD) || (session.totalTokens > 0 && session.costUSD === 0) || !session.models
      || typeof session.models !== "object" || Array.isArray(session.models) || !Object.keys(session.models).length) {
      throw new Error("ccusage session coverage or accounting is invalid");
    }
    seen.add(session.sessionId);
    const modelSums = Object.fromEntries(fields.map((field) => [field, 0])) as typeof sums;
    let modelReasoning = 0;
    let modelReasoningComplete = true;
    for (const [model, usage] of Object.entries(session.models)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model) || !validCounts(usage)
        || (usage.totalTokens > 0 && usage.isFallback !== false)) {
        throw new Error("ccusage model pricing is unavailable");
      }
      models.add(model);
      for (const field of fields) modelSums[field] += usage[field];
      if (usage.reasoningOutputTokens === undefined) modelReasoningComplete = false;
      else modelReasoning += usage.reasoningOutputTokens;
    }
    if (fields.some((field) => modelSums[field] !== session[field])) {
      throw new Error("ccusage model totals do not match the session");
    }
    if (session.reasoningOutputTokens === undefined) reasoningComplete = false;
    else {
      if (!modelReasoningComplete || modelReasoning !== session.reasoningOutputTokens) {
        throw new Error("ccusage reasoning totals do not match the session");
      }
      reasoning += session.reasoningOutputTokens;
    }
    for (const field of fields) sums[field] += session[field];
    cost += session.costUSD;
  }
  if (fields.some((field) => sums[field] !== report.totals![field])
    || !validAmount(cost) || Math.abs(cost - report.totals.costUSD) > 1e-8
    || (report.totals.reasoningOutputTokens !== undefined
      && (!reasoningComplete || reasoning !== report.totals.reasoningOutputTokens))) {
    throw new Error("ccusage totals do not match the selected sessions");
  }
  return {
    inputTokens: sums.inputTokens + sums.cacheReadTokens + sums.cacheCreationTokens,
    cachedInputTokens: sums.cacheReadTokens,
    cacheCreationInputTokens: sums.cacheCreationTokens,
    outputTokens: sums.outputTokens,
    ...(report.totals.reasoningOutputTokens !== undefined ? { reasoningOutputTokens: report.totals.reasoningOutputTokens } : {}),
    totalTokens: sums.totalTokens,
    ...(models.size === 1 ? { model: [...models][0] } : {}),
    costUsd: cost,
    costSource: "estimated",
  };
}

interface Log {
  id: string;
  parent?: string;
  agentPath?: string;
  path: string;
  complete: boolean;
  spawned: Set<string>;
  boundary: number;
  counters?: Record<string, number>;
  compactionRecords: Set<string>;
  compacted: Set<string>;
}

async function selectedLogs(home: string, decoder: CodexUsage, signal: AbortSignal): Promise<Log[]> {
  if (!decoder.rootId || !decoder.completed || !decoder.valid) throw new Error("Codex attempt did not finish reliably");
  const logs = new Map<string, Log>();
  let files = 0;
  let bytes = 0;
  async function visit(directory: string, depth = 0): Promise<void> {
    signal.throwIfAborted();
    if (depth > 6) throw new Error("Codex log nesting exceeds the accounting limit");
    await assertSafeDirectory(home, directory, "Codex accounting directory");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++files > 2048 || entry.isSymbolicLink()) throw new Error("Codex accounting files are unsafe");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(path, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      await assertSafeFile(home, path, "Codex accounting log");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let log: Log | undefined;
      let turn: string | undefined;
      const calls = new Set<string>();
      const lines = new JsonLines((record) => {
        const p = record?.payload;
        if (!p || typeof p !== "object") return;
        if (!log && record.type === "session_meta" && typeof p.id === "string") {
          const spawn = p.source?.subagent?.thread_spawn;
          log = { id: p.id, parent: p.parent_thread_id ?? spawn?.parent_thread_id ?? p.forked_from_id,
            agentPath: spawn?.agent_path, path, complete: false, spawned: new Set(),
            boundary: p.subagent_history_start_ordinal ?? -1, compactionRecords: new Set(), compacted: new Set() };
          if (log.boundary !== -1 && !count(log.boundary)) throw new Error("Codex history boundary is invalid");
          if (log.parent && p.history_mode !== "paginated") throw new Error("Codex descendant history is unverified");
          return;
        }
        if (!log) return;
        if (log.boundary >= 0) {
          if (!count(record.ordinal)) throw new Error("Codex history ordinal is missing");
          if (record.ordinal < log.boundary) return;
        }
        if (record.type === "event_msg" && p.type === "token_count" && p.info != null) {
          const total = p.info.total_token_usage;
          const last = p.info.last_token_usage;
          // Codex also reports context occupancy without advancing billable usage.
          const contextObservation = total && last && validNativeCounters(total)
            && ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"]
              .every((key) => last[key] === 0)
            && (last.cache_write_input_tokens === undefined || last.cache_write_input_tokens === 0)
            && count(last.total_tokens) && last.total_tokens > 0
            && ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]
              .every((key) => (total[key] ?? 0) === (log!.counters?.[key] ?? 0));
          const values = [total, last];
          if (!values.some((value) => value != null)
            || values.some((value) => value != null && !(value === last && contextObservation) && !validNativeCounters(value))) {
            throw new Error("Codex usage event contains invalid counters");
          }
          if (total && last && !contextObservation
            && Object.keys(last).some((key) => count(last[key]) && count(total[key]) && last[key] > total[key])) {
            throw new Error("Codex usage delta exceeds cumulative counters");
          }
          if (total) log.counters = total;
        }
        if (record.type === "token_usage_record") {
          const usage = p.usage;
          if (typeof p.response_id !== "string" || !p.response_id.trim() || !usage || !count(usage.input_tokens)
            || !count(usage.output_tokens) || !validNativeCounters({ cached_input_tokens: 0, reasoning_output_tokens: 0,
              total_tokens: usage.input_tokens + usage.output_tokens, ...usage })) {
            throw new Error("Codex compaction usage is invalid");
          }
          if (p.thread_token_usage != null && !validNativeCounters({ cached_input_tokens: 0, reasoning_output_tokens: 0,
            total_tokens: p.thread_token_usage.input_tokens + p.thread_token_usage.output_tokens, ...p.thread_token_usage })) {
            throw new Error("Codex compaction thread counters are invalid");
          }
          if (usage.input_tokens + usage.output_tokens > 0) log.compactionRecords.add(p.response_id.trim());
        }
        if (record.type === "compacted" && typeof p.compaction_response_id === "string") log.compacted.add(p.compaction_response_id.trim());
        if (record.type === "event_msg" && p.type === "task_started") { turn = p.turn_id; log.complete = false; }
        if (record.type === "event_msg" && p.type === "task_complete" && turn && p.turn_id === turn) log.complete = true;
        if (record.type !== "response_item") return;
        if (p.type === "function_call" && (p.name === "spawn_agent" || p.name?.endsWith(".spawn_agent"))) {
          if (typeof p.call_id !== "string" || !p.call_id || calls.has(p.call_id)) throw new Error("Codex spawn identity is invalid");
          calls.add(p.call_id);
        }
        if (p.type === "function_call_output" && calls.has(p.call_id)) {
          let result;
          if (typeof p.output !== "string") throw new Error("Codex spawn result is invalid");
          try { result = JSON.parse(p.output); } catch { throw new Error("Codex spawn result is unverified"); }
          if (typeof result.agent_id === "string") log.spawned.add(result.agent_id);
          else if (typeof result.task_name === "string") log.spawned.add(result.task_name);
          else if (!result.error) throw new Error("Spawned Codex session identity is missing");
          calls.delete(p.call_id);
        }
      }, 16 << 20);
      try {
        const size = (await file.stat()).size;
        bytes += size;
        if (size > 256 << 20 || bytes > 512 << 20) throw new Error("Codex logs exceed the accounting limit");
        for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
          signal.throwIfAborted();
          lines.write(chunk as Buffer);
        }
        lines.end();
        if (lines.invalid || calls.size || !log || logs.has(log.id)) throw new Error("Codex accounting log is invalid");
        logs.set(log.id, log);
      } finally { await file.close(); }
    }
  }
  for (const name of ["sessions", "archived_sessions"]) {
    try { await visit(join(home, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const included = new Set([decoder.rootId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const log of logs.values()) if (log.parent && included.has(log.parent) && !included.has(log.id)) {
      included.add(log.id); changed = true;
    }
  }
  const selected = [...included].map((id) => logs.get(id));
  if (selected.some((log) => !log?.complete)) throw new Error("A selected Codex session did not finish");
  const complete = selected as Log[];
  const identities = new Set(complete.flatMap((log) => [log.id, log.agentPath].filter((id): id is string => !!id)));
  if (complete.some((log) => [...log.spawned].some((id) => !identities.has(id)))
    || [...decoder.spawned].some((id) => !identities.has(id))) {
    throw new Error("A spawned Codex session log is missing");
  }
  return complete;
}

function validNativeCounters(value: Record<string, unknown>): boolean {
  return !!value && ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]
    .every((key) => count(value[key]))
    && Number(value.cached_input_tokens) <= Number(value.input_tokens)
    && Number(value.cached_input_tokens) + Number(value.cache_write_input_tokens ?? 0) <= Number(value.input_tokens)
    && Number(value.reasoning_output_tokens) <= Number(value.output_tokens)
    && value.total_tokens === Number(value.input_tokens) + Number(value.output_tokens)
    && (value.cache_write_input_tokens === undefined || (count(value.cache_write_input_tokens)
      && value.cache_write_input_tokens <= Number(value.input_tokens)));
}

export async function collectCodexCost(home: string, decoder: CodexUsage, run: CommandRunner,
  signal = AbortSignal.timeout(30_000), onObserved?: (usage: AttemptUsage) => void): Promise<AttemptUsage> {
  const logs = await selectedLogs(home, decoder, signal);
  const observed: AttemptUsage = {};
  for (const log of logs) if (log.counters) {
    for (const [key, field] of [["inputTokens", "input_tokens"], ["cachedInputTokens", "cached_input_tokens"],
      ["cacheCreationInputTokens", "cache_write_input_tokens"], ["outputTokens", "output_tokens"],
      ["reasoningOutputTokens", "reasoning_output_tokens"]] as const) {
      if (log.counters[field] !== undefined) observed[key] = (observed[key] ?? 0) + log.counters[field]!;
    }
  }
  for (const [key, value] of Object.entries(observed)) if (!count(value)) delete observed[key as keyof AttemptUsage];
  if (Object.keys(observed).length) onObserved?.(observed);
  const snapshot = await realpath(await mkdtemp(join(tmpdir(), "agent-flow-ccusage-")));
  try {
    await mkdir(join(snapshot, "sessions"), { mode: 0o700 });
    const names = logs.map((log) => basename(log.path, ".jsonl"));
    if (new Set(names).size !== names.length) throw new Error("Codex session filenames conflict");
    for (const log of logs) await copyRegularFile(log.path, join(snapshot, "sessions", basename(log.path)), "Codex accounting snapshot", signal);
    const options = { cwd: snapshot, signal,
      env: harnessEnvironment({ CODEX_HOME: snapshot, HOME: snapshot, NO_COLOR: "1" }) };
    let config: string | undefined;
    try { config = await assertSafeFile(home, join(home, "config.toml"), "Codex tier settings"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (config) {
      const result = await run("python3", ["-I", "-c", [
        "import json, sys, tomllib",
        'with open(sys.argv[1], "rb") as source: value = tomllib.load(source).get("service_tier")',
        'if value is not None and value not in ("standard", "default", "priority", "fast", "flex"): raise SystemExit("Unsupported service tier")',
        "print(json.dumps(value))",
      ].join("\n"), config], options).catch((error: unknown) => {
        if (signal.aborted || codexCostErrorCode(error, signal) === "CCUSAGE_IO_FAILED") throw error;
        throw new Error("Codex service tier is unavailable");
      });
      const tier = JSON.parse(result.stdout);
      if (result.stderr.trim() || (tier !== null && !["standard", "default", "priority", "fast", "flex"].includes(tier))) {
        throw new Error("Codex service tier is unavailable");
      }
      if (tier !== null) await writeFile(join(snapshot, "config.toml"), `service_tier = "${tier}"\n`, { mode: 0o600 });
    }
    const path = join(snapshot, "ccusage.json");
    await writeFile(path, '{"defaults":{"offline":false}}', { mode: 0o600 });
    const version = await run("ccusage", ["--version"], options);
    const match = /^ccusage 20\.(\d+)\.(\d+)$/.exec(version.stdout.trim());
    if (!match || (Number(match[1]) === 0 && Number(match[2]) < 47) || version.stderr.trim()) {
      throw new Error("Codex accounting requires ccusage >=20.0.47 and <21");
    }
    const result = await run("ccusage", ["codex", "session", "--json", "--no-offline", "--config", path], options);
    if (result.stderr.trim()) throw new Error("ccusage reported an accounting warning");
    const report = JSON.parse(result.stdout);
    const usage = decodeCodexCostReport(report, names);
    for (const log of logs) {
      // Remote compaction can bill records outside the ordinary cumulative counters.
      if ([...log.compactionRecords].some((id) => log.compacted.has(id))) continue;
      const counters = log.counters;
      const session: Session = report.sessions.find((item: Session) => item.sessionId === basename(log.path, ".jsonl"));
      if (!counters || session.inputTokens + session.cacheReadTokens + session.cacheCreationTokens !== counters.input_tokens
        || session.cacheReadTokens !== counters.cached_input_tokens
        || session.cacheCreationTokens !== (counters.cache_write_input_tokens ?? 0)
        || session.outputTokens !== counters.output_tokens
        || (session.reasoningOutputTokens !== undefined && session.reasoningOutputTokens !== counters.reasoning_output_tokens)) {
        throw new Error("ccusage session does not match native cumulative counters");
      }
    }
    return { ...usage, costCalculator: version.stdout.trim() };
  } finally { await rm(snapshot, { recursive: true, force: true }); }
}
