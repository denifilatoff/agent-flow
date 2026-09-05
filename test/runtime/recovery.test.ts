import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createGitHubAdapter } from "../../src/provider/github.ts";
import type { Publication } from "../../src/provider/publication.ts";
import type {
  ProviderRequest,
  ProviderResponse,
  ProviderTicketSnapshot,
  RateLimitedHttpClient,
  RecoveryEvidence,
} from "../../src/provider/types.ts";
import { reconcileTicket, type AttemptRequest } from "../../src/runtime/reconcile.ts";
import { classifyRecovery } from "../../src/runtime/recovery.ts";

const CONTROLLER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const REPOSITORY = "owner/repo";
const REF = { provider: "github", repository: REPOSITORY, number: 17 } as const;
interface GitHubFixture {
  repository: unknown;
  issue: { title: string; body: string; updated_at: string; labels: Array<{ name: string }> };
  timelineFirst: unknown[];
  timelineSecond: Array<{
    id: number;
    created_at: string;
    actor: { id: number; login: string };
  }>;
  pull: { body: string; created_at: string; updated_at: string };
  secondPull: unknown;
}
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/github/api.json", import.meta.url), "utf8"),
) as GitHubFixture;

function snapshot(patch: Partial<ProviderTicketSnapshot> = {}): ProviderTicketSnapshot {
  const activation = fixture.timelineSecond[0]!;
  return {
    ref: REF,
    repository: {
      provider: "github",
      name: REPOSITORY,
      host: "github.example.test",
      cloneRoot: "https://github.example.test/",
      cloneUrl: "https://github.example.test/owner/repo.git",
    },
    title: fixture.issue.title,
    description: fixture.issue.body,
    open: true,
    labels: fixture.issue.labels.map(({ name }: { name: string }) => name),
    updatedAt: fixture.issue.updated_at,
    activation: {
      present: true,
      eventId: String(activation.id),
      actor: { login: activation.actor.login, providerId: String(activation.actor.id) },
      occurredAt: activation.created_at,
    },
    comments: [],
    changeRequest: null,
    ...patch,
  };
}

function publication(
  controller = CONTROLLER,
  config = SHA,
  key = "comment-1",
  createdAt = "2026-08-25T10:00:20Z",
): Publication {
  return { key, createdAt, metadata: { config, controller } };
}

function evidence(patch: Partial<RecoveryEvidence> = {}): RecoveryEvidence {
  return {
    snapshot: snapshot(),
    publications: [],
    changes: [],
    reviews: [],
    ambiguities: [],
    complete: true,
    activeBoundary: "known",
    legacyActive: false,
    ...patch,
  };
}

test("C14/C17 inactive and incomplete evidence cannot resume work", () => {
  const foreign = publication(FOREIGN);
  assert.equal(classifyRecovery(evidence({ complete: false, publications: [foreign] }), CONTROLLER).kind, "ambiguous");
  assert.equal(classifyRecovery({
    ...evidence({ complete: false, publications: [foreign] }),
    snapshot: snapshot({ activation: { present: false, eventId: null, actor: null, occurredAt: null } }),
  }, CONTROLLER).kind, "inactive");
  assert.equal(classifyRecovery(evidence({ legacyActive: true, publications: [foreign] }), CONTROLLER).kind, "ambiguous");
  assert.equal(
    classifyRecovery(evidence({ activeBoundary: "ambiguous", publications: [foreign] }), CONTROLLER).kind,
    "ambiguous",
  );
  assert.equal(classifyRecovery(evidence({ snapshot: snapshot({ open: false }) }), CONTROLLER).kind, "inactive");
});

test("a closed ticket with a merged change can finish from provider-only state", () => {
  const change = {
    provider: "github" as const,
    repository: REPOSITORY,
    number: 31,
    url: "https://github.example.test/owner/repo/pull/31",
    headSha: "1".repeat(40),
    state: "merged" as const,
    actor: { login: "developer", providerId: "8" },
    body: fixture.pull.body,
    createdAt: fixture.pull.created_at,
    updatedAt: fixture.pull.updated_at,
  };
  const owner = publication(
    CONTROLLER,
    SHA,
    JSON.stringify(["github", "https://api.github.example.test/", REPOSITORY, "change-request", "31"]),
  );
  const decision = classifyRecovery(evidence({
    snapshot: snapshot({
      open: false,
      labels: ["agent-flow:development", "agent-stage:awaiting-merge"],
      changeRequest: change,
    }),
    publications: [owner],
    changes: [change],
  }), CONTROLLER);

  assert.equal(decision.kind, "reassess");
  assert.equal(decision.owner?.key, owner.key);
});

