import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createGitHubAdapter } from "../../src/provider/github.ts";
import { ProviderHttpError } from "../../src/provider/http.ts";
import type {
  ProviderRequest,
  ProviderResponse,
  RateLimitedHttpClient,
} from "../../src/provider/types.ts";

const SINCE = "2026-08-25T10:00:00.000Z";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const REPOSITORY = "owner/repo";
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/github/api.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

interface Reply {
  data: unknown;
  next?: string | null;
  error?: Error;
}

class FixtureClient implements RateLimitedHttpClient {
  readonly calls: ProviderRequest[] = [];
  readonly #routes = new Map<string, Reply[]>();

  add(method: ProviderRequest["method"], path: string, ...replies: Reply[]): this {
    this.#routes.set(`${method ?? "GET"} ${path}`, replies);
    return this;
  }

  async request<T>(request: ProviderRequest): Promise<ProviderResponse<T>> {
    this.calls.push(request);
    assert.equal(request.headers?.accept, "application/vnd.github+json");
    assert.equal(request.headers?.["x-github-api-version"], "2022-11-28");

    const key = `${request.method ?? "GET"} ${request.path}`;
    const replies = this.#routes.get(key);
    const reply = replies?.shift();
    if (!reply) throw new Error(`unexpected GitHub fixture request: ${key}`);
    if (reply.error) throw reply.error;
    return {
      status: 200,
      data: reply.data as T,
      headers: {},
      pagination: { next: reply.next ?? null },
      notModified: false,
    };
  }
}

function adapter(client: FixtureClient) {
  return createGitHubAdapter(
    {
      apiUrl: "https://api.github.example.test",
      tokenEnv: "GITHUB_TOKEN",
      repositories: [REPOSITORY],
    },
    client,
  );
}

test("verifies auth and reads canonical repository identity", async () => {
  const client = new FixtureClient()
    .add("GET", "user", { data: fixture.user })
    .add("GET", "repos/owner/repo", { data: fixture.repository });
  const github = adapter(client);

  assert.deepEqual(await github.verifyAuth(), { login: "controller", providerId: "41" });
  assert.deepEqual(await github.readRepository(REPOSITORY), {
    provider: "github",
    name: REPOSITORY,
    host: "github.example.test",
    cloneUrl: "https://github.example.test/owner/repo.git",
  });
  assert.deepEqual(client.calls.map(({ priority }) => priority), ["active", "active"]);
});

test("discovers changed issues and normalizes one snapshot", async () => {
  const discoveryPath =
    "repos/owner/repo/issues?state=all&since=2026-08-25T09%3A59%3A59.000Z&per_page=100";
  const client = new FixtureClient()
    .add("GET", discoveryPath, {
      data: fixture.discovery,
      next:
        "repos/owner/repo/issues?state=all&since=2026-08-25T09%3A59%3A59.000Z&per_page=100&page=2",
    })
    .add("GET", "repos/owner/repo", { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: fixture.issue })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", {
      data: fixture.timelineFirst,
      next: "repos/owner/repo/issues/17/timeline?page=2",
    })
    .add("GET", "repos/owner/repo/issues/17/timeline?page=2", {
      data: fixture.timelineSecond,
    })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", {
      data: fixture.commentsFirst,
      next: "repos/owner/repo/issues/17/comments?page=2",
    })
    .add("GET", "repos/owner/repo/issues/17/comments?page=2", {
      data: fixture.commentsSecond,
    })
    .add("GET", "repos/owner/repo/pulls/31", { data: fixture.pull });
  const github = adapter(client);

  const page = await github.discover(REPOSITORY, { updatedAfter: SINCE, overlapSeconds: 1 });
  assert.deepEqual(page, {
    tickets: [{ provider: "github", repository: REPOSITORY, number: 17 }],
    nextCursor:
      "repos/owner/repo/issues?state=all&since=2026-08-25T09%3A59%3A59.000Z&per_page=100&page=2",
  });
  const ticket = await github.readTicket(page.tickets[0]!);
  assert.equal(ticket.activation.present, true);
  assert.equal(ticket.activation.eventId, "803");
  assert.equal(ticket.activation.actor?.login, "maintainer");
  assert.deepEqual(ticket.labels, ["bug", "agent-flow:development", "agent-stage:review"]);
  assert.deepEqual(ticket.comments.map(({ id }) => id), ["901", "902"]);
  assert.equal(ticket.changeRequest?.number, 31);
  assert.equal(ticket.changeRequest?.headSha, HEAD_SHA);
  assert.equal(ticket.changeRequest?.state, "merged");
  assert.equal(client.calls[0]!.priority, "background");
  assert.ok(client.calls.slice(1).every(({ priority }) => priority === "active"));
});

test("rejects a discovery cursor that targets another repository", async () => {
  await assert.rejects(
    adapter(new FixtureClient()).discover(
      REPOSITORY,
      { updatedAfter: SINCE, overlapSeconds: 1 },
      "repos/other/repo/issues?hint=repos/owner/repo/issues",
    ),
    /does not belong/,
  );
});

