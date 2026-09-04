import type { ProviderConfig } from "../config/types.js";
import { ProviderHttpError } from "./http.ts";
import { parsePublication, type Publication } from "./publication.ts";
import type {
  Actor,
  DiscoveryPage,
  DiscoveryWindow,
  NormalizedChangeRequest,
  NormalizedReview,
  Permission,
  ProviderAdapter,
  ProviderComment,
  RecoveryEvidence,
  ProviderRepository,
  ProviderResponse,
  ProviderTicketSnapshot,
  RateLimitedHttpClient,
  RequestPriority,
  TicketRef,
} from "./types.js";

export type GitHubConfig = ProviderConfig;

const HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};
const ACTIVATION_LABEL = "agent-flow:development";
const REVIEW_METADATA =
  /^<!-- agent-flow-review:v1 head=([0-9a-f]{40}) verdict=(approved|changes-requested|commented) -->$/;

export function createGitHubAdapter(
  config: GitHubConfig,
  client: RateLimitedHttpClient,
): ProviderAdapter {
  const allowlist = new Set(config.repositories);
  const apiBase = new URL(config.apiUrl);
  if (!apiBase.pathname.endsWith("/")) apiBase.pathname += "/";
  const apiScope = canonicalApiScope(apiBase);

  function repositoryPath(repository: string): string {
    if (!allowlist.has(repository)) throw new Error(`GitHub repository is not allowlisted: ${repository}`);
    const parts = repository.split("/");
    if (parts.length !== 2 || parts.some((part) => !part)) {
      throw new Error(`invalid GitHub repository name: ${repository}`);
    }
    return parts.map(encodeURIComponent).join("/");
  }

  function ticketPath(ref: TicketRef): string {
    if (ref.provider !== "github") throw new Error("ticket provider must be github");
    assertPositiveInteger(ref.number, "ticket number");
    return `repos/${repositoryPath(ref.repository)}/issues/${ref.number}`;
  }

  async function request(
    path: string,
    priority: RequestPriority,
    options: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: unknown;
    } = {},
  ): Promise<ProviderResponse<unknown>> {
    return client.request({
      path,
      priority,
      method: options.method,
      headers: HEADERS,
      body: options.body,
    });
  }

  async function listAll(path: string, priority: RequestPriority): Promise<unknown[]> {
    const items: unknown[] = [];
    const visited = new Set<string>();
    let next: string | null = path;
    while (next) {
      if (visited.has(next)) throw new Error("GitHub pagination returned a cycle");
      visited.add(next);
      const response = await request(next, priority);
      items.push(...array(response.data, "GitHub list response"));
      next = response.pagination.next;
    }
    return items;
  }

  async function readRepository(repository: string): Promise<ProviderRepository> {
    const response = await request(`repos/${repositoryPath(repository)}`, "active");
    const value = object(response.data, "GitHub repository");
    const name = string(value, "full_name");
    if (name.toLowerCase() !== repository.toLowerCase()) {
      throw new Error(`GitHub repository identity mismatch: expected ${repository}, received ${name}`);
    }
    const webUrl = new URL(string(value, "html_url"));
    return {
      provider: "github",
      name,
      host: webUrl.host,
      cloneRoot: new URL("/", webUrl).href,
      cloneUrl: string(value, "clone_url"),
    };
  }

  async function readChangeRequest(
    ref: TicketRef,
    number: number,
  ): Promise<NormalizedChangeRequest> {
    assertTicket(ref, allowlist);
    assertPositiveInteger(number, "pull request number");
    const response = await request(
      `repos/${repositoryPath(ref.repository)}/pulls/${number}`,
      "active",
    );
    return normalizePull(response.data, ref.repository);
  }

  async function readSnapshotData(ref: TicketRef) {
    const path = ticketPath(ref);
    const repository = await readRepository(ref.repository);
    const issue = object((await request(path, "active")).data, "GitHub issue");
    const open = normalizeIssueState(issue);
    const labels = normalizeLabels(issue.labels);
    const timeline = await listAll(`${path}/timeline?per_page=100`, "active");
    const comments = (await listAll(`${path}/comments?per_page=100`, "active"))
      .map(normalizeComment);
    const activationEvents: Array<{ kind: "add" | "remove"; id: string; createdAt: string; actor: Actor }> = [];
    for (const event of timeline) {
      const item = object(event, "GitHub timeline event");
      if (isLabelEvent(item, "labeled", ACTIVATION_LABEL)) {
        activationEvents.push({ kind: "add", id: identifier(item.id, "GitHub activation event id"), createdAt: string(item, "created_at"), actor: normalizeActor(item.actor, "GitHub activation actor") });
      } else if (isLabelEvent(item, "unlabeled", ACTIVATION_LABEL)) {
        activationEvents.push({ kind: "remove", id: identifier(item.id, "GitHub activation event id"), createdAt: string(item, "created_at"), actor: normalizeActor(item.actor, "GitHub activation actor") });
      }
    }
    const activationEvent = labels.includes(ACTIVATION_LABEL)
      ? activationEvents.toReversed().find(({ kind }) => kind === "add")
      : undefined;
    const links = findChangeRequestNumbers(
      timeline,
      new URL(`repos/${repositoryPath(ref.repository)}`, apiBase),
    );
    return {
      snapshot: {
        ref,
        repository,
        title: string(issue, "title"),
        description: optionalString(issue.body, "GitHub issue body"),
        open,
        labels,
        updatedAt: string(issue, "updated_at"),
        activation: {
          present: labels.includes(ACTIVATION_LABEL),
          eventId: activationEvent?.id ?? null,
          actor: activationEvent?.actor ?? null,
          occurredAt: activationEvent?.createdAt ?? null,
        },
        comments,
        changeRequest: null,
      },
      activationEvents,
      changeNumbers: links.numbers,
      linkAmbiguities: links.ambiguities,
    };
  }

  return {
    kind: "github",

    async verifyAuth(): Promise<Actor> {
      const response = await request("user", "active");
      return normalizeActor(response.data, "GitHub user");
    },

    async discover(
      repository: string,
      window: DiscoveryWindow,
      cursor?: string,
    ): Promise<DiscoveryPage> {
      const route = repositoryPath(repository);
      const since = discoverySince(window);
      let path: string;
      if (cursor) {
        const cursorUrl = new URL(cursor, apiBase);
        const expectedUrl = new URL(`repos/${route}/issues`, apiBase);
        if (cursorUrl.origin !== expectedUrl.origin || cursorUrl.pathname !== expectedUrl.pathname) {
          throw new Error("GitHub discovery cursor does not belong to the repository");
        }
        const expected = { state: "all", since, per_page: "100" };
        for (const [name, value] of Object.entries(expected)) {
          if (cursorUrl.searchParams.getAll(name).length !== 1
            || cursorUrl.searchParams.get(name) !== value) {
            throw new Error("GitHub cursor does not match the discovery window");
          }
        }
        for (const name of cursorUrl.searchParams.keys()) {
          if (!Object.hasOwn(expected, name) && name !== "page") {
            throw new Error("GitHub cursor does not match the discovery window");
          }
        }
        const pages = cursorUrl.searchParams.getAll("page");
        if (pages.length > 1 || (pages[0] !== undefined && !/^[1-9]\d*$/.test(pages[0]))) {
          throw new Error("GitHub cursor does not match the discovery window");
        }
        path = cursor;
      } else {
        const query = new URLSearchParams({
          state: "all",
          since,
          per_page: "100",
        });
        path = `repos/${route}/issues?${query}`;
      }

      const response = await request(path, "background");
      return {
        tickets: issueRefs(response.data, repository),
        nextCursor: response.pagination.next,
      };
    },

    async bootstrap(repository: string): Promise<TicketRef[]> {
      const route = repositoryPath(repository);
      const found = new Map<number, TicketRef>();
      for (const label of ["agent-flow:managed", ACTIVATION_LABEL]) {
        const query = new URLSearchParams({ state: "all", labels: label, per_page: "100" });
        for (const ref of issueRefs(
          await listAll(`repos/${route}/issues?${query}`, "background"),
          repository,
        )) {
          found.set(ref.number, ref);
        }
      }
      return [...found.values()];
    },

    readRepository,

    async readTicket(ref: TicketRef): Promise<ProviderTicketSnapshot> {
      const data = await readSnapshotData(ref);
      const changeNumber = uniqueChangeNumber(data.changeNumbers, "GitHub issue has multiple related pull requests");
      return {
        ...data.snapshot,
        changeRequest: changeNumber === null ? null : await readChangeRequest(ref, changeNumber),
      };
    },

    async readRecoveryEvidence(ref: TicketRef): Promise<RecoveryEvidence> {
      const data = await readSnapshotData(ref);
      const changes = await Promise.all(data.changeNumbers.map((number) => readChangeRequest(ref, number)));
      const reviewRows = await Promise.all(changes.map(async (change) => ({
        change,
        values: await listAll(
          `repos/${repositoryPath(ref.repository)}/pulls/${change.number}/reviews?per_page=100`,
          "active",
        ),
      })));
      const ambiguities: string[] = [...data.linkAmbiguities];
      const boundary = activeBoundary(data.snapshot, data.activationEvents, ambiguities);
      const permissionCache = new Map<string, boolean>();
      const authorized = async (actor: Actor): Promise<boolean> => {
        const cached = permissionCache.get(actor.providerId);
        if (cached !== undefined) return cached;
        const allowed = ["write", "maintain", "admin"].includes(await (async () => {
          const response = await request(
            `repos/${repositoryPath(ref.repository)}/collaborators/${encodeURIComponent(actor.login)}/permission`,
            "active",
          );
          return permission(string(object(response.data, "GitHub permission"), "permission"));
        })());
        permissionCache.set(actor.providerId, allowed);
        return allowed;
      };
      if (data.snapshot.activation.present) {
        if (!data.snapshot.activation.actor) ambiguities.push("activation author is unavailable");
        else if (!await authorized(data.snapshot.activation.actor)) ambiguities.push("activation author is not authorized");
      }
      const publications: Publication[] = [];
      let legacyActive = false;
      const canonicalRepository = data.snapshot.repository.name;
      const addPublication = async (
        kind: "comment" | "change-request" | "review",
        id: string,
        body: string,
        createdAt: string,
        updatedAt: string | null,
        actor: Actor,
      ): Promise<void> => {
        const key = publicationKey("github", apiScope, canonicalRepository, kind, id);
        if (!withinActiveBoundary(data.snapshot, boundary, createdAt)) return;
        const parsed = parsePublication(body);
        if (parsed.kind === "legacy") {
          legacyActive = true;
          return;
        }
        if (parsed.kind === "invalid") {
          ambiguities.push(`invalid publication marker: ${key}`);
          return;
        }
        if (parsed.kind !== "current") return;
        const metadata = parsed.metadata;
        if (updatedAt !== null && updatedAt !== createdAt) {
          ambiguities.push(`publication provenance is unavailable: ${key}`);
          return;
        }
        if (!await authorized(actor)) {
          ambiguities.push(`publication author is not authorized: ${key}`);
          return;
        }
        publications.push({ key, createdAt, metadata });
      };
      for (const comment of data.snapshot.comments) {
        await addPublication("comment", comment.id, comment.body, comment.createdAt, comment.updatedAt, comment.actor);
      }
      for (const change of changes) {
        await addPublication("change-request", String(change.number), change.body, change.createdAt, change.updatedAt, change.actor);
      }
      const reviews: NormalizedReview[] = [];
      for (const { change, values } of reviewRows) {
        for (const value of values) {
          const row = object(value, "GitHub review");
          const body = optionalString(row.body, "GitHub review body");
          const parsed = parsePublication(body);
          if (parsed.kind === "unmarked") continue;
          const id = identifier(row.id, "GitHub review id");
          const submittedAt = optionalString(row.submitted_at, "GitHub review submitted_at");
          if (!submittedAt) {
            ambiguities.push(`review submission time is unavailable: ${publicationKey("github", apiScope, canonicalRepository, "review", id)}`);
            continue;
          }
          const actor = normalizeActor(row.user, "GitHub review actor");
          if (parsed.kind === "current") {
            try {
              const review = normalizeReview(row);
              reviews.push(review);
              await addPublication("review", id, body, submittedAt, null, actor);
            } catch (error) {
              ambiguities.push(`invalid review evidence: ${publicationKey("github", apiScope, canonicalRepository, "review", id)}: ${error instanceof Error ? error.message : "unknown error"}`);
            }
          } else {
            await addPublication("review", id, body, submittedAt, null, actor);
          }
        }
      }
      if (changes.length > 1) ambiguities.push("multiple linked pull requests");
      return {
        snapshot: { ...data.snapshot, changeRequest: changes.length === 1 ? changes[0]! : null },
        publications,
        changes,
        reviews,
        ambiguities,
        complete: true,
        activeBoundary: boundary,
        legacyActive,
      };
    },

    async permission(repository: string, actor: Actor): Promise<Permission> {
      const response = await request(
        `repos/${repositoryPath(repository)}/collaborators/${encodeURIComponent(actor.login)}/permission`,
        "active",
      );
      const value = string(object(response.data, "GitHub permission"), "permission");
      return permission(value);
    },

    async readComment(ref: TicketRef, id: string): Promise<ProviderComment> {
      assertTicket(ref, allowlist);
      assertIdentifier(id, "comment id");
      const response = await request(
        `repos/${repositoryPath(ref.repository)}/issues/comments/${id}`,
        "active",
      );
      return normalizeComment(response.data);
    },

    async createComment(ref: TicketRef, body: string): Promise<ProviderComment> {
      const response = await request(`${ticketPath(ref)}/comments`, "active", {
        method: "POST",
        body: { body },
      });
      return normalizeComment(response.data);
    },

    async updateComment(ref: TicketRef, id: string, body: string): Promise<ProviderComment> {
      assertTicket(ref, allowlist);
      assertIdentifier(id, "comment id");
      const response = await request(
        `repos/${repositoryPath(ref.repository)}/issues/comments/${id}`,
        "active",
        { method: "PATCH", body: { body } },
      );
      return normalizeComment(response.data);
    },

    async setControllerLabels(ref: TicketRef, remove: string[], add: string[]): Promise<string[]> {
      for (const label of [...remove, ...add]) {
        if (!isControllerLabel(label)) throw new Error(`label is not controller-owned: ${label}`);
      }
      const path = ticketPath(ref);
      for (const label of new Set(remove)) {
        try {
          await request(`${path}/labels/${encodeURIComponent(label)}`, "active", { method: "DELETE" });
        } catch (error) {
          if (!(error instanceof ProviderHttpError) || error.status !== 404) throw error;
        }
      }
      const labels = [...new Set(add)];
      if (labels.length > 0) {
        await request(`${path}/labels`, "active", { method: "POST", body: { labels } });
      }
      const issue = object((await request(path, "active")).data, "GitHub issue");
      return normalizeLabels(issue.labels);
    },

    readChangeRequest,

    async findReview(
      ref: TicketRef,
      changeNumber: number,
      marker: string,
    ): Promise<NormalizedReview | null> {
      assertTicket(ref, allowlist);
      assertPositiveInteger(changeNumber, "pull request number");
      const reviews = await listAll(
        `repos/${repositoryPath(ref.repository)}/pulls/${changeNumber}/reviews?per_page=100`,
        "active",
      );
      const matches = reviews.filter((value) =>
        optionalString(object(value, "GitHub review").body, "GitHub review body")
          .split(/\r?\n/, 1)[0] === marker);
      if (matches.length > 1) {
        throw new Error("multiple GitHub reviews have the same attempt marker");
      }
      return matches[0] === undefined ? null : normalizeReview(matches[0]);
    },

    async readReview(ref: TicketRef, changeNumber: number, id: string): Promise<NormalizedReview> {
      assertTicket(ref, allowlist);
      assertPositiveInteger(changeNumber, "pull request number");
      assertIdentifier(id, "review id");
      const response = await request(
        `repos/${repositoryPath(ref.repository)}/pulls/${changeNumber}/reviews/${id}`,
        "active",
      );
      return normalizeReview(response.data);
    },
  };
}

