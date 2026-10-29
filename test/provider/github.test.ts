import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfigBundle } from "../../src/config/load.ts";
import { createGitHubAdapter } from "../../src/provider/github.ts";
import { ProviderHttpError } from "../../src/provider/http.ts";
import { classifyRecovery } from "../../src/runtime/recovery.ts";
import { electOwner } from "../../src/provider/publication.ts";
import type {
  ProviderRequest,
  ProviderResponse,
  RateLimitedHttpClient,
} from "../../src/provider/types.ts";
import { readDecisionAndBuildReceipt } from "../../src/runtime/receipts.ts";

const SINCE = "2026-08-25T10:00:00.000Z";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const REPOSITORY = "owner/repo";
const REVIEW_MARKER = "<!-- agent-flow:v1 flow=flow-1 attempt=attempt-1 artifact=review -->";
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

function adapter(client: FixtureClient, activationLabels?: readonly string[]) {
  return createGitHubAdapter(
    {
      apiUrl: "https://api.github.example.test",
      repositories: [REPOSITORY],
    },
    client,
    activationLabels,
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
    cloneRoot: "https://github.example.test/",
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
  assert.equal(ticket.title, "Fix the edge case");
  assert.equal(ticket.description, "Handle the documented edge case without changing existing behavior.");
  assert.equal(ticket.activation.present, true);
  assert.equal(ticket.activation.label, "agent-flow:development");
  assert.equal(ticket.activation.eventId, "803");
  assert.equal(ticket.activation.actor?.login, "maintainer");
  assert.deepEqual(ticket.labels, ["bug", "agent-flow:development", "agent-stage:review"]);
  assert.deepEqual(ticket.comments.map(({ id }) => id), ["901", "902"]);
  assert.equal(ticket.changeRequest?.number, 31);
  assert.equal(ticket.changeRequest?.headSha, HEAD_SHA);
  assert.equal(ticket.changeRequest?.state, "merged");
  assert.equal(ticket.changeRequest?.body.includes("agent-flow:v1"), true);
  assert.equal(ticket.changeRequest?.createdAt, "2026-08-25T10:00:05Z");
  assert.equal(client.calls[0]!.priority, "background");
  assert.ok(client.calls.slice(1).every(({ priority }) => priority === "active"));
});

test("C17 reads complete recovery evidence from paginated comments, linked pulls, and reviews", async () => {
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo", { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: fixture.issue })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", { data: fixture.timelineFirst, next: "repos/owner/repo/issues/17/timeline?page=2" })
    .add("GET", "repos/owner/repo/issues/17/timeline?page=2", {
      data: [
        ...(fixture.timelineSecond as unknown[]),
        {
          id: 805,
          event: "cross-referenced",
          created_at: "2026-08-25T10:00:11Z",
          actor: { id: 8, login: "developer" },
          source: { type: "issue", issue: { number: 32, repository_url: "https://api.github.example.test/repos/owner/repo", pull_request: {} } },
        },
      ],
    })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", {
      data: fixture.commentsFirst,
      next: "repos/owner/repo/issues/17/comments?page=2",
    })
    .add("GET", "repos/owner/repo/issues/17/comments?page=2", { data: [fixture.recoveryComment] })
    .add("GET", "repos/owner/repo/pulls/31", {
      data: { ...fixture.pull, updated_at: "2026-08-25T10:01:00Z" },
    })
    .add("POST", "graphql", { data: { data: { nodes: [{ id: "PRR_review_1", __typename: "PullRequestReview", lastEditedAt: null }] } } }, {
      data: { data: { repository: { pullRequest: { lastEditedAt: null } } } },
    })
    .add("GET", "repos/owner/repo/pulls/32", { data: fixture.secondPull })
    .add("GET", "repos/owner/repo/pulls/31/reviews?per_page=100", { data: [fixture.recoveryReview] })
    .add("GET", "repos/owner/repo/pulls/32/reviews?per_page=100", { data: [] })
    .add("GET", "repos/owner/repo/collaborators/maintainer/permission", { data: { permission: "maintain" } })
    .add("GET", "repos/owner/repo/collaborators/developer/permission", { data: { permission: "push" } })
    .add("GET", "repos/owner/repo/collaborators/reviewer/permission", { data: { permission: "maintain" } });

  const evidence = await adapter(client).readRecoveryEvidence({ provider: "github", repository: REPOSITORY, number: 17 });

  assert.equal(evidence.complete, true);
  assert.equal(evidence.activeBoundary, "fresh");
  assert.equal(evidence.legacyActive, false);
  assert.equal(evidence.snapshot.changeRequest, null);
  assert.equal(evidence.changes.length, 2);
  assert.equal(evidence.reviews.length, 1);
  assert.ok(evidence.publications.some(({ key }) => key.includes("change-request")));
  assert.ok(!evidence.ambiguities.some((value) => value.includes("change-request")
    && value.includes("provenance")));
  assert.ok(evidence.publications.some(({ key }) => key.includes("comment")));
  assert.ok(evidence.publications.some(({ key }) => key.includes("review")));
  assert.ok(electOwner(evidence.publications)?.key.includes("change-request"));
  assert.ok(evidence.ambiguities.some((value) => value.includes("multiple linked")));
  assert.ok(client.calls.some(({ path }) => path.endsWith("collaborators/developer/permission")));
  assert.ok(client.calls.some(({ path }) => path.endsWith("collaborators/reviewer/permission")));
  assert.equal(client.calls.filter(({ path }) => path === "graphql").length, 2);
  assert.ok(client.calls.every(({ priority }) => priority === "active"));
});

