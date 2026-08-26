import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import type { AgentReceipt } from "../../src/config/types.ts";
import type {
  Actor,
  DiscoveryPage,
  DiscoveryWindow,
  NormalizedChangeRequest,
  NormalizedReview,
  Permission,
  ProviderAdapter,
  ProviderComment,
  ProviderRepository,
  ProviderTicketSnapshot,
  TicketRef,
} from "../../src/provider/types.ts";
import { ProviderHttpError } from "../../src/provider/http.ts";
import {
  InvalidReceiptError,
  ReceiptReadbackError,
  readAndVerifyReceipt,
  type ReceiptExpectation,
} from "../../src/runtime/receipts.ts";

const FLOW_ID = "123e4567-e89b-42d3-a456-426614174000";
const ATTEMPT_ID = "123e4567-e89b-42d3-a456-426614174001";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const OLD_HEAD = "1111111111111111111111111111111111111111";
const TICKET: TicketRef = { provider: "github", repository: "owner/repo", number: 17 };
const GITLAB_TICKET: TicketRef = { provider: "gitlab", repository: "owner/repo", number: 17 };
const ACTOR: Actor = { login: "maintainer", providerId: "9" };
const COMMENT_URL = "https://github.example.test/owner/repo/issues/17#issuecomment-101";
const GITLAB_COMMENT_URL = "https://gitlab.example.test/owner/repo/-/issues/17#note_101";
const GITLAB_WORK_ITEM_URL = "https://gitlab.example.test/owner/repo/-/work_items/17#note_101";
const CHANGE_URL = "https://github.example.test/owner/repo/pull/31";
const REVIEW_URL = "https://github.example.test/owner/repo/pull/31#pullrequestreview-701";
const HUMAN_URL = "https://github.example.test/owner/repo/issues/17#issuecomment-201";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function marker(artifactKind: string): string {
  return `<!-- agent-flow:v1 flow=${FLOW_ID} attempt=${ATTEMPT_ID} artifact=${artifactKind} -->`;
}

function receipt(
  artifacts: AgentReceipt["artifacts"],
  overrides: Partial<AgentReceipt> = {},
): AgentReceipt {
  return {
    apiVersion: "agent-flow/v1alpha1",
    kind: "AgentReceipt",
    flowInstanceId: FLOW_ID,
    attemptId: ATTEMPT_ID,
    outcome: "succeeded",
    summary: "Published the verified result.",
    artifacts,
    ...overrides,
  };
}

function commentArtifact(artifactKind: "assessment" | "plan" | "question" | "diagnostic" = "assessment") {
  return {
    kind: "comment" as const,
    id: "101",
    url: COMMENT_URL,
    marker: marker(artifactKind),
    artifactKind,
  };
}

function changeArtifact(overrides: Partial<AgentReceipt["artifacts"][number]> = {}) {
  return {
    kind: "change-request" as const,
    number: 31,
    url: CHANGE_URL,
    headSha: HEAD_SHA,
    state: "open" as const,
    ...overrides,
  };
}

function reviewArtifact(overrides: Partial<AgentReceipt["artifacts"][number]> = {}) {
  return {
    kind: "review" as const,
    id: "701",
    url: REVIEW_URL,
    headSha: HEAD_SHA,
    verdict: "approved" as const,
    ...overrides,
  };
}

function providerComment(overrides: Partial<ProviderComment> = {}): ProviderComment {
  return {
    id: "101",
    url: COMMENT_URL,
    body: `${marker("assessment")}\nComplete assessment.`,
    actor: ACTOR,
    createdAt: "2026-08-25T10:00:00.000Z",
    updatedAt: "2026-08-25T10:00:00.000Z",
    ...overrides,
  };
}

function change(overrides: Partial<NormalizedChangeRequest> = {}): NormalizedChangeRequest {
  return {
    provider: "github",
    repository: "owner/repo",
    number: 31,
    url: CHANGE_URL,
    headSha: HEAD_SHA,
    state: "open",
    actor: ACTOR,
    updatedAt: "2026-08-25T10:00:00.000Z",
    ...overrides,
  };
}