function issueRefs(value: unknown, repository: string): TicketRef[] {
  return array(value, "GitHub issues").flatMap((item) => {
    const issue = object(item, "GitHub issue list entry");
    if (issue.pull_request !== undefined) return [];
    const number = integer(issue, "number");
    assertPositiveInteger(number, "ticket number");
    return [{ provider: "github", repository, number }];
  });
}

function normalizePull(value: unknown, repository: string): NormalizedChangeRequest {
  const pull = object(value, "GitHub pull request");
  const providerState = string(pull, "state");
  if (providerState !== "open" && providerState !== "closed") {
    throw new Error(`unsupported GitHub pull request state: ${providerState}`);
  }
  const state = pull.merged_at === null || pull.merged_at === undefined
    ? providerState
    : "merged";
  return {
    provider: "github",
    repository,
    number: integer(pull, "number"),
    url: string(pull, "html_url"),
    headSha: string(object(pull.head, "GitHub pull request head"), "sha"),
    state,
    actor: normalizeActor(pull.user, "GitHub pull request actor"),
    body: optionalString(pull.body, "GitHub pull request body"),
    createdAt: string(pull, "created_at"),
    updatedAt: string(pull, "updated_at"),
  };
}

function normalizeReview(value: unknown): NormalizedReview {
  const review = object(value, "GitHub review");
  const state = string(review, "state").toUpperCase();
  let providerVerdict: NormalizedReview["verdict"] | null;
  switch (state) {
    case "APPROVED": providerVerdict = "approved"; break;
    case "CHANGES_REQUESTED": providerVerdict = "changes-requested"; break;
    case "COMMENTED": providerVerdict = null; break;
    default: throw new Error(`unsupported GitHub review state: ${state}`);
  }
  const body = optionalString(review.body, "GitHub review body");
  const metadata = REVIEW_METADATA.exec(body.split(/\r?\n/)[1] ?? "");
  if (!metadata) throw new Error("invalid GitHub review metadata");
  const headSha = string(review, "commit_id");
  if (metadata[1] !== headSha) {
    throw new Error("GitHub review metadata head SHA does not match the provider head SHA");
  }
  const verdict = metadata[2] as NormalizedReview["verdict"];
  if (providerVerdict !== null && verdict !== providerVerdict) {
    throw new Error("GitHub review state and metadata verdict do not match");
  }
  return {
    id: identifier(review.id, "GitHub review id"),
    url: string(review, "html_url"),
    actor: normalizeActor(review.user, "GitHub review actor"),
    submittedAt: string(review, "submitted_at"),
    headSha,
    verdict,
    body,
  };
}

