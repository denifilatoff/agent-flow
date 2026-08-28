import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { parseYaml } from "./schema-validator.ts";
import type { ConfigBundle } from "./load.js";
import type { FlowTransition } from "./types.js";
import { isProviderTokenEnvironmentForApiUrl } from "./provider-credentials.ts";

type FlowGuardName = NonNullable<FlowTransition["guards"]>[number];
type FlowActionName = NonNullable<FlowTransition["actions"]>[number];

export const IMPLEMENTED_GUARDS = new Set<FlowGuardName>([
  "authorized-actor",
  "activation-present",
  "ticket-open",
  "head-matches",
  "receipt-valid",
]);

export const IMPLEMENTED_ACTIONS = new Set<FlowActionName>([
  "record-receipt",
  "remember-resume-state",
  "clear-resume-state",
  "reset-retry-budget",
  "remove-activation-label",
]);

interface SemanticError {
  path: string;
  message: string;
}

export class SemanticConfigError extends Error {
  readonly errors: readonly SemanticError[];

  constructor(errors: SemanticError[]) {
    const sorted = errors.sort((left, right) => {
      if (left.path !== right.path) return left.path < right.path ? -1 : 1;
      if (left.message === right.message) return 0;
      return left.message < right.message ? -1 : 1;
    });
    super(`Configuration semantics are invalid:\n${sorted.map((error) => `${error.path}: ${error.message}`).join("\n")}`);
    this.name = "SemanticConfigError";
    this.errors = sorted;
  }
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function validatePackage(
  bundle: ConfigBundle,
  agentId: string,
  errors: SemanticError[],
): Promise<void> {
  const agent = bundle.catalog.agents[agentId];
  const path = `catalog.agents.${agentId}.package`;
  const candidate = resolve(bundle.root, agent.package);
  if (!isInside(bundle.root, candidate)) {
    errors.push({ path, message: "package path escapes the pinned root" });
    return;
  }

  let packageRoot: string;
  try {
    packageRoot = await realpath(candidate);
  } catch {
    errors.push({ path, message: `package ${agent.package} does not exist` });
    return;
  }
  if (!isInside(bundle.root, packageRoot)) {
    errors.push({ path, message: "package path escapes the pinned root" });
    return;
  }

  let packageEntries;
  try {
    packageEntries = await readdir(packageRoot, { withFileTypes: true });
  } catch {
    errors.push({ path, message: `package ${agent.package} is not a readable directory` });
    return;
  }

  const manifests = packageEntries.filter((entry) => entry.isFile() && entry.name === "apm.yml");
  if (manifests.length !== 1) {
    errors.push({ path, message: "package must contain exactly one apm.yml" });
  } else {
    try {
      const manifest = await parseYaml(resolve(packageRoot, "apm.yml")) as Record<string, unknown>;
      if (!Array.isArray(manifest.targets) || !manifest.targets.includes(agent.target)) {
        errors.push({
          path: `catalog.agents.${agentId}.target`,
          message: `target ${agent.target} does not match the package manifest`,
        });
      }
    } catch {
      errors.push({ path, message: "apm.yml is not valid YAML" });
    }
  }

  if (!await isRegularFile(resolve(packageRoot, "apm.lock.yaml"))) {
    errors.push({ path, message: "apm.lock.yaml is not a committed file" });
  }

  try {
    const entries = await readdir(resolve(packageRoot, ".apm/agents"), { withFileTypes: true });
    const agents = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".agent.md"));
    if (agents.length !== 1) {
      errors.push({ path, message: "package must contain exactly one logical entry agent" });
    }
  } catch {
    errors.push({ path, message: "package must contain exactly one logical entry agent" });
  }
}

