import assert from "node:assert/strict";
import test from "node:test";

import { parseYaml, validateDocument } from "../../src/config/schema-validator.ts";

test("rejects unknown fields and unsupported versions", async () => {
  const value = await parseYaml("config/flows/development.yaml") as Record<string, unknown>;
  assert.throws(() => validateDocument("Flow", { ...value, extra: true }));
  assert.throws(() => validateDocument("Flow", { ...value, apiVersion: "agent-flow/v1" }));
});

test("accepts every shipped YAML document", async () => {
  validateDocument("Flow", await parseYaml("config/flows/development.yaml"));
  validateDocument("AgentCatalog", await parseYaml("config/agents.yaml"));
  validateDocument("ControllerConfig", await parseYaml("config/controller.example.yaml"));
});
