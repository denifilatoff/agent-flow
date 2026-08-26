import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const PACKAGE_TARGETS = {
  architect: ["claude", "codex"],
  planner: ["claude", "codex"],
  developer: ["codex"],
  reviewer: ["codex"],
} as const;

const ARTIFACT_CONTRACTS = {
  architect: /exactly\s+`kind: "comment"`,\s+`id`,\s+`url`,\s+`marker`, and `artifactKind`/,
  planner: /exactly\s+`kind: "comment"`,\s+`id`,\s+`url`,\s+`marker`, and `artifactKind`/,
  developer: /exactly\s+`kind: "change-request"`,\s+`number`,\s+`url`,\s+`headSha`, and `state`/,
  reviewer: /exactly\s+`kind: "review"`,\s+`id`,\s+`url`,\s+`headSha`, and `verdict`/,
} as const;

const HUMAN_INPUT_ARTIFACT_MATRIX =
  /For a `question` or `unclear`\s+verdict,[\s\S]*exactly\s+one marked question\s+artifact[\s\S]*`kind: "comment"`[\s\S]*`artifactKind: "question"`[\s\S]*For `approved`, `changes-requested`, or `cancelled`,[\s\S]*`artifacts`\s+to `\[\]`/;

function parsePrimitive(source: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  assert.ok(match, "primitive must have YAML frontmatter");
  return { frontmatter: parse(match[1]) as Record<string, unknown>, body: match[2] };
}

async function assertAgentPackage(packageName: keyof typeof PACKAGE_TARGETS, artifact: string): Promise<void> {
  const packageRoot = new URL(`../../agent-packages/${packageName}/`, import.meta.url);
  const manifest = parse(await readFile(new URL("apm.yml", packageRoot), "utf8")) as Record<string, unknown>;

  assert.equal(manifest.name, packageName);
  assert.equal(manifest.version, "1.0.1");
  assert.deepEqual(manifest.targets, PACKAGE_TARGETS[packageName]);
  await readFile(new URL("apm.lock.yaml", packageRoot), "utf8");

  const agentFiles = (await readdir(new URL(".apm/agents/", packageRoot))).filter((file) => file.endsWith(".agent.md"));
  assert.deepEqual(agentFiles, [`${packageName}.agent.md`]);
  const agent = parsePrimitive(await readFile(new URL(`.apm/agents/${agentFiles[0]}`, packageRoot), "utf8"));
  assert.equal(agent.frontmatter.name, packageName);
  assert.match(agent.body, new RegExp(`\\b${artifact}\\b`));
  assert.match(agent.body, ARTIFACT_CONTRACTS[packageName]);
  if (packageName === "developer" || packageName === "reviewer") {
    assert.match(agent.body, /exactly\s+`kind: "comment"`,\s+`id`,\s+`url`,\s+`marker`, and `artifactKind`/);
  }

  const instructionFiles = (await readdir(new URL(".apm/instructions/", packageRoot))).filter((file) =>
    file.endsWith(".instructions.md"),
  );
  assert.deepEqual(instructionFiles, [`${packageName}.instructions.md`]);
  const instruction = parsePrimitive(
    await readFile(new URL(`.apm/instructions/${instructionFiles[0]}`, packageRoot), "utf8"),
  );
  assert.equal(instruction.frontmatter.applyTo, "**/*");
  assert.match(instruction.body, new RegExp(`\\b${packageName}\\b`));
  assert.match(instruction.body, /AGENT_FLOW_CONTEXT_PATH/);
  assert.match(instruction.body, /AGENT_FLOW_RECEIPT_PATH/);
  assert.match(instruction.body, new RegExp(`\\b${artifact}\\b`));
}

test("architect package has one entry agent and a lockfile", async () => {
  await assertAgentPackage("architect", "assessment");
});

test("planner package has one entry agent and a lockfile", async () => {
  await assertAgentPackage("planner", "plan");
});

test("developer package has one entry agent and a lockfile", async () => {
  await assertAgentPackage("developer", "change-request");
});

test("reviewer package has one entry agent and a lockfile", async () => {
  await assertAgentPackage("reviewer", "review");
});

test("human-input receipts always use the schema-compatible outcome", async () => {
  for (const packageName of Object.keys(PACKAGE_TARGETS)) {
    const agent = parsePrimitive(
      await readFile(
        new URL(`../../agent-packages/${packageName}/.apm/agents/${packageName}.agent.md`, import.meta.url),
        "utf8",
      ),
    );
    assert.match(
      agent.body,
      /In human-input\s+mode, always set receipt `outcome` to `succeeded`/,
    );
    assert.match(
      agent.body,
      /set `notes` to an array of one or more nonempty strings, never to a string/,
    );
    assert.match(agent.body, HUMAN_INPUT_ARTIFACT_MATRIX);
  }
});

test("developer requires a change request only for successful stage-mode development", async () => {
  const developer = parsePrimitive(
    await readFile(
      new URL("../../agent-packages/developer/.apm/agents/developer.agent.md", import.meta.url),
      "utf8",
    ),
  );
  assert.match(developer.body, /A successful stage-mode development result has one artifact containing exactly/);
});

