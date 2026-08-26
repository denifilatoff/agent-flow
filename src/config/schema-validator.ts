import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as formatsPlugin from "ajv-formats";
import { parse } from "yaml";

import type { SchemaKind } from "./types.js";

type JsonSchema = Record<string, unknown>;

const schemaFiles = [
  "agent-catalog.schema.json",
  "agent-receipt.schema.json",
  "control-state.schema.json",
  "controller-config.schema.json",
  "flow.schema.json",
] as const;

const schemaIds: Record<SchemaKind, string> = {
  Flow: "https://agent-flow.dev/schemas/v1/flow.schema.json",
  AgentCatalog: "https://agent-flow.dev/schemas/v1/agent-catalog.schema.json",
  ControllerConfig: "https://agent-flow.dev/schemas/v1/controller-config.schema.json",
  ControlState: "https://agent-flow.dev/schemas/v1/control-state.schema.json",
  AgentReceipt: "https://agent-flow.dev/schemas/v1/agent-receipt.schema.json",
};

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const addFormats = formatsPlugin.default as unknown as (instance: Ajv2020) => void;
addFormats(ajv);

for (const file of schemaFiles) {
  const schema = JSON.parse(readFileSync(new URL(`../../schemas/v1/${file}`, import.meta.url), "utf8")) as JsonSchema;
  ajv.addSchema(schema);
}

const validators: Record<SchemaKind, ValidateFunction> = Object.fromEntries(
  Object.entries(schemaIds).map(([kind, id]) => [kind, ajv.getSchema(id)!]),
) as Record<SchemaKind, ValidateFunction>;

export class ConfigValidationError extends Error {
  readonly kind: SchemaKind;
  readonly instancePath: string;

  constructor(kind: SchemaKind, error?: ErrorObject) {
    const instancePath = error?.instancePath || "/";
    const message = error?.message || "schema validation failed";
    super(`${kind} validation failed at ${instancePath}: ${message}`);
    this.name = "ConfigValidationError";
    this.kind = kind;
    this.instancePath = instancePath;
  }
}

export async function parseYaml(path: string): Promise<unknown> {
  return parse(await readFile(path, "utf8"));
}

export function validateDocument<T>(kind: SchemaKind, value: unknown): T {
  const validator = validators[kind];
  if (!validator(value)) {
    throw new ConfigValidationError(kind, validator.errors?.[0]);
  }
  return value as T;
}
