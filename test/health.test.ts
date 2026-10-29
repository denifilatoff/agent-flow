import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfigBundle } from "../src/config/load.ts";
import { RuntimeManager, readSecretFile } from "../src/config/runtime.ts";
import { createHealthServer, createOperationalStatus } from "../src/health.ts";
import type { ReadyDependencies } from "../src/preflight.ts";
import { createStartupRedactor } from "../src/redaction.ts";
import type { Controller } from "../src/runtime/controller.ts";

const FLOW = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
const OPERATOR_PASSWORD = "operator-password-314159";
const OPERATOR_AUTHORIZATION = `Basic ${Buffer.from(`operator:${OPERATOR_PASSWORD}`).toString("base64")}`;

test("requires fixed operator Basic authentication for every non-health route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-http-auth-"));
  const authFile = join(root, "operator-password");
  await writeFile(authFile, `${OPERATOR_PASSWORD}\n`, { mode: 0o600 });
  const status = {
    isReady: () => true,
    markReady() {},
    markNotReady() {},
    bindReady() {},
    dashboard: async () => null,
    sessionFile: async () => ({
      status: 200 as const,
      body: { available: true as const, content: "x".repeat(1_048_576), truncated: false },
    }),
    snapshot: () => ({
      configurationRepository: "/config",
      configurationRevision: "a".repeat(40),
      runtimeDigest: "b".repeat(64),
      validationErrors: [],
      restartRequired: false,
      restartReason: null,
      changedRestartFields: [],
      activeAttempts: 0,
      safeToRestart: false,
    }),
  } satisfies OperationalStatus;
  const server = createHealthServer("127.0.0.1", 0, status, await readSecretFile(authFile));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(authFile, "replacement-password\n", { mode: 0o600 });
  const port = (server.address() as AddressInfo).port;
  const url = (route: string) => `http://127.0.0.1:${port}${route}`;

  assert.equal((await fetch(url("/health/live"))).status, 200);
  assert.equal((await fetch(url("/health/ready"))).status, 200);

  for (const [route, method] of [
    ["/", "GET"],
    ["/assets/styles.css", "GET"],
    ["/api/status", "GET"],
    ["/api/dashboard", "GET"],
    [`/api/sessions/${FLOW}/${ATTEMPT}/context.json`, "GET"],
    ["/unknown", "GET"],
    ["/api/status", "POST"],
  ] as const) {
    const response = await fetch(url(route), { method });
    assert.equal(response.status, 401, `${method} ${route}`);
    assert.equal(response.headers.get("www-authenticate"), 'Basic realm="agent-flow", charset="UTF-8"');
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    assert.doesNotMatch(body, /operator-password|\/config/);
  }

  for (const authorization of [
    "Bearer ignored",
    "Basic",
    "Basic !!!",
    `Basic ${Buffer.from("operator:wrong-password").toString("base64")}`,
    `Basic ${Buffer.from(`other:${OPERATOR_PASSWORD}`).toString("base64")}`,
  ]) {
    const response = await fetch(url("/api/status"), { headers: { authorization } });
    assert.equal(response.status, 401, authorization);
  }

  assert.equal((await fetch(url("/api/status"), {
    headers: { authorization: OPERATOR_AUTHORIZATION },
  })).status, 200);
  const oversized = await fetch(url(`/api/sessions/${FLOW}/${ATTEMPT}/context.json`), {
    headers: { authorization: OPERATOR_AUTHORIZATION },
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { available: false, reason: "session file too large" });
  assert.equal((await fetch(url("/api/status"), {
    headers: { authorization: `Basic ${Buffer.from("operator:replacement-password").toString("base64")}` },
  })).status, 401);
  assert.equal((await fetch(url("/api/status"), {
    method: "POST",
    headers: { authorization: OPERATOR_AUTHORIZATION },
  })).status, 405);
  assert.equal((await fetch(url("/unknown"), {
    headers: { authorization: OPERATOR_AUTHORIZATION },
  })).status, 404);
});

