import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfigBundle } from "../src/config/load.ts";
import { RuntimeManager } from "../src/config/runtime.ts";
import { createHealthServer, createOperationalStatus } from "../src/health.ts";
import type { ReadyDependencies } from "../src/preflight.ts";
import type { Controller } from "../src/runtime/controller.ts";

const FLOW = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";

test("serves liveness, runtime-aware readiness, and read-only redacted status", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-health-"));
  const path = join(root, "runtime.yaml");
  const initial = (await readFile("config/runtime.example.yaml", "utf8")).replace("/var/lib/agent-flow", root);
  await writeFile(path, initial);
  const runtime = await RuntimeManager.create(path);
  const status = createOperationalStatus(runtime, async (_fd, expectedPath) => expectedPath);
  const server = createHealthServer("127.0.0.1", 0, status);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const port = (server.address() as AddressInfo).port;
  const url = (route: string) => `http://127.0.0.1:${port}${route}`;

  for (const [route, contentType] of [
    ["/", "text/html; charset=utf-8"],
    ["/index.html", "text/html; charset=utf-8"],
    ["/assets/styles.css", "text/css; charset=utf-8"],
    ["/assets/app.js", "text/javascript; charset=utf-8"],
  ]) {
    const asset = await fetch(url(route));
    assert.equal(asset.status, 200, route);
    assert.equal(asset.headers.get("content-type"), contentType, route);
    assert.equal(asset.headers.get("cache-control"), "no-cache", route);
  }
  const page = await (await fetch(url("/"))).text();
  assert.match(page, /href="\/assets\/styles\.css"/);
  assert.match(page, /src="\/assets\/app\.js"/);
  for (const heading of ["System status", "Configuration", "Flow graph", "Prepare change"]) {
    assert.match(page, new RegExp(heading));
  }
  for (const route of ["/assets/../index.html", "/assets/%2e%2e/index.html"]) {
    assert.equal((await rawGet(port, route)).status, 404, route);
  }

  assert.equal((await fetch(url("/health/live"))).status, 200);
  assert.equal((await fetch(url("/health/ready"))).status, 503);
  const unavailable = await fetch(url("/api/dashboard"));
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
  assert.deepEqual(await unavailable.json(), { available: false, reason: "preflight unavailable" });
  assert.equal((await fetch(url(`/api/sessions/${FLOW}/${ATTEMPT}/context.json`))).status, 503);

  const bundle = await loadConfigBundle(process.cwd(), "config/stack.yaml", "a".repeat(40));
  const controller: Controller = {
    async bootstrap() {}, async run() {}, async reconcileNow() {},
    snapshot: () => ({ lifecycle: "ready", repositories: [], tickets: [],
      queue: { active: 0, queued: 0, concurrency: 4 }, activeWork: [], errors: [] }),
  };
  status.bindReady({
    bundle, providers: { github: {} as never }, harnesses: { claude: {} as never, codex: {} as never }, controller,
    preflight: { status: "ready", provider: "github", harnesses: ["claude", "codex"],
      configurationRevision: bundle.revision },
  } satisfies ReadyDependencies);
  await mkdir(join(root, "sessions", FLOW, ATTEMPT), { recursive: true });
  await writeFile(join(root, "sessions", FLOW, ATTEMPT, "context.json"), "session context\n");
  status.markReady();
  assert.equal((await fetch(url("/health/ready"))).status, 200);
  const dashboard = await fetch(url("/api/dashboard"));
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.headers.get("cache-control"), "no-store");
  assert.equal((await dashboard.json() as { available: boolean }).available, true);
  const session = await fetch(url(`/api/sessions/${FLOW}/${ATTEMPT}/context.json`));
  assert.equal(session.status, 200);
  assert.equal(session.headers.get("cache-control"), "no-store");
  assert.deepEqual(await session.json(), { available: true, content: "session context\n", truncated: false });
  await writeFile(join(root, "sessions", FLOW, ATTEMPT, "harness.log"), "provider-token=secret\n");
  const rawLog = await fetch(url(`/api/sessions/${FLOW}/${ATTEMPT}/harness.log`));
  const rawLogBody = await rawLog.text();
  assert.equal(rawLog.status, 400);
  assert.equal(rawLogBody.includes("provider-token=secret"), false);
  assert.equal((await fetch(url(`/api/sessions/${FLOW}/${ATTEMPT}/other.txt`))).status, 400);

  await writeFile(path, initial.replace("port: 8080", "port: 8081"));
  await runtime.reload();
  assert.equal((await fetch(url("/health/live"))).status, 200);
  assert.equal((await fetch(url("/health/ready"))).status, 503);
  const snapshot = await (await fetch(url("/api/status"))).json() as Record<string, unknown>;
  assert.equal((await fetch(url("/api/status"))).headers.get("cache-control"), "no-store");
  assert.equal(snapshot.configurationRevision, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(snapshot.restartRequired, true);
  assert.deepEqual(snapshot.changedRestartFields, ["runtime.http.port"]);
  assert.equal(JSON.stringify(snapshot).includes("tokenFile"), false);
  assert.equal(JSON.stringify(snapshot).includes("authFile"), false);

  for (const [route, method, statusCode] of [
    ["/api/status", "POST", 405],
    ["/api/dashboard", "POST", 405],
    ["/api/unknown", "GET", 404],
  ] as const) {
    const api = await fetch(url(route), { method });
    assert.equal(api.status, statusCode, route);
    assert.equal(api.headers.get("cache-control"), "no-store", route);
  }
  assert.equal((await fetch(url("/assets/styles.css"), { method: "POST" })).status, 405);
  assert.equal((await fetch(url("/other"))).status, 404);
});

function rawGet(port: number, path: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode ?? 0 }));
    });
    request.once("error", reject);
    request.end();
  });
}
