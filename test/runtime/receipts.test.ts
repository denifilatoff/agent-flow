import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import type { AgentReceipt, FlowDefinition, ResultContract } from "../../src/config/types.ts";
import { ProviderHttpError } from "../../src/provider/http.ts";
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
import type { AttemptMode } from "../../src/runtime/agent-protocol.ts";
import { classifyAttemptError, controlError } from "../../src/runtime/errors.ts";
import * as receiptModule from "../../src/runtime/receipts.ts";

const FLOW_ID = "123e4567-e89b-42d3-a456-426614174000";
const ATTEMPT_ID = "123e4567-e89b-42d3-a456-426614174001";
const STARTED_AT = "2026-08-27T10:00:00.000Z";
const PUBLISHED_AT = "2026-08-27T10:01:00.000Z";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const OLD_HEAD = "1111111111111111111111111111111111111111";
const TICKET: TicketRef = { provider: "github", repository: "owner/repo", number: 17 };
const GITLAB_TICKET: TicketRef = { provider: "gitlab", repository: "owner/repo", number: 17 };
const ACTOR: Actor = { login: "maintainer", providerId: "9" };
const COMMENT_URL = "https://github.example.test/owner/repo/issues/17#issuecomment-101";
const QUESTION_URL = "https://github.example.test/owner/repo/issues/17#issuecomment-102";
const HUMAN_URL = "https://github.example.test/owner/repo/issues/17#issuecomment-201";
const CHANGE_URL = "https://github.example.test/owner/repo/pull/31";
const REVIEW_URL = "https://github.example.test/owner/repo/pull/31#pullrequestreview-701";
const GITLAB_COMMENT_URL = "https://gitlab.example.test/owner/repo/-/issues/17#note_101";
const GITLAB_WORK_ITEM_URL = "https://gitlab.example.test/owner/repo/-/work_items/17#note_101";
const roots: string[] = [];

interface DecisionExpectationSpec {
  flow: FlowDefinition;
  stateId: string;
  mode: AttemptMode;
  resultContract: ResultContract;
  flowInstanceId: string;
  attemptId: string;
  ticket: TicketRef;
  startedAt: string;
  sourceComment: ProviderComment | null;
  pinnedChangeRequest: NormalizedChangeRequest | null;
}

type DecisionReader = (
  path: string,
  expected: DecisionExpectationSpec,
  provider: ProviderAdapter,
  cancelled: boolean,
) => Promise<AgentReceipt>;

const decisionReader = (receiptModule as unknown as Record<string, unknown>)
  .readDecisionAndBuildReceipt as DecisionReader | undefined;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function marker(artifact: "assessment" | "plan" | "question" | "review"): string {
  return `<!-- agent-flow:v1 flow=${FLOW_ID} attempt=${ATTEMPT_ID} artifact=${artifact} -->`;
}

function flow(): FlowDefinition {
  const transition = { target: "done" };
  return {
    apiVersion: "agent-flow/v1alpha1",
    kind: "Flow",
    metadata: {
      id: "development",
      activationLabel: "agent-flow:development",
      managedLabel: "agent-flow:managed",
    },
    spec: {
      initial: "assessment",
      states: {
        assessment: { kind: "agent", resultContract: "assessment", on: {
          "agent-succeeded": transition, "agent-needs-human": transition,
        } },
        planning: { kind: "agent", resultContract: "plan", on: {
          "agent-succeeded": transition, "agent-needs-human": transition,
        } },
        development: { kind: "agent", resultContract: "development", on: {
          "agent-succeeded": transition, "agent-needs-human": transition,
        } },
        review: { kind: "agent", resultContract: "review", on: {
          "review-approved": transition, "review-changes-requested": transition, "agent-needs-human": transition,
        } },
        "assessment-review": { kind: "human-gate", resultContract: "human-gate", on: {
          "human-approved": transition,
          "human-changes-requested": transition,
          "human-question": transition,
          "human-unclear": transition,
          "human-cancelled": transition,
        } },
        "needs-human": { kind: "paused", on: {
          "agent-needs-human": transition,
          "human-answer-accepted": transition,
          "human-answer-cancelled": transition,
          "human-answer-unclear": transition,
        } },
        done: { kind: "final" },
      },
    },
  };
}