test("rejects a GitHub pull request whose publication marker was added after creation", async () => {
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo", { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: fixture.issue })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", { data: fixture.timelineSecond })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", { data: [] })
    .add("GET", "repos/owner/repo/pulls/31", {
      data: { ...fixture.pull, updated_at: "2026-08-25T10:01:00Z" },
    })
    .add("POST", "graphql", {
      data: { data: { repository: { pullRequest: { lastEditedAt: "2026-08-25T10:01:00Z" } } } },
    })
    .add("GET", "repos/owner/repo/pulls/31/reviews?per_page=100", { data: [] })
    .add("GET", "repos/owner/repo/collaborators/maintainer/permission", { data: { permission: "maintain" } })
    .add("GET", "repos/owner/repo/collaborators/developer/permission", { data: { permission: "push" } });

  const evidence = await adapter(client).readRecoveryEvidence({
    provider: "github",
    repository: REPOSITORY,
    number: 17,
  });

  assert.equal(evidence.publications.some(({ key, ownershipEligible }) => ownershipEligible !== false && key.includes("change-request")), false);
  assert.ok(evidence.ambiguities.some((value) => value.includes("publication provenance")));
  assert.equal(client.calls.filter(({ path }) => path === "graphql").length, 1);
});

test("marks a first activation without managed or stage history as fresh", async () => {
  const issue = {
    ...(fixture.issue as Record<string, unknown>),
    labels: [{ name: "bug" }, { name: "agent-flow:development" }],
  };
  const activation = (fixture.timelineSecond as unknown[])[0];
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo", { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: issue })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", { data: [activation] })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", { data: [] })
    .add("GET", "repos/owner/repo/collaborators/maintainer/permission", {
      data: { permission: "maintain" },
    });

  const evidence = await adapter(client).readRecoveryEvidence({
    provider: "github",
    repository: REPOSITORY,
    number: 17,
  });

  assert.equal(evidence.activeBoundary, "fresh");
  assert.deepEqual(evidence.publications, []);
  assert.deepEqual(evidence.ambiguities, []);
});

test("fresh recovery ignores pull requests created before the latest activation", async () => {
  const oldLink = {
    id: 799,
    event: "cross-referenced",
    created_at: "2026-08-25T09:10:00Z",
    actor: { id: 8, login: "developer" },
    source: {
      issue: {
        number: 31,
        repository_url: "https://api.github.example.test/repos/owner/repo",
        pull_request: {},
      },
    },
  };
  const oldPull = {
    ...(fixture.pull as Record<string, unknown>),
    created_at: "2026-08-25T09:05:00Z",
    updated_at: "2026-08-25T09:05:00Z",
  };
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo", { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: fixture.issue })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", {
      data: [...(fixture.timelineFirst as unknown[]), oldLink, ...(fixture.timelineSecond as unknown[])],
    })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", { data: [] })
    .add("GET", "repos/owner/repo/pulls/31", { data: oldPull })
    .add("GET", "repos/owner/repo/pulls/31/reviews?per_page=100", { data: [fixture.recoveryReview] })
    .add("GET", "repos/owner/repo/collaborators/maintainer/permission", { data: { permission: "maintain" } });

  const evidence = await adapter(client).readRecoveryEvidence({
    provider: "github",
    repository: REPOSITORY,
    number: 17,
  });

  assert.equal(evidence.activeBoundary, "fresh");
  assert.deepEqual(evidence.changes, []);
  assert.deepEqual(evidence.reviews, []);
  assert.deepEqual(evidence.publications, []);
  assert.equal(evidence.ambiguities.some((value) => value.includes("multiple linked")), false);
});