export async function validateSemantics(bundle: ConfigBundle): Promise<void> {
  const errors: SemanticError[] = [];
  const states = bundle.flow.spec.states;

  if (!Object.hasOwn(states, bundle.flow.spec.initial)) {
    errors.push({ path: "flow.spec.initial", message: `initial state ${bundle.flow.spec.initial} does not exist` });
  }
  for (const [label, stateId] of Object.entries(bundle.flow.spec.activationRoutes ?? {})) {
    if (!Object.hasOwn(states, stateId)) {
      errors.push({ path: `flow.spec.activationRoutes.${label}`, message: `initial state ${stateId} does not exist` });
    }
  }

  for (const stateId of Object.keys(states).sort()) {
    const state = states[stateId];
    const statePath = `flow.spec.states.${stateId}`;
    const transitions = state.on ?? {};
    const events = Object.keys(transitions).sort();

    if (state.kind === "final" && events.length > 0) {
      errors.push({ path: `${statePath}.on`, message: "final state must not define transitions" });
    } else if (state.kind !== "final" && events.length === 0) {
      errors.push({ path: `${statePath}.on`, message: "non-final state must define at least one transition" });
    }

    if (state.agent && !Object.hasOwn(bundle.catalog.agents, state.agent)) {
      errors.push({ path: `${statePath}.agent`, message: `agent ${state.agent} does not exist` });
    }

    for (const event of events) {
      const transition = transitions[event];
      const transitionPath = `${statePath}.on.${event}`;
      if (transition.target === "$resume") {
        if ((stateId !== "needs-human" && stateId !== "blocked") || state.kind !== "paused") {
          errors.push({
            path: `${transitionPath}.target`,
            message: "$resume is allowed only from needs-human or blocked",
          });
        }
      } else if (!Object.hasOwn(states, transition.target)) {
        errors.push({ path: `${transitionPath}.target`, message: `transition target ${transition.target} does not exist` });
      }

      if (transition.resumeTarget !== undefined) {
        if (transition.target !== "needs-human" && transition.target !== "blocked") {
          errors.push({
            path: `${transitionPath}.resumeTarget`,
            message: "resumeTarget is allowed only for transitions into needs-human or blocked",
          });
        }
        if (!Object.hasOwn(states, transition.resumeTarget)) {
          errors.push({
            path: `${transitionPath}.resumeTarget`,
            message: `resume target ${transition.resumeTarget} does not exist`,
          });
        }
      }

      for (const guard of transition.guards ?? []) {
        if (!IMPLEMENTED_GUARDS.has(guard)) {
          errors.push({ path: `${transitionPath}.guards`, message: `guard ${guard} is not implemented` });
        }
      }
      for (const action of transition.actions ?? []) {
        if (!IMPLEMENTED_ACTIONS.has(action)) {
          errors.push({ path: `${transitionPath}.actions`, message: `action ${action} is not implemented` });
        }
      }
    }
  }

  for (const agentId of Object.keys(bundle.catalog.agents).sort()) {
    await validatePackage(bundle, agentId, errors);
  }

  const repositories = new Map<string, string>();
  for (const provider of (["github", "gitlab"] as const)) {
    const config = bundle.controller.providers[provider];
    if (config && !isProviderTokenEnvironmentForApiUrl(provider, config.tokenEnv, config.apiUrl)) {
      const host = new URL(config.apiUrl).hostname;
      errors.push({
        path: `controller.providers.${provider}.tokenEnv`,
        message: provider === "github"
          ? `token environment ${config.tokenEnv} is not supported for GitHub API host ${host}`
          : `token environment ${config.tokenEnv} is not supported by gitlab CLI`,
      });
    }
    for (const [index, repository] of (config?.repositories ?? []).entries()) {
      const path = `controller.providers.${provider}.repositories.${index}`;
      const previous = repositories.get(repository);
      if (previous) {
        errors.push({ path, message: `repository ${repository} is configured more than once (first at ${previous})` });
      } else {
        repositories.set(repository, path);
      }
    }
  }

  if (errors.length > 0) {
    throw new SemanticConfigError(errors);
  }
}
