import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const requiredMounts = [
  { source: "${AGENT_FLOW_RUNTIME_PATH:-./config/runtime.example.yaml}", target: "/etc/agent-flow/runtime.yaml", readOnly: true },
  { source: "${AGENT_FLOW_PROVIDER_TOKEN_PATH:?set AGENT_FLOW_PROVIDER_TOKEN_PATH}", target: "/run/secrets/agent-flow/provider-token", readOnly: true },
  { source: "${AGENT_FLOW_CODEX_AUTH_PATH:?set AGENT_FLOW_CODEX_AUTH_PATH}", target: "/run/secrets/agent-flow/codex-auth", readOnly: true },
  { source: "${AGENT_FLOW_CLAUDE_AUTH_PATH:?set AGENT_FLOW_CLAUDE_AUTH_PATH}", target: "/run/secrets/agent-flow/claude-auth", readOnly: true },
  { source: "${AGENT_FLOW_DATA_PATH:-./.agent-flow-data}", target: "/var/lib/agent-flow", readOnly: false },
];

test("locks the runtime image, tools, and controller service", async () => {
  const dockerfile = uncomment(await readFile("Dockerfile", "utf8"));
  assertDockerfileContract(dockerfile);

  const toolsLock = JSON.parse(await readFile("docker/tools/package-lock.json", "utf8")) as {
    packages: Record<string, { version?: string }>;
  };
  assert.equal(toolsLock.packages["node_modules/@openai/codex"]?.version, "0.150.0-alpha.8");
  assert.equal(toolsLock.packages["node_modules/@anthropic-ai/claude-code"]?.version, "2.1.217");
  const toolsPackage = JSON.parse(await readFile("docker/tools/package.json", "utf8")) as { allowScripts?: unknown };
  assert.deepEqual(toolsPackage.allowScripts, { "@anthropic-ai/claude-code": true });

  const requirements = await readFile("docker/apm-requirements.txt", "utf8");
  assert.match(requirements, /apm_cli-0\.28\.0-py3-none-any\.whl/);
  assert.match(requirements, /28682028559dc3e03b4d9d2431eea906f58eacfaa39974657d29646136a4f716/);
  for (const block of requirements.split(/\n(?=[a-zA-Z0-9])/).filter((entry) => /^[a-zA-Z0-9]/.test(entry))) {
    assert.match(block, /(?:==| @ https:\/\/)/);
    assert.match(block, /--hash=sha256:[a-f0-9]{64}/);
  }

  const composeText = await readFile("compose.yaml", "utf8");
  const compose = parse(composeText) as { services?: Record<string, ControllerService> };
  assert.deepEqual(Object.keys(compose.services ?? {}), ["controller"]);
  const controller = compose.services!.controller!;
  assert.equal(controller.init, true);
  assert.deepEqual(controller.ports, ["8080:8080"]);
  assert.equal(controller.environment, undefined);
  assert.match(JSON.stringify(controller.healthcheck), /health\/ready/);
  assert.doesNotMatch(JSON.stringify(controller), /docker\.sock/);
  assertMountContract(controller.volumes ?? []);
});

test("keeps pull requests unprivileged and publishes verified multi-arch images", async () => {
  const workflow = parse(await readFile(".github/workflows/build.yml", "utf8")) as BuildWorkflow;

  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push, { branches: ["main"], tags: ["v*"] });
  assert.deepEqual(workflow.permissions, { contents: "read" });

  const imageCheck = workflow.jobs["image-check"];
  assert.equal(imageCheck?.if, "github.event_name == 'pull_request'");
  assert.equal(imageCheck?.needs, "verify");
  assert.equal(stepUsing(imageCheck, "docker/build-push-action").with?.push, false);
  for (const job of [workflow.jobs.verify, imageCheck]) assertUnprivilegedImageJob(job, workflow.permissions);

  const publish = workflow.jobs.publish;
  assert.equal(publish?.if, "github.event_name != 'pull_request'");
  assert.equal(publish?.needs, "verify");
  assert.deepEqual(publish?.permissions, { contents: "read", packages: "write" });
  const publishBuild = stepUsing(publish, "docker/build-push-action");
  assert.equal(publishBuild.with?.push, true);
  assert.equal(publishBuild.with?.platforms, "linux/amd64,linux/arm64");

  const metadata = stepUsing(publish, "docker/metadata-action");
  const tags = String(metadata.with?.tags);
  for (const tag of ["value=edge", "type=sha,prefix=sha-", "type=semver,pattern={{version}}",
    "type=semver,pattern={{major}}.{{minor}}", "value=latest"]) {
    assert.match(tags, new RegExp(escapeRegex(tag)));
  }

  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses) assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/);
    }
  }
});

