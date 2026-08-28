import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RuntimeManager } from "../src/config/runtime.ts";
import { createHealthServer, createOperationalStatus } from "../src/health.ts";

test("serves liveness, runtime-aware readiness, and read-only redacted status", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-health-"));
  const path = join(root, "runtime.yaml");
  const initial = await readFile("config/runtime.example.yaml", "utf8");
  await writeFile(path, initial);
  const runtime = await RuntimeManager.create(path);
  const status = createOperationalStatus(runtime);
  const server = createHealthServer("127.0.0.1", 0, status);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const port = (server.address() as AddressInfo).port;
  const url = (route: string) => `http://127.0.0.1:${port}${route}`;

  assert.equal((await fetch(url("/health/live"))).status, 200);
  assert.equal((await fetch(url("/health/ready"))).status, 503);
  status.markReady();
  assert.equal((await fetch(url("/health/ready"))).status, 200);

  await writeFile(path, initial.replace("port: 8080", "port: 8081"));
  await runtime.reload();
  assert.equal((await fetch(url("/health/live"))).status, 200);
  assert.equal((await fetch(url("/health/ready"))).status, 503);
  const snapshot = await (await fetch(url("/api/status"))).json() as Record<string, unknown>;
  assert.equal(snapshot.configurationRevision, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(snapshot.restartRequired, true);
  assert.deepEqual(snapshot.changedRestartFields, ["runtime.http.port"]);
  assert.equal(JSON.stringify(snapshot).includes("tokenFile"), false);
  assert.equal(JSON.stringify(snapshot).includes("authFile"), false);

  assert.equal((await fetch(url("/api/status"), { method: "POST" })).status, 405);
  assert.equal((await fetch(url("/other"))).status, 404);
});