test("treats a publication with the activation timestamp as ambiguous", async () => {
  const comment = {
    ...(fixture.recoveryComment as Record<string, unknown>),
    created_at: "2026-08-25T10:00:00Z",
    updated_at: "2026-08-25T10:00:00Z",
  };
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo", { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: fixture.issue })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", {
      data: [...(fixture.timelineFirst as unknown[]), (fixture.timelineSecond as unknown[])[0]],
    })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", { data: [comment] })
    .add("GET", "repos/owner/repo/collaborators/maintainer/permission", { data: { permission: "maintain" } })
    .add("GET", "repos/owner/repo/collaborators/developer/permission", { data: { permission: "write" } });

  const evidence = await adapter(client).readRecoveryEvidence({
    provider: "github",
    repository: REPOSITORY,
    number: 17,
  });

  assert.deepEqual(evidence.publications, []);
  assert.ok(evidence.ambiguities.some((value) => value.includes("activation timestamp")));
});

test("development verification selects the pull request from the second activation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-github-reactivation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const decision = join(root, "decision.json");
  await writeFile(decision, '{"event":"agent-succeeded"}\n');
  const oldLink = {
    id: 799,
    event: "cross-referenced",
    created_at: "2026-08-25T09:10:00Z",
    source: { issue: { number: 31, repository_url: "https://api.github.example.test/repos/owner/repo", pull_request: {} } },
  };
  const newLink = {
    id: 805,
    event: "cross-referenced",
    created_at: "2026-08-25T10:00:11Z",
    source: { issue: { number: 32, repository_url: "https://api.github.example.test/repos/owner/repo", pull_request: {} } },
  };
  const oldPull = {
    ...(fixture.pull as Record<string, unknown>),
    created_at: "2026-08-25T09:05:00Z",
    updated_at: "2026-08-25T09:05:00Z",
  };
  const currentPull = {
    ...(fixture.secondPull as Record<string, unknown>),
    body: (fixture.pull as { body: string }).body,
  };
  const timeline = [...(fixture.timelineFirst as unknown[]), oldLink, ...(fixture.timelineSecond as unknown[]), newLink];
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo", { data: fixture.repository }, { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: fixture.issue }, { data: fixture.issue })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", { data: timeline }, { data: timeline })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", { data: [] }, { data: [] })
    .add("GET", "repos/owner/repo/pulls/31", { data: oldPull }, { data: oldPull })
    .add("GET", "repos/owner/repo/pulls/32", { data: currentPull }, { data: currentPull }, { data: currentPull })
    .add("GET", "repos/owner/repo/collaborators/developer/permission", { data: { permission: "write" } });
  const bundle = await loadConfigBundle(process.cwd(), "config/stack.yaml", "a".repeat(40));

  const receipt = await readDecisionAndBuildReceipt(decision, {
    flow: bundle.flow,
    stateId: "development",
    mode: "stage",
    resultContract: "development",
    configRevision: "a".repeat(40),
    controllerId: "11111111-1111-4111-8111-111111111111",
    publicationKeys: [],
    flowInstanceId: "33333333-3333-4333-8333-333333333333",
    attemptId: "44444444-4444-4444-8444-444444444444",
    ticket: { provider: "github", repository: REPOSITORY, number: 17 },
    sourceComment: null,
    pinnedChangeRequest: null,
  }, adapter(client), false);

  assert.equal(receipt.artifacts[0]?.kind, "change-request");
  assert.equal(receipt.artifacts[0]?.kind === "change-request" ? receipt.artifacts[0].number : null, 32);
});

test("C17 rejects incomplete GitHub recovery evidence pages", async () => {
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo", { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: fixture.issue })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", { data: [] })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", {
      data: fixture.commentsFirst,
      next: "repos/owner/repo/issues/17/comments?page=2",
    })
    .add("GET", "repos/owner/repo/issues/17/comments?page=2", { data: null, error: new Error("page failed") });

  await assert.rejects(
    adapter(client).readRecoveryEvidence({ provider: "github", repository: REPOSITORY, number: 17 }),
    /page failed/,
  );
});

test("marks a REST connected GitHub event without a linked pull request as ambiguous", async () => {
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo", { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: fixture.issue })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", {
      data: [
        {
          id: 901,
          event: "labeled",
          created_at: "2026-08-25T10:00:00Z",
          actor: { id: 7, login: "maintainer" },
          label: { name: "agent-flow:development" },
        },
        {
          id: 902,
          event: "connected",
          created_at: "2026-08-25T10:00:01Z",
        },
      ],
    })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", { data: [] })
    .add("GET", "repos/owner/repo/collaborators/maintainer/permission", { data: { permission: "maintain" } });

  const evidence = await adapter(client).readRecoveryEvidence({ provider: "github", repository: REPOSITORY, number: 17 });

  assert.deepEqual(evidence.changes, []);
  assert.ok(evidence.ambiguities.includes("unresolved connected GitHub pull request: 902"));
});