function comment(
  artifact: "assessment" | "plan" | "question" = "assessment",
  overrides: Partial<ProviderComment> = {},
): ProviderComment {
  const question = artifact === "question";
  return {
    id: question ? "102" : "101",
    url: question ? QUESTION_URL : COMMENT_URL,
    body: `${marker(artifact)}\nPublished ${artifact}.`,
    actor: ACTOR,
    createdAt: PUBLISHED_AT,
    updatedAt: PUBLISHED_AT,
    ...overrides,
  };
}

function source(overrides: Partial<ProviderComment> = {}): ProviderComment {
  return {
    id: "201",
    url: HUMAN_URL,
    body: "Approved with one note.",
    actor: ACTOR,
    createdAt: "2026-08-27T09:58:00.000Z",
    updatedAt: "2026-08-27T09:58:00.000Z",
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
    updatedAt: PUBLISHED_AT,
    ...overrides,
  };
}

function review(overrides: Partial<NormalizedReview> = {}): NormalizedReview {
  return {
    id: "701",
    url: REVIEW_URL,
    actor: ACTOR,
    submittedAt: PUBLISHED_AT,
    headSha: HEAD_SHA,
    verdict: "approved",
    body: `${marker("review")}\n<!-- agent-flow-review:v1 head=${HEAD_SHA} verdict=approved -->\nApproved.`,
    ...overrides,
  };
}

function repository(provider: "github" | "gitlab" = "github"): ProviderRepository {
  const host = `${provider}.example.test`;
  return {
    provider,
    name: "owner/repo",
    host,
    cloneRoot: `https://${host}/`,
    cloneUrl: `https://${host}/owner/repo.git`,
  };
}

function snapshot(overrides: Partial<ProviderTicketSnapshot> = {}): ProviderTicketSnapshot {
  return {
    ref: TICKET,
    repository: repository(),
    title: "Fix the edge case",
    description: "Handle the documented edge case.",
    open: true,
    labels: ["agent-flow:development"],
    updatedAt: PUBLISHED_AT,
    activation: { present: true, eventId: "1", actor: ACTOR, occurredAt: "2026-08-27T09:00:00.000Z" },
    comments: [],
    changeRequest: change(),
    ...overrides,
  };
}

class FakeProvider implements ProviderAdapter {
  readonly kind: "github" | "gitlab";
  readonly expectedTicket: TicketRef;
  calls: string[] = [];
  ticket = snapshot();
  ticketReads: ProviderTicketSnapshot[] = [];
  comments = new Map<string, ProviderComment>();
  changeRequest = change();
  foundReview: NormalizedReview | null = review();
  reviewReadback = review();
  actorPermission: Permission = "write";
  failure: Error | null = null;
  duplicateReview = false;

  constructor(kind: "github" | "gitlab" = "github", expectedTicket: TicketRef = TICKET) {
    this.kind = kind;
    this.expectedTicket = expectedTicket;
  }

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
    return this.record("readTicket", this.ticketReads.shift() ?? this.ticket);
  }
  async permission(repositoryName: string, actor: Actor): Promise<Permission> {
    assert.equal(repositoryName, this.expectedTicket.repository);
    return this.record(`permission:${actor.login}`, this.actorPermission);
  }
  async readComment(ref: TicketRef, id: string): Promise<ProviderComment> {
    assert.deepEqual(ref, this.expectedTicket);
    const published = this.comments.get(id);
    if (!published) throw new ProviderHttpError("missing comment", 404, false, null, {});
    return this.record(`readComment:${id}`, published);
  }
  async createComment(_ref: TicketRef, _body: string): Promise<ProviderComment> { throw new Error("unused"); }
  async updateComment(_ref: TicketRef, _id: string, _body: string): Promise<ProviderComment> {
    throw new Error("unused");
  }
  async setControllerLabels(_ref: TicketRef, _remove: string[], _add: string[]): Promise<string[]> {
    throw new Error("unused");
  }
  async readChangeRequest(ref: TicketRef, number: number): Promise<NormalizedChangeRequest> {
    assert.deepEqual(ref, this.expectedTicket);
    assert.equal(number, this.changeRequest.number);
    return this.record(`readChangeRequest:${number}`, this.changeRequest);
  }
  async findReview(ref: TicketRef, number: number, reviewMarker: string): Promise<NormalizedReview | null> {
    assert.deepEqual(ref, this.expectedTicket);
    assert.equal(number, this.changeRequest.number);
    assert.equal(reviewMarker, marker("review"));
    this.calls.push(`findReview:${number}`);
    if (this.failure) throw this.failure;
    if (this.duplicateReview) throw new Error("duplicate review token=top-secret");
    return this.foundReview;
  }
  async readReview(ref: TicketRef, number: number, id: string): Promise<NormalizedReview> {
    assert.deepEqual(ref, this.expectedTicket);
    assert.equal(number, this.changeRequest.number);
    return this.record(`readReview:${number}:${id}`, this.reviewReadback);
  }
}

