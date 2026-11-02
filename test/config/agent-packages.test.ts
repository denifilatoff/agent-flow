import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

import { AGENT_PACKAGE_PROTOCOL_CONTRACT } from "../helpers/agent-package-contracts.ts";

const PACKAGE_TARGETS = {
  documentarian: ["claude", "codex"],
  architect: ["claude", "codex"],
  planner: ["claude", "codex"],
  developer: ["codex"],
  reviewer: ["codex"],
  "bug-investigator": ["claude", "codex"],
  bugfixer: ["codex"],
} as const;

const PACKAGE_VERSIONS = {
  documentarian: "1.1.0",
  architect: "1.1.0",
  planner: "1.1.0",
  developer: "1.1.0",
  reviewer: "1.1.0",
  "bug-investigator": "1.1.0",
  bugfixer: "1.1.0",
} as const;

const AI_PACKAGES_REVISION = "375b5f87a881da999d6a66e20cf8c6d6f257a6d0";
const AI_PACKAGES = "Netcracker/qubership-ai-packages/agent-packages";
const USER_ESSENTIALS_DEPENDENCY = `${AI_PACKAGES}/qubership-user-essentials#${AI_PACKAGES_REVISION}`;
const ADVERSARIAL_REVIEW_DEPENDENCY = `${AI_PACKAGES}/adversarial-code-review#${AI_PACKAGES_REVISION}`;
const BLACKBOX_DEPENDENCY = `${AI_PACKAGES}/blackbox-test-design#${AI_PACKAGES_REVISION}`;
const TESTING_ROLES = new Set(["developer", "bugfixer", "bug-investigator", "reviewer"]);
const BUG_SKILL_REVISION = "634b92f887487fc61cddc2f61d77830e09e8f589";
const ENGINEERING_SKILL_REVISION = "f63ec56a3cc936408d792956ae583c3c96a825bd";
const ENGINEERING_SKILLS = {
  documentarian: ["documentation-and-adrs"],
  architect: ["spec-driven-development"],
  planner: ["planning-and-task-breakdown"],
  developer: ["incremental-implementation", "test-driven-development"],
  bugfixer: ["debugging-and-error-recovery", "test-driven-development"],
} as const;