test("reviewer distinguishes open, closed-unmerged, and merged stage inputs", async () => {
  const reviewer = parsePrimitive(
    await readFile(
      new URL("../../agent-packages/reviewer/.apm/agents/reviewer.agent.md", import.meta.url),
      "utf8",
    ),
  );
  assert.match(reviewer.body, /An open linked change request in stage mode uses the normal pinned-head review path\./);
  assert.match(
    reviewer.body,
    /A closed, unmerged linked change request in stage mode is allowed only for the one-shot reopen-or-cancel question/,
  );
  assert.match(reviewer.body, /Do not review the closed head or publish review metadata\s+or a verdict\./);
  assert.match(reviewer.body, /A merged linked change request must never use the reopen-or-cancel path\./);
});

test("reviewer returns the exact closed-change question receipt", async () => {
  const reviewer = parsePrimitive(
    await readFile(
      new URL("../../agent-packages/reviewer/.apm/agents/reviewer.agent.md", import.meta.url),
      "utf8",
    ),
  );
  assert.match(
    reviewer.body,
    /<!-- agent-flow:v1 flow=<flow-instance-id> attempt=<attempt-id> artifact=question -->/,
  );
  assert.match(reviewer.body, /Read the\s+published question back through the provider/);
  assert.match(reviewer.body, /set `outcome` to `needs-human`/);
  assert.match(reviewer.body, /include exactly that one\s+`ReceiptComment`/);
  assert.match(reviewer.body, /Do not include `ReceiptReview` or `humanGate`/);
});

test("reviewer interprets a later authorized answer without reviewing", async () => {
  const reviewer = parsePrimitive(
    await readFile(
      new URL("../../agent-packages/reviewer/.apm/agents/reviewer.agent.md", import.meta.url),
      "utf8",
    ),
  );
  assert.match(
    reviewer.body,
    /Human-input mode interprets the authorized unmarked comment as `reopen`, `cancel`, or `unclear`/,
  );
  assert.match(reviewer.body, /Map a request to cancel to `cancelled`/);
  assert.match(
    reviewer.body,
    /In human-input mode, always set receipt `outcome` to `succeeded`[\s\S]*include `humanGate`/,
  );
  assert.match(reviewer.body, /`unclear` or question result publishes a marked clarification question/);
  assert.match(reviewer.body, /Do not publish a review verdict in human-input\s+mode\./);
});

test("reviewer limits pinned-head and review receipts to open stage mode", async () => {
  const reviewer = parsePrimitive(
    await readFile(
      new URL("../../agent-packages/reviewer/.apm/agents/reviewer.agent.md", import.meta.url),
      "utf8",
    ),
  );
  assert.match(reviewer.body, /Only open stage mode reviews the pinned head/);
  assert.match(reviewer.body, /Only a successful open stage-mode review writes a `ReceiptReview`/);
  assert.match(reviewer.body, /Closed stage mode and human-input mode never review code or emit a review verdict/);
});

test("reviewer package instruction preserves the mode-specific receipt contract", async () => {
  const instruction = parsePrimitive(
    await readFile(
      new URL(
        "../../agent-packages/reviewer/.apm/instructions/reviewer.instructions.md",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.match(instruction.body, /Open\s+stage mode reviews only the pinned head and writes a review receipt/);
  assert.match(instruction.body, /Closed stage mode publishes the reopen-or-cancel\s+question/);
  assert.match(instruction.body, /Human-input mode interprets the authorized answer without reviewing code/);
  assert.match(instruction.body, /Every mode\s+writes its appropriate `AgentReceipt` to `AGENT_FLOW_RECEIPT_PATH`/);
});

test("reviewer publishes review metadata immediately after the common marker", async () => {
  const reviewer = parsePrimitive(
    await readFile(
      new URL("../../agent-packages/reviewer/.apm/agents/reviewer.agent.md", import.meta.url),
      "utf8",
    ),
  );
  assert.match(
    reviewer.body,
    /```text\r?\n<!-- agent-flow:v1 flow=<flow-instance-id> attempt=<attempt-id> artifact=review -->\r?\n<!-- agent-flow-review:v1 head=<sha> verdict=<verdict> -->\r?\n```/,
  );
  assert.match(reviewer.body, /40-character lowercase hexadecimal SHA/);
  assert.match(reviewer.body, /exactly `approved`,\s*`changes-requested`, or `commented`/);
  assert.match(reviewer.body, /Preserve both marker lines during provider readback/);
  assert.match(reviewer.body, /publish no verdict.*head.*differs/is);
  assert.match(reviewer.body, /GitHub self-approval fallback[\s\S]*native `COMMENT` review/);
  assert.match(reviewer.body, /successful open stage-mode review writes a `ReceiptReview`/);
  assert.doesNotMatch(reviewer.body, /also record the marked provider comment/);
  assert.match(
    reviewer.body,
    /Human-input clarification questions[\s\S]*common marker[\s\S]*omit review metadata/,
  );
});
