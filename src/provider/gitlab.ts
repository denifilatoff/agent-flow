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

export type GitLabConfig = ProviderConfig;

const HEADERS = { accept: "application/json" };
const ACTIVATION_LABEL = "agent-flow:development";
const REVIEW_METADATA =
  /^<!-- agent-flow-review:v1 head=([0-9a-f]{40}) verdict=(approved|changes-requested|commented) -->$/;

export function createGitLabAdapter(
  config: GitLabConfig,
  client: RateLimitedHttpClient,
): ProviderAdapter {
  const allowlist = new Set(config.repositories);
  const apiBase = new URL(config.apiUrl);
  if (!apiBase.pathname.endsWith("/")) apiBase.pathname += "/";
  const apiScope = canonicalApiScope(apiBase);
  const webBase = gitLabWebBase(apiBase);

  function repositoryPath(repository: string): string {
    if (!allowlist.has(repository)) throw new Error(`GitLab repository is not allowlisted: ${repository}`);
    const parts = repository.split("/");
    if (parts.length < 2 || parts.some((part) => !part)) {
      throw new Error(`invalid GitLab repository name: ${repository}`);
    }
    return `projects/${encodeURIComponent(repository)}`;
  }

  function ticketPath(ref: TicketRef): string {
    assertTicket(ref, allowlist);
    return `${repositoryPath(ref.repository)}/issues/${ref.number}`;
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
      if (visited.has(next)) throw new Error("GitLab pagination returned a cycle");
      visited.add(next);
      const response = await request(next, priority);
      items.push(...array(response.data, "GitLab list response"));
      next = response.pagination.next === null
        ? null
        : validatePagination(next, response.pagination.next, apiBase);
    }
    return items;
  }

  async function readProject(repository: string): Promise<Record<string, unknown>> {
    return object(
      (await request(repositoryPath(repository), "active")).data,
      "GitLab project",
    );
  }

  async function readRepository(repository: string): Promise<ProviderRepository> {
    return normalizeProject(await readProject(repository), repository, webBase);
  }

  async function readChangeRequest(
    ref: TicketRef,
    number: number,
  ): Promise<NormalizedChangeRequest> {
    assertTicket(ref, allowlist);
    assertPositiveInteger(number, "merge request number");
    const response = await request(
      `${repositoryPath(ref.repository)}/merge_requests/${number}`,
      "active",
    );
    return normalizeMergeRequest(response.data, ref.repository);
  }

  async function readPermission(repository: string, actor: Actor): Promise<Permission> {
    assertIdentifier(actor.providerId, "GitLab actor id");
    let response: ProviderResponse<unknown>;
    try {
      response = await request(
        `${repositoryPath(repository)}/members/all/${actor.providerId}`,
        "active",
      );
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 404) return "none";
      throw error;
    }
    const member = object(response.data, "GitLab project member");
    if (identifier(member.id, "GitLab project member id") !== actor.providerId) {
      throw new Error("GitLab project member identity mismatch");
    }
    return permission(integer(member, "access_level"));
  }

  async function readSnapshotData(ref: TicketRef) {
    const path = ticketPath(ref);
    const project = await readProject(ref.repository);
    const repository = normalizeProject(project, ref.repository, webBase);
    const issue = object((await request(path, "active")).data, "GitLab issue");
    const open = normalizeIssueState(issue);
    const labels = normalizeLabels(issue.labels);
    const events = await listAll(`${path}/resource_label_events?per_page=100`, "active");
    const activationEvents: Array<{ kind: "add" | "remove"; id: string; createdAt: string; actor: Actor }> = [];
    for (const event of events) {
      const item = object(event, "GitLab label event");
      if (isLabelEvent(item, "add", ACTIVATION_LABEL) || isLabelEvent(item, "remove", ACTIVATION_LABEL)) {
        activationEvents.push({
          kind: item.action === "add" ? "add" as const : "remove" as const,
          id: identifier(item.id, "GitLab activation event id"),
          createdAt: string(item, "created_at"),
          actor: normalizeActor(item.user, "GitLab activation actor"),
        });
      }
    }
    const activationEvent = labels.includes(ACTIVATION_LABEL)
      ? activationEvents.toReversed().find(({ kind }) => kind === "add")
      : undefined;
    const issueUrl = string(issue, "web_url");
    const commentQuery = new URLSearchParams({
      activity_filter: "only_comments",
      order_by: "created_at",
      sort: "asc",
      per_page: "100",
    });
    const comments = (await listAll(`${path}/notes?${commentQuery}`, "active"))
      .map((note) => normalizeNote(note, issueUrl));
    const related = await listAll(`${path}/related_merge_requests?per_page=100`, "active");
    return {
      snapshot: {
        ref,
        repository,
        title: string(issue, "title"),
        description: optionalString(issue.description, "GitLab issue description"),
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
      changeNumbers: findChangeRequestNumbers(related, integer(project, "id"), ref.repository),
    };
  }

  async function readActiveChanges(
    ref: TicketRef,
    data: Awaited<ReturnType<typeof readSnapshotData>>,
    ambiguities: string[],
  ): Promise<{ boundary: RecoveryEvidence["activeBoundary"]; changes: NormalizedChangeRequest[] }> {
    const boundary = activeBoundary(data.snapshot, data.activationEvents, ambiguities);
    const changes = (await Promise.all(data.changeNumbers.map((number) => readChangeRequest(ref, number))))
      .filter((change) => withinActiveBoundary(data.snapshot, boundary, change.createdAt));
    return { boundary, changes };
  }

  return {
    kind: "gitlab",

    async verifyAuth(): Promise<Actor> {
      const response = await request("user", "active");
      return normalizeActor(response.data, "GitLab user");
    },

    async discover(
      repository: string,
      window: DiscoveryWindow,
      cursor?: string,
    ): Promise<DiscoveryPage> {
      const route = `${repositoryPath(repository)}/issues`;
      const updatedAfter = discoverySince(window);
      const query = new URLSearchParams({
        scope: "all",
        state: "all",
        updated_after: updatedAfter,
        per_page: "100",
      });
      const initialPath = `${route}?${query}`;
      let path: string;
      if (cursor !== undefined) {
        const cursorUrl = new URL(cursor, apiBase);
        const expectedUrl = new URL(route, apiBase);
        if (cursorUrl.origin !== expectedUrl.origin
          || cursorUrl.pathname !== expectedUrl.pathname
          || cursorUrl.hash) {
          throw new Error("GitLab discovery cursor does not belong to the repository");
        }
        const expected = { scope: "all", state: "all", updated_after: updatedAfter, per_page: "100" };
        for (const [name, value] of Object.entries(expected)) {
          if (cursorUrl.searchParams.getAll(name).length !== 1
            || cursorUrl.searchParams.get(name) !== value) {
            throw new Error("GitLab cursor does not match the discovery window");
          }
        }
        for (const name of cursorUrl.searchParams.keys()) {
          if (!Object.hasOwn(expected, name) && name !== "page") {
            throw new Error("GitLab cursor does not match the discovery window");
          }
        }
        const pages = cursorUrl.searchParams.getAll("page");
        const page = Number(pages[0]);
        if (pages.length !== 1
          || !/^[1-9]\d*$/.test(pages[0]!)
          || !Number.isSafeInteger(page)
          || page <= 1) {
          throw new Error("GitLab discovery cursor requires one advancing page parameter");
        }
        path = cursor;
      } else {
        path = initialPath;
      }

      const response = await request(path, "background");
      return {
        tickets: issueRefs(response.data, repository),
        nextCursor: response.pagination.next === null
          ? null
          : validatePagination(path, response.pagination.next, apiBase),
      };
    },

    async bootstrap(repository: string): Promise<TicketRef[]> {
      const route = `${repositoryPath(repository)}/issues`;
      const query = new URLSearchParams({
        scope: "all",
        state: "all",
        labels: ACTIVATION_LABEL,
        per_page: "100",
      });
      return issueRefs(await listAll(`${route}?${query}`, "background"), repository);
    },

    readRepository,

    async readTicket(ref: TicketRef): Promise<ProviderTicketSnapshot> {
      const data = await readSnapshotData(ref);
      const { changes } = await readActiveChanges(ref, data, []);
      const change = uniqueChange(changes, "GitLab issue has multiple related merge requests");
      return {
        ...data.snapshot,
        changeRequest: change,
      };
    },

    async readRecoveryEvidence(ref: TicketRef): Promise<RecoveryEvidence> {
      const data = await readSnapshotData(ref);
      const ambiguities: string[] = [];
      const { boundary, changes } = await readActiveChanges(ref, data, ambiguities);
      const reviewRows = await Promise.all(changes.map(async (change) => ({
        change,
        values: await listAll(`${repositoryPath(ref.repository)}/merge_requests/${change.number}/notes?per_page=100`, "active"),
      })));
      const permissionCache = new Map<string, boolean>();
      const authorized = async (actor: Actor): Promise<boolean> => {
        const cached = permissionCache.get(actor.providerId);
        if (cached !== undefined) return cached;
        const allowed = ["write", "maintain", "admin"].includes(await readPermission(ref.repository, actor));
        permissionCache.set(actor.providerId, allowed);
        return allowed;
      };
      if (data.snapshot.activation.present) {
        if (!data.snapshot.activation.actor) ambiguities.push("activation author is unavailable");
        else if (!await authorized(data.snapshot.activation.actor)) ambiguities.push("activation author is not authorized");
      }
      const publications: Publication[] = [];
      let legacyActive = false;
      const addPublication = async (
        kind: "comment" | "change-request" | "review",
        id: string,
        body: string,
        createdAt: string,
        updatedAt: string | null,
        actor: Actor,
        provenanceAvailable = true,
      ): Promise<void> => {
        const key = publicationKey("gitlab", apiScope, ref.repository, kind, id);
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
        if ((kind !== "change-request" && updatedAt !== null && updatedAt !== createdAt)
          || !provenanceAvailable) {
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
      for (const { change, values } of reviewRows) {
        const marked = parsePublication(change.body).kind === "current";
        const descriptionWasEdited = marked && change.updatedAt !== change.createdAt
          && values.some((value) => {
            const row = object(value, "GitLab merge request note");
            return row.system === true
              && optionalString(row.body, "GitLab merge request system note body") === "changed the description";
          });
        await addPublication(
          "change-request",
          String(change.number),
          change.body,
          change.createdAt,
          change.updatedAt,
          change.actor,
          !descriptionWasEdited,
        );
      }
      const reviews: NormalizedReview[] = [];
      for (const { change, values } of reviewRows) {
        for (const value of values) {
          const row = object(value, "GitLab review note");
          const id = identifier(row.id, "GitLab review note id");
          const body = optionalString(row.body, "GitLab review note body");
          const submittedAt = string(row, "created_at");
          const updatedAt = string(row, "updated_at");
          const actor = normalizeActor(row.author, "GitLab review note actor");
          const parsed = parsePublication(body);
          if (parsed.kind === "current") {
            try {
              const review = normalizeReviewNote(row, change, false);
              reviews.push(review);
              await addPublication("review", id, body, submittedAt, updatedAt, actor);
            } catch (error) {
              ambiguities.push(`invalid review evidence: ${publicationKey("gitlab", apiScope, ref.repository, "review", id)}: ${error instanceof Error ? error.message : "unknown error"}`);
            }
          } else {
            await addPublication("review", id, body, submittedAt, updatedAt, actor);
          }
        }
      }
      if (changes.length > 1) ambiguities.push("multiple linked merge requests");
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
      return readPermission(repository, actor);
    },

    async readComment(ref: TicketRef, id: string): Promise<ProviderComment> {
      assertIdentifier(id, "note id");
      const response = await request(`${ticketPath(ref)}/notes/${id}`, "active");
      return normalizeNote(response.data, issueWebUrl(webBase, ref, id));
    },

    async createComment(ref: TicketRef, body: string): Promise<ProviderComment> {
      const response = await request(`${ticketPath(ref)}/notes`, "active", {
        method: "POST",
        body: { body },
      });
      const note = object(response.data, "GitLab note");
      const id = identifier(note.id, "GitLab note id");
      return normalizeNote(note, issueWebUrl(webBase, ref, id));
    },

    async updateComment(ref: TicketRef, id: string, body: string): Promise<ProviderComment> {
      assertIdentifier(id, "note id");
      const response = await request(`${ticketPath(ref)}/notes/${id}`, "active", {
        method: "PUT",
        body: { body },
      });
      return normalizeNote(response.data, issueWebUrl(webBase, ref, id));
    },

    async setControllerLabels(ref: TicketRef, remove: string[], add: string[]): Promise<string[]> {
      for (const label of [...remove, ...add]) {
        if (!isControllerLabel(label)) throw new Error(`label is not controller-owned: ${label}`);
      }
      const path = ticketPath(ref);
      const additions = [...new Set(add)];
      const additionSet = new Set(additions);
      const removals = [...new Set(remove)].filter((label) => !additionSet.has(label));
      if (additions.length > 0 || removals.length > 0) {
        const body: Record<string, string> = {};
        if (removals.length > 0) body.remove_labels = removals.join(",");
        if (additions.length > 0) body.add_labels = additions.join(",");
        await request(path, "active", { method: "PUT", body });
      }
      const issue = object((await request(path, "active")).data, "GitLab issue");
      return normalizeLabels(issue.labels);
    },

    readChangeRequest,

    async findReview(
      ref: TicketRef,
      changeNumber: number,
      marker: string,
      excludedIds: readonly string[] = [],
    ): Promise<NormalizedReview | null> {
      assertTicket(ref, allowlist);
      assertPositiveInteger(changeNumber, "merge request number");
      const notes = await listAll(
        `${repositoryPath(ref.repository)}/merge_requests/${changeNumber}/notes?per_page=100`,
        "active",
      );
      const excluded = new Set(excludedIds);
      const matches = notes.filter((value) => {
        const note = object(value, "GitLab review note");
        return !excluded.has(identifier(note.id, "GitLab review note id"))
          && optionalString(note.body, "GitLab review note body").split(/\r?\n/, 1)[0] === marker;
      });
      if (matches.length > 1) {
        throw new Error("multiple GitLab review notes match the publication marker");
      }
      if (matches[0] === undefined) return null;
      return normalizeReviewNote(matches[0], await readChangeRequest(ref, changeNumber));
    },

    async readReview(ref: TicketRef, changeNumber: number, id: string): Promise<NormalizedReview> {
      assertTicket(ref, allowlist);
      assertPositiveInteger(changeNumber, "merge request number");
      assertIdentifier(id, "review note id");
      const change = await readChangeRequest(ref, changeNumber);
      const response = await request(
        `${repositoryPath(ref.repository)}/merge_requests/${changeNumber}/notes/${id}`,
        "active",
      );
      return normalizeReviewNote(response.data, change);
    },
  };
}

function validatePagination(currentPath: string, nextPath: string, apiBase: URL): string {
  const current = new URL(currentPath, apiBase);
  const next = new URL(nextPath, apiBase);
  if (next.origin !== current.origin
    || next.pathname !== current.pathname
    || next.username
    || next.password
    || next.hash) {
    throw new Error("GitLab pagination changed the request route");
  }

  const currentPage = paginationPage(current, false);
  const nextPage = paginationPage(next, true);
  if (nextPage <= currentPage) throw new Error("GitLab pagination page did not advance");
  if (paginationFilters(current) !== paginationFilters(next)) {
    throw new Error("GitLab pagination changed request filters");
  }
  return nextPath;
}

function paginationPage(url: URL, required: boolean): number {
  const values = url.searchParams.getAll("page");
  if (values.length === 0 && !required) return 1;
  const page = Number(values[0]);
  if (values.length !== 1
    || !/^[1-9]\d*$/.test(values[0]!)
    || !Number.isSafeInteger(page)) {
    throw new Error("GitLab pagination requires exactly one positive page parameter");
  }
  return page;
}

function paginationFilters(url: URL): string {
  return JSON.stringify(
    [...url.searchParams.entries()]
      .filter(([name]) => name !== "page")
      .sort(([leftName, leftValue], [rightName, rightValue]) =>
        leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)),
  );
}

function normalizeProject(
  project: Record<string, unknown>,
  repository: string,
  cloneRoot: URL,
): ProviderRepository {
  const name = string(project, "path_with_namespace");
  if (name !== repository) {
    throw new Error(`GitLab repository identity mismatch: expected ${repository}, received ${name}`);
  }
  return {
    provider: "gitlab",
    name,
    host: cloneRoot.host,
    cloneRoot: cloneRoot.href,
    cloneUrl: string(project, "http_url_to_repo"),
  };
}

function issueRefs(value: unknown, repository: string): TicketRef[] {
  return array(value, "GitLab issues").map((item) => {
    const issue = object(item, "GitLab issue list entry");
    const number = integer(issue, "iid");
    assertPositiveInteger(number, "ticket number");
    return { provider: "gitlab", repository, number };
  });
}

function normalizeMergeRequest(value: unknown, repository: string): NormalizedChangeRequest {
  const mergeRequest = object(value, "GitLab merge request");
  const providerState = string(mergeRequest, "state");
  let state: NormalizedChangeRequest["state"];
  switch (providerState) {
    case "opened": state = "open"; break;
    case "closed": state = "closed"; break;
    case "merged": state = "merged"; break;
    default: throw new Error(`unsupported GitLab merge request state: ${providerState}`);
  }
  return {
    provider: "gitlab",
    repository,
    number: integer(mergeRequest, "iid"),
    url: string(mergeRequest, "web_url"),
    headSha: string(mergeRequest, "sha"),
    state,
    actor: normalizeActor(mergeRequest.author, "GitLab merge request actor"),
    body: optionalString(mergeRequest.description, "GitLab merge request description"),
    createdAt: string(mergeRequest, "created_at"),
    updatedAt: string(mergeRequest, "updated_at"),
  };
}

function normalizeReviewNote(
  value: unknown,
  change: NormalizedChangeRequest,
  requireCurrentHead = true,
): NormalizedReview {
  const note = object(value, "GitLab review note");
  const body = optionalString(note.body, "GitLab review note body");
  const metadata = REVIEW_METADATA.exec(body.split(/\r?\n/)[1] ?? "");
  if (!metadata) throw new Error("invalid GitLab review note metadata");
  const headSha = metadata[1]!;
  if (requireCurrentHead && headSha !== change.headSha) {
    throw new Error("GitLab review note head SHA does not match the merge request head SHA");
  }
  const id = identifier(note.id, "GitLab review note id");
  return {
    id,
    url: noteArtifactUrl(note, change.url, id),
    actor: normalizeActor(note.author, "GitLab review note actor"),
    submittedAt: string(note, "created_at"),
    headSha,
    verdict: metadata[2] as NormalizedReview["verdict"],
    body,
  };
}

function normalizeNote(value: unknown, resourceUrl: string): ProviderComment {
  const note = object(value, "GitLab note");
  const id = identifier(note.id, "GitLab note id");
  return {
    id,
    url: noteArtifactUrl(note, resourceUrl, id),
    body: optionalString(note.body, "GitLab note body"),
    actor: normalizeActor(note.author, "GitLab note actor"),
    createdAt: string(note, "created_at"),
    updatedAt: string(note, "updated_at"),
  };
}

function normalizeActor(value: unknown, label: string): Actor {
  const actor = object(value, label);
  return {
    login: string(actor, "username"),
    providerId: identifier(actor.id, `${label} id`),
  };
}

function normalizeLabels(value: unknown): string[] {
  return array(value, "GitLab labels").map((label) => {
    if (typeof label !== "string" || !label) throw new Error("GitLab label must be a non-empty string");
    return label;
  });
}

function findChangeRequestNumbers(
  related: unknown[],
  projectId: number,
  repository: string,
): number[] {
  const candidates = new Set<number>();
  for (const item of related) {
    const mergeRequest = object(item, "GitLab related merge request");
    if (integer(mergeRequest, "project_id") !== projectId) continue;
    const number = integer(mergeRequest, "iid");
    assertPositiveInteger(number, "merge request number");
    const references = nullableObject(mergeRequest.references);
    if (references && string(references, "full") !== `${repository}!${number}`) continue;
    candidates.add(number);
  }
  return [...candidates].sort((left, right) => left - right);
}

function uniqueChange(changes: readonly NormalizedChangeRequest[], message: string): NormalizedChangeRequest | null {
  if (changes.length > 1) throw new Error(message);
  return changes[0] ?? null;
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
  if (events.some((event) => event.kind === "remove" && event.createdAt < snapshot.activation.occurredAt!)) {
    return "fresh";
  }
  const firstActivation = events.length === 1
    && events[0]!.kind === "add"
    && !snapshot.labels.includes("agent-flow:managed")
    && !snapshot.labels.some((label) => label.startsWith("agent-stage:"));
  return firstActivation ? "fresh" : "known";
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
    throw new Error("invalid GitLab discovery window");
  }
  return new Date(timestamp - window.overlapSeconds * 1_000).toISOString();
}