const DOMAIN_CONTRACTS = {
  documentarian: [/documentation-and-adrs/, /complete.*diff/, /supplied head/, /existing linked change request/,
    /no-op/, /no empty commit/, /ADRs/, /changelogs/, /generated files/, /Do not repair implementation/],
  architect: [/spec-driven-development/, /\bscope\b/, /\bconstraints\b/, /\binterfaces\b/, /\brisks\b/, /acceptance conditions/],
  planner: [
    /planning-and-task-breakdown/,
    /complete implementation plan/,
    /required changes/,
    /\border\b/,
    /affected interfaces/,
    /\btests\b/,
    /acceptance checks/,
  ],
  developer: [
    /incremental-implementation/,
    /test-driven-development/,
    /smallest change/,
    /repository's instructions/,
    /trace (?:the )?(?:relevant )?(?:callers|call sites?)/,
    /review the diff/,
    /relevant test suite/,
  ],
  reviewer: [/adversarial-code-review/, /pinned head/, /Do not edit code/, /Do not merge/, /native `COMMENT` review/],
  "bug-investigator": [/bug-reproduction-brief/, /bug-receipt/, /stop before changing code/, /Do not edit code/],
  bugfixer: [
    /debugging-and-error-recovery/,
    /test-driven-development/,
    /reproduction brief/,
    /smallest/,
    /regression\s+check/,
    /root cause/,
  ],
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
  assert.equal(manifest.version, PACKAGE_VERSIONS[packageName]);
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

test("bug investigator package has one entry agent and a lockfile", async () => {
  await assertAgentPackage("bug-investigator", "diagnostic");
});

test("bug investigator publishes controller diagnostics on the ticket", async () => {
  const investigator = parsePrimitive(
    await readFile(
      new URL("../../agent-packages/bug-investigator/.apm/agents/bug-investigator.agent.md", import.meta.url),
      "utf8",
    ),
  );
  assert.match(investigator.body, /both diagnostic artifacts on the supplied ticket/);
  assert.match(investigator.body, /never on its change request/);
});

test("bugfixer package has one entry agent and a lockfile", async () => {
  await assertAgentPackage("bugfixer", "regression");
});

test("reviewer pins and locks the adversarial review skill", async () => {
  const packageRoot = new URL("../../agent-packages/reviewer/", import.meta.url);
  const manifest = parse(await readFile(new URL("apm.yml", packageRoot), "utf8")) as {
    dependencies?: { apm?: string[] };
  };
  assert.deepEqual(manifest.dependencies?.apm, [
    USER_ESSENTIALS_DEPENDENCY, ADVERSARIAL_REVIEW_DEPENDENCY, BLACKBOX_DEPENDENCY,
  ]);

  const lock = await readFile(new URL("apm.lock.yaml", packageRoot), "utf8");
  assert.match(lock, /name: adversarial-code-review/);
  assert.match(lock, new RegExp(`resolved_commit: ${AI_PACKAGES_REVISION}`));
  assert.match(lock, /\.agents\/skills\/adversarial-code-review\/SKILL\.md/);
});

test("bug investigator pins and locks both bug skills for Claude and Codex", async () => {
  const packageRoot = new URL("../../agent-packages/bug-investigator/", import.meta.url);
  const manifest = parse(await readFile(new URL("apm.yml", packageRoot), "utf8")) as {
    dependencies?: { apm?: string[] };
  };
  assert.deepEqual(manifest.dependencies?.apm, [
    USER_ESSENTIALS_DEPENDENCY,
    `github/awesome-copilot/skills/bug-reproduction-brief#${BUG_SKILL_REVISION}`,
    `github/awesome-copilot/skills/bug-receipt#${BUG_SKILL_REVISION}`,
    BLACKBOX_DEPENDENCY,
  ]);

  const lock = await readFile(new URL("apm.lock.yaml", packageRoot), "utf8");
  assert.match(lock, /name: bug-reproduction-brief/);
  assert.match(lock, /name: bug-receipt/);
  assert.equal(lock.match(new RegExp(`resolved_commit: ${BUG_SKILL_REVISION}`, "g"))?.length, 2);
  assert.match(lock, /\.claude\/skills\/bug-receipt\/SKILL\.md/);
  assert.match(lock, /\.agents\/skills\/bug-receipt\/SKILL\.md/);
});

for (const [packageName, skills] of Object.entries(ENGINEERING_SKILLS)) {
  test(`${packageName} pins and locks its engineering skills`, async () => {
    const packageRoot = new URL(`../../agent-packages/${packageName}/`, import.meta.url);
    const manifest = parse(await readFile(new URL("apm.yml", packageRoot), "utf8")) as {
      dependencies?: { apm?: string[] };
    };
    assert.deepEqual(
      manifest.dependencies?.apm,
      [
        USER_ESSENTIALS_DEPENDENCY,
        ...skills.map((skill) => `addyosmani/agent-skills/skills/${skill}#${ENGINEERING_SKILL_REVISION}`),
        ...(TESTING_ROLES.has(packageName) ? [BLACKBOX_DEPENDENCY] : []),
      ],
    );

    const lock = await readFile(new URL("apm.lock.yaml", packageRoot), "utf8");
    for (const skill of skills) {
      assert.match(lock, new RegExp(`name: ${skill}`));
      assert.match(lock, new RegExp(`\\.agents/skills/${skill}/SKILL\\.md`));
    }
    assert.equal(lock.match(new RegExp(`resolved_commit: ${ENGINEERING_SKILL_REVISION}`, "g"))?.length, skills.length);
  });
}

for (const [packageName, targets] of Object.entries(PACKAGE_TARGETS)) {
  test(`${packageName} locks user essentials and its role-specific test skills for every target`, async () => {
    const root = new URL(`../../agent-packages/${packageName}/`, import.meta.url);
    const manifest = parse(await readFile(new URL("apm.yml", root), "utf8"));
    assert.equal(manifest.dependencies.apm.filter((dep: string) => dep === USER_ESSENTIALS_DEPENDENCY).length, 1);
    const lock = parse(await readFile(new URL("apm.lock.yaml", root), "utf8"));
    const aiPackages = lock.dependencies.filter((dep: { repo_url: string }) =>
      dep.repo_url.toLowerCase() === "netcracker/qubership-ai-packages",
    );
    assert.ok(aiPackages.length > 1, "umbrella dependencies must be resolved transitively");
    for (const dependency of aiPackages) assert.equal(dependency.resolved_commit, AI_PACKAGES_REVISION);
    const skills = ["test-authoring", "final-review", "docs-page-authoring"];
    if (TESTING_ROLES.has(packageName)) skills.push("blackbox-test-design");
    else assert.ok(!lock.dependencies.some((dep: { name: string }) => dep.name === "blackbox-test-design"));
    for (const skill of skills) {
      const dependency = lock.dependencies.find((dep: { name: string }) => dep.name === skill);
      assert.ok(dependency, `${packageName} must lock ${skill}`);
      for (const target of targets) {
        const directory = target === "claude" ? ".claude" : ".agents";
        assert.ok(dependency.deployed_files.includes(`${directory}/skills/${skill}/SKILL.md`));
      }
    }
  });
}

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
  assert.match(reviewer.body, /GitHub self-review\s+fallback[\s\S]*native `COMMENT` review/);
});


test("documentarian has one scoped entry agent and a dual-target pinned skill", async () => {
  await assertAgentPackage("documentarian", "documentation");
  const lock = await readFile(new URL("../../agent-packages/documentarian/apm.lock.yaml", import.meta.url), "utf8");
  assert.match(lock, /\.claude\/skills\/documentation-and-adrs\/SKILL\.md/);
  assert.match(lock, /\.agents\/skills\/documentation-and-adrs\/SKILL\.md/);
});