test("ignores an unmarked pending GitHub review without a submission time", async () => {
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo", { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: fixture.issue })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", {
      data: [
        {
          id: 901,
          event: "labeled",
          created_at: "2026-08-25T10:00:00Z",
          actor: { id: 7, login: "maintainer" },
          label: { name: "agent-flow:development" },
        },
        {
          id: 902,
          event: "cross-referenced",
          source: { issue: { number: 31, repository_url: "https://api.github.example.test/repos/owner/repo", pull_request: {} } },
        },
      ],
    })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", { data: [] })
    .add("GET", "repos/owner/repo/pulls/31", { data: fixture.pull })
    .add("GET", "repos/owner/repo/pulls/31/reviews?per_page=100", {
      data: [{ id: 705, state: "PENDING", body: "Draft review", user: { id: 9, login: "reviewer" } }],
    })
    .add("GET", "repos/owner/repo/collaborators/maintainer/permission", { data: { permission: "maintain" } })
    .add("GET", "repos/owner/repo/collaborators/developer/permission", { data: { permission: "push" } });

  const evidence = await adapter(client).readRecoveryEvidence({ provider: "github", repository: REPOSITORY, number: 17 });

  assert.deepEqual(evidence.reviews, []);
  assert.equal(evidence.ambiguities.some((value) => value.includes("review")), false);
});

test("marks a marked pending GitHub review without a submission time as ambiguous", async () => {
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo", { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: fixture.issue })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", {
      data: [
        {
          id: 901,
          event: "labeled",
          created_at: "2026-08-25T10:00:00Z",
          actor: { id: 7, login: "maintainer" },
          label: { name: "agent-flow:development" },
        },
        {
          id: 902,
          event: "cross-referenced",
          source: { issue: { number: 31, repository_url: "https://api.github.example.test/repos/owner/repo", pull_request: {} } },
        },
      ],
    })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", { data: [] })
    .add("GET", "repos/owner/repo/pulls/31", { data: fixture.pull })
    .add("GET", "repos/owner/repo/pulls/31/reviews?per_page=100", {
      data: [{ id: 705, state: "PENDING", body: "<!-- agent-flow:review -->\nApproved", user: { id: 9, login: "reviewer" } }],
    })
    .add("GET", "repos/owner/repo/collaborators/maintainer/permission", { data: { permission: "maintain" } })
    .add("GET", "repos/owner/repo/collaborators/developer/permission", { data: { permission: "push" } });

  const evidence = await adapter(client).readRecoveryEvidence({ provider: "github", repository: REPOSITORY, number: 17 });

  assert.deepEqual(evidence.reviews, []);
  assert.ok(evidence.ambiguities.some((value) => value.includes("review submission time is unavailable")));
});

test("uses the canonical GitHub repository name in recovery publication keys", async () => {
  const repository = { ...(fixture.repository as Record<string, unknown>), full_name: "Owner/Repo" };
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo", { data: repository })
    .add("GET", "repos/owner/repo/issues/17", { data: fixture.issue })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", {
      data: [
        {
          id: 901,
          event: "labeled",
          created_at: "2026-08-25T10:00:00Z",
          actor: { id: 7, login: "maintainer" },
          label: { name: "agent-flow:development" },
        },
        {
          id: 902,
          event: "cross-referenced",
          source: { issue: { number: 31, repository_url: "https://api.github.example.test/repos/owner/repo", pull_request: {} } },
        },
      ],
    })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", { data: [] })
    .add("GET", "repos/owner/repo/pulls/31", { data: fixture.pull })
    .add("GET", "repos/owner/repo/pulls/31/reviews?per_page=100", { data: [] })
    .add("GET", "repos/owner/repo/collaborators/maintainer/permission", { data: { permission: "maintain" } })
    .add("GET", "repos/owner/repo/collaborators/developer/permission", { data: { permission: "push" } });

  const evidence = await adapter(client).readRecoveryEvidence({ provider: "github", repository: REPOSITORY, number: 17 });

  assert.equal(JSON.parse(evidence.publications[0]!.key)[2], "Owner/Repo");
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

test("bootstraps active and managed tickets across pages", async () => {
  const activationPath =
    "repos/owner/repo/issues?state=all&labels=agent-flow%3Adevelopment&per_page=100";
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo/issues?state=all&labels=agent-flow%3Amanaged&per_page=100", { data: [] })
    .add("GET", activationPath, {
      data: [{ number: 17 }, { number: 18, pull_request: {} }],
      next: "repos/owner/repo/issues?labels=agent-flow%3Adevelopment&page=2",
    })
    .add("GET", "repos/owner/repo/issues?labels=agent-flow%3Adevelopment&page=2", {
      data: [{ number: 20 }],
    });

  assert.deepEqual(await adapter(client).bootstrap(REPOSITORY), [
    { provider: "github", repository: REPOSITORY, number: 17 },
    { provider: "github", repository: REPOSITORY, number: 20 },
  ]);
  assert.ok(client.calls.every(({ priority }) => priority === "background"));
});