function normalizeComment(value: unknown): ProviderComment {
  const comment = object(value, "GitHub comment");
  return {
    id: identifier(comment.id, "GitHub comment id"),
    url: string(comment, "html_url"),
    body: optionalString(comment.body, "GitHub comment body"),
    actor: normalizeActor(comment.user, "GitHub comment actor"),
    createdAt: string(comment, "created_at"),
    updatedAt: string(comment, "updated_at"),
  };
}

function normalizeActor(value: unknown, label: string): Actor {
  const actor = object(value, label);
  return {
    login: string(actor, "login"),
    providerId: identifier(actor.id, `${label} id`),
  };
}

function normalizeLabels(value: unknown): string[] {
  return array(value, "GitHub labels").map((label) => {
    if (typeof label === "string") return label;
    return string(object(label, "GitHub label"), "name");
  });
}

function findChangeRequestNumbers(
  timeline: unknown[],
  repositoryUrl: URL,
): { numbers: number[]; ambiguities: string[] } {
  const candidates = new Set<number>();
  const ambiguities: string[] = [];
  for (const value of timeline) {
    const event = object(value, "GitHub timeline event");
    if (event.event === "cross-referenced") {
      const source = nullableObject(event.source);
      const issue = nullableObject(source?.issue);
      if (!issue || issue.pull_request === undefined || !sameRepositoryUrl(issue.repository_url, repositoryUrl)) continue;
      const number = integer(issue, "number");
      assertPositiveInteger(number, "pull request number");
      candidates.add(number);
      continue;
    }
    if (event.event !== "connected") continue;
    ambiguities.push(`unresolved connected GitHub pull request: ${identifier(event.id, "GitHub timeline event id")}`);
  }
  return { numbers: [...candidates].sort((left, right) => left - right), ambiguities };
}