test("rejects runtime instructions placed only in a build stage", () => {
  const digest = "a".repeat(64);
  const dockerfile = `FROM node@sha256:${digest} AS build
COPY docker/apm-requirements.txt /tmp/apm-requirements.txt
RUN pip install --require-hashes --requirement /tmp/apm-requirements.txt
COPY --from=tools /tools/node_modules /opt/tools/node_modules
COPY schemas ./schemas
USER 10001:10001
EXPOSE 8080
CMD ["node", "dist/main.js"]
FROM node@sha256:${digest}
USER 10001:10001`;

  assert.throws(() => assertRuntimeStage(dockerStages(dockerfile).at(-1)!));
});

test("rejects a volume mounted from the wrong host source", () => {
  const volumes = requiredMounts.map(({ source, target, readOnly }) =>
    `${source}:${target}${readOnly ? ":ro" : ""}`,
  );
  volumes[0] = `./fake-config:${requiredMounts[0]!.target}:ro`;

  assert.throws(() => assertMountContract(volumes));
});

interface ControllerService {
  init?: boolean;
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  healthcheck?: unknown;
}

interface BuildWorkflow {
  on: Record<string, unknown> & { push?: unknown };
  permissions: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

interface WorkflowJob {
  if?: string;
  needs?: string;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface WorkflowStep {
  uses?: string;
  with?: Record<string, unknown>;
}

function stepUsing(job: WorkflowJob | undefined, action: string): WorkflowStep {
  const step = job?.steps?.find((candidate) => candidate.uses?.startsWith(`${action}@`));
  assert.ok(step, `missing ${action} step`);
  return step;
}

function assertUnprivilegedImageJob(job: WorkflowJob | undefined, inheritedPermissions: Record<string, string>): void {
  assert.deepEqual(job?.permissions ?? inheritedPermissions, { contents: "read" });
  assert.equal(job?.steps?.some((step) => step.uses?.startsWith("docker/login-action@")), false);
  for (const step of job?.steps?.filter((candidate) => candidate.uses?.startsWith("docker/build-push-action@")) ?? []) {
    assert.notEqual(step.with?.push, true);
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uncomment(source: string): string {
  return source.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
}

function assertDockerfileContract(dockerfile: string): void {
  const stages = dockerStages(dockerfile);
  assert.ok(stages.length >= 2);
  for (const stage of stages) assert.match(stage, /^FROM .+@sha256:[a-f0-9]{64}(?:\s|$)/);

  const toolsStage = stages.find((stage) => /^FROM .+ AS tools$/m.test(stage));
  assert.ok(toolsStage);
  assert.match(toolsStage, /^COPY docker\/tools\/package\.json docker\/tools\/package-lock\.json \.\/$/m);
  assert.match(toolsStage, /^RUN npm ci --omit=dev/m);
  assertRuntimeStage(stages.at(-1)!);
}

function assertRuntimeStage(stage: string): void {
  assert.match(stage, /snapshot\.debian\.org\/archive\/debian\/\d{8}T\d{6}Z/);
  assert.match(stage, /snapshot\.debian\.org\/archive\/debian-security\/\d{8}T\d{6}Z/);
  assert.match(stage, /^COPY docker\/apm-requirements\.txt \/tmp\/apm-requirements\.txt$/m);
  assert.match(stage, /python3 -m pip install[\s\\]+--break-system-packages[\s\S]*--require-hashes[\s\\]+--requirement \/tmp\/apm-requirements\.txt/);
  assert.match(stage, /^COPY --from=tools .+\/tools\/node_modules \/opt\/tools\/node_modules$/m);
  assert.match(stage, /^COPY .+schemas .+schemas$/m);
  assert.match(stage, /mkdir -p \/etc\/agent-flow \/run\/secrets\/agent-flow \/var\/lib\/agent-flow \/tmp\/agent-flow/);
  assert.doesNotMatch(stage, /AGENT_FLOW_|GITHUB_TOKEN|GITLAB_TOKEN|CODEX_HOME|CLAUDE_CONFIG_DIR/);
  assert.match(stage, /^EXPOSE 8080$/m);
  assert.deepEqual(stage.match(/^CMD .+$/gm), ['CMD ["node", "dist/main.js"]']);

  const users = stage.match(/^USER .+$/gm) ?? [];
  assert.ok(users.length > 0);
  assert.match(users.at(-1)!, /^USER (?!0(?:\D|$)|root(?:\D|$))\S+/);
}

function dockerStages(source: string): string[] {
  const starts = [...source.matchAll(/^FROM .+$/gm)].map((match) => match.index);
  return starts.map((start, index) => source.slice(start, starts[index + 1]));
}

function assertMountContract(volumes: string[]): void {
  assert.deepEqual(volumes.map(parseMount), requiredMounts);
}

function parseMount(value: string): { source: string; target: string; readOnly: boolean } {
  const readOnly = value.endsWith(":ro");
  const mount = readOnly ? value.slice(0, -3) : value;
  const separator = mount.lastIndexOf(":");
  assert.ok(separator > 0, `invalid volume: ${value}`);
  return { source: mount.slice(0, separator), target: mount.slice(separator + 1), readOnly };
}