test("uses a configured bugfix label for bootstrap and activation", async () => {
  const managedPath = "repos/owner/repo/issues?state=all&labels=agent-flow%3Amanaged&per_page=100";
  const bugfixPath = "repos/owner/repo/issues?state=all&labels=bugfix&per_page=100";
  const issue = {
    ...(fixture.issue as Record<string, unknown>),
    labels: [{ name: "bugfix" }],
  };
  const event = {
    id: 900,
    event: "labeled",
    created_at: "2026-08-25T10:00:00Z",
    actor: { id: 7, login: "maintainer" },
    label: { name: "bugfix" },
  };
  const client = new FixtureClient()
    .add("GET", managedPath, { data: [] })
    .add("GET", bugfixPath, { data: [{ number: 17 }] })
    .add("GET", "repos/owner/repo", { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: issue }, { data: { ...issue, labels: [] } })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", { data: [event] })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", { data: [] })
    .add("DELETE", "repos/owner/repo/issues/17/labels/bugfix", { data: [] });
  const github = adapter(client, ["bugfix"]);

  assert.deepEqual(await github.bootstrap(REPOSITORY), [
    { provider: "github", repository: REPOSITORY, number: 17 },
  ]);
  const ticket = await github.readTicket({ provider: "github", repository: REPOSITORY, number: 17 });
  assert.equal(ticket.activation.present, true);
  assert.equal(ticket.activation.eventId, "900");
  assert.equal(ticket.activation.actor?.login, "maintainer");
  assert.deepEqual(
    await github.setControllerLabels(ticket.ref, ["bugfix"], []),
    [],
  );
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

test("removes an activation label pinned by an older flow revision", async () => {
  const issue = { ...(fixture.issue as Record<string, unknown>), labels: [] };
  const client = new FixtureClient()
    .add("DELETE", "repos/owner/repo/issues/17/labels/legacy-bugfix", { data: [] })
    .add("GET", "repos/owner/repo/issues/17", { data: issue });

  assert.deepEqual(
    await adapter(client).setControllerLabels(
      { provider: "github", repository: REPOSITORY, number: 17 },
      ["legacy-bugfix"],
      [],
      ["legacy-bugfix"],
    ),
    [],
  );
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
    body:
      "<!-- agent-flow:v1 flow=flow-1 attempt=attempt-1 artifact=review -->\n"
      + `<!-- agent-flow-review:v1 head=${HEAD_SHA} verdict=changes-requested -->\n`
      + "Please fix the edge case.",
  });
});

test("discovers a paginated GitHub COMMENT review by its exact first-line marker", async () => {
  const listPath = "repos/owner/repo/pulls/31/reviews?per_page=100";
  const client = new FixtureClient()
    .add("GET", listPath, {
      data: [fixture.unrelatedReview],
      next: `${listPath}&page=2`,
    })
    .add("GET", `${listPath}&page=2`, { data: [fixture.commentReview] })
    .add("GET", "repos/owner/repo/pulls/31/reviews/703", { data: fixture.commentReview });
  const github = adapter(client);
  const ref = { provider: "github" as const, repository: REPOSITORY, number: 17 };

  const found = await github.findReview(ref, 31, REVIEW_MARKER);

  assert.equal(found?.id, "703");
  assert.equal(found?.verdict, "approved");
  assert.deepEqual(await github.readReview(ref, 31, found!.id), found);
});

test("returns null when no GitHub review starts with the exact marker", async () => {
  const client = new FixtureClient().add(
    "GET",
    "repos/owner/repo/pulls/31/reviews?per_page=100",
    { data: [fixture.unrelatedReview] },
  );
  const ref = { provider: "github" as const, repository: REPOSITORY, number: 17 };

  assert.equal(await adapter(client).findReview(ref, 31, REVIEW_MARKER), null);
});

test("rejects duplicate GitHub reviews with the same publication marker", async () => {
  const duplicate = { ...(fixture.commentReview as Record<string, unknown>), id: 704 };
  const client = new FixtureClient().add(
    "GET",
    "repos/owner/repo/pulls/31/reviews?per_page=100",
    { data: [fixture.commentReview, duplicate] },
  );
  const ref = { provider: "github" as const, repository: REPOSITORY, number: 17 };

  await assert.rejects(
    adapter(client).findReview(ref, 31, REVIEW_MARKER),
    /multiple GitHub reviews.*publication marker/,
  );
});

