import type { ProviderConfig } from "../config/types.js";
import { ProviderHttpError } from "./http.ts";
import { parseMigrationReceipt } from "./migration-receipt.ts";
import { parsePublication, unanchoredPublicationKeys, type Publication } from "./publication.ts";
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
  RequiredChecks,
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
const DEFAULT_ACTIVATION_LABELS = ["agent-flow:development"];
const REVIEW_METADATA =
  /^<!-- agent-flow-review:v1 head=([0-9a-f]{40}) verdict=(approved|changes-requested|commented) -->$/;

export function createGitHubAdapter(
  config: GitHubConfig,
  client: RateLimitedHttpClient,
  activationLabels: readonly string[] = DEFAULT_ACTIVATION_LABELS,
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

  async function githubDescriptionWasEdited(ref: TicketRef, number: number): Promise<boolean> {
    const [owner, name] = ref.repository.split("/") as [string, string];
    const response = object((await request(
      apiBase.pathname.endsWith("/api/v3/") ? "../graphql" : "graphql",
      "active",
      {
        method: "POST",
        body: {
          query: "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){lastEditedAt}}}",
          variables: { owner, name, number },
        },
      },
    )).data, "GitHub GraphQL response");
    if (response.errors !== undefined) throw new Error("GitHub pull request edit history is unavailable");
    const data = object(response.data, "GitHub GraphQL data");
    const repository = object(data.repository, "GitHub GraphQL repository");
    const pull = object(repository.pullRequest, "GitHub GraphQL pull request");
    return optionalString(pull.lastEditedAt, "GitHub pull request lastEditedAt") !== "";
  }

  async function reviewEditProvenance(values: unknown[]): Promise<Map<string, string | null>> {
    const ids = [...new Set(values.flatMap((value) => {
      const row = object(value, "GitHub review");
      return parsePublication(optionalString(row.body, "GitHub review body")).kind === "current"
        && typeof row.node_id === "string" && row.node_id ? [row.node_id] : [];
    }))];
    const edits = new Map<string, string | null>();
    for (let offset = 0; offset < ids.length; offset += 100) {
      try {
        const response = object((await request(
          apiBase.pathname.endsWith("/api/v3/") ? "../graphql" : "graphql", "active",
          { method: "POST", body: {
            query: "query($ids:[ID!]!){nodes(ids:$ids){id __typename ... on PullRequestReview {lastEditedAt}}}",
            variables: { ids: ids.slice(offset, offset + 100) },
          } },
        )).data, "GitHub GraphQL response");
        if (response.errors !== undefined) continue;
        const nodes = array(object(response.data, "GitHub GraphQL data").nodes, "GitHub review nodes");
        for (const value of nodes) {
          if (value === null) continue;
          const node = object(value, "GitHub review node");
          if (node.__typename === "PullRequestReview" && typeof node.id === "string"
            && (node.lastEditedAt === null || typeof node.lastEditedAt === "string")) {
            edits.set(node.id, node.lastEditedAt);
          }
        }
      } catch { /* Unavailable edit provenance cannot elect an owner. */ }
    }
    return edits;
  }

  async function readSnapshotData(ref: TicketRef, pinnedActivationLabel?: string) {
    const recognizedLabels = pinnedActivationLabel ? [pinnedActivationLabel] : activationLabels;
    const path = ticketPath(ref);
    const repository = await readRepository(ref.repository);
    const issue = object((await request(path, "active")).data, "GitHub issue");
    const open = normalizeIssueState(issue);
    const labels = normalizeLabels(issue.labels);
    const timeline = await listAll(`${path}/timeline?per_page=100`, "active");
    const comments = (await listAll(`${path}/comments?per_page=100`, "active"))
      .map(normalizeComment);
    const activeLabels = recognizedLabels.filter((label) => labels.includes(label));
    const activationEvents: Array<{ kind: "add" | "remove"; label: string; id: string; createdAt: string; actor: Actor }> = [];
    for (const event of timeline) {
      const item = object(event, "GitHub timeline event");
      const label = recognizedLabels.find((label) =>
        isLabelEvent(item, "labeled", label) || isLabelEvent(item, "unlabeled", label));
      if (label) activationEvents.push({
        kind: item.event === "labeled" ? "add" : "remove", label,
        id: identifier(item.id, "GitHub activation event id"),
        createdAt: string(item, "created_at"), actor: normalizeActor(item.actor, "GitHub activation actor"),
      });
    }
    const activationEvent = activationEvents.toReversed()
      .find(({ kind, label }) => kind === "add" && activeLabels.includes(label));
    const linkAmbiguities: string[] = [];
    const boundary = activeBoundary({ activation: { present: activeLabels.length > 0, occurredAt: activationEvent?.createdAt ?? null, actor: activationEvent?.actor ?? null }, labels } as ProviderTicketSnapshot,
      activationEvents.filter(({ label }) => label === activationEvent?.label), linkAmbiguities);
    const links = findChangeRequestNumbers(
      timeline.filter((value) => {
        const event = object(value, "GitHub timeline event");
        const time = typeof event.created_at === "string" ? Date.parse(event.created_at) : NaN;
        return boundary !== "fresh" || !Number.isFinite(time) || time >= Date.parse(activationEvent!.createdAt);
      }),
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
          present: activeLabels.length > 0,
          label: activationEvent?.label ?? null,
          eventId: activationEvent?.id ?? null,
          actor: activationEvent?.actor ?? null,
          occurredAt: activationEvent?.createdAt ?? null,
        },
        comments,
        changeRequest: null,
      },
      activationEvents: activationEvents.filter(({ label }) => label === activationEvent?.label),
      changeNumbers: links.numbers,
      linkAmbiguities: links.ambiguities,
    };
  }

  async function readActiveChanges(
    ref: TicketRef,
    data: Awaited<ReturnType<typeof readSnapshotData>>,
    ambiguities: string[],
  ): Promise<{ boundary: RecoveryEvidence["activeBoundary"]; changes: NormalizedChangeRequest[] }> {
    const boundary = activeBoundary(data.snapshot, data.activationEvents, ambiguities);
    const changes = (await Promise.all(data.changeNumbers.map((number) => readChangeRequest(ref, number))))
      .filter((change) => withinActiveBoundary(data.snapshot, boundary, change.createdAt, ambiguities));
    return { boundary, changes };
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
      for (const label of ["agent-flow:managed", ...activationLabels]) {
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

    async readTicket(ref: TicketRef, pinnedActivationLabel?: string): Promise<ProviderTicketSnapshot> {
      const data = await readSnapshotData(ref, pinnedActivationLabel);
      const { changes } = await readActiveChanges(ref, data, []);
      const carried = data.snapshot.comments.filter(comment=>!data.snapshot.activation.occurredAt || Date.parse(comment.createdAt)>=Date.parse(data.snapshot.activation.occurredAt)).flatMap(comment => { const parsed = parseMigrationReceipt(comment.body); return parsed ? [parsed.receipt.change.number] : []; }).at(-1);
      const change = carried ? changes.find(change => change.number === carried) ?? null : uniqueChange(changes, "GitHub issue has multiple related pull requests");
      return {
        ...data.snapshot,
        changeRequest: change,
      };
    },

    async readRecoveryEvidence(ref: TicketRef, pinnedActivationLabel?: string): Promise<RecoveryEvidence> {
      const data = await readSnapshotData(ref, pinnedActivationLabel);
      const ambiguities: string[] = [...data.linkAmbiguities];
      const { boundary, changes } = await readActiveChanges(ref, data, ambiguities);
      const reviewRows = await Promise.all(changes.map(async (change) => ({
        change,
        values: await listAll(
          `repos/${repositoryPath(ref.repository)}/pulls/${change.number}/reviews?per_page=100`,
          "active",
        ),
      })));
      const reviewEdits = await reviewEditProvenance(reviewRows.flatMap(({ values }) => values));
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
        provenanceAvailable = true,
      ): Promise<void> => {
        const key = publicationKey("github", apiScope, canonicalRepository, kind, id);
        const parsed = parsePublication(body);
        if (parsed.kind === "unmarked") return;
        if (!withinActiveBoundary(data.snapshot, boundary, createdAt, ambiguities)) return;
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
        const original = (updatedAt === null || updatedAt === createdAt || kind === "change-request")
          && provenanceAvailable;
        if (!original && kind === "comment") {
          ambiguities.push(`publication provenance is unavailable: ${key}`);
          return;
        }
        if (!await authorized(actor)) {
          ambiguities.push(`publication author is not authorized: ${key}`);
          return;
        }
        publications.push({ key, createdAt, metadata, ...original ? {} : { ownershipEligible: false } });
      };
      for (const comment of data.snapshot.comments) {
        await addPublication("comment", comment.id, comment.body, comment.createdAt, comment.updatedAt, comment.actor);
      }
      for (const change of changes) {
        const marked = parsePublication(change.body).kind === "current";
        const provenanceAvailable = !marked || change.updatedAt === change.createdAt
          || !await githubDescriptionWasEdited(ref, change.number);
        await addPublication(
          "change-request",
          String(change.number),
          change.body,
          change.createdAt,
          change.updatedAt,
          change.actor,
          provenanceAvailable,
        );
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
              const original = reviewEdits.has(String(row.node_id))
                && (reviewEdits.get(String(row.node_id)) === null
                  || Date.parse(reviewEdits.get(String(row.node_id))!) < Date.parse(submittedAt));
              if (original) reviews.push(normalizeReview(row));
              await addPublication("review", id, body, submittedAt, null, actor, original);
            } catch (error) {
              ambiguities.push(`invalid review evidence: ${publicationKey("github", apiScope, canonicalRepository, "review", id)}: ${error instanceof Error ? error.message : "unknown error"}`);
            }
          } else {
            await addPublication("review", id, body, submittedAt, null, actor);
          }
        }
      }
      for (const key of unanchoredPublicationKeys(publications)) {
        ambiguities.push(`publication provenance is unavailable: ${key}`);
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

    async setControllerLabels(
      ref: TicketRef,
      remove: string[],
      add: string[],
      pinnedActivationLabels: readonly string[] = [],
    ): Promise<string[]> {
      for (const label of [...remove, ...add]) {
        if (!isControllerLabel(label, [...activationLabels, ...pinnedActivationLabels])) {
          throw new Error(`label is not controller-owned: ${label}`);
        }
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

    async readRequiredChecks(ref, change) {
      assertTicket(ref, allowlist);
      if (change.provider !== "github" || change.repository !== ref.repository || !/^[0-9a-f]{40}$/.test(change.headSha)) {
        throw new Error("CI change request identity mismatch");
      }
      const checks: RequiredChecks["checks"] = [];
      const visited = new Set<string>();
      let path: string | null = `repos/${repositoryPath(ref.repository)}/commits/${change.headSha}/check-runs?filter=latest&per_page=100`;
      while (path) {
        if (visited.has(path)) throw new Error("GitHub CI pagination cycle");
        visited.add(path);
        const response = await request(path, "active");
        const page = object(response.data, "GitHub checks");
        for (const item of array(page.check_runs, "GitHub check runs")) {
          const run = object(item, "GitHub check run");
          if (string(run, "head_sha") !== change.headSha) throw new Error("CI head mismatch");
          const status = string(run, "status");
          checks.push({ name: string(run, "name"), status: status !== "completed" ? "pending"
            : run.conclusion === "success" ? "success" : "failure" });
        }
        path = response.pagination.next;
      }
      // Commit statuses are a separate CI mechanism; include the latest value per context.
      const statuses = await listAll(`repos/${repositoryPath(ref.repository)}/commits/${change.headSha}/statuses?per_page=100`, "active");
      const seen = new Set<string>();
      for (const item of statuses) {
        const status = object(item, "GitHub commit status");
        const name = string(status, "context");
        if (seen.has(name)) continue;
        seen.add(name);
        checks.push({ name, status: status.state === "success" ? "success" : status.state === "pending" ? "pending" : "failure" });
      }
      return { headSha: change.headSha, checks };
    },
    readChangeRequest,

    async findReview(
      ref: TicketRef,
      changeNumber: number,
      marker: string,
      excludedIds: readonly string[] = [],
    ): Promise<NormalizedReview | null> {
      assertTicket(ref, allowlist);
      assertPositiveInteger(changeNumber, "pull request number");
      const reviews = await listAll(
        `repos/${repositoryPath(ref.repository)}/pulls/${changeNumber}/reviews?per_page=100`,
        "active",
      );
      const excluded = new Set(excludedIds);
      const matches = reviews.filter((value) => {
        const review = object(value, "GitHub review");
        return !excluded.has(identifier(review.id, "GitHub review id"))
          && optionalString(review.body, "GitHub review body").split(/\r?\n/, 1)[0] === marker;
      });
      if (matches.length > 1) {
        throw new Error("multiple GitHub reviews match the publication marker");
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
    objectId: String(pull.node_id ?? pull.id ?? pull.number),
    ...typeof (pull.head as Record<string,unknown>).ref === "string" ? { headBranch: (pull.head as Record<string,unknown>).ref as string } : {},
    ...((pull.head as Record<string,unknown>).repo as Record<string,unknown> | null)?.full_name ? { headRepository: ((pull.head as Record<string,unknown>).repo as Record<string,unknown>).full_name as string } : {},
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
  ambiguities: string[],
): boolean {
  if (!snapshot.activation.present || boundary === "ambiguous" || snapshot.activation.occurredAt === null) {
    return false;
  }
  const activationTime = Date.parse(snapshot.activation.occurredAt);
  const publicationTime = Date.parse(createdAt);
  if (!Number.isFinite(activationTime) || !Number.isFinite(publicationTime)) {
    ambiguities.push("publication or activation timestamp is invalid");
    return false;
  }
  if (publicationTime === activationTime) {
    ambiguities.push("publication order at the activation timestamp is ambiguous");
    return false;
  }
  return publicationTime > activationTime;
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

function isControllerLabel(label: string, activationLabels: readonly string[]): boolean {
  return label === "agent-flow:managed"
    || activationLabels.includes(label)
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
