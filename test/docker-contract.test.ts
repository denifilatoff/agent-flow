import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("pins the runtime CLIs and declares every required mount", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  for (const version of ["2.96.0", "1.111.0", "0.28.0", "0.150.0-alpha.8", "2.1.217"]) {
    assert.match(dockerfile, new RegExp(escapeRegExp(version)));
  }
  for (const from of dockerfile.match(/^FROM .+$/gm) ?? []) assert.match(from, /@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /^USER (?!0\b|root\b)\S+/m);
  assert.match(dockerfile, /^EXPOSE 8080$/m);
  assert.match(dockerfile, /^COPY .+schemas .+schemas$/m);

  const composeText = await readFile("compose.yaml", "utf8");
  for (const mount of ["/config", "/data", ".config/gh", ".config/glab-cli", ".codex", ".claude", ".claude.json"]) {
    assert.match(composeText, new RegExp(escapeRegExp(mount)));
  }
  assert.doesNotMatch(composeText, /docker\.sock/);

  const compose = parse(composeText) as { services?: Record<string, { ports?: string[] }> };
  assert.deepEqual(Object.keys(compose.services ?? {}), ["controller"]);
  assert.ok(compose.services?.controller?.ports?.includes("8080:8080"));
});