test("excludes baseline GitHub reviews when locating the current result", async () => {
  const duplicate = { ...(fixture.commentReview as Record<string, unknown>), id: 704 };
  const client = new FixtureClient().add(
    "GET",
    "repos/owner/repo/pulls/31/reviews?per_page=100",
    { data: [fixture.commentReview, duplicate] },
  );
  const ref = { provider: "github" as const, repository: REPOSITORY, number: 17 };

  assert.equal((await adapter(client).findReview(ref, 31, REVIEW_MARKER, ["703"]))?.id, "704");
});

test("reads the logical verdict from a GitHub COMMENT review", async () => {
  const review = {
    ...(fixture.review as Record<string, unknown>),
    state: "COMMENTED",
    body:
      "<!-- agent-flow:v1 flow=flow-1 attempt=attempt-1 artifact=review -->\n"
      + `<!-- agent-flow-review:v1 head=${HEAD_SHA} verdict=approved -->`,
  };
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo/pulls/31/reviews/701", { data: review });
  const ref = { provider: "github" as const, repository: REPOSITORY, number: 17 };

  assert.equal((await adapter(client).readReview(ref, 31, "701")).verdict, "approved");
});

test("rejects missing or malformed GitHub review metadata", async () => {
  const missing = {
    ...(fixture.review as Record<string, unknown>),
    body: "<!-- agent-flow:v1 flow=flow-1 attempt=attempt-1 artifact=review -->",
  };
  const malformed = {
    ...(fixture.review as Record<string, unknown>),
    body:
      "<!-- agent-flow:v1 flow=flow-1 attempt=attempt-1 artifact=review -->\n"
      + `<!-- agent-flow-review:v1 head=${HEAD_SHA} verdict=changes-requested --> `,
  };
  const client = new FixtureClient()
    .add(
      "GET",
      "repos/owner/repo/pulls/31/reviews/701",
      { data: missing },
      { data: malformed },
    );
  const github = adapter(client);
  const ref = { provider: "github" as const, repository: REPOSITORY, number: 17 };

  await assert.rejects(github.readReview(ref, 31, "701"), /review metadata/);
  await assert.rejects(github.readReview(ref, 31, "701"), /review metadata/);
});

test("rejects GitHub review metadata for a different provider head", async () => {
  const review = {
    ...(fixture.review as Record<string, unknown>),
    body:
      "<!-- agent-flow:v1 flow=flow-1 attempt=attempt-1 artifact=review -->\n"
      + "<!-- agent-flow-review:v1 head=1111111111111111111111111111111111111111 verdict=changes-requested -->",
  };
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo/pulls/31/reviews/701", { data: review });
  const ref = { provider: "github" as const, repository: REPOSITORY, number: 17 };

  await assert.rejects(adapter(client).readReview(ref, 31, "701"), /head SHA/);
});

