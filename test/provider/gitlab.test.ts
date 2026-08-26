import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createGitLabAdapter } from "../../src/provider/gitlab.ts";
import { ProviderHttpError } from "../../src/provider/http.ts";
import type {
  ProviderRequest,
  ProviderResponse,
  RateLimitedHttpClient,
} from "../../src/provider/types.ts";

const SINCE = "2026-08-25T10:00:00.000Z";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const REPOSITORY = "group/project";
const PROJECT = "projects/group%2Fproject";
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/gitlab/api.json", import.meta.url), "utf8"),
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
    assert.equal(request.headers?.accept, "application/json");

    const key = `${request.method ?? "GET"} ${request.path}`;
    const replies = this.#routes.get(key);
    const reply = replies?.shift();
    if (!reply) throw new Error(`unexpected GitLab fixture request: ${key}`);
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

function adapter(
  client: FixtureClient,
  apiUrl = "https://gitlab.example.test/api/v4",
) {
  return createGitLabAdapter(
    {
      apiUrl,
      tokenEnv: "GITLAB_TOKEN",
      repositories: [REPOSITORY],
    },
    client,
  );
}

const ref = { provider: "gitlab" as const, repository: REPOSITORY, number: 23 };

test("verifies auth and reads the encoded canonical project identity", async () => {
  const client = new FixtureClient()
    .add("GET", "user", { data: fixture.user })
    .add("GET", PROJECT, { data: fixture.project });
  const gitlab = adapter(client);

  assert.deepEqual(await gitlab.verifyAuth(), { login: "controller", providerId: "51" });
  assert.deepEqual(await gitlab.readRepository(REPOSITORY), {
    provider: "gitlab",
    name: REPOSITORY,
    host: "gitlab.example.test",
    cloneUrl: "https://gitlab.example.test/group/project.git",
  });
  assert.deepEqual(client.calls.map(({ priority }) => priority), ["active", "active"]);
});

test("uses updated_after and normalizes an issue snapshot", async () => {
  const discoveryPath =
    `${PROJECT}/issues?scope=all&state=all&updated_after=2026-08-25T09%3A59%3A59.000Z&per_page=100`;
  const next =
    `/api/v4/${PROJECT}/issues?scope=all&state=all&updated_after=2026-08-25T09%3A59%3A59.000Z&per_page=100&page=2`;
  const client = new FixtureClient()
    .add("GET", discoveryPath, { data: fixture.discovery, next })
    .add("GET", PROJECT, { data: fixture.project })
    .add("GET", `${PROJECT}/issues/23`, { data: fixture.issue })
    .add("GET", `${PROJECT}/issues/23/resource_label_events?per_page=100`, {
      data: fixture.labelEventsFirst,
      next: `${PROJECT}/issues/23/resource_label_events?per_page=100&page=2`,
    })
    .add("GET", `${PROJECT}/issues/23/resource_label_events?per_page=100&page=2`, {
      data: fixture.labelEventsSecond,
    })
    .add(
      "GET",
      `${PROJECT}/issues/23/notes?activity_filter=only_comments&order_by=created_at&sort=asc&per_page=100`,
      {
        data: fixture.commentsFirst,
        next:
          `${PROJECT}/issues/23/notes?activity_filter=only_comments&order_by=created_at&sort=asc&per_page=100&page=2`,
      },
    )
    .add(
      "GET",
      `${PROJECT}/issues/23/notes?activity_filter=only_comments&order_by=created_at&sort=asc&per_page=100&page=2`,
      { data: fixture.commentsSecond },
    )
    .add("GET", `${PROJECT}/issues/23/related_merge_requests?per_page=100`, {
      data: fixture.relatedMergeRequests,
    })
    .add("GET", `${PROJECT}/merge_requests/41`, { data: fixture.mergeRequest });
  const gitlab = adapter(client);

  const page = await gitlab.discover(REPOSITORY, { updatedAfter: SINCE, overlapSeconds: 1 });
  assert.deepEqual(page, {
    tickets: [{ provider: "gitlab", repository: REPOSITORY, number: 23 }],
    nextCursor: next,
  });
  const ticket = await gitlab.readTicket(page.tickets[0]!);
  assert.equal(ticket.activation.present, true);
  assert.equal(ticket.activation.eventId, "802");
  assert.equal(ticket.activation.actor?.login, "maintainer");
  assert.deepEqual(ticket.labels, ["bug", "agent-flow:development", "agent-stage:review"]);
  assert.deepEqual(ticket.comments.map(({ id }) => id), ["601", "602"]);
  assert.equal(ticket.changeRequest?.number, 41);
  assert.equal(ticket.changeRequest?.state, "open");
  assert.equal(ticket.changeRequest?.headSha, HEAD_SHA);
  assert.equal(client.calls[0]!.priority, "background");
  assert.ok(client.calls.slice(1).every(({ priority }) => priority === "active"));
});