test("unresolved provider ambiguity prevents foreign owner election", () => {
  const decision = classifyRecovery(evidence({
    publications: [publication(FOREIGN)],
    ambiguities: ["linked change request identity is unresolved"],
  }), CONTROLLER);

  assert.equal(decision.kind, "ambiguous");
  assert.equal(decision.owner, null);
});

test("the first publication elects a foreign owner regardless of discovery order", () => {
  const winner = publication(FOREIGN, OTHER_SHA, "first", "2026-08-25T10:00:10Z");
  const loser = publication(CONTROLLER, SHA, "second", "2026-08-25T10:00:20Z");

  for (const publications of [[winner, loser], [loser, winner]]) {
    const decision = classifyRecovery(evidence({ publications }), CONTROLLER);
    assert.equal(decision.kind, "foreign");
    assert.equal(decision.owner?.key, "first");
  }
});

test("C12 only conflicting pins from the winning controller are ambiguous", () => {
  const winner = publication(
    CONTROLLER,
    SHA,
    JSON.stringify(["github", "https://api.github.example.test/", REPOSITORY, "comment", "1"]),
    "2026-08-25T10:00:10Z",
  );
  const losingPin = publication(
    FOREIGN,
    OTHER_SHA,
    JSON.stringify(["github", "https://api.github.example.test/", REPOSITORY, "comment", "2"]),
    "2026-08-25T10:00:20Z",
  );
  assert.equal(classifyRecovery(evidence({ publications: [losingPin, winner] }), CONTROLLER).kind, "reassess");

  const conflictingWinner = publication(CONTROLLER, OTHER_SHA, "third", "2026-08-25T10:00:30Z");
  assert.equal(
    classifyRecovery(evidence({ publications: [winner, losingPin, conflictingWinner] }), CONTROLLER).kind,
    "ambiguous",
  );

  const losingChange = publication(
    FOREIGN,
    OTHER_SHA,
    JSON.stringify(["github", "https://api.github.example.test/", REPOSITORY, "change-request", "31"]),
    "2026-08-25T10:00:20Z",
  );
  assert.equal(
    classifyRecovery(evidence({ publications: [winner, losingChange] }), CONTROLLER).kind,
    "ambiguous",
  );
});

test("C5 a PR-only first publication elects its controller and pinned configuration", () => {
  const change = publication(
    CONTROLLER,
    SHA,
    JSON.stringify(["github", "https://api.github.example.test/", REPOSITORY, "change-request", "31"]),
  );

  const decision = classifyRecovery(evidence({ publications: [change] }), CONTROLLER);

  assert.equal(decision.kind, "reassess");
  assert.equal(decision.owner?.key, change.key);
  assert.equal(decision.owner?.metadata.config, SHA);
});

test("C11/C15/C16 fresh reactivation resumes while uncertain boundaries and blocked labels pause", () => {
  const oldMerge = {
    provider: "github" as const,
    repository: REPOSITORY,
    number: 31,
    url: "https://github.example.test/owner/repo/pull/31",
    headSha: "1".repeat(40),
    state: "merged" as const,
    actor: { login: "developer", providerId: "8" },
    body: fixture.pull.body,
    createdAt: fixture.pull.created_at,
    updatedAt: fixture.pull.updated_at,
  };
  const oldDone = snapshot({ labels: ["agent-flow:development", "agent-stage:done"] });

  assert.equal(classifyRecovery(evidence({
    snapshot: oldDone,
    activeBoundary: "fresh",
    changes: [oldMerge],
  }), CONTROLLER).kind, "resume");
  assert.equal(classifyRecovery(evidence({
    snapshot: oldDone,
    activeBoundary: "ambiguous",
    changes: [oldMerge],
  }), CONTROLLER).kind, "ambiguous");
  assert.equal(classifyRecovery(evidence({
    snapshot: snapshot({ labels: ["agent-flow:development"] }),
    activeBoundary: "known",
  }), CONTROLLER).kind, "ambiguous");
  assert.equal(classifyRecovery(evidence({
    snapshot: snapshot({ labels: ["agent-flow:development", "agent-stage:blocked"] }),
  }), CONTROLLER).kind, "ambiguous");
});