test("rejects logical verdicts that disagree with native GitHub review states", async () => {
  const approvedWithChanges = {
    ...(fixture.review as Record<string, unknown>),
    state: "APPROVED",
    body:
      "<!-- agent-flow:v1 flow=flow-1 attempt=attempt-1 artifact=review -->\n"
      + `<!-- agent-flow-review:v1 head=${HEAD_SHA} verdict=changes-requested -->`,
  };
  const changesWithApproval = {
    ...(fixture.review as Record<string, unknown>),
    state: "CHANGES_REQUESTED",
    body:
      "<!-- agent-flow:v1 flow=flow-1 attempt=attempt-1 artifact=review -->\n"
      + `<!-- agent-flow-review:v1 head=${HEAD_SHA} verdict=approved -->`,
  };
  const client = new FixtureClient()
    .add(
      "GET",
      "repos/owner/repo/pulls/31/reviews/701",
      { data: approvedWithChanges },
      { data: changesWithApproval },
    );
  const github = adapter(client);
  const ref = { provider: "github" as const, repository: REPOSITORY, number: 17 };

  await assert.rejects(github.readReview(ref, 31, "701"), /review state and metadata verdict/);
  await assert.rejects(github.readReview(ref, 31, "701"), /review state and metadata verdict/);
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

test("a new activation ignores unresolved connections from the cancelled activation", async () => {
  const label = { name: "agent-flow:development" };
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo", { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: fixture.issue })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", { data: [
      { id: 1, event: "labeled", label, created_at: "2026-08-25T09:00:00Z", actor: { id: 7, login: "maintainer" } },
      { id: 2, event: "connected", created_at: "2026-08-25T09:01:00Z" },
      { id: 3, event: "unlabeled", label, created_at: "2026-08-25T09:02:00Z", actor: { id: 7, login: "maintainer" } },
      { id: 4, event: "labeled", label, created_at: "2026-08-25T10:00:00Z", actor: { id: 7, login: "maintainer" } },
    ] })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", { data: [] })
    .add("GET", "repos/owner/repo/collaborators/maintainer/permission", { data: { permission: "maintain" } });

  const evidence = await adapter(client).readRecoveryEvidence({ provider: "github", repository: REPOSITORY, number: 17 });

  assert.equal(evidence.activeBoundary, "fresh");
  assert.deepEqual(evidence.ambiguities, []);
  assert.deepEqual(evidence.publications, []);
});

test("native review ownership requires original-publication edit provenance", async (t) => {
  for (const [name, lastEditedAt, eligible] of [
    ["unedited", null, true],
    ["draft edit before submission", "2026-08-25T10:00:19Z", true],
    ["same second as submission", "2026-08-25T10:00:20Z", false],
    ["after submission", "2026-08-25T10:00:21Z", false],
    ["unavailable", undefined, false],
  ] as const) {
    await t.test(name, async () => {
      const client = new FixtureClient()
        .add("GET", "repos/owner/repo", { data: fixture.repository })
        .add("GET", "repos/owner/repo/issues/17", { data: fixture.issue })
        .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", { data: fixture.timelineSecond })
        .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", { data: [] })
        .add("GET", "repos/owner/repo/pulls/31", { data: fixture.pull })
        .add("GET", "repos/owner/repo/pulls/31/reviews?per_page=100", { data: [{
          ...(fixture.recoveryReview as Record<string, unknown>), node_id: "PRR_review_1",
          submitted_at: "2026-08-25T10:00:20Z",
        }] })
        .add("POST", "graphql", { data: lastEditedAt === undefined
          ? { errors: [{ message: "unavailable" }] }
          : { data: { nodes: [{ id: "PRR_review_1", __typename: "PullRequestReview", lastEditedAt }] } } })
        .add("GET", "repos/owner/repo/collaborators/maintainer/permission", { data: { permission: "maintain" } })
        .add("GET", "repos/owner/repo/collaborators/developer/permission", { data: { permission: "maintain" } })
        .add("GET", "repos/owner/repo/collaborators/reviewer/permission", { data: { permission: "maintain" } });
      const evidence = await adapter(client).readRecoveryEvidence({ provider: "github", repository: REPOSITORY, number: 17 });
      const review = evidence.publications.find(({ key, ownershipEligible }) => ownershipEligible !== false && JSON.parse(key)[3] === "review");
      assert.equal(Boolean(review), eligible);
      if (eligible) assert.equal(review!.createdAt, "2026-08-25T10:00:20Z");
      else {
        assert.equal(evidence.reviews.length, 0);
        assert.equal(classifyRecovery(evidence, "11111111-1111-4111-8111-111111111111").kind, "reassess");
      }
    });
  }
});

test("pinned recovery keeps its activation history when another startup route is added later", async () => {
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo", { data: fixture.repository })
    .add("GET", "repos/owner/repo/issues/17", { data: { ...fixture.issue as object,
      labels: [{ name: "bugfix" }, { name: "agent-flow:development" }, { name: "agent-flow:managed" }, { name: "agent-stage:bug-development" }],
    } })
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", { data: [
      { id: 1, event: "labeled", label: { name: "bugfix" }, created_at: "2026-08-25T09:00:00Z", actor: { id: 7, login: "maintainer" } },
      { id: 2, event: "labeled", label: { name: "agent-flow:development" }, created_at: "2026-08-25T10:00:00Z", actor: { id: 7, login: "maintainer" } },
    ] })
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", { data: [{
      ...fixture.recoveryComment as object, created_at: "2026-08-25T09:30:00Z", updated_at: "2026-08-25T09:30:00Z",
    }] })
    .add("GET", "repos/owner/repo/collaborators/maintainer/permission", { data: { permission: "maintain" } })
    .add("GET", "repos/owner/repo/collaborators/developer/permission", { data: { permission: "maintain" } });
  const evidence = await adapter(client).readRecoveryEvidence({ provider: "github", repository: REPOSITORY, number: 17 }, "bugfix");
  assert.equal(evidence.snapshot.activation.label, "bugfix");
  assert.equal(evidence.snapshot.activation.eventId, "1");
  assert.equal(evidence.publications.length, 1);
  assert.deepEqual(evidence.ambiguities, []);
});

test("managed discovery retains a ticket whose pinned activation is absent from startup routes", async () => {
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo/issues?state=all&labels=agent-flow%3Amanaged&per_page=100", { data: [{ number: 17 }] })
    .add("GET", "repos/owner/repo/issues?state=all&labels=agent-flow%3Adevelopment&per_page=100", { data: [] });
  assert.deepEqual(await adapter(client).bootstrap(REPOSITORY), [{ provider: "github", repository: REPOSITORY, number: 17 }]);
});

