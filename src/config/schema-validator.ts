import { readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as formatsPlugin from "ajv-formats";
import { parse } from "yaml";

import type { SchemaKind } from "./types.js";

type JsonSchema = Record<string, unknown>;

const schemaFiles = [
  "agent-catalog.schema.json",
  "agent-decision.schema.json",
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
  AgentDecision: "https://agent-flow.dev/schemas/v1/agent-decision.schema.json",
  AgentReceipt: "https://agent-flow.dev/schemas/v1/agent-receipt.schema.json",
};

export type DocumentValidator = <T>(kind: SchemaKind, value: unknown) => T;

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

function compileValidators(schemas: JsonSchema[]): Record<SchemaKind, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  const addFormats = formatsPlugin.default as unknown as (instance: Ajv2020) => void;
  addFormats(ajv);
  for (const schema of schemas) ajv.addSchema(schema);

  return Object.fromEntries(Object.entries(schemaIds).map(([kind, id]) => {
    const validator = ajv.getSchema(id);
    if (!validator) throw new Error(`${kind} schema must declare $id ${id}`);
    return [kind, validator];
  })) as Record<SchemaKind, ValidateFunction>;
}

function validateWith<T>(validators: Record<SchemaKind, ValidateFunction>, kind: SchemaKind, value: unknown): T {
  const validator = validators[kind];
  if (!validator(value)) {
    throw new ConfigValidationError(kind, validator.errors?.[0]);
  }
  return value as T;
}

const defaultValidators = compileValidators(schemaFiles.map((file) =>
  JSON.parse(readFileSync(new URL(`../../schemas/v1/${file}`, import.meta.url), "utf8")) as JsonSchema
));

export function validateDocument<T>(kind: SchemaKind, value: unknown): T {
  return validateWith(defaultValidators, kind, value);
}

export async function createDocumentValidator(schemaDirectory: string): Promise<DocumentValidator> {
  const canonicalDirectory = await realpath(schemaDirectory);
  const schemas: JsonSchema[] = [];
  for (const file of schemaFiles) {
    let schemaPath: string;
    try {
      schemaPath = await realpath(join(canonicalDirectory, file));
    } catch (error) {
      throw new Error(`pinned schema ${file} could not be read`, { cause: error });
    }
    const child = relative(canonicalDirectory, schemaPath);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error(`pinned schema ${file} escapes the pinned root`);
    }

    let source: string;
    try {
      source = await readFile(schemaPath, "utf8");
    } catch (error) {
      throw new Error(`pinned schema ${file} could not be read`, { cause: error });
    }
    try {
      schemas.push(JSON.parse(source) as JsonSchema);
    } catch (error) {
      throw new Error(`pinned schema ${file} contains invalid JSON`, { cause: error });
    }
  }

  let validators: Record<SchemaKind, ValidateFunction>;
  try {
    validators = compileValidators(schemas);
  } catch (error) {
    throw new Error("pinned schemas could not be compiled", { cause: error });
  }
  return <T>(kind: SchemaKind, value: unknown): T => validateWith(validators, kind, value);
}
