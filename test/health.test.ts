import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createHealthServer, createReadiness } from "../src/health.ts";

test("reports live before preflight and ready only after every check", async (t) => {
  const readiness = createReadiness();
  const server = createHealthServer(0, readiness);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;

  assert.equal((await fetch(`http://127.0.0.1:${port}/health/live`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 503);
  readiness.markReady();
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 200);
  readiness.markNotReady();
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 503);
  assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
});