const RECOVERY_CONTROLLER = "11111111-1111-4111-8111-111111111111";
for (const edited of [false, true]) test(`GitHub existing owner anchor, PR description edited=${edited}`, async () => {
  const anchor = {...fixture.recoveryComment, created_at:"2026-08-25T10:00:02Z", updated_at:"2026-08-25T10:00:02Z"};
  const client = new FixtureClient()
  .add("GET", "repos/owner/repo", {data: fixture.repository})
  .add("GET", "repos/owner/repo/issues/17", {data: fixture.issue})
  .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", {data: fixture.timelineSecond})
  .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", {data:[anchor]})
  .add("GET", "repos/owner/repo/pulls/31", {data:{...fixture.pull, state:"open", merged_at:null, updated_at:edited?"2026-08-25T10:01:00Z":"2026-08-25T10:00:05Z"}})
  .add("GET", "repos/owner/repo/pulls/31/reviews?per_page=100", {data:[]})
  .add("POST", "graphql", {data:{data:{repository:{pullRequest:{lastEditedAt:"2026-08-25T10:01:00Z"}}}}})
  .add("GET", "repos/owner/repo/collaborators/maintainer/permission", {data:{permission:"maintain"}})
  .add("GET", "repos/owner/repo/collaborators/developer/permission", {data:{permission:"push"}});
  const evidence=await adapter(client).readRecoveryEvidence({provider:"github", repository:REPOSITORY, number:17});
  const owner=electOwner(evidence.publications);  const decision=classifyRecovery(evidence,RECOVERY_CONTROLLER);
  assert.equal(owner?.metadata.controller,RECOVERY_CONTROLLER);
  assert.equal(JSON.parse(owner!.key)[3],"comment");
  assert.equal(decision.kind, "reassess");
});

test("receipt readback retains the pinned route's linked pull request after startup routes change", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-github-pinned-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const decision = join(root, "decision.json");
  await writeFile(decision, '{"event":"agent-succeeded"}\n');
  const repeated = (data: unknown, count = 3) => Array.from({ length: count }, () => ({ data }));
  const issue = { ...fixture.issue as object,
    labels: [{ name: "bugfix" }, { name: "agent-flow:managed" }, { name: "agent-stage:bug-development" }],
  };
  const timeline = [{ id: 1, event: "labeled", label: { name: "bugfix" },
    created_at: "2026-08-25T10:00:00Z", actor: { id: 7, login: "maintainer" } },
    (fixture.timelineSecond as unknown[])[1]];
  const pull = { ...fixture.pull as object, state: "open", merged_at: null };
  const client = new FixtureClient()
    .add("GET", "repos/owner/repo", ...repeated(fixture.repository))
    .add("GET", "repos/owner/repo/issues/17", ...repeated(issue))
    .add("GET", "repos/owner/repo/issues/17/timeline?per_page=100", ...repeated(timeline))
    .add("GET", "repos/owner/repo/issues/17/comments?per_page=100", ...repeated([]))
    .add("GET", "repos/owner/repo/pulls/31", ...repeated(pull, 4))
    .add("GET", "repos/owner/repo/pulls/31/reviews?per_page=100", { data: [] })
    .add("GET", "repos/owner/repo/collaborators/maintainer/permission", { data: { permission: "maintain" } })
    .add("GET", "repos/owner/repo/collaborators/developer/permission", ...repeated({ permission: "write" }, 2));
  const github = adapter(client);
  const ref = { provider: "github", repository: REPOSITORY, number: 17 } as const;
  const recovered = await github.readRecoveryEvidence(ref, "bugfix");
  assert.equal(recovered.snapshot.changeRequest?.number, 31);
  const bundle = await loadConfigBundle(process.cwd(), "config/stack.yaml", "a".repeat(40));
  const receipt = await readDecisionAndBuildReceipt(decision, {
    flow: bundle.flow, stateId: "bug-development", mode: "stage", resultContract: "development",
    configRevision: "a".repeat(40), controllerId: RECOVERY_CONTROLLER, activationLabel: "bugfix",
    publicationKeys: [], flowInstanceId: "33333333-3333-4333-8333-333333333333",
    attemptId: "44444444-4444-4444-8444-444444444444", ticket: ref,
    sourceComment: null, pinnedChangeRequest: recovered.snapshot.changeRequest,
  }, github, false);
  assert.equal(receipt.artifacts[0]?.kind === "change-request" && receipt.artifacts[0].number, 31);
});
