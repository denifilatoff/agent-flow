import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { ConfigValidationError, parseYaml, validateDocument } from "./schema-validator.ts";
import { normalizeConfigurationSource } from "./repository.ts";
import type { ExecutionSnapshot, HarnessTarget, RuntimeConfig } from "./types.ts";
import type { CatalogHarnesses } from "./semantic.ts";

export const RUNTIME_CONFIG_PATH = "/etc/agent-flow/runtime.yaml";

export interface RuntimeGeneration {
  config: RuntimeConfig;
  runtimeDigest: string;
}

export interface RuntimeStatus {
  runtimeDigest: string;
  validationErrors: string[];
  restartRequired: boolean;
  restartReason: string | null;
  changedRestartFields: string[];
  activeAttempts: number;
  safeToRestart: boolean;
}

const restartFields = [
  ["configuration.repository"], ["configuration.revision"], ["configuration.stack"],
  ["provider.type"], ["provider.apiUrl"], ["provider.repositories"], ["provider.tokenFile"],
  ["execution.harnesses"], ["runtime.dataDirectory"], ["runtime.http.address"], ["runtime.http.port"],
  ["runtime.http.authFile"],
] as const;

export class RuntimeManager {
  private readonly path: string;
  private generation: RuntimeGeneration;
  private activeAttempts = 0;
  private validationErrors: string[] = [];
  private changedRestartFields: string[] = [];
  private readonly catalogHarnesses = new Map<string, Set<HarnessTarget>>();
  private reloadTail: Promise<void> = Promise.resolve();

  private constructor(path: string, initial: RuntimeGeneration) {
    this.path = path;
    this.generation = initial;
  }

  static async create(path = RUNTIME_CONFIG_PATH): Promise<RuntimeManager> {
    return new RuntimeManager(path, await loadRuntimeConfig(path));
  }

  effective(): RuntimeConfig {
    return this.generation.config;
  }

  bindCatalog(catalog: CatalogHarnesses): void {
    const combined = new Map([...this.catalogHarnesses].map(([agentId, targets]) => [agentId, new Set(targets)]));
    for (const [agentId, targets] of Object.entries(catalog)) {
      const existing = combined.get(agentId);
      combined.set(agentId, new Set(existing ? targets.filter((target) => existing.has(target)) : targets));
    }
    validateRuntimeBindings(this.generation.config, combined);
    this.catalogHarnesses.clear();
    for (const [agentId, targets] of combined) this.catalogHarnesses.set(agentId, targets);
  }

  async reload(): Promise<void> {
    const reload = this.reloadTail.then(() => this.reloadOnce());
    this.reloadTail = reload.catch(() => undefined);
    return reload;
  }

  private async reloadOnce(): Promise<void> {
    let candidate: RuntimeGeneration;
    try {
      candidate = await loadRuntimeConfig(this.path);
      if (this.catalogHarnesses.size > 0) validateRuntimeBindings(candidate.config, this.catalogHarnesses);
    } catch (error) {
      this.validationErrors = [boundedError(error)];
      this.changedRestartFields = [];
      return;
    }
    const changed = restartFields
      .map(([path]) => path)
      .filter((path) => !isDeepStrictEqual(valueAt(this.generation.config, path), valueAt(candidate.config, path)));
    this.validationErrors = [];
    this.changedRestartFields = changed;
    if (changed.length === 0) this.generation = candidate;
  }

  mayStartWork(): boolean {
    return this.validationErrors.length === 0 && this.changedRestartFields.length === 0;
  }

  attemptStarted(): void {
    this.activeAttempts += 1;
  }

  attemptFinished(): void {
    if (this.activeAttempts < 1) throw new Error("active attempt count underflow");
    this.activeAttempts -= 1;
  }

  status(): RuntimeStatus {
    const restartRequired = !this.mayStartWork();
    return {
      runtimeDigest: this.generation.runtimeDigest,
      validationErrors: [...this.validationErrors],
      restartRequired,
      restartReason: this.validationErrors.length > 0
        ? "runtime configuration is invalid"
        : this.changedRestartFields.length > 0
          ? "runtime configuration changes require restart"
          : null,
      changedRestartFields: [...this.changedRestartFields],
      activeAttempts: this.activeAttempts,
      safeToRestart: restartRequired && this.activeAttempts === 0,
    };
  }

  async execution(agentId: string): Promise<{ runtimeDigest: string; executionSnapshot: ExecutionSnapshot }> {
    await this.reload();
    if (!this.mayStartWork()) throw new Error("runtime configuration requires operator action");
    const executionSnapshot = this.generation.config.execution.agents[agentId];
    if (!executionSnapshot) throw new Error(`runtime execution binding is missing for agent ${agentId}`);
    return { runtimeDigest: this.generation.runtimeDigest, executionSnapshot: structuredClone(executionSnapshot) };
  }
}

export async function loadRuntimeConfig(path = RUNTIME_CONFIG_PATH): Promise<RuntimeGeneration> {
  const config = validateDocument<RuntimeConfig>("RuntimeConfig", await parseYaml(path));
  validateRuntimeBindings(config);
  return { config, runtimeDigest: runtimeDigest(config) };
}

export function runtimeDigest(config: RuntimeConfig): string {
  return createHash("sha256").update(JSON.stringify(normalize(config))).digest("hex");
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalize(child)]));
  }
  return value;
}

function valueAt(config: RuntimeConfig, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) =>
    value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, config);
}

function boundedError(error: unknown): string {
  if (error instanceof ConfigValidationError) return error.message.slice(0, 256);
  if (error instanceof RuntimeBindingError) return error.message;
  return "runtime configuration could not be parsed";
}

class RuntimeBindingError extends Error {}

function validateRuntimeBindings(config: RuntimeConfig, expected?: ReadonlyMap<string, ReadonlySet<HarnessTarget>>): void {
  try {
    normalizeConfigurationSource(config.configuration.repository);
    const apiUrl = new URL(config.provider.apiUrl);
    if (apiUrl.protocol !== "https:" || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
      throw new Error();
    }
  } catch {
    throw new RuntimeBindingError("runtime URL contains credentials or unsupported components");
  }
  const harnesses = new Set(Object.keys(config.execution.harnesses));
  for (const [agentId, execution] of Object.entries(config.execution.agents)) {
    if (!harnesses.has(execution.harness)) {
      throw new RuntimeBindingError(`runtime harness binding is missing for agent ${agentId}`);
    }
  }
  if (expected && [...expected.keys()].some((agentId) => !config.execution.agents[agentId])) {
    throw new RuntimeBindingError("runtime agent bindings do not match the pinned catalog");
  }
  for (const [agentId, targets] of expected ?? []) {
    const selected = config.execution.agents[agentId]?.harness;
    if (selected && !targets.has(selected)) {
      throw new RuntimeBindingError(`runtime harness ${selected} is not supported by agent ${agentId}`);
    }
  }
}

export async function readSecretFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 65_536) {
      throw new Error("secret file must be a non-empty regular file no larger than 65536 bytes");
    }
    const value = (await handle.readFile("utf8")).trim();
    if (!value || /[\0\r\n]/.test(value)) throw new Error("secret file must contain one non-empty value");
    return value;
  } finally {
    await handle.close();
  }
}