interface Reply { data: unknown; next?: string | null }

class FixtureClient implements RateLimitedHttpClient {
  readonly calls: ProviderRequest[] = [];
  readonly #routes = new Map<string, Reply[]>();

  add(path: string, ...replies: Reply[]): this {
    this.#routes.set(`GET ${path}`, replies);
    return this;
  }

  async request<T>(request: ProviderRequest): Promise<ProviderResponse<T>> {
    this.calls.push(request);
    const reply = this.#routes.get(`${request.method ?? "GET"} ${request.path}`)?.shift();
    if (!reply) throw new Error(`unexpected GitHub fixture request: ${request.path}`);
    return {
      status: 200,
      data: reply.data as T,
      headers: {},
      pagination: { next: reply.next ?? null },
      notModified: false,
    };
  }
}

test("C19 two competing GitHub pull requests pause reconciliation without launching an agent", async () => {
  const secondLink = {
    id: 805,
    event: "cross-referenced",
    created_at: "2026-08-25T10:00:11Z",
    actor: { id: 8, login: "developer" },
    source: {
      issue: {
        number: 32,
        repository_url: "https://api.github.example.test/repos/owner/repo",
        pull_request: { url: "https://api.github.example.test/repos/owner/repo/pulls/32" },
      },
    },
  };
  const client = new FixtureClient()
    .add("repos/owner/repo", { data: fixture.repository })
    .add("repos/owner/repo/issues/17", { data: fixture.issue })
    .add("repos/owner/repo/issues/17/timeline?per_page=100", {
      data: [...fixture.timelineFirst, ...fixture.timelineSecond, secondLink],
    })
    .add("repos/owner/repo/issues/17/comments?per_page=100", { data: [] })
    .add("repos/owner/repo/pulls/31", { data: fixture.pull })
    .add("repos/owner/repo/pulls/32", { data: fixture.secondPull })
    .add("repos/owner/repo/pulls/31/reviews?per_page=100", { data: [] })
    .add("repos/owner/repo/pulls/32/reviews?per_page=100", { data: [] })
    .add("repos/owner/repo/collaborators/maintainer/permission", { data: { permission: "maintain" } })
    .add("repos/owner/repo/collaborators/developer/permission", { data: { permission: "write" } });
  const provider = createGitHubAdapter({
    apiUrl: "https://api.github.example.test",
    tokenEnv: "GITHUB_TOKEN",
    repositories: [REPOSITORY],
  }, client);
  const launches: AttemptRequest[] = [];
  const recorded: string[] = [];

  const outcome = await reconcileTicket({
    provider,
    controllerId: CONTROLLER,
    config: {
      loadCurrent: async () => { throw new Error("configuration must not load"); },
      loadPinned: async () => { throw new Error("configuration must not load"); },
    },
    launcher: {
      async start(request) { launches.push(request); },
      async cancel() {},
      isRunning: () => false,
    },
    async writeControl() { throw new Error("control must not be written"); },
    async recordRecovery(_ref, currentEvidence, decision) {
      assert.equal(currentEvidence.changes.length, 2);
      assert.ok(currentEvidence.ambiguities.length > 0);
      recorded.push(decision.kind);
    },
  }, REF);

  assert.equal(outcome.runnable, false);
  assert.equal(outcome.started, false);
  assert.deepEqual(recorded, ["ambiguous"]);
  assert.deepEqual(launches, []);
  assert.ok(client.calls.every(({ method }) => method === undefined || method === "GET"));
  assert.equal(
    client.calls.filter(({ path }) => path === "repos/owner/repo/issues/17").length,
    1,
  );
  assert.equal(
    client.calls.filter(
      ({ path }) => path === "repos/owner/repo/issues/17/timeline?per_page=100",
    ).length,
    1,
  );
});
