import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { createDocumentValidator, parseYaml } from "./schema-validator.ts";
import type { AgentCatalog, ControllerConfig, FlowDefinition } from "./types.js";

export interface ConfigBundle {
  revision: string;
  root: string;
  controller: ControllerConfig;
  flow: FlowDefinition;
  catalog: AgentCatalog;
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

export async function loadConfigBundle(root: string, controllerPath: string, revision: string): Promise<ConfigBundle> {
  const canonicalRoot = await realpath(resolve(root));
  const validatePinnedDocument = await createDocumentValidator(await pinnedFile(canonicalRoot, "schemas/v1"));
  const controller = validatePinnedDocument<ControllerConfig>(
    "ControllerConfig",
    await parseYaml(await pinnedFile(canonicalRoot, controllerPath)),
  );
  const flow = validatePinnedDocument<FlowDefinition>(
    "Flow",
    await parseYaml(await pinnedFile(canonicalRoot, controller.configuration.flow)),
  );
  const catalog = validatePinnedDocument<AgentCatalog>(
    "AgentCatalog",
    await parseYaml(await pinnedFile(canonicalRoot, controller.configuration.catalog)),
  );

  return { revision, root: canonicalRoot, controller, flow, catalog };
}