test("binds discovery cursors to the exact project and window", async () => {
  const query =
    "scope=all&state=all&updated_after=2026-08-25T09%3A59%3A59.000Z&per_page=100&page=2";
  const valid = `/api/v4/${PROJECT}/issues?${query}`;
  const client = new FixtureClient().add("GET", valid, { data: [] });
  const gitlab = adapter(client);
  const window = { updatedAfter: SINCE, overlapSeconds: 1 };

  assert.deepEqual(await gitlab.discover(REPOSITORY, window, valid), {
    tickets: [],
    nextCursor: null,
  });
  await assert.rejects(
    gitlab.discover(REPOSITORY, window, `/api/v4/projects/other%2Fproject/issues?${query}`),
    /does not belong/,
  );
  await assert.rejects(
    gitlab.discover(
      REPOSITORY,
      window,
      `/api/v4/${PROJECT}/issues?scope=all&state=all&per_page=100&page=2`,
    ),
    /discovery window/,
  );
  await assert.rejects(
    gitlab.discover(REPOSITORY, window, `${valid}&page=3`),
    /page/,
  );
  await assert.rejects(
    gitlab.discover(
      REPOSITORY,
      window,
      `/api/v4/${PROJECT}/issues?scope=all&state=all&updated_after=2026-08-25T09%3A59%3A59.000Z&per_page=100`,
    ),
    /page/,
  );
  await assert.rejects(
    gitlab.discover(REPOSITORY, window, ""),
    /discovery cursor/,
  );
  await assert.rejects(
    gitlab.discover(REPOSITORY, window, valid.replace("page=2", `page=${"9".repeat(400)}`)),
    /discovery cursor requires one advancing page parameter/,
  );
});

test("rejects provider pagination that changes routes or omits an advancing page", async () => {
  const discovery =
    `${PROJECT}/issues?scope=all&state=all&updated_after=2026-08-25T09%3A59%3A59.000Z&per_page=100`;
  const noPageClient = new FixtureClient().add("GET", discovery, {
    data: fixture.discovery,
    next: `/api/v4/${discovery}`,
  });
  await assert.rejects(
    adapter(noPageClient).discover(REPOSITORY, { updatedAfter: SINCE, overlapSeconds: 1 }),
    /pagination.*page/,
  );

  const hugePageClient = new FixtureClient().add("GET", discovery, {
    data: fixture.discovery,
    next: `/api/v4/${discovery}&page=${"9".repeat(400)}`,
  });
  await assert.rejects(
    adapter(hugePageClient).discover(REPOSITORY, { updatedAfter: SINCE, overlapSeconds: 1 }),
    /pagination.*page/,
  );

  const managed = `${PROJECT}/issues?scope=all&state=all&labels=agent-flow%3Amanaged&per_page=100`;
  const crossProjectClient = new FixtureClient().add("GET", managed, {
    data: [{ iid: 23 }],
    next:
      "/api/v4/projects/other%2Fproject/issues?scope=all&state=all&labels=agent-flow%3Amanaged&per_page=100&page=2",
  });
  await assert.rejects(adapter(crossProjectClient).bootstrap(REPOSITORY), /pagination.*route/);

  const changedFilterClient = new FixtureClient().add("GET", managed, {
    data: [{ iid: 23 }],
    next:
      `/api/v4/${PROJECT}/issues?scope=all&state=opened&labels=agent-flow%3Amanaged&per_page=100&page=2`,
  });
  await assert.rejects(adapter(changedFilterClient).bootstrap(REPOSITORY), /pagination.*filters/);
});

test("bootstraps the union of managed and activation labels across pages", async () => {
  const managed = `${PROJECT}/issues?scope=all&state=all&labels=agent-flow%3Amanaged&per_page=100`;
  const activation =
    `${PROJECT}/issues?scope=all&state=all&labels=agent-flow%3Adevelopment&per_page=100`;
  const client = new FixtureClient()
    .add("GET", managed, {
      data: [{ iid: 23 }],
      next:
        `${PROJECT}/issues?scope=all&state=all&labels=agent-flow%3Amanaged&per_page=100&page=2`,
    })
    .add(
      "GET",
      `${PROJECT}/issues?scope=all&state=all&labels=agent-flow%3Amanaged&per_page=100&page=2`,
      { data: [{ iid: 24 }] },
    )
    .add("GET", activation, { data: [{ iid: 23 }, { iid: 25 }] });

  assert.deepEqual(await adapter(client).bootstrap(REPOSITORY), [
    { provider: "gitlab", repository: REPOSITORY, number: 23 },
    { provider: "gitlab", repository: REPOSITORY, number: 24 },
    { provider: "gitlab", repository: REPOSITORY, number: 25 },
  ]);
  assert.ok(client.calls.every(({ priority }) => priority === "background"));
});