function sameRepositoryUrl(value: unknown, expected: URL): boolean {
  if (typeof value !== "string") return false;
  try {
    const actual = new URL(value);
    return actual.origin === expected.origin
      && actual.pathname.replace(/\/$/, "").toLowerCase()
        === expected.pathname.replace(/\/$/, "").toLowerCase()
      && !actual.search
      && !actual.hash;
  } catch {
    return false;
  }
}

function uniqueChangeNumber(numbers: readonly number[], message: string): number | null {
  if (numbers.length > 1) throw new Error(message);
  return numbers[0] ?? null;
}

function canonicalApiScope(value: URL): string {
  const scope = new URL(value);
  scope.username = "";
  scope.password = "";
  scope.search = "";
  scope.hash = "";
  scope.pathname = `${scope.pathname.replace(/\/+$/, "")}/`;
  return scope.href;
}

function publicationKey(
  provider: "github" | "gitlab",
  apiScope: string,
  repository: string,
  kind: "comment" | "change-request" | "review",
  id: string,
): string {
  return JSON.stringify([provider, apiScope, repository, kind, id]);
}

function activeBoundary(
  snapshot: ProviderTicketSnapshot,
  events: ReadonlyArray<{ kind: "add" | "remove"; createdAt: string }>,
  ambiguities: string[],
): "known" | "fresh" | "ambiguous" {
  if (!snapshot.activation.present) return "known";
  if (!snapshot.activation.occurredAt || !snapshot.activation.actor) {
    ambiguities.push("activation boundary is unavailable");
    return "ambiguous";
  }
  return events.some((event) => event.kind === "remove" && event.createdAt < snapshot.activation.occurredAt!)
    ? "fresh"
    : "known";
}