test("binds discovery cursors to the exact API resource and window", async () => {
  const window = { updatedAfter: SINCE, overlapSeconds: 1 };
  const query = "state=all&since=2026-08-25T09%3A59%3A59.000Z&per_page=100&page=2";
  const validCursor = `repos/owner/repo/issues?${query}`;
  const client = new FixtureClient().add("GET", validCursor, { data: [] });
  const github = adapter(client);

  assert.deepEqual(await github.discover(REPOSITORY, window, validCursor), {
    tickets: [],
    nextCursor: null,
  });

  await assert.rejects(
    github.discover(REPOSITORY, window, `evil/repos/owner/repo/issues?${query}`),
    /does not belong/,
  );
  await assert.rejects(
    github.discover(REPOSITORY, window, "repos/owner/repo/issues?state=all&per_page=100&page=2"),
    /discovery window/,
  );
  await assert.rejects(
    github.discover(
      REPOSITORY,
      window,
      "repos/owner/repo/issues?state=all&since=2026-08-25T09%3A59%3A58.000Z&per_page=100&page=2",
    ),
    /discovery window/,
  );
  await assert.rejects(
    github.discover(REPOSITORY, window, `repos/owner/repo/issues?${query}&page=3`),
    /discovery window/,
  );
});

test("bootstraps the union of managed and activation labels across pages", async () => {
  const managedPath =
    "repos/owner/repo/issues?state=all&labels=agent-flow%3Amanaged&per_page=100";
  const activationPath =
    "repos/owner/repo/issues?state=all&labels=agent-flow%3Adevelopment&per_page=100";
  const client = new FixtureClient()
    .add("GET", managedPath, {
      data: [{ number: 17 }, { number: 18, pull_request: {} }],
      next: "repos/owner/repo/issues?labels=agent-flow%3Amanaged&page=2",
    })
    .add("GET", "repos/owner/repo/issues?labels=agent-flow%3Amanaged&page=2", {
      data: [{ number: 19 }],
    })
    .add("GET", activationPath, {
      data: [{ number: 17 }, { number: 20 }],
    });

  assert.deepEqual(await adapter(client).bootstrap(REPOSITORY), [
    { provider: "github", repository: REPOSITORY, number: 17 },
    { provider: "github", repository: REPOSITORY, number: 19 },
    { provider: "github", repository: REPOSITORY, number: 20 },
  ]);
  assert.ok(client.calls.every(({ priority }) => priority === "background"));
});

test("maps permissions and performs comment CRUD", async () => {
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo/collaborators/maintainer/permission", {
      data: fixture.permission,
    })
    .add("GET", "repos/owner/repo/issues/comments/903", { data: fixture.comment })
    .add("POST", "repos/owner/repo/issues/17/comments", { data: fixture.createdComment })
    .add("PATCH", "repos/owner/repo/issues/comments/903", { data: fixture.updatedComment });
  const github = adapter(client);
  const ref = { provider: "github" as const, repository: REPOSITORY, number: 17 };

  assert.equal(await github.permission(REPOSITORY, { login: "maintainer", providerId: "7" }), "write");
  assert.equal((await github.readComment(ref, "903")).body, "question");
  assert.equal((await github.createComment(ref, "created")).id, "904");
  assert.equal((await github.updateComment(ref, "903", "updated")).body, "updated");
  assert.deepEqual(client.calls[2]!.body, { body: "created" });
  assert.deepEqual(client.calls[3]!.body, { body: "updated" });
  assert.ok(client.calls.every(({ priority }) => priority === "active"));
});

test("updates controller labels without replacing concurrently added repository labels", async () => {
  const client = new FixtureClient()
    .add("DELETE", "repos/owner/repo/issues/17/labels/agent-stage%3Areview", {
      data: [{ name: "bug" }, { name: "agent-flow:development" }],
    })
    .add("POST", "repos/owner/repo/issues/17/labels", {
      data: [
        { name: "bug" },
        { name: "agent-flow:development" },
        { name: "concurrent-user-label" },
        { name: "agent-stage:done" }
      ],
    })
    .add("GET", "repos/owner/repo/issues/17", {
      data: {
        ...(fixture.issue as Record<string, unknown>),
        labels: [
          { name: "bug" },
          { name: "agent-flow:development" },
          { name: "concurrent-user-label" },
          { name: "agent-stage:done" }
        ],
      },
    });
  const github = adapter(client);
  const ref = { provider: "github" as const, repository: REPOSITORY, number: 17 };

  assert.deepEqual(
    await github.setControllerLabels(ref, ["agent-stage:review"], ["agent-stage:done"]),
    ["bug", "agent-flow:development", "concurrent-user-label", "agent-stage:done"],
  );
  assert.deepEqual(client.calls.map(({ method }) => method ?? "GET"), ["DELETE", "POST", "GET"]);
  assert.deepEqual(client.calls[1]!.body, { labels: ["agent-stage:done"] });
  await assert.rejects(
    github.setControllerLabels(ref, ["bug"], []),
    /not controller-owned/,
  );
});

