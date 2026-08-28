import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfigBundle } from "../../src/config/load.ts";
import { parseYaml, validateDocument } from "../../src/config/schema-validator.ts";
import { validateSemantics } from "../../src/config/semantic.ts";

const REVISION = "0123456789abcdef0123456789abcdef01234567";

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("expected the promise to reject");
}

async function loadFixture(name: "invalid-target"): Promise<void> {
  const bundle = await loadConfigBundle(process.cwd(), "config/stack.yaml", REVISION);
  bundle.flow = validateDocument("Flow", await parseYaml(`test/fixtures/config/${name}/flow.yaml`));

  await validateSemantics(bundle);
}

test("accepts the shipped bundle", async () => {
  const bundle = await loadConfigBundle(process.cwd(), "config/stack.yaml", REVISION);
  assert.deepEqual(bundle.flow.spec.states["needs-human"].on?.["agent-needs-human"], {
    target: "needs-human",
    guards: ["receipt-valid"],
    actions: ["record-receipt"],
  });
  await assert.doesNotReject(validateSemantics(bundle));
});

test("uses and requires schemas from the pinned root", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-pinned-schema-"));
  try {
    await cp("config", join(root, "config"), { recursive: true });
    await cp("schemas", join(root, "schemas"), { recursive: true });
    const flowSchemaPath = join(root, "schemas/v1/flow.schema.json");
    const flowSchema = JSON.parse(await readFile(flowSchemaPath, "utf8")) as {
      properties: { metadata: { properties: { id: Record<string, unknown> } } };
    };
    flowSchema.properties.metadata.properties.id.const = "pinned-flow";
    await writeFile(flowSchemaPath, JSON.stringify(flowSchema));

    await assert.rejects(
      loadConfigBundle(root, "config/stack.yaml", REVISION),
      /Flow validation failed.*must be equal to constant/,
    );

    const receiptSchemaPath = join(root, "schemas/v1/agent-receipt.schema.json");
    await unlink(receiptSchemaPath);
    await assert.rejects(
      loadConfigBundle(root, "config/stack.yaml", REVISION),
      /agent-receipt\.schema\.json/,
    );
    await writeFile(receiptSchemaPath, "{");
    await assert.rejects(
      loadConfigBundle(root, "config/stack.yaml", REVISION),
      /pinned schema agent-receipt\.schema\.json.*invalid JSON/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a pinned schema symlink outside the pinned root", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-flow-schema-symlink-"));
  const root = join(workspace, "root");
  try {
    await mkdir(root);
    await cp("config", join(root, "config"), { recursive: true });
    await cp("schemas", join(root, "schemas"), { recursive: true });
    const flowSchemaPath = join(root, "schemas/v1/flow.schema.json");
    const outsideSchemaPath = join(workspace, "outside-flow.schema.json");
    await cp(flowSchemaPath, outsideSchemaPath);
    await unlink(flowSchemaPath);
    await symlink(outsideSchemaPath, flowSchemaPath);

    await assert.rejects(
      loadConfigBundle(root, "config/stack.yaml", REVISION),
      /schemas\/v1\/flow\.schema\.json escapes the pinned root/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rejects missing transition targets", async () => {
  await assert.rejects(loadFixture("invalid-target"), /transition target .* does not exist/);
});

test("reports every flow error in deterministic path order", async () => {
  const bundle = await loadConfigBundle(process.cwd(), "config/stack.yaml", REVISION);
  bundle.flow.spec.initial = "missing-initial";
  bundle.flow.spec.states.assessment.agent = "missing-agent";
  bundle.flow.spec.states.assessment.on!["agent-succeeded"] = {
    target: "$resume",
    resumeTarget: "missing-resume",
    guards: ["missing-guard"],
    actions: ["missing-action"],
  } as never;
  delete bundle.flow.spec.states["assessment-review"].on;
  bundle.flow.spec.states.done.on = {
    "authorized-comment": { target: "missing-final-target" },
  };
  bundle.flow.spec.states.waiting = {
    kind: "paused",
    on: { "authorized-comment": { target: "$resume" } },
  };

  const error = await rejection(validateSemantics(bundle));
  assert.match(error.message, /initial state missing-initial does not exist/);
  assert.match(error.message, /agent missing-agent does not exist/);
  assert.match(error.message, /\$resume is allowed only from needs-human or blocked/);
  assert.match(error.message, /resumeTarget is allowed only for transitions into needs-human or blocked/);
  assert.match(error.message, /resume target missing-resume does not exist/);
  assert.match(error.message, /guard missing-guard is not implemented/);
  assert.match(error.message, /action missing-action is not implemented/);
  assert.match(error.message, /non-final state must define at least one transition/);
  assert.match(error.message, /final state must not define transitions/);
  assert.ok(error.message.indexOf("flow.spec.initial") < error.message.indexOf("flow.spec.states.assessment.agent"));
});

test("rejects incomplete packages and paths outside the pinned root", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-config-"));
  try {
    await cp("config", join(root, "config"), { recursive: true });
    await cp("schemas", join(root, "schemas"), { recursive: true });
    await cp("agent-packages", join(root, "agent-packages"), { recursive: true });
    await unlink(join(root, "agent-packages/architect/apm.lock.yaml"));
    await unlink(join(root, "agent-packages/planner/apm.yml"));
    await writeFile(join(root, "agent-packages/developer/.apm/agents/extra.agent.md"), "---\nname: extra\n---\n");

    const bundle = await loadConfigBundle(root, "config/stack.yaml", REVISION);
    bundle.catalog.agents.reviewer.package = "../outside";

    const error = await rejection(validateSemantics(bundle));
    assert.match(error.message, /apm.lock.yaml is not a committed file/);
    assert.match(error.message, /package must contain exactly one apm.yml/);
    assert.match(error.message, /package must contain exactly one logical entry agent/);
    assert.match(error.message, /package path escapes the pinned root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
