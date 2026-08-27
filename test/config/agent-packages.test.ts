import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

import { AGENT_PACKAGE_PROTOCOL_CONTRACT } from "../helpers/agent-package-contracts.ts";

const PACKAGE_TARGETS = {
  architect: ["claude", "codex"],
  planner: ["claude", "codex"],
  developer: ["codex"],
  reviewer: ["codex"],
} as const;

const DOMAIN_CONTRACTS = {
  architect: [/\bscope\b/, /\bconstraints\b/, /\binterfaces\b/, /\brisks\b/, /acceptance conditions/],
  planner: [
    /complete implementation plan/,
    /required changes/,
    /\border\b/,
    /affected interfaces/,
    /\btests\b/,
    /acceptance checks/,
  ],
  developer: [
    /smallest change/,
    /repository's instructions/,
    /trace (?:the )?(?:relevant )?(?:callers|call sites?)/,
    /review the diff/,
    /relevant test suite/,
  ],
  reviewer: [/pinned head/, /blocking/, /nonblocking/, /Do not edit code/, /Do not merge/, /native `COMMENT` review/],
} as const;

for (const event of [
  "attempts-exhausted",
  "authorized-comment",
  "change-request-updated",
  "change-request-merged",
  "change-request-closed",
]) {
  test(`separation contract rejects the ${event} flow event`, () => {
    assert.match(event, AGENT_PACKAGE_PROTOCOL_CONTRACT);
  });
}

for (const [receipt, fields] of [
  ["comment", "artifactKind marker url id kind"],
  ["change request", "state headSha url number kind"],
  ["review", "verdict headSha url id kind"],
]) {
  test(`separation contract rejects a reordered ${receipt} receipt field list`, () => {
    assert.match(fields, AGENT_PACKAGE_PROTOCOL_CONTRACT);
  });
}

function parsePrimitive(source: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  assert.ok(match, "primitive must have YAML frontmatter");
  return { frontmatter: parse(match[1]) as Record<string, unknown>, body: match[2] };
}

async function assertAgentPackage(packageName: keyof typeof PACKAGE_TARGETS, artifact: string): Promise<void> {
  const packageRoot = new URL(`../../agent-packages/${packageName}/`, import.meta.url);
  const manifest = parse(await readFile(new URL("apm.yml", packageRoot), "utf8")) as Record<string, unknown>;

  assert.equal(manifest.name, packageName);
  assert.equal(manifest.version, "1.0.2");
  assert.deepEqual(manifest.targets, PACKAGE_TARGETS[packageName]);
  await readFile(new URL("apm.lock.yaml", packageRoot), "utf8");

  const agentFiles = (await readdir(new URL(".apm/agents/", packageRoot))).filter((file) => file.endsWith(".agent.md"));
  assert.deepEqual(agentFiles, [`${packageName}.agent.md`]);
  const agent = parsePrimitive(await readFile(new URL(`.apm/agents/${agentFiles[0]}`, packageRoot), "utf8"));
  assert.equal(agent.frontmatter.name, packageName);
  assert.match(agent.body, new RegExp(`\\b${artifact}\\b`));
  for (const contract of DOMAIN_CONTRACTS[packageName]) assert.match(agent.body, contract);

  const instructionFiles = (await readdir(new URL(".apm/instructions/", packageRoot))).filter((file) =>
    file.endsWith(".instructions.md"),
  );
  assert.deepEqual(instructionFiles, [`${packageName}.instructions.md`]);
  const instruction = parsePrimitive(
    await readFile(new URL(`.apm/instructions/${instructionFiles[0]}`, packageRoot), "utf8"),
  );
  assert.equal(instruction.frontmatter.applyTo, "**/*");
  assert.match(instruction.body, new RegExp(`\\b${packageName}\\b`));
  assert.match(instruction.body, new RegExp(`\\b${artifact}\\b`));
  assert.doesNotMatch(`${instruction.body}\n${agent.body}`, AGENT_PACKAGE_PROTOCOL_CONTRACT);
}

test("architect package has one entry agent and a lockfile", async () => {
  await assertAgentPackage("architect", "assessment");
});

test("planner package has one entry agent and a lockfile", async () => {
  await assertAgentPackage("planner", "plan");
});

test("developer package has one entry agent and a lockfile", async () => {
  await assertAgentPackage("developer", "change request");
});

test("reviewer package has one entry agent and a lockfile", async () => {
  await assertAgentPackage("reviewer", "review");
});

test("role packages interpret human feedback without defining flow decisions", async () => {
  for (const packageName of Object.keys(PACKAGE_TARGETS)) {
    const agent = parsePrimitive(
      await readFile(
        new URL(`../../agent-packages/${packageName}/.apm/agents/${packageName}.agent.md`, import.meta.url),
        "utf8",
      ),
    );
    assert.match(agent.body, /plain (?:meaning|language)/);
    assert.match(agent.body, /clarif/);
  }
});

test("developer keeps change-request publication in its domain scope", async () => {
  const developer = parsePrimitive(
    await readFile(
      new URL("../../agent-packages/developer/.apm/agents/developer.agent.md", import.meta.url),
      "utf8",
    ),
  );
  assert.match(developer.body, /change request/);
});

test("reviewer reviews only the pinned head and does not change the repository", async () => {
  const reviewer = parsePrimitive(
    await readFile(
      new URL("../../agent-packages/reviewer/.apm/agents/reviewer.agent.md", import.meta.url),
      "utf8",
    ),
  );
  assert.match(reviewer.body, /pinned head/);
  assert.match(reviewer.body, /before publication/);
  assert.match(reviewer.body, /publish no review/);
  assert.match(reviewer.body, /Do not edit code/);
  assert.match(reviewer.body, /Do not merge/);
});

test("reviewer separates blocking from nonblocking findings", async () => {
  const reviewer = parsePrimitive(
    await readFile(
      new URL("../../agent-packages/reviewer/.apm/agents/reviewer.agent.md", import.meta.url),
      "utf8",
    ),
  );
  assert.match(reviewer.body, /blocking finding/);
  assert.match(reviewer.body, /nonblocking finding/);
  assert.match(reviewer.body, /Request changes only/);
});

test("reviewer interprets human feedback without inventing command syntax", async () => {
  const reviewer = parsePrimitive(
    await readFile(
      new URL("../../agent-packages/reviewer/.apm/agents/reviewer.agent.md", import.meta.url),
      "utf8",
    ),
  );
  assert.match(reviewer.body, /plain meaning/);
  assert.match(reviewer.body, /Do not invent command syntax/);
  assert.match(reviewer.body, /ask a clarification question/);
});

test("reviewer keeps the GitHub native self-review fallback", async () => {
  const reviewer = parsePrimitive(
    await readFile(
      new URL("../../agent-packages/reviewer/.apm/agents/reviewer.agent.md", import.meta.url),
      "utf8",
    ),
  );
  assert.match(reviewer.body, /GitHub self-review fallback[\s\S]*native `COMMENT` review/);
});