test("serves liveness, runtime-aware readiness, and read-only redacted status", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-health-"));
  const path = join(root, "runtime.yaml");
  const initial = (await readFile("config/runtime.example.yaml", "utf8")).replace("/var/lib/agent-flow", root);
  await writeFile(path, initial);
  const runtime = await RuntimeManager.create(path);
  const status = createOperationalStatus(runtime, async (_fd, expectedPath) => expectedPath);
  const server = createHealthServer("127.0.0.1", 0, status, OPERATOR_PASSWORD);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const port = (server.address() as AddressInfo).port;
  const url = (route: string) => `http://127.0.0.1:${port}${route}`;
  const fetch = (input: string | URL, init: RequestInit = {}) => globalThis.fetch(input, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: OPERATOR_AUTHORIZATION },
  });

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
    assert.equal((await rawGet(port, route, OPERATOR_AUTHORIZATION)).status, 404, route);
  }

  assert.equal((await fetch(url("/health/live"))).status, 200);
  assert.equal((await fetch(url("/health/ready"))).status, 503);
  const unavailable = await fetch(url("/api/dashboard"));
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
  assert.deepEqual(await unavailable.json(), { available: false, reason: "preflight unavailable" });
  assert.equal((await fetch(url(`/api/sessions/${FLOW}/${ATTEMPT}/context.json`))).status, 503);

  await writeFile(path, initial.replace("https://api.github.com", "https://user:password@api.github.com"));
  await runtime.reload();
  const rejectedStatus = await (await fetch(url("/api/status"))).text();
  const rejectedDashboard = await (await fetch(url("/api/dashboard"))).text();
  for (const secret of ["user", "password"]) {
    assert.equal(rejectedStatus.includes(secret), false);
    assert.equal(rejectedDashboard.includes(secret), false);
  }
  assert.match(rejectedStatus, /runtime configuration is invalid/);
  await writeFile(path, initial);
  await runtime.reload();

  const bundle = await loadConfigBundle(process.cwd(), "config/stack.yaml", "a".repeat(40));
  const controller: Controller = {
    async bootstrap() {}, async run() {}, async reconcileNow() {},
    snapshot: () => ({ lifecycle: "ready", repositories: [], tickets: [],
      queue: { active: 0, queued: 0, concurrency: 4 }, activeWork: [], errors: [] }),
  };
  const redactor = createStartupRedactor();
  const providerSecret = "provider-token+/=42";
  const harnessSecret = "harness-secret-314159";
  redactor.register(providerSecret);
  redactor.register(Buffer.from(JSON.stringify({ accessToken: harnessSecret })));
  status.bindReady({
    bundle, providers: { github: {} as never }, harnesses: { claude: {} as never, codex: {} as never }, controller,
    preflight: { status: "ready", provider: "github", harnesses: ["claude", "codex"],
      configurationRevision: bundle.revision },
    redactSessionContent: redactor.redact,
  } satisfies ReadyDependencies);
  await mkdir(join(root, "sessions", FLOW, ATTEMPT), { recursive: true });
  await writeFile(join(root, "sessions", FLOW, ATTEMPT, "context.json"), JSON.stringify({ providerSecret }));
  await writeFile(join(root, "sessions", FLOW, ATTEMPT, "decision.json"), JSON.stringify({ harnessSecret }));
  await writeFile(join(root, "sessions", FLOW, ATTEMPT, "harness.log"), [
    providerSecret,
    JSON.stringify(harnessSecret).slice(1, -1),
    encodeURIComponent(providerSecret),
    Buffer.from(harnessSecret).toString("base64"),
    Buffer.from(providerSecret).toString("hex"),
  ].join("\n"));
  status.markReady();
  assert.equal((await fetch(url("/health/ready"))).status, 200);
  const dashboard = await fetch(url("/api/dashboard"));
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.headers.get("cache-control"), "no-store");
  const dashboardBody = await dashboard.text();
  assert.equal((JSON.parse(dashboardBody) as { available: boolean }).available, true);
  const statusBody = await (await fetch(url("/api/status"))).text();
  for (const secret of [providerSecret, harnessSecret]) {
    assert.equal(dashboardBody.includes(secret), false);
    assert.equal(statusBody.includes(secret), false);
  }
  for (const file of ["context.json", "decision.json", "harness.log"]) {
    const session = await fetch(url(`/api/sessions/${FLOW}/${ATTEMPT}/${file}`));
    assert.equal(session.status, 200, file);
    assert.equal(session.headers.get("cache-control"), "no-store");
    const body = await session.text();
    for (const secret of [providerSecret, harnessSecret]) assert.equal(body.includes(secret), false, `${file}: ${secret}`);
  }
  await writeFile(join(root, "sessions", FLOW, ATTEMPT, "harness.log"), "z".repeat(1_048_577));
  const bounded = await fetch(url(`/api/sessions/${FLOW}/${ATTEMPT}/harness.log`));
  const boundedBody = await bounded.text();
  assert.ok(Buffer.byteLength(boundedBody) <= 1_048_576);
  assert.equal(bounded.status, 413);
  assert.deepEqual(JSON.parse(boundedBody), { available: false, reason: "session file too large" });
  assert.equal((await fetch(url(`/api/sessions/${FLOW}/${ATTEMPT}/other.txt`))).status, 400);
  for (const route of [
    `/api/sessions/${FLOW}/${ATTEMPT}/%63ontext.json`,
    `/api/sessions/${FLOW}/${ATTEMPT}/../context.json`,
    `/api/sessions/${FLOW}/%2e%2e/context.json`,
  ]) assert.notEqual((await rawGet(port, route, OPERATOR_AUTHORIZATION)).status, 200, route);

  await writeFile(path, initial.replace(
    "https://github.com/example/agent-stack.git",
    "https://github.com/example/agent-stack.git?private_token=secret#secret",
  ));
  await runtime.reload();
  const retainedDashboard = await (await fetch(url("/api/dashboard"))).text();
  assert.equal(retainedDashboard.includes("private_token"), false);
  assert.equal(retainedDashboard.includes("#secret"), false);
  assert.match(retainedDashboard, /https:\/\/github\.com\/example\/agent-stack\.git/);
  await writeFile(path, initial);
  await runtime.reload();

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
    [`/api/sessions/${FLOW}/${ATTEMPT}/context.json`, "POST", 405],
    ["/api/unknown", "GET", 404],
  ] as const) {
    const api = await fetch(url(route), { method });
    assert.equal(api.status, statusCode, route);
    assert.equal(api.headers.get("cache-control"), "no-store", route);
  }
  assert.equal((await fetch(url("/assets/styles.css"), { method: "POST" })).status, 405);
  assert.equal((await fetch(url("/other"))).status, 404);
});

function rawGet(port: number, path: string, authorization?: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers: { authorization } }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode ?? 0 }));
    });
    request.once("error", reject);
    request.end();
  });
}
