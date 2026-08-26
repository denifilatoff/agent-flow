import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderHttpError,
  createRateLimitedHttpClient,
} from "../../src/provider/http.ts";
import { RateLimiter } from "../../src/runtime/rate-limiter.ts";

function harness(
  responses: Response[],
  baseUrl = new URL("https://api.example.test/v1/"),
) {
  let now = 0;
  const delays: number[] = [];
  const requests: Request[] = [];
  const limiter = new RateLimiter(
    { maxCallsPerMinute: 20, quotaReservePercent: 25 },
    {
      now: () => now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
    },
  );
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
  const client = createRateLimitedHttpClient(
    baseUrl,
    () => ({ authorization: "Bearer secret" }),
    limiter,
    fetchImpl,
  );
  return { client, delays, requests };
}

test("treats a GitLab-style base URL without a slash as an API directory", async () => {
  const { client, requests } = harness(
    [Response.json({}), Response.json({})],
    new URL("https://gitlab.example.test/api/v4"),
  );

  await client.request({ path: "user", priority: "active" });
  await client.request({ path: "/api/v4/projects?page=2", priority: "active" });

  assert.equal(requests[0]!.url, "https://gitlab.example.test/api/v4/user");
  assert.equal(requests[1]!.url, "https://gitlab.example.test/api/v4/projects?page=2");
});

test("returns JSON, response headers, and normalized Link pagination", async () => {
  const { client, requests } = harness([
    Response.json(
      { id: 17 },
      {
        headers: {
          etag: '"ticket-17"',
          link: '<https://api.example.test/v1/issues?page=2>; rel="next", <https://api.example.test/v1/issues?page=4>; rel="last"',
        },
      },
    ),
  ]);

  const response = await client.request<{ id: number }>({ path: "issues?page=1", priority: "background" });

  assert.deepEqual(response.data, { id: 17 });
  assert.equal(response.headers.etag, '"ticket-17"');
  assert.equal(response.pagination.next, "/v1/issues?page=2");
  assert.equal(requests[0]!.url, "https://api.example.test/v1/issues?page=1");
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer secret");
});

test("normalizes X-Next-Page and makes provider reset headers pause background work", async () => {
  const { client, delays } = harness([
    Response.json([], {
      headers: {
        "ratelimit-limit": "100",
        "ratelimit-remaining": "25",
        "ratelimit-reset": "60",
        "x-next-page": "3",
      },
    }),
    Response.json([]),
  ]);

  const first = await client.request<unknown[]>({ path: "issues?page=2", priority: "background" });
  await client.request<unknown[]>({ path: "issues?page=3", priority: "background" });

  assert.equal(first.pagination.next, "/v1/issues?page=3");
  assert.equal(delays.at(-1), 60_000);
});

test("applies the longer Retry-After or provider minimum interval to both priorities", async () => {
  const { client, delays } = harness([
    Response.json({}, { headers: { "retry-after": "5", "x-poll-interval": "7" } }),
    Response.json({}),
  ]);

  await client.request({ path: "issues", priority: "background" });
  await client.request({ path: "issues/17", priority: "active" });

  assert.equal(delays.at(-1), 7_000);
});

test("preserves JSON error bodies and classifies only throttling and server failures as transient", async () => {
  const { client } = harness([
    Response.json({ message: "bad request" }, { status: 400 }),
    Response.json({ message: "slow down" }, { status: 429 }),
    Response.json({ message: "unavailable" }, { status: 503 }),
  ]);

  for (const [status, transient] of [[400, false], [429, true], [503, true]] as const) {
    await assert.rejects(
      client.request({ path: `errors/${status}`, priority: "active" }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderHttpError);
        assert.equal(error.status, status);
        assert.equal(error.transient, transient);
        assert.deepEqual(error.body, {
          message: status === 400 ? "bad request" : status === 429 ? "slow down" : "unavailable",
        });
        return true;
      },
    );
  }
});

test("keeps a malformed server response retryable", async () => {
  const { client } = harness([
    new Response("not-json", { status: 502, headers: { "content-type": "application/json" } }),
  ]);

  await assert.rejects(
    client.request({ path: "errors/502", priority: "active" }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.status, 502);
      assert.equal(error.transient, true);
      return true;
    },
  );
});

test("keeps optional ETags in memory and returns a cache miss for 304", async () => {
  const { client, requests } = harness([
    Response.json({ id: 17 }, { headers: { etag: '"v1"' } }),
    new Response(null, { status: 304 }),
  ]);

  await client.request({ path: "issues/17", priority: "active", etagKey: "issue-17" });
  const cached = await client.request({ path: "issues/17", priority: "active", etagKey: "issue-17" });

  assert.equal(requests[1]!.headers.get("if-none-match"), '"v1"');
  assert.equal(cached.notModified, true);
  assert.equal(cached.data, null);
});

test("rejects absolute cross-origin request paths before sending credentials", async () => {
  const { client, requests } = harness([]);

  await assert.rejects(
    client.request({ path: "https://attacker.test/issues", priority: "active" }),
    /same provider origin/,
  );
  assert.equal(requests.length, 0);
});

test("rejects same-origin paths outside the configured API prefix", async () => {
  const { client, requests } = harness([], new URL("https://gitlab.example.test/api/v4"));

  for (const path of ["/user", "../user", "https://gitlab.example.test/user"]) {
    await assert.rejects(
      client.request({ path, priority: "active" }),
      /configured provider API prefix/,
    );
  }
  assert.equal(requests.length, 0);
});