function review(overrides: Partial<NormalizedReview> = {}): NormalizedReview {
  return {
    id: "701",
    url: REVIEW_URL,
    actor: ACTOR,
    submittedAt: "2026-08-25T10:00:00.000Z",
    headSha: HEAD_SHA,
    verdict: "approved",
    body: `${marker("review")}\n<!-- agent-flow-review:v1 head=${HEAD_SHA} verdict=approved -->\nApproved.`,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ProviderTicketSnapshot> = {}): ProviderTicketSnapshot {
  return {
    ref: TICKET,
    repository: {
      provider: "github",
      name: "owner/repo",
      host: "github.example.test",
      cloneRoot: "https://github.example.test/",
      cloneUrl: "https://github.example.test/owner/repo.git",
    },
    title: "Fix the edge case",
    description: "Handle the documented edge case.",
    open: true,
    labels: ["agent-flow:development"],
    updatedAt: "2026-08-25T10:00:00.000Z",
    activation: { present: true, eventId: "1", actor: ACTOR, occurredAt: "2026-08-25T09:00:00.000Z" },
    comments: [],
    changeRequest: change(),
    ...overrides,
  };
}

class FakeProvider implements ProviderAdapter {
  readonly kind: "github" | "gitlab";
  readonly expectedTicket: TicketRef;

  constructor(kind: "github" | "gitlab" = "github", expectedTicket: TicketRef = TICKET) {
    this.kind = kind;
    this.expectedTicket = expectedTicket;
  }
  calls: string[] = [];
  comment = providerComment();
  ticket: ProviderTicketSnapshot | null = null;
  ticketAfterArtifactRead: ProviderTicketSnapshot | null = null;
  changeRequest = change();
  review = review();
  sourceComment = providerComment({ id: "201", url: HUMAN_URL, body: "Approved with one note." });
  actorPermission: Permission = "write";
  failure: Error | null = null;

  private record<T>(name: string, value: T): T {
    this.calls.push(name);
    if (this.failure) throw this.failure;
    return value;
  }

  async verifyAuth(): Promise<Actor> { throw new Error("unused"); }
  async discover(_repository: string, _window: DiscoveryWindow, _cursor?: string): Promise<DiscoveryPage> {
    throw new Error("unused");
  }
  async bootstrap(_repository: string): Promise<TicketRef[]> { throw new Error("unused"); }
  async readRepository(_repository: string): Promise<ProviderRepository> { throw new Error("unused"); }
  async readTicket(ref: TicketRef): Promise<ProviderTicketSnapshot> {
    assert.deepEqual(ref, this.expectedTicket);
    return this.record("readTicket", this.ticket ?? snapshot({
      comments: [this.comment, this.sourceComment],
      changeRequest: this.changeRequest,
    }));
  }
  async permission(repository: string, actor: Actor): Promise<Permission> {
    assert.equal(repository, this.expectedTicket.repository);
    assert.deepEqual(actor, this.sourceComment.actor);
    return this.record("permission", this.actorPermission);
  }
  async readComment(ref: TicketRef, id: string): Promise<ProviderComment> {
    assert.deepEqual(ref, this.expectedTicket);
    return this.record(`readComment:${id}`, id === "201" ? this.sourceComment : this.comment);
  }
  async createComment(_ref: TicketRef, _body: string): Promise<ProviderComment> { throw new Error("unused"); }
  async updateComment(_ref: TicketRef, _id: string, _body: string): Promise<ProviderComment> {
    throw new Error("unused");
  }
  async setControllerLabels(_ref: TicketRef, _remove: string[], _add: string[]): Promise<string[]> {
    throw new Error("unused");
  }
  async readChangeRequest(ref: TicketRef, number: number): Promise<NormalizedChangeRequest> {
    assert.deepEqual(ref, TICKET);
    assert.equal(number, 31);
    const result = this.record(`readChangeRequest:${number}`, this.changeRequest);
    if (this.ticketAfterArtifactRead) this.ticket = this.ticketAfterArtifactRead;
    return result;
  }
  async findReview(): Promise<never> { throw new Error("unused"); }
  async readReview(ref: TicketRef, changeNumber: number, id: string): Promise<NormalizedReview> {
    assert.deepEqual(ref, TICKET);
    assert.equal(changeNumber, 31);
    assert.equal(id, "701");
    const result = this.record(`readReview:${changeNumber}:${id}`, this.review);
    if (this.ticketAfterArtifactRead) this.ticket = this.ticketAfterArtifactRead;
    return result;
  }
}

function expectation(
  resultContract: ReceiptExpectation["resultContract"],
  ticket: TicketRef = TICKET,
): ReceiptExpectation {
  return {
    flowInstanceId: FLOW_ID,
    attemptId: ATTEMPT_ID,
    resultContract,
    ticket,
    pinnedHeadSha: resultContract === "review" ? HEAD_SHA : null,
  };
}

async function verify(
  value: unknown,
  resultContract: ReceiptExpectation["resultContract"] = "assessment",
  provider = new FakeProvider(),
  cancelled = false,
  ticket: TicketRef = TICKET,
): Promise<AgentReceipt> {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-receipt-"));
  roots.push(root);
  const path = join(root, "receipt.json");
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  return readAndVerifyReceipt(path, expectation(resultContract, ticket), provider, cancelled);
}

async function invalid(promise: Promise<unknown>, pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof InvalidReceiptError);
    assert.equal(error.code, "INVALID_RECEIPT");
    assert.equal(error.retryable, false);
    assert.ok(error.message.length <= 240);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("accepts only a marked assessment that the provider reads back", async () => {
  const provider = new FakeProvider();

  const result = await verify(receipt([commentArtifact()]), "assessment", provider);

  assert.equal(result.attemptId, ATTEMPT_ID);
  assert.deepEqual(provider.calls, ["readComment:101", "readTicket"]);
});

test("accepts only the GitLab work-item alias for the same verified issue comment", async () => {
  const provider = new FakeProvider("gitlab", GITLAB_TICKET);
  provider.comment = providerComment({ url: GITLAB_COMMENT_URL });
  provider.ticket = snapshot({
    ref: GITLAB_TICKET,
    repository: {
      provider: "gitlab",
      name: GITLAB_TICKET.repository,
      host: "gitlab.example.test",
      cloneRoot: "https://gitlab.example.test/",
      cloneUrl: "https://gitlab.example.test/owner/repo.git",
    },
    comments: [providerComment({ url: GITLAB_WORK_ITEM_URL })],
    changeRequest: null,
  });

  const result = await verify(receipt([{ ...commentArtifact(), url: GITLAB_WORK_ITEM_URL }]),
    "assessment", provider, false, GITLAB_TICKET);

  assert.equal(result.artifacts[0]?.url, GITLAB_WORK_ITEM_URL);
  assert.deepEqual(provider.calls, ["readComment:101", "readTicket"]);

  for (const url of [
    "https://@gitlab.example.test/owner/repo/-/work_items/17#note_101",
    "https://gitlab.example.test/owner/repo/-/work_items/17?#note_101",
    "https://other.example.test/owner/repo/-/work_items/17#note_101",
    "https://gitlab.example.test/other/repo/-/work_items/17#note_101",
    "https://gitlab.example.test/root/owner/repo/-/work_items/17#note_101",
    "https://gitlab.example.test/owner/repo/-/work_items/18#note_101",
    "https://gitlab.example.test/owner/repo/-/work_items/17#note_999",
  ]) {
    await invalid(verify(receipt([{ ...commentArtifact(), url }]),
      "assessment", provider, false, GITLAB_TICKET), /comment URL/);
  }
});

test("rejects malformed, oversized, and schema-invalid receipt JSON", async (context) => {
  await context.test("malformed JSON", () => invalid(verify("{"), /JSON/));
  await context.test("oversized JSON", () => invalid(verify(" ".repeat(1_048_577)), /size/));
  await context.test("schema mismatch", () => invalid(verify({ kind: "AgentReceipt" }), /schema/));
});

test("rejects mismatched flow and attempt identities", async (context) => {
  await context.test("flow ID", () => invalid(verify(receipt([commentArtifact()], {
    flowInstanceId: "123e4567-e89b-42d3-a456-426614174099",
  })), /flow instance/));
  await context.test("attempt ID", () => invalid(verify(receipt([commentArtifact()], {
    attemptId: "123e4567-e89b-42d3-a456-426614174099",
  })), /attempt/));
});

test("rejects a cancelled result before parsing or provider calls", async () => {
  const provider = new FakeProvider();

  await invalid(verify("not JSON", "assessment", provider, true), /cancelled/);

  assert.deepEqual(provider.calls, []);
});

test("accepts each successful result contract", async (context) => {
  await context.test("plan", async () => {
    const provider = new FakeProvider();
    provider.comment = providerComment({
      body: `${marker("plan")}\nComplete plan.`,
    });
    await verify(receipt([commentArtifact("plan")]), "plan", provider);
    assert.deepEqual(provider.calls, ["readComment:101", "readTicket"]);
  });
  await context.test("development", async () => {
    const provider = new FakeProvider();
    await verify(receipt([changeArtifact()]), "development", provider);
    assert.deepEqual(provider.calls, ["readChangeRequest:31", "readTicket"]);
  });
  await context.test("review", async () => {
    const provider = new FakeProvider();
    await verify(receipt([reviewArtifact()]), "review", provider);
    assert.deepEqual(provider.calls, ["readTicket", "readReview:31:701", "readTicket"]);
  });
  await context.test("human gate without duplicating the source comment artifact", async () => {
    const provider = new FakeProvider();
    await verify(receipt([], {
      humanGate: { sourceCommentId: "201", verdict: "approved", notes: ["One nonblocking note."] },
    }), "human-gate", provider);
    assert.deepEqual(provider.calls, ["readComment:201", "permission", "readTicket"]);
  });
  await context.test("none", async () => {
    const provider = new FakeProvider();
    await verify(receipt([]), "none", provider);
    assert.deepEqual(provider.calls, []);
  });
});

test("accepts one verified question for needs-human agent outcomes", async () => {
  for (const contract of ["assessment", "plan", "development", "review"] as const) {
    const provider = new FakeProvider();
    provider.comment = providerComment({ body: `${marker("question")}\nWhich API should be used?` });
    await verify(receipt([commentArtifact("question")], { outcome: "needs-human" }), contract, provider);
    assert.deepEqual(provider.calls, ["readComment:101", "readTicket"]);
  }
});

test("accepts failed receipts with only an optional verified diagnostic", async (context) => {
  await context.test("without a diagnostic", () => verify(receipt([], {
    outcome: "failed",
    error: { code: "TOOL_FAILED", message: "The tool exited with status 1." },
  })));
  await context.test("with a diagnostic", async () => {
    const provider = new FakeProvider();
    provider.comment = providerComment({ body: `${marker("diagnostic")}\nTests failed.` });
    await verify(receipt([commentArtifact("diagnostic")], {
      outcome: "failed",
      error: { code: "TEST_FAILED", message: "The test suite failed." },
    }), "development", provider);
    assert.deepEqual(provider.calls, ["readComment:101", "readTicket"]);
  });
});

test("rejects duplicate, multiple, and extraneous primary artifacts", async (context) => {
  await context.test("duplicate stable identity", () => invalid(verify(receipt([
    commentArtifact(),
    commentArtifact(),
  ])), /duplicate/));
  await context.test("multiple assessment artifacts", () => invalid(verify(receipt([
    commentArtifact(),
    { ...commentArtifact(), id: "102", url: `${COMMENT_URL}2` },
  ])), /exactly one/));
  await context.test("wrong primary kind", () => invalid(verify(receipt([
    commentArtifact("plan"),
  ])), /assessment/));
  await context.test("extraneous diagnostic on success", () => invalid(verify(receipt([
    commentArtifact(),
    { ...commentArtifact("diagnostic"), id: "102", url: `${COMMENT_URL}2` },
  ])), /artifact/));
  await context.test("change request on needs-human", () => invalid(verify(receipt([
    changeArtifact(),
  ], { outcome: "needs-human" }), "development"), /question/));
  await context.test("review on failed", () => invalid(verify(receipt([
    reviewArtifact(),
  ], {
    outcome: "failed",
    error: { code: "REVIEW_FAILED", message: "Review failed." },
  }), "review"), /diagnostic/));
});

test("rejects wrong comment markers and review metadata", async (context) => {
  await context.test("receipt marker", () => invalid(verify(receipt([{
    ...commentArtifact(),
    marker: `${marker("assessment")} `,
  }])), /marker/));
  await context.test("provider first line", () => {
    const provider = new FakeProvider();
    provider.comment = providerComment({ body: ` ${marker("assessment")}\nAssessment.` });
    return invalid(verify(receipt([commentArtifact()]), "assessment", provider), /marker/);
  });
  await context.test("review second line", () => {
    const provider = new FakeProvider();
    provider.review = review({
      body: `${marker("review")}\n<!-- agent-flow-review:v1 head=${HEAD_SHA} verdict=approved --> `,
    });
    return invalid(verify(receipt([reviewArtifact()]), "review", provider), /metadata/);
  });
});

test("rejects missing or mismatched comment publications", async (context) => {
  await context.test("missing", () => {
    const provider = new FakeProvider();
    provider.failure = new Error("404 with secret response");
    return invalid(verify(receipt([commentArtifact()]), "assessment", provider), /publication/);
  });
  await context.test("wrong ID", () => {
    const provider = new FakeProvider();
    provider.comment = providerComment({ id: "999" });
    return invalid(verify(receipt([commentArtifact()]), "assessment", provider), /comment ID/);
  });
  await context.test("wrong URL", () => {
    const provider = new FakeProvider();
    provider.comment = providerComment({ url: "https://github.example.test/wrong" });
    return invalid(verify(receipt([commentArtifact()]), "assessment", provider), /comment URL/);
  });
});

test("rejects comments that do not belong to the final expected ticket snapshot", async (context) => {
  await context.test("receipt artifact from another ticket", () => {
    const provider = new FakeProvider();
    provider.ticket = snapshot({ comments: [] });
    return invalid(verify(receipt([commentArtifact()]), "assessment", provider), /expected ticket/);
  });
  await context.test("same identity with different body", () => {
    const provider = new FakeProvider();
    provider.ticket = snapshot({ comments: [providerComment({ body: `${marker("assessment")}\nOther body.` })] });
    return invalid(verify(receipt([commentArtifact()]), "assessment", provider), /expected ticket/);
  });
  await context.test("authorized human source from another ticket", () => {
    const provider = new FakeProvider();
    provider.ticket = snapshot({ comments: [] });
    return invalid(verify(receipt([], {
      humanGate: { sourceCommentId: "201", verdict: "approved", notes: [] },
    }), "human-gate", provider), /expected ticket/);
  });
});

test("rejects an unlinked or mismatched development change request", async (context) => {
  await context.test("unlinked", () => {
    const provider = new FakeProvider();
    provider.ticket = snapshot({ changeRequest: null });
    return invalid(verify(receipt([changeArtifact()]), "development", provider), /linked change request/);
  });
  const cases: Array<[string, Partial<NormalizedChangeRequest>, RegExp]> = [
    ["provider", { provider: "gitlab" }, /provider/],
    ["repository", { repository: "other/repo" }, /repository/],
    ["number", { number: 32 }, /number/],
    ["URL", { url: "https://github.example.test/wrong" }, /URL/],
    ["state", { state: "closed" }, /state/],
    ["head", { headSha: OLD_HEAD }, /head SHA/],
  ];
  for (const [name, overrides, pattern] of cases) {
    await context.test(name, () => {
      const provider = new FakeProvider();
      provider.changeRequest = change(overrides);
      return invalid(verify(receipt([changeArtifact()]), "development", provider), pattern);
    });
  }
});

test("rejects stale or mismatched review publications", async (context) => {
  await context.test("missing pinned head", async () => {
    const provider = new FakeProvider();
    const expected = expectation("review");
    expected.pinnedHeadSha = null;
    const root = await mkdtemp(join(tmpdir(), "agent-flow-receipt-"));
    roots.push(root);
    const path = join(root, "receipt.json");
    await writeFile(path, JSON.stringify(receipt([reviewArtifact()])));
    await invalid(readAndVerifyReceipt(path, expected, provider, false), /pinned head/);
  });
  await context.test("linked change head", () => {
    const provider = new FakeProvider();
    provider.ticket = snapshot({ changeRequest: change({ headSha: OLD_HEAD }) });
    return invalid(verify(receipt([reviewArtifact()]), "review", provider), /head SHA/);
  });
  await context.test("wrong linked change request", () => {
    const provider = new FakeProvider();
    provider.ticket = snapshot({ changeRequest: change({ number: 32 }) });
    provider.review = review();
    return invalid(verify(receipt([reviewArtifact()]), "review", provider), /publication/);
  });
  const cases: Array<[string, Partial<NormalizedReview>, RegExp]> = [
    ["ID", { id: "999" }, /review ID/],
    ["URL", { url: "https://github.example.test/wrong" }, /review URL/],
    ["head", { headSha: OLD_HEAD }, /head SHA/],
    ["verdict", { verdict: "changes-requested" }, /verdict/],
  ];
  for (const [name, overrides, pattern] of cases) {
    await context.test(name, () => {
      const provider = new FakeProvider();
      provider.review = review(overrides);
      return invalid(verify(receipt([reviewArtifact()]), "review", provider), pattern);
    });
  }
});

test("rejects linked change mutations after artifact readback", async (context) => {
  for (const [name, overrides] of [
    ["number", { number: 32 }],
    ["head", { headSha: OLD_HEAD }],
    ["state", { state: "closed" as const }],
  ] as const) {
    await context.test(`development ${name}`, () => {
      const provider = new FakeProvider();
      provider.ticketAfterArtifactRead = snapshot({ changeRequest: change(overrides) });
      return invalid(verify(receipt([changeArtifact()]), "development", provider), /change request/);
    });
    await context.test(`review ${name}`, () => {
      const provider = new FakeProvider();
      provider.ticketAfterArtifactRead = snapshot({ changeRequest: change(overrides) });
      return invalid(verify(receipt([reviewArtifact()]), "review", provider), /change request/);
    });
  }
});

test("verifies human-gate source identity, content, and permission", async (context) => {
  const humanReceipt = receipt([], {
    humanGate: { sourceCommentId: "201", verdict: "approved", notes: [] },
  });
  await context.test("source ID", () => {
    const provider = new FakeProvider();
    provider.sourceComment = providerComment({ id: "202", url: HUMAN_URL, body: "Approved." });
    return invalid(verify(humanReceipt, "human-gate", provider), /source comment ID/);
  });
  await context.test("unmarked source", () => {
    const provider = new FakeProvider();
    provider.sourceComment = providerComment({
      id: "201",
      url: HUMAN_URL,
      body: `${marker("question")}\nApproved.`,
    });
    return invalid(verify(humanReceipt, "human-gate", provider), /unmarked/);
  });
  for (const permission of ["none", "read", "triage"] as const) {
    await context.test(`permission ${permission}`, () => {
      const provider = new FakeProvider();
      provider.actorPermission = permission;
      return invalid(verify(humanReceipt, "human-gate", provider), /permission/);
    });
  }
  await context.test("verified clarification question", async () => {
    const provider = new FakeProvider();
    provider.comment = providerComment({ body: `${marker("question")}\nCould you clarify?` });
    await verify(receipt([commentArtifact("question")], {
      humanGate: { sourceCommentId: "201", verdict: "unclear", notes: ["The intent is unclear."] },
    }), "human-gate", provider);
    assert.deepEqual(provider.calls, ["readComment:101", "readComment:201", "permission", "readTicket"]);
  });
});

test("enforces the human-gate verdict and question matrix", async (context) => {
  const humanReceipt = (
    verdict: "approved" | "changes-requested" | "cancelled" | "question" | "unclear",
    withQuestion: boolean,
  ) => receipt(withQuestion ? [commentArtifact("question")] : [], {
    humanGate: { sourceCommentId: "201", verdict, notes: [] },
  });

  for (const verdict of ["approved", "changes-requested", "cancelled"] as const) {
    await context.test(`accepts ${verdict} without a question`, () =>
      verify(humanReceipt(verdict, false), "human-gate"));
    await context.test(`rejects ${verdict} with a question`, () => {
      const provider = new FakeProvider();
      provider.comment = providerComment({ body: `${marker("question")}\nCould you clarify?` });
      return invalid(verify(humanReceipt(verdict, true), "human-gate", provider), /question/);
    });
  }
  for (const verdict of ["question", "unclear"] as const) {
    await context.test(`accepts ${verdict} with one question`, () => {
      const provider = new FakeProvider();
      provider.comment = providerComment({ body: `${marker("question")}\nCould you clarify?` });
      return verify(humanReceipt(verdict, true), "human-gate", provider);
    });
    await context.test(`rejects ${verdict} without a question`, () =>
      invalid(verify(humanReceipt(verdict, false), "human-gate"), /question/));
  }
});

test("sanitizes provider exceptions", async () => {
  const provider = new FakeProvider();
  provider.failure = new Error("token=top-secret raw provider body");

  await assert.rejects(verify(receipt([commentArtifact()]), "assessment", provider), (error: unknown) => {
    assert.ok(error instanceof InvalidReceiptError);
    assert.doesNotMatch(error.message, /top-secret|raw provider body|token=/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("preserves only the retryable classification for transient provider readback", async () => {
  const provider = new FakeProvider();
  provider.failure = new ProviderHttpError(
    "token=top-secret",
    503,
    true,
    { token: "top-secret" },
    { authorization: "top-secret" },
  );

  await assert.rejects(verify(receipt([commentArtifact()]), "assessment", provider), (error: unknown) => {
    assert.ok(error instanceof ReceiptReadbackError);
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /top-secret|token=/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("keeps a nontransient missing publication non-retryable", async () => {
  const provider = new FakeProvider();
  provider.failure = new ProviderHttpError("missing token=top-secret", 404, false, null, {});

  await assert.rejects(verify(receipt([commentArtifact()]), "assessment", provider), (error: unknown) => {
    assert.ok(error instanceof InvalidReceiptError);
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, /top-secret|token=/);
    return true;
  });
});