test("continues a label transition when the old label is already absent", async () => {
  const missing = new ProviderHttpError("label not found", 404, false, {
    message: "Label does not exist",
  }, {});
  const client = new FixtureClient()
    .add("DELETE", "repos/owner/repo/issues/17/labels/agent-stage%3Areview", {
      data: null,
      error: missing,
    })
    .add("POST", "repos/owner/repo/issues/17/labels", {
      data: [{ name: "agent-stage:done" }],
    })
    .add("GET", "repos/owner/repo/issues/17", {
      data: {
        ...(fixture.issue as Record<string, unknown>),
        labels: [{ name: "bug" }, { name: "agent-stage:done" }],
      },
    });
  const ref = { provider: "github" as const, repository: REPOSITORY, number: 17 };

  assert.deepEqual(
    await adapter(client).setControllerLabels(ref, ["agent-stage:review"], ["agent-stage:done"]),
    ["bug", "agent-stage:done"],
  );
  assert.deepEqual(client.calls.map(({ method }) => method ?? "GET"), ["DELETE", "POST", "GET"]);

  const serverFailure = new ProviderHttpError("provider unavailable", 503, true, null, {});
  const failingClient = new FixtureClient().add(
    "DELETE",
    "repos/owner/repo/issues/17/labels/agent-stage%3Areview",
    { data: null, error: serverFailure },
  );
  await assert.rejects(
    adapter(failingClient).setControllerLabels(ref, ["agent-stage:review"], ["agent-stage:done"]),
    (error) => error === serverFailure,
  );
});

test("ignores cross-referenced pull requests from another repository", async () => {
  const crossRepositoryTimeline = [{
    id: 805,
    event: "cross-referenced",
    created_at: "2026-08-25T10:00:10Z",
    actor: { id: 8, login: "developer" },
    source: {
      type: "issue",
      issue: {
        number: 31,
        repository_url: "https://api.github.example.test/repos/other/repo",
        pull_request: {
          url: "https://api.github.example.test/repos/other/repo/pulls/31",
        },
      },
    },
  }];
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo", { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: fixture.issue })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", {
      data: crossRepositoryTimeline,
    })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", { data: [] })
    .add("GET", "repos/owner/repo/pulls/31", { data: fixture.pull });
  const ref = { provider: "github" as const, repository: REPOSITORY, number: 17 };

  assert.equal((await adapter(client).readTicket(ref)).changeRequest, null);
  assert.equal(client.calls.some(({ path }) => path.endsWith("/pulls/31")), false);
});

test("reads change request and review state at the provider head", async () => {
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo/pulls/31", { data: fixture.pull })
    .add("GET", "repos/owner/repo/pulls/31/reviews/701", { data: fixture.review });
  const github = adapter(client);
  const ref = { provider: "github" as const, repository: REPOSITORY, number: 17 };

  const change = await github.readChangeRequest(ref, 31);
  assert.equal(change.state, "merged");
  assert.equal(change.headSha, HEAD_SHA);
  assert.deepEqual(await github.readReview(ref, 31, "701"), {
    id: "701",
    url: "https://github.example.test/owner/repo/pull/31#pullrequestreview-701",
    actor: { login: "reviewer", providerId: "9" },
    submittedAt: "2026-08-25T10:30:00Z",
    headSha: HEAD_SHA,
    verdict: "changes-requested",
    body: "Please fix the edge case.",
  });
});

test("rejects an unknown pull request state", async () => {
  const malformedPull = {
    ...(fixture.pull as Record<string, unknown>),
    merged_at: null,
    state: "draft",
  };
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo/pulls/31", { data: malformedPull });
  const ref = { provider: "github" as const, repository: REPOSITORY, number: 17 };

  await assert.rejects(adapter(client).readChangeRequest(ref, 31), /pull request state/);
});

test("rejects unknown issue and review states", async () => {
  const malformedIssue = {
    ...(fixture.issue as Record<string, unknown>),
    state: "locked",
  };
  const malformedReview = {
    ...(fixture.review as Record<string, unknown>),
    state: "PENDING",
  };
  const issueClient = new FixtureClient()
    .add("GET", "repos/owner/repo", { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: malformedIssue });
  const reviewClient = new FixtureClient()
    .add("GET", "repos/owner/repo/pulls/31/reviews/701", { data: malformedReview });
  const ref = { provider: "github" as const, repository: REPOSITORY, number: 17 };

  await assert.rejects(adapter(issueClient).readTicket(ref), /issue state/);
  await assert.rejects(adapter(reviewClient).readReview(ref, 31, "701"), /review state/);
});