test("maps project access levels and performs issue note CRUD", async () => {
  const client = new FixtureClient()
    .add("GET", `${PROJECT}/members/all/7`, {
      data: { id: 7, username: "maintainer", access_level: 40 },
    })
    .add("GET", `${PROJECT}/members/all/6`, {
      data: { id: 6, username: "developer", access_level: 30 },
    })
    .add("GET", `${PROJECT}/members/all/9`, {
      data: { id: 9, username: "owner", access_level: 50 },
    })
    .add("GET", `${PROJECT}/members/all/10`, {
      data: { id: 10, username: "reporter", access_level: 20 },
    })
    .add("GET", `${PROJECT}/issues/23/notes/603`, { data: fixture.comment })
    .add("POST", `${PROJECT}/issues/23/notes`, { data: fixture.createdComment })
    .add("PUT", `${PROJECT}/issues/23/notes/603`, { data: fixture.updatedComment });
  const gitlab = adapter(client);

  assert.equal(await gitlab.permission(REPOSITORY, { login: "maintainer", providerId: "7" }), "maintain");
  assert.equal(await gitlab.permission(REPOSITORY, { login: "developer", providerId: "6" }), "write");
  assert.equal(await gitlab.permission(REPOSITORY, { login: "owner", providerId: "9" }), "admin");
  assert.equal(await gitlab.permission(REPOSITORY, { login: "reporter", providerId: "10" }), "read");
  assert.equal((await gitlab.readComment(ref, "603")).body, "question");
  assert.equal((await gitlab.createComment(ref, "created")).id, "604");
  assert.equal((await gitlab.updateComment(ref, "603", "updated")).body, "updated");
  assert.deepEqual(client.calls[5]!.body, { body: "created" });
  assert.deepEqual(client.calls[6]!.body, { body: "updated" });
  assert.ok(client.calls.every(({ priority }) => priority === "active"));
});

test("maps a missing project member to none and preserves other provider errors", async () => {
  const missing = new ProviderHttpError("member not found", 404, false, null, {});
  const unavailable = new ProviderHttpError("provider unavailable", 503, true, null, {});
  const client = new FixtureClient()
    .add("GET", `${PROJECT}/members/all/11`, { data: null, error: missing })
    .add("GET", `${PROJECT}/members/all/12`, { data: null, error: unavailable });
  const gitlab = adapter(client);

  assert.equal(await gitlab.permission(REPOSITORY, { login: "outsider", providerId: "11" }), "none");
  await assert.rejects(
    gitlab.permission(REPOSITORY, { login: "developer", providerId: "12" }),
    (error) => error === unavailable,
  );
});

test("updates only reserved labels and preserves concurrent user labels", async () => {
  const updatedIssue = {
    ...(fixture.issue as Record<string, unknown>),
    labels: ["bug", "concurrent-user-label", "agent-stage:done"],
  };
  const client = new FixtureClient()
    .add("PUT", `${PROJECT}/issues/23`, { data: updatedIssue })
    .add("GET", `${PROJECT}/issues/23`, { data: updatedIssue });
  const gitlab = adapter(client);

  assert.deepEqual(
    await gitlab.setControllerLabels(
      ref,
      ["agent-stage:review", "agent-stage:review"],
      ["agent-stage:done", "agent-stage:done"],
    ),
    ["bug", "concurrent-user-label", "agent-stage:done"],
  );
  assert.deepEqual(client.calls[0]!.body, {
    remove_labels: "agent-stage:review",
    add_labels: "agent-stage:done",
  });
  await assert.rejects(gitlab.setControllerLabels(ref, ["bug"], []), /not controller-owned/);
});

test("ignores related merge requests from another project", async () => {
  const client = new FixtureClient()
    .add("GET", PROJECT, { data: fixture.project })
    .add("GET", `${PROJECT}/issues/23`, { data: fixture.issue })
    .add("GET", `${PROJECT}/issues/23/resource_label_events?per_page=100`, { data: [] })
    .add(
      "GET",
      `${PROJECT}/issues/23/notes?activity_filter=only_comments&order_by=created_at&sort=asc&per_page=100`,
      { data: [] },
    )
    .add("GET", `${PROJECT}/issues/23/related_merge_requests?per_page=100`, {
      data: [{
        id: 4100,
        iid: 41,
        project_id: 101,
        references: { full: "other/project!41" },
      }],
    });

  assert.equal((await adapter(client).readTicket(ref)).changeRequest, null);
  assert.equal(client.calls.some(({ path }) => path.endsWith("/merge_requests/41")), false);
});