function withinActiveBoundary(
  snapshot: ProviderTicketSnapshot,
  boundary: "known" | "fresh" | "ambiguous",
  createdAt: string,
): boolean {
  return snapshot.activation.present
    && boundary !== "ambiguous"
    && snapshot.activation.occurredAt !== null
    && createdAt >= snapshot.activation.occurredAt;
}

function discoverySince(window: DiscoveryWindow): string {
  const timestamp = Date.parse(window.updatedAfter);
  if (!Number.isFinite(timestamp)
    || !Number.isSafeInteger(window.overlapSeconds)
    || window.overlapSeconds < 0) {
    throw new Error("invalid GitHub discovery window");
  }
  return new Date(timestamp - window.overlapSeconds * 1_000).toISOString();
}

function normalizeIssueState(issue: Record<string, unknown>): boolean {
  const state = string(issue, "state");
  if (state === "open") return true;
  if (state === "closed") return false;
  throw new Error(`unsupported GitHub issue state: ${state}`);
}

function isLabelEvent(value: unknown, eventName: string, labelName: string): boolean {
  const event = nullableObject(value);
  const label = nullableObject(event?.label);
  return event?.event === eventName && label?.name === labelName;
}

function permission(value: string): Permission {
  switch (value.toLowerCase()) {
    case "admin": return "admin";
    case "maintain": return "maintain";
    case "push":
    case "write": return "write";
    case "triage": return "triage";
    case "pull":
    case "read": return "read";
    default: return "none";
  }
}

function isControllerLabel(label: string): boolean {
  return label === "agent-flow:managed"
    || label === ACTIVATION_LABEL
    || label.startsWith("agent-stage:");
}

function assertTicket(ref: TicketRef, allowlist: Set<string>): void {
  if (ref.provider !== "github") throw new Error("ticket provider must be github");
  if (!allowlist.has(ref.repository)) {
    throw new Error(`GitHub repository is not allowlisted: ${ref.repository}`);
  }
  assertPositiveInteger(ref.number, "ticket number");
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertIdentifier(value: string, label: string): void {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be numeric`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  const result = nullableObject(value);
  if (!result) throw new Error(`${label} must be an object`);
  return result;
}

function nullableObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field) throw new Error(`${key} must be a non-empty string`);
  return field;
}

function optionalString(value: unknown, label: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error(`${label} must be a string or null`);
  return value;
}

function integer(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (!Number.isSafeInteger(field)) throw new Error(`${key} must be an integer`);
  return field as number;
}

function identifier(value: unknown, label: string): string {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error(`${label} must be a numeric identifier`);
}
