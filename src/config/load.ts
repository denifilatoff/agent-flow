import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { createDocumentValidator, parseYaml, validateDocument, type DocumentValidator } from "./schema-validator.ts";
import type { AgentCatalog, FlowDefinition, SchemaKind, StackDefinition } from "./types.js";

export interface ConfigBundle {
  revision: string;
  root: string;
  stack: StackDefinition;
  flow: FlowDefinition;
  catalog: AgentCatalog;
}

const bundleValidators = new WeakMap<ConfigBundle, DocumentValidator>();
const requiredContracts = [
  "schemas/v1/agent-decision.schema.json",
  "schemas/v1/agent-receipt.schema.json",
  "schemas/v1/control-state.schema.json",
] as const;
const requiredSchemas = [
  "schemas/v1/stack.schema.json",
  "schemas/v1/flow.schema.json",
  "schemas/v1/agent-catalog.schema.json",
  ...requiredContracts,
] as const;

export function validateBundleDocument<T>(bundle: ConfigBundle, kind: SchemaKind, value: unknown): T {
  return (bundleValidators.get(bundle) ?? validateDocument)<T>(kind, value);
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function pinnedFile(root: string, path: string): Promise<string> {
  const candidate = resolve(root, path);
  if (!isInside(root, candidate)) {
    throw new Error(`configuration path ${path} escapes the pinned root`);
  }

  const canonical = await realpath(candidate);
  if (!isInside(root, canonical)) {
    throw new Error(`configuration path ${path} escapes the pinned root`);
  }
  return canonical;
}

export async function loadConfigBundle(root: string, stackPath: string, revision: string): Promise<ConfigBundle> {
  const canonicalRoot = await realpath(resolve(root));
  const stack = validateDocument<StackDefinition>(
    "Stack",
    await parseYaml(await pinnedFile(canonicalRoot, stackPath)),
  );
  for (const path of requiredContracts) {
    if (!stack.spec.contracts.includes(path)) throw new Error(`stack contract ${path} is required`);
  }
  for (const path of requiredSchemas) {
    if (!stack.spec.schemas.includes(path)) throw new Error(`stack schema ${path} is required`);
  }
  for (const contract of stack.spec.contracts) {
    if (!stack.spec.schemas.includes(contract)) throw new Error(`stack contract ${contract} is not included in schemas`);
  }
  for (const path of [...stack.spec.contracts, ...stack.spec.schemas]) await pinnedFile(canonicalRoot, path);
  const validatePinnedDocument = await createDocumentValidator(
    await pinnedFile(canonicalRoot, "schemas/v1"),
    stack.spec.schemas.map((path) => path.slice("schemas/v1/".length)),
  );
  validatePinnedDocument<StackDefinition>("Stack", stack);
  const flow = validatePinnedDocument<FlowDefinition>(
    "Flow",
    await parseYaml(await pinnedFile(canonicalRoot, stack.spec.flow)),
  );
  const catalog = validatePinnedDocument<AgentCatalog>(
    "AgentCatalog",
    await parseYaml(await pinnedFile(canonicalRoot, stack.spec.catalog)),
  );

  const bundle = { revision, root: canonicalRoot, stack, flow, catalog };
  bundleValidators.set(bundle, validatePinnedDocument);
  return bundle;
}
