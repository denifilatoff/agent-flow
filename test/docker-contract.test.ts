import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const requiredMounts: Record<string, boolean> = {
  "/config": true,
  "/data": false,
  "/home/agent/.config/gh": true,
  "/home/agent/.config/glab-cli": true,
  "/home/agent/.codex": true,
  "/home/agent/.claude": true,
  "/home/agent/.claude.json": true,
};

test("locks the runtime image, tools, and controller service", async () => {
  const dockerfile = uncomment(await readFile("Dockerfile", "utf8"));
  const from = dockerfile.match(/^FROM .+$/gm) ?? [];
  assert.ok(from.length >= 2);
  for (const instruction of from) assert.match(instruction, /@sha256:[a-f0-9]{64}(?:\s|$)/);
  assert.match(dockerfile, /snapshot\.debian\.org\/archive\/debian\/\d{8}T\d{6}Z/);
  assert.match(dockerfile, /snapshot\.debian\.org\/archive\/debian-security\/\d{8}T\d{6}Z/);
  assert.match(dockerfile, /docker\/tools\/package-lock\.json/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /docker\/apm-requirements\.txt/);
  assert.match(dockerfile, /pip install .+--require-hashes/);
  assert.match(dockerfile, /^COPY .+schemas .+schemas$/m);
  assert.match(dockerfile, /^EXPOSE 8080$/m);
  assert.match(dockerfile, /^CMD \["node", "dist\/main\.js"\]$/m);

  const finalStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM ") + 1);
  const users = finalStage.match(/^USER .+$/gm) ?? [];
  assert.ok(users.length > 0);
  assert.match(users.at(-1)!, /^USER (?!0(?:\D|$)|root(?:\D|$))\S+/);

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
  assert.deepEqual(Object.keys(controller.environment ?? {}).sort(), [
    "AGENT_FLOW_CONTROLLER_CONFIG", "GITHUB_TOKEN", "GITLAB_TOKEN",
  ]);
  assert.match(JSON.stringify(controller.healthcheck), /health\/ready/);
  assert.doesNotMatch(JSON.stringify(controller), /docker\.sock/);
  const mounts = Object.fromEntries((controller.volumes ?? []).map(parseMount));
  assert.deepEqual(mounts, requiredMounts);
});

interface ControllerService {
  init?: boolean;
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  healthcheck?: unknown;
}

function uncomment(source: string): string {
  return source.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
}

function parseMount(value: string): [string, boolean] {
  const parts = value.split(":");
  const target = parts.at(-1) === "ro" ? parts.at(-2)! : parts.at(-1)!;
  return [target, parts.at(-1) === "ro"];
}