function normalizeIssueState(issue: Record<string, unknown>): boolean {
  const state = string(issue, "state");
  if (state === "opened") return true;
  if (state === "closed") return false;
  throw new Error(`unsupported GitLab issue state: ${state}`);
}

function isLabelEvent(value: unknown, action: string, labelName: string): boolean {
  const event = nullableObject(value);
  const label = nullableObject(event?.label);
  return event?.action === action && label?.name === labelName;
}

function permission(accessLevel: number): Permission {
  if (accessLevel >= 50) return "admin";
  if (accessLevel >= 40) return "maintain";
  if (accessLevel >= 30) return "write";
  if (accessLevel >= 20) return "read";
  if (accessLevel >= 15) return "triage";
  if (accessLevel >= 10) return "read";
  return "none";
}

function issueWebUrl(webBase: URL, ref: TicketRef, noteId: string): string {
  return noteUrl(webBase, ref.repository, "issues", ref.number, noteId);
}

function noteUrl(
  webBase: URL,
  repository: string,
  resource: "issues" | "merge_requests",
  number: number,
  noteId: string,
): string {
  const path = repository.split("/").map(encodeURIComponent).join("/");
  const url = new URL(webBase);
  const root = url.pathname.replace(/\/$/, "");
  url.pathname = `${root}/${path}/-/${resource}/${number}`;
  url.hash = `note_${noteId}`;
  return url.href;
}

function noteArtifactUrl(note: Record<string, unknown>, resourceUrl: string, noteId: string): string {
  if (note.web_url !== undefined && note.web_url !== null) {
    return new URL(string(note, "web_url")).href;
  }
  const url = new URL(resourceUrl);
  url.hash = `note_${noteId}`;
  return url.href;
}

function gitLabWebBase(apiBase: URL): URL {
  const webBase = new URL(apiBase);
  const path = webBase.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/api/v4")) throw new Error("GitLab API URL must end with /api/v4");
  webBase.pathname = `${path.slice(0, -"/api/v4".length)}/`;
  webBase.search = "";
  webBase.hash = "";
  return webBase;
}

function isControllerLabel(label: string): boolean {
  return label === "agent-flow:managed"
    || label === ACTIVATION_LABEL
    || label.startsWith("agent-stage:");
}

function assertTicket(ref: TicketRef, allowlist: Set<string>): void {
  if (ref.provider !== "gitlab") throw new Error("ticket provider must be gitlab");
  if (!allowlist.has(ref.repository)) {
    throw new Error(`GitLab repository is not allowlisted: ${ref.repository}`);
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