test("rejects ambiguous related merge requests in the same project", async () => {
  const client = new FixtureClient()
    .add("GET", PROJECT, { data: fixture.project })
    .add("GET", `${PROJECT}/issues/23`, { data: fixture.issue })
    .add("GET", `${PROJECT}/issues/23/resource_label_events?per_page=100`, { data: [] })
    .add(
      "GET",
      `${PROJECT}/issues/23/notes?activity_filter=only_comments&order_by=created_at&sort=asc&per_page=100`,
      { data: [] },
    )
    .add("GET", `${PROJECT}/issues/23/related_merge_requests?per_page=100`, {
      data: [
        { iid: 41, project_id: 100, references: { full: "group/project!41" } },
        { iid: 42, project_id: 100, references: { full: "group/project!42" } },
      ],
    });

  await assert.rejects(adapter(client).readTicket(ref), /multiple related merge requests/);
});

test("reads merge request and structured review-note state", async () => {
  const client = new FixtureClient()
    .add(
      "GET",
      `${PROJECT}/merge_requests/41`,
      { data: fixture.mergeRequest },
      { data: fixture.mergeRequest },
    )
    .add("GET", `${PROJECT}/merge_requests/41/notes/702`, { data: fixture.reviewNote });
  const gitlab = adapter(client);

  const change = await gitlab.readChangeRequest(ref, 41);
  assert.equal(change.state, "open");
  assert.equal(change.headSha, HEAD_SHA);
  assert.deepEqual(await gitlab.readReview(ref, 41, "702"), {
    id: "702",
    url: "https://gitlab.example.test/group/project/-/merge_requests/41#note_702",
    actor: { login: "reviewer", providerId: "9" },
    submittedAt: "2026-08-25T10:30:00.000Z",
    headSha: HEAD_SHA,
    verdict: "changes-requested",
    body: (fixture.reviewNote as Record<string, unknown>).body,
  });
});

test("preserves a self-managed GitLab relative URL root for note artifacts", async () => {
  const relativeApi = "https://gitlab.example.test/gitlab/api/v4";
  const relativeMergeRequest = {
    ...(fixture.mergeRequest as Record<string, unknown>),
    web_url: "https://gitlab.example.test/gitlab/group/project/-/merge_requests/41",
  };
  const client = new FixtureClient()
    .add("GET", `${PROJECT}/issues/23/notes/603`, { data: fixture.comment })
    .add("GET", `${PROJECT}/merge_requests/41`, { data: relativeMergeRequest })
    .add("GET", `${PROJECT}/merge_requests/41/notes/702`, { data: fixture.reviewNote });
  const gitlab = adapter(client, relativeApi);

  assert.equal(
    (await gitlab.readComment(ref, "603")).url,
    "https://gitlab.example.test/gitlab/group/project/-/issues/23#note_603",
  );
  assert.equal(
    (await gitlab.readReview(ref, 41, "702")).url,
    "https://gitlab.example.test/gitlab/group/project/-/merge_requests/41#note_702",
  );
});

test("rejects unknown issue, merge request, and review-note states", async () => {
  const badIssueClient = new FixtureClient()
    .add("GET", PROJECT, { data: fixture.project })
    .add("GET", `${PROJECT}/issues/23`, {
      data: { ...(fixture.issue as Record<string, unknown>), state: "locked" },
    });
  await assert.rejects(adapter(badIssueClient).readTicket(ref), /issue state/);

  const badMergeClient = new FixtureClient().add("GET", `${PROJECT}/merge_requests/41`, {
    data: { ...(fixture.mergeRequest as Record<string, unknown>), state: "locked" },
  });
  await assert.rejects(adapter(badMergeClient).readChangeRequest(ref, 41), /merge request state/);

  const badReview = {
    ...(fixture.reviewNote as Record<string, unknown>),
    body: `<!-- agent-flow:v1 flow=flow-1 attempt=attempt-1 artifact=review -->\n`
      + `<!-- agent-flow-review:v1 head=${HEAD_SHA} verdict=pending -->`,
  };
  const badReviewClient = new FixtureClient()
    .add("GET", `${PROJECT}/merge_requests/41`, { data: fixture.mergeRequest })
    .add("GET", `${PROJECT}/merge_requests/41/notes/702`, { data: badReview });
  await assert.rejects(adapter(badReviewClient).readReview(ref, 41, "702"), /review note metadata/);

  const staleReview = {
    ...(fixture.reviewNote as Record<string, unknown>),
    body: `<!-- agent-flow:v1 flow=flow-1 attempt=attempt-1 artifact=review -->\n`
      + "<!-- agent-flow-review:v1 head=1111111111111111111111111111111111111111 verdict=approved -->",
  };
  const staleReviewClient = new FixtureClient()
    .add("GET", `${PROJECT}/merge_requests/41`, { data: fixture.mergeRequest })
    .add("GET", `${PROJECT}/merge_requests/41/notes/702`, { data: staleReview });
  await assert.rejects(adapter(staleReviewClient).readReview(ref, 41, "702"), /head SHA/);
});