function expectation(overrides: Partial<DecisionExpectationSpec> = {}): DecisionExpectationSpec {
  return {
    flow: flow(),
    stateId: "assessment",
    mode: "stage",
    resultContract: "assessment",
    flowInstanceId: FLOW_ID,
    attemptId: ATTEMPT_ID,
    ticket: TICKET,
    startedAt: STARTED_AT,
    sourceComment: null,
    pinnedChangeRequest: null,
    ...overrides,
  };
}

function installComments(provider: FakeProvider, comments: ProviderComment[]): void {
  provider.ticket = snapshot({ comments });
  provider.comments = new Map(comments.map((published) => [published.id, published]));
}

async function readDecision(
  value: unknown,
  expected = expectation(),
  provider = new FakeProvider(),
  cancelled = false,
): Promise<AgentReceipt> {
  assert.equal(typeof decisionReader, "function", "readDecisionAndBuildReceipt must be exported");
  const root = await mkdtemp(join(tmpdir(), "agent-flow-decision-"));
  roots.push(root);
  const path = join(root, "decision.json");
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  return decisionReader(path, expected, provider, cancelled);
}

async function decisionError(
  promise: Promise<unknown>,
  name: string,
  code: string,
  retryable: boolean,
  pattern?: RegExp,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    const constructor = (receiptModule as unknown as Record<string, unknown>)[name];
    assert.equal(typeof constructor, "function", `${name} must be exported`);
    assert.ok(error instanceof (constructor as new (...args: never[]) => Error));
    assert.equal((error as Error & { code: string }).code, code);
    assert.equal((error as Error & { retryable: boolean }).retryable, retryable);
    assert.ok(error.message.length <= 240);
    assert.equal(error.cause, undefined);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

const retryableDecision = (promise: Promise<unknown>, pattern?: RegExp) =>
  decisionError(promise, "InvalidDecisionError", "INVALID_DECISION", true, pattern);
const unavailableEvidence = (promise: Promise<unknown>, pattern?: RegExp) =>
  decisionError(promise, "DecisionEvidenceUnavailableError", "DECISION_EVIDENCE_UNAVAILABLE", true, pattern);
const readbackFailure = (promise: Promise<unknown>) =>
  decisionError(promise, "DecisionReadbackError", "DECISION_READBACK_FAILED", true);
const trustFailure = (promise: Promise<unknown>, pattern?: RegExp) =>
  decisionError(promise, "DecisionTrustError", "DECISION_TRUST_FAILED", false, pattern);

test("exports the decision receipt builder", () => {
  assert.equal(typeof decisionReader, "function");
});

test("builds comment receipts from one-field agent decisions", async (context) => {
  for (const [stateId, resultContract, artifactKind] of [
    ["assessment", "assessment", "assessment"],
    ["planning", "plan", "plan"],
  ] as const) {
    await context.test(resultContract, async () => {
      const provider = new FakeProvider();
      const published = comment(artifactKind);
      installComments(provider, [published]);
      const receipt = await readDecision(
        { event: "agent-succeeded" }, expectation({ stateId, resultContract }), provider,
      );
      assert.deepEqual(receipt, {
        apiVersion: "agent-flow/v1alpha1",
        kind: "AgentReceipt",
        flowInstanceId: FLOW_ID,
        attemptId: ATTEMPT_ID,
        outcome: "succeeded",
        summary: "Agent completed the stage.",
        artifacts: [{ kind: "comment", id: published.id, url: published.url,
          marker: marker(artifactKind), artifactKind }],
      });
      assert.deepEqual(provider.calls, ["readTicket", `readComment:${published.id}`, "readTicket"]);
    });
  }
});

test("builds a development receipt from the linked open change request", async () => {
  const provider = new FakeProvider();
  const receipt = await readDecision(
    { event: "agent-succeeded" },
    expectation({ stateId: "development", resultContract: "development" }),
    provider,
  );
  assert.deepEqual(receipt, {
    apiVersion: "agent-flow/v1alpha1",
    kind: "AgentReceipt",
    flowInstanceId: FLOW_ID,
    attemptId: ATTEMPT_ID,
    outcome: "succeeded",
    summary: "Agent completed the stage.",
    artifacts: [{ kind: "change-request", number: 31, url: CHANGE_URL,
      headSha: HEAD_SHA, state: "open" }],
  });
  assert.deepEqual(provider.calls, ["readTicket", "readChangeRequest:31", "readTicket"]);
});

test("builds review receipts from provider-native logical verdicts", async (context) => {
  for (const [event, verdict, summary] of [
    ["review-approved", "approved", "Review approved the change."],
    ["review-changes-requested", "changes-requested", "Review requested changes."],
  ] as const) {
    await context.test(event, async () => {
      const provider = new FakeProvider();
      const published = review({ verdict,
        body: `${marker("review")}\n<!-- agent-flow-review:v1 head=${HEAD_SHA} verdict=${verdict} -->\nNarrative ignored.` });
      provider.foundReview = published;
      provider.reviewReadback = published;
      const receipt = await readDecision({ event }, expectation({
        stateId: "review", resultContract: "review", pinnedChangeRequest: change(),
      }), provider);
      assert.deepEqual(receipt, {
        apiVersion: "agent-flow/v1alpha1",
        kind: "AgentReceipt",
        flowInstanceId: FLOW_ID,
        attemptId: ATTEMPT_ID,
        outcome: "succeeded",
        summary,
        artifacts: [{ kind: "review", id: "701", url: REVIEW_URL, headSha: HEAD_SHA, verdict }],
      });
      assert.deepEqual(provider.calls, ["readTicket", "findReview:31", "readReview:31:701", "readTicket"]);
    });
  }
});

test("builds needs-human receipts for every agent result contract", async (context) => {
  for (const [stateId, resultContract] of [
    ["assessment", "assessment"], ["planning", "plan"],
    ["development", "development"], ["review", "review"],
  ] as const) {
    await context.test(resultContract, async () => {
      const provider = new FakeProvider();
      installComments(provider, [comment("question")]);
      const receipt = await readDecision({ event: "agent-needs-human" }, expectation({
        stateId, resultContract, pinnedChangeRequest: resultContract === "review" ? change() : null,
      }), provider);
      assert.equal(receipt.outcome, "needs-human");
      assert.equal(receipt.summary, "Agent requested human input.");
      assert.deepEqual(receipt.artifacts, [{ kind: "comment", id: "102", url: QUESTION_URL,
        marker: marker("question"), artifactKind: "question" }]);
    });
  }
});

test("builds human-gate receipts for every human event family", async (context) => {
  const cases = [
    ["assessment-review", "human-approved", "approved", false, "Human approved the result."],
    ["assessment-review", "human-changes-requested", "changes-requested", false, "Human requested changes."],
    ["assessment-review", "human-question", "question", true, "Human asked a question."],
    ["assessment-review", "human-unclear", "unclear", true, "Human intent was unclear."],
    ["assessment-review", "human-cancelled", "cancelled", false, "Human cancelled the flow."],
    ["needs-human", "human-answer-accepted", "approved", false, "Human answer was accepted."],
    ["needs-human", "human-answer-cancelled", "cancelled", false, "Human answer cancelled the flow."],
    ["needs-human", "human-answer-unclear", "unclear", true, "Human answer was unclear."],
  ] as const;
  for (const [stateId, event, verdict, withQuestion, summary] of cases) {
    await context.test(event, async () => {
      const provider = new FakeProvider();
      const human = source();
      installComments(provider, withQuestion ? [human, comment("question")] : [human]);
      const receipt = await readDecision({ event }, expectation({
        stateId, mode: "human-input", resultContract: "human-gate", sourceComment: human,
      }), provider);
      assert.equal(receipt.summary, summary);
      assert.deepEqual(receipt.humanGate, { sourceCommentId: "201", verdict, notes: [] });
      assert.deepEqual(receipt.artifacts, withQuestion
        ? [{ kind: "comment", id: "102", url: QUESTION_URL,
          marker: marker("question"), artifactKind: "question" }]
        : []);
    });
  }
});

test("treats malformed and unconfigured decisions as retryable", async (context) => {
  await context.test("empty", () => retryableDecision(readDecision(""), /JSON/));
  await context.test("malformed", () => retryableDecision(readDecision("{"), /JSON/));
  await context.test("schema", () => retryableDecision(
    readDecision({ event: "agent-succeeded", extra: true }), /schema/));
  await context.test("size", () => retryableDecision(readDecision(" ".repeat(1_048_577)), /size/));
  await context.test("unconfigured event before provider reads", async () => {
    const provider = new FakeProvider();
    await retryableDecision(readDecision({ event: "review-approved" }, expectation(), provider), /not allowed/);
    assert.deepEqual(provider.calls, []);
  });
});

test("treats missing fresh evidence as retryable", async (context) => {
  await context.test("comment", async () => {
    const provider = new FakeProvider();
    installComments(provider, [comment("assessment", {
      createdAt: "2026-08-27T09:59:59.999Z", updatedAt: "2026-08-27T09:59:59.999Z",
    })]);
    await unavailableEvidence(readDecision({ event: "agent-succeeded" }, expectation(), provider), /comment/);
  });
  await context.test("change request", async () => {
    const provider = new FakeProvider();
    provider.ticket = snapshot({ changeRequest: null });
    await unavailableEvidence(readDecision({ event: "agent-succeeded" }, expectation({
      stateId: "development", resultContract: "development",
    }), provider), /change request/);
  });
  await context.test("review", async () => {
    const provider = new FakeProvider();
    provider.foundReview = null;
    await unavailableEvidence(readDecision({ event: "review-approved" }, expectation({
      stateId: "review", resultContract: "review", pinnedChangeRequest: change(),
    }), provider), /review/);
  });
});

test("rejects cancellation and changed provider identity", async (context) => {
  await context.test("cancelled before parsing", async () => {
    const provider = new FakeProvider();
    await trustFailure(readDecision("not JSON", expectation(), provider, true), /cancelled/);
    assert.deepEqual(provider.calls, []);
  });
  await context.test("provider", async () => {
    const provider = new FakeProvider("gitlab", GITLAB_TICKET);
    await trustFailure(readDecision({ event: "agent-succeeded" }, expectation(), provider), /provider/);
    assert.deepEqual(provider.calls, []);
  });
  await context.test("ticket", async () => {
    const provider = new FakeProvider();
    provider.ticket = snapshot({ ref: { ...TICKET, number: 18 } });
    await trustFailure(readDecision({ event: "agent-succeeded" }, expectation(), provider), /ticket/);
  });
  await context.test("repository", async () => {
    const provider = new FakeProvider();
    provider.ticket = snapshot({ repository: { ...repository(), name: "other/repo" } });
    await trustFailure(readDecision({ event: "agent-succeeded" }, expectation(), provider), /repository/);
  });
});

test("rejects marker, duplicate, identity, URL, and membership contradictions", async (context) => {
  await context.test("wrong artifact marker", async () => {
    const provider = new FakeProvider();
    installComments(provider, [comment("plan")]);
    await trustFailure(readDecision({ event: "agent-succeeded" }, expectation(), provider), /artifact kind/);
  });
  await context.test("duplicate evidence", async () => {
    const provider = new FakeProvider();
    installComments(provider, [comment(), comment("assessment", { id: "103", url: `${COMMENT_URL}3` })]);
    await trustFailure(readDecision({ event: "agent-succeeded" }, expectation(), provider), /duplicate/);
  });
  for (const [name, overrides, pattern] of [
    ["ID", { id: "999" }, /comment ID/],
    ["URL", { url: "https://github.example.test/wrong" }, /comment URL/],
    ["marker", { body: ` ${marker("assessment")}\nAssessment.` }, /marker/],
  ] as const) {
    await context.test(name, async () => {
      const provider = new FakeProvider();
      const found = comment();
      installComments(provider, [found]);
      provider.comments.set(found.id, { ...found, ...overrides });
      await trustFailure(readDecision({ event: "agent-succeeded" }, expectation(), provider), pattern);
    });
  }
  await context.test("final membership", async () => {
    const provider = new FakeProvider();
    const found = comment();
    installComments(provider, [found]);
    provider.ticketReads = [snapshot({ comments: [found] }), snapshot({ comments: [] })];
    await trustFailure(readDecision({ event: "agent-succeeded" }, expectation(), provider), /expected ticket/);
  });
});

test("accepts the canonical GitLab issue/work-item comment URL alias", async () => {
  const provider = new FakeProvider("gitlab", GITLAB_TICKET);
  const found = comment("assessment", { url: GITLAB_WORK_ITEM_URL });
  provider.ticket = snapshot({ ref: GITLAB_TICKET, repository: repository("gitlab"),
    comments: [found], changeRequest: null });
  provider.comments.set(found.id, { ...found, url: GITLAB_COMMENT_URL });
  const receipt = await readDecision(
    { event: "agent-succeeded" }, expectation({ ticket: GITLAB_TICKET }), provider,
  );
  assert.equal(receipt.artifacts[0]?.url, GITLAB_COMMENT_URL);

  for (const url of [
    "https://@gitlab.example.test/owner/repo/-/work_items/17#note_101",
    "https://gitlab.example.test/owner/repo/-/work_items/17?#note_101",
    "https://other.example.test/owner/repo/-/work_items/17#note_101",
    "https://gitlab.example.test/other/repo/-/work_items/17#note_101",
    "https://gitlab.example.test/root/owner/repo/-/work_items/17#note_101",
    "https://gitlab.example.test/owner/repo/-/work_items/18#note_101",
    "https://gitlab.example.test/owner/repo/-/work_items/17#note_999",
  ]) {
    const mismatched = { ...found, url };
    provider.ticket = { ...provider.ticket, comments: [mismatched] };
    provider.comments.set(found.id, { ...found, url: GITLAB_COMMENT_URL });
    await trustFailure(readDecision(
      { event: "agent-succeeded" }, expectation({ ticket: GITLAB_TICKET }), provider,
    ), /comment URL/);
  }
});

test("rejects linked change identity and readback contradictions", async (context) => {
  await context.test("different pinned change", async () => {
    const provider = new FakeProvider();
    await trustFailure(readDecision({ event: "agent-succeeded" }, expectation({
      stateId: "development",
      resultContract: "development",
      pinnedChangeRequest: change({ number: 30, url: "https://github.example.test/owner/repo/pull/30" }),
    }), provider), /identity/);
  });
  for (const [name, overrides, pattern] of [
    ["URL", { url: "https://github.example.test/wrong" }, /URL/],
    ["head", { headSha: OLD_HEAD }, /head SHA/],
    ["state", { state: "closed" as const }, /state/],
  ] as const) {
    await context.test(name, async () => {
      const provider = new FakeProvider();
      provider.changeRequest = change(overrides);
      await trustFailure(readDecision({ event: "agent-succeeded" }, expectation({
        stateId: "development", resultContract: "development",
      }), provider), pattern);
    });
  }
});

test("allows development to move an existing change head", async () => {
  const provider = new FakeProvider();
  const receipt = await readDecision({ event: "agent-succeeded" }, expectation({
    stateId: "development",
    resultContract: "development",
    pinnedChangeRequest: change({ headSha: OLD_HEAD, updatedAt: "2026-08-27T09:50:00.000Z" }),
  }), provider);
  assert.equal(receipt.artifacts[0]?.kind, "change-request");
  assert.equal((receipt.artifacts[0] as { headSha: string }).headSha, HEAD_SHA);
});

test("rejects duplicate, stale, mismatched, or malformed review evidence", async (context) => {
  await context.test("duplicate", async () => {
    const provider = new FakeProvider();
    provider.duplicateReview = true;
    await trustFailure(readDecision({ event: "review-approved" }, expectation({
      stateId: "review", resultContract: "review", pinnedChangeRequest: change(),
    }), provider), /review/);
  });
  await context.test("stale linked head", async () => {
    const provider = new FakeProvider();
    provider.ticket = snapshot({ changeRequest: change({ headSha: OLD_HEAD }) });
    await trustFailure(readDecision({ event: "review-approved" }, expectation({
      stateId: "review", resultContract: "review", pinnedChangeRequest: change(),
    }), provider), /head SHA/);
  });
  for (const [name, overrides, pattern] of [
    ["ID", { id: "999" }, /review ID/],
    ["URL", { url: "https://github.example.test/wrong" }, /review URL/],
    ["head", { headSha: OLD_HEAD }, /head SHA/],
    ["verdict", { verdict: "changes-requested" as const }, /verdict/],
    ["metadata", { body: `${marker("review")}\n<!-- agent-flow-review:v1 head=${HEAD_SHA} verdict=changes-requested -->` }, /metadata/],
  ] as const) {
    await context.test(name, async () => {
      const provider = new FakeProvider();
      provider.reviewReadback = review(overrides);
      await trustFailure(readDecision({ event: "review-approved" }, expectation({
        stateId: "review", resultContract: "review", pinnedChangeRequest: change(),
      }), provider), pattern);
    });
  }
});

test("rejects mismatched or unauthorized human source comments", async (context) => {
  const run = (provider: FakeProvider, human: ProviderComment) => readDecision(
    { event: "human-approved" },
    expectation({ stateId: "assessment-review", mode: "human-input",
      resultContract: "human-gate", sourceComment: human }),
    provider,
  );
  await context.test("changed source", async () => {
    const provider = new FakeProvider();
    const human = source();
    installComments(provider, [{ ...human, body: "Changed after pinning." }]);
    await trustFailure(run(provider, human), /source comment/);
  });
  await context.test("marked source", async () => {
    const provider = new FakeProvider();
    const human = source();
    installComments(provider, [{ ...human, body: `${marker("question")}\nNot human input.` }]);
    await trustFailure(run(provider, human), /unmarked/);
  });
  for (const permission of ["none", "read", "triage"] as const) {
    await context.test(`permission ${permission}`, async () => {
      const provider = new FakeProvider();
      const human = source();
      installComments(provider, [human]);
      provider.actorPermission = permission;
      await trustFailure(run(provider, human), /permission/);
    });
  }
});

test("sanitizes transient and contradictory provider failures", async (context) => {
  await context.test("transient", async () => {
    const provider = new FakeProvider();
    provider.failure = new ProviderHttpError("token=top-secret raw body", 503, true,
      { token: "top-secret" }, { authorization: "top-secret" });
    await readbackFailure(readDecision({ event: "agent-succeeded" }, expectation(), provider));
  });
  await context.test("contradiction", async () => {
    const provider = new FakeProvider();
    provider.failure = new Error("token=top-secret raw provider body");
    await assert.rejects(readDecision({ event: "agent-succeeded" }, expectation(), provider), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "DecisionTrustError");
      assert.doesNotMatch(error.message, /top-secret|raw provider body|token=/);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
});

test("classifies decision input and evidence errors at the retry boundary", () => {
  const cases = [
    [new receiptModule.InvalidDecisionError("token=top-secret"), "INVALID_DECISION", true],
    [new receiptModule.DecisionEvidenceUnavailableError("token=top-secret"),
      "DECISION_EVIDENCE_UNAVAILABLE", true],
    [new receiptModule.DecisionReadbackError(), "DECISION_READBACK_FAILED", true],
    [new receiptModule.DecisionTrustError("token=top-secret"), "DECISION_TRUST_FAILED", false],
  ] as const;

  for (const [error, code, retryable] of cases) {
    const classified = classifyAttemptError(error);
    assert.equal(classified.code, code);
    assert.equal(classified.retryable, retryable);
    assert.doesNotMatch(classified.message, /top-secret|token=/);
    const stored = controlError(classified);
    assert.equal(stored.code, code);
    assert.ok(stored.message.length <= 240);
  }
});
