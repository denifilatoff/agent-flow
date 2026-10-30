import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";

import { RuntimeManager } from "../../src/config/runtime.ts";
import { parseControlComment } from "../../src/provider/control-comment.ts";
import { electOwner, parsePublication, renderPublication, type Publication } from "../../src/provider/publication.ts";
import type {
  AgentDecision,
  AgentReceipt,
  ControlState,
} from "../../src/config/types.ts";
import type { NormalizedChangeRequest, ProviderComment, ProviderKind } from "../../src/provider/types.ts";
import { createProductionDependencies } from "../../src/main.ts";
import { runPreflight, type ReadyDependencies } from "../../src/preflight.ts";
import { providerScope } from "../../src/runtime/local-store.ts";

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NEXT_HEAD = "1111111111111111111111111111111111111111";
const MAINTAINER = { login: "maintainer", providerId: "7" };
const CONTROLLER = { login: "controller", providerId: "51" };

type AttemptMode = "success" | "exit-failure" | "block" | "late" | "crash-after-publish" | "reuse" | "race";

interface FixtureOptions {
  oldCiPolicy?:boolean;
  firstAttempt?: AttemptMode;
  forceStartupFailure?: boolean;
  repairCiAfterFailure?: boolean;
  ciAfterReview?: "success" | "pending" | "failure";
}

interface StoredComment {
  id: string;
  body: string;
  actor: { login: string; providerId: string };
  createdAt: string;
  updatedAt: string;
}

interface StoredChange {
  number: number;
  headSha: string;
  state: "open" | "closed" | "merged";
  updatedAt: string;
  createdAt: string;
  body: string;
}

interface StoredReview {
  id: string;
  body: string;
  headSha: string;
  verdict: "approved" | "changes-requested" | "commented";
  createdAt: string;
}

interface RoutingEvent {
  kind: "compile" | "run";
  agentId: string;
  target: "claude" | "codex";
}

interface LabelEvent {
  id: number;
  action: "add" | "remove";
  createdAt: string;
}

interface RunningController {
  ready: ReadyDependencies;
  abort: AbortController;
  run: Promise<void>;
}

export interface CollisionResult {
  ownerSeenByA: string | null;
  ownerSeenByB: string | null;
  loserCancelled: boolean;
  loserWritesAfterObservation: number;
  loserDisposition: string | null;
  duplicateCommentsDeleted: number;
  extraOwnershipReadsBeforePublication: number;
  requestLog: Array<{ method: string; path: string; phase: string; installation: string | null }>;
}

export interface FixtureRun {
  activate(): Promise<void>;
  activeProcesses(): Promise<number>;
  answer(body: string): Promise<void>;
  blockNextAttempt(state: string): Promise<void>;
  requestChangesOnNextReview(): Promise<void>;
  changeHead(): Promise<void>;
  setCi(status: "success" | "pending" | "failure" | "missing"): Promise<void>;
  changeRequest(): Promise<NormalizedChangeRequest | null>;
  close(): Promise<void>;
  closeChangeRequest(): Promise<void>;
  control(): Promise<ControlState>;
  controllerLabels(): Promise<string[]>;
  compilations(): Promise<Array<Omit<RoutingEvent, "kind">>>;
  collide(): Promise<CollisionResult>;
  decisions(): Promise<AgentDecision[]>;
  finish(): Promise<void>;
  humanAnswers(): Promise<ProviderComment[]>;
  latestAgentComment(): Promise<ProviderComment | null>;
  maximumConcurrentAttempts(): Promise<number>;
  mergeChangeRequest(): Promise<void>;
  migrate(resume?:string,agentOnly?:boolean):Promise<string>;
  migrateCiPolicy():Promise<string>;
  migrationReceipts():Promise<string[]>;
  reconcile(): Promise<void>;
  receipts(): Promise<AgentReceipt[]>;
  reviewRequests(): Promise<string[]>;
  controllerCommentWrites(): Promise<number>;
  removeActivation(): Promise<void>;
  restart(): Promise<void>;
  resetDatabaseAndRestart(): Promise<void>;
  reactivateAfterStop(): Promise<void>;
  controllerId(): Promise<string>;
  routing(): Promise<Array<Omit<RoutingEvent, "kind">>>;
  sessions(): Promise<string[]>;
  untilAttempt(status: "started" | "succeeded"): Promise<void>;
  untilAgentComments(count: number): Promise<void>;
  agentCommentIds(): Promise<string[]>;
  untilState(state: string): Promise<void>;
  unauthenticatedProviderStatus(): Promise<number>;
}

export async function startFixture(provider: ProviderKind, options: FixtureOptions = {}): Promise<FixtureRun> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `agent-flow-e2e-${provider}-`)));
  const originalCertificates = getCACertificates("default");
  const previous = { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS };
  let server: Server | undefined;
  let running: RunningController | undefined;
  let competitor: RunningController | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let certificatesChanged = false;
  let environmentChanged = false;

  const cleanup = (): Promise<void> => cleanupPromise ??= performCleanup();
  async function performCleanup(): Promise<void> {
    const operations: Promise<unknown>[] = [];
    if (running) {
      running.abort.abort();
      operations.push(running.run);
    }
    if (competitor) {
      competitor.abort.abort();
      operations.push(competitor.run);
    }
    if (server?.listening) operations.push(closeServer(server));
    const results = await Promise.allSettled(operations);
    for (const controller of [running, competitor]) {
      if (!controller) continue;
      try {
        controller.ready.store.close();
      } catch (error) {
        results.push({ status: "rejected", reason: error });
      }
    }
    if (environmentChanged) {
      if (previous.PATH === undefined) delete process.env.PATH;
      else process.env.PATH = previous.PATH;
      if (previous.NODE_EXTRA_CA_CERTS === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = previous.NODE_EXTRA_CA_CERTS;
    }
    if (certificatesChanged) {
      try {
        setDefaultCACertificates(originalCertificates);
      } catch (error) {
        results.push({ status: "rejected", reason: error });
      }
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      results.push({ status: "rejected", reason: error });
    }
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "fixture shutdown failed");
  }

  try {
  const certificate = join(root, "fixture.crt");
  const key = join(root, "fixture.key");
  await createCertificate(certificate, key);
  certificatesChanged = true;
  setDefaultCACertificates([...originalCertificates, await readFile(certificate, "utf8")]);
  const state = new FixtureState(provider, options.firstAttempt,options.oldCiPolicy);
  state.ciAfterReview = options.ciAfterReview;
  state.repairCiAfterFailure = options.repairCiAfterFailure;
  server = createServer({ cert: await readFile(certificate), key: await readFile(key) }, (request, response) => {
    void state.handle(request, response).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "fixture failed" }));
    });
  });
  await listen(server);
  const address = server.address();
  assert(address && typeof address !== "string");
  state.origin = `https://localhost:${address.port}`;

  const configRepository = join(root, "config-repository");
  const dataDirectory = join(root, "data");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const eventsPath = join(root, "events.ndjson");
  await Promise.all([mkdir(dataDirectory, { mode: 0o700 }), mkdir(bin), mkdir(home)]);
  await createTools(bin);
  await createAuth(home);
  const tokenFile = join(root, "provider-token");
  const operatorAuthFile = join(root, "operator-password");
  await Promise.all([
    writeFile(tokenFile, "fixture\n", { mode: 0o600 }),
    writeFile(operatorAuthFile, "operator-password-314159\n", { mode: 0o600 }),
  ]);
  const runtimePath = await createConfiguration(
    provider,
    configRepository,
    dataDirectory,
    state.apiUrl,
    address.port + 1,
    configRepository,
    dataDirectory,
    tokenFile,
    join(home, ".codex/auth.json"),
    join(home, ".claude/.credentials.json"),
    operatorAuthFile,
    60,
    options.firstAttempt === "race" ? 30 : 5,
    options.oldCiPolicy,
  );

  environmentChanged = true;
  process.env.PATH = `${bin}:${previous.PATH ?? ""}`;
  process.env.NODE_EXTRA_CA_CERTS = certificate;
  if (options.forceStartupFailure) throw new Error("forced fixture startup failure");
  running = await startController(runtimePath);

  function currentControl(): ControlState | null {
    return running!.ready.store.load(providerScope(provider, state.apiUrl), state.ref)?.value.control ?? null;
  }

  async function reconcile(): Promise<void> {
    await running.ready.controller.reconcileNow(state.ref);
    await waitFor(() => !hasUnsettledSuccess(currentControl(), state));
  }

  async function stopController(): Promise<void> {
    const controller = running!;
    controller.abort.abort();
    await controller.run;
    controller.ready.store.close();
  }

  async function restart(): Promise<void> {
    await stopController();
    running = await startController(runtimePath);
  }

  async function resetDatabaseAndRestart(): Promise<void> {
    await stopController();
    await unlink(join(dataDirectory, "execution.sqlite"));
    running = await startController(runtimePath);
  }

  async function untilState(target: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const control = currentControl();
      if (control?.stateId === target) return;
      await reconcile();
      await waitFor(() => {
        const current = currentControl();
        return current?.stateId === target
          || current?.attemptSeries?.current?.status === "succeeded"
          || current?.attemptSeries?.current?.status === "failed";
      });
    }
    throw new Error(`fixture did not reach state ${target}: ${JSON.stringify(currentControl())}`);
  }

  async function events(kind: RoutingEvent["kind"]): Promise<Array<Omit<RoutingEvent, "kind">>> {
    const body = await readFile(eventsPath, "utf8").catch(() => "");
    return body.trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as RoutingEvent)
      .filter((event) => event.kind === kind)
      .map(({ agentId, target }) => ({ agentId, target }));
  }

  const run: FixtureRun = {
    async activate() { state.activate(); },
    async activeProcesses() { return state.activeAttempts.size; },
    async answer(body) { state.addComment(body, MAINTAINER); },
    async blockNextAttempt(stateId) { state.nextModes.set(stateId, ["block"]); },
    async requestChangesOnNextReview() { state.nextReviewVerdict = "changes-requested"; },
    async changeHead() { state.changeHead(); },
    async setCi(status) { state.ciStatus = status; },
    async changeRequest() { return state.normalizedChange(); },
    async close() {
      await cleanup();
    },
    async closeChangeRequest() { state.setChangeState("closed"); },
    control: async () => requireControl(currentControl()),
    controllerId: async () => (await readFile(join(dataDirectory, "controller-id"), "utf8")).trim(),
    controllerLabels: async () => state.labels.filter((label) => label.startsWith("agent-")).sort(),
    compilations: async () => events("compile"),
    async collide() {
      if (options.firstAttempt !== "race") throw new Error("collision fixture requires race mode");
      const competitorRoot = join(root, "competitor");
      const competitorData = join(competitorRoot, "data");
      const competitorHome = join(competitorRoot, "home");
      const competitorRepository = join(competitorRoot, "config-repository");
      await mkdir(competitorRoot, { mode: 0o700 });
      await Promise.all([mkdir(competitorData, { mode: 0o700 }), mkdir(competitorHome)]);
      const competitorToken = join(root, "competitor-token");
      await writeFile(competitorToken, "fixture-b", { mode: 0o600 });
      const competitorControllerPath = await createConfiguration(
        provider,
        competitorRepository,
        competitorData,
        state.apiUrl,
        address.port + 2,
        competitorRepository, competitorData, competitorToken,
        join(competitorHome, ".codex/auth.json"),
        join(competitorHome, ".claude/.credentials.json"), operatorAuthFile, 60, 30,
      );
      await createAuth(competitorHome);
      competitor = await startController(competitorControllerPath);
      await waitFor(() => state.currentPublications().length === 2);

      const installations = [
        { name: "a", running: running!, data: dataDirectory },
        { name: "b", running: competitor, data: competitorData },
      ];
      const publications = state.currentPublications();
      const publicationBaseline = publications.map(({ key }) => key).sort();
      const owner = electOwner(publications)!;
      const scope = providerScope(provider, state.apiUrl);
      const publicationControllers = publications
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.key.localeCompare(right.key))
        .map(({ metadata }) => metadata.controller);
      const identified = await Promise.all(installations.map(async (installation) => ({
        ...installation,
        id: (await readFile(join(installation.data, "controller-id"), "utf8")).trim(),
      })));
      const byController = new Map(identified.map((installation) => [installation.id, installation]));
      const loserId = publicationControllers.find((id) => id !== owner.metadata.controller)!;
      const loserAttemptId = state.raceAttemptId(loserId);
      const loserInstallation = byController.get(loserId)!;
      const reconcileOrder = publicationControllers.toReversed().map((id) => byController.get(id)!);
      let loserObservedAt = -1;
      for (const installation of reconcileOrder) {
        state.phase = `reconcile-${installation.name}`;
        await installation.running.ready.controller.reconcileNow(state.ref);
        if (installation.id === loserId) loserObservedAt = state.requestLog.length;
      }
      const loserPhase = `reconcile-${loserInstallation.name}`;
      const firstPublish = state.requestLog.findIndex(({ method }) => method === "PUBLISH");
      const readsBeforePublish = state.requestLog.slice(0, firstPublish)
        .filter(({ method, path }) => method === "GET" && path.endsWith(`/issues/${state.number}/comments`)).length;
      state.phase = "release";
      state.releaseRace();
      await waitFor(() => state.activeAttempts.size === 0);
      const ownerInstallation = byController.get(owner.metadata.controller)!;
      await waitFor(() => ownerInstallation.running.ready.store.load(scope, state.ref)?.value.owner?.controllerId
        === owner.metadata.controller);
      const ownerSeenByA = identified[0]!.running.ready.store.load(scope, state.ref)?.value.owner?.controllerId ?? null;
      const ownerSeenByB = identified[1]!.running.ready.store.load(scope, state.ref)?.value.owner?.controllerId ?? null;
      const loserDisposition = loserInstallation.running.ready.store.load(scope, state.ref)?.value.disposition ?? null;
      const writes = state.requestLog.filter(({ phase, installation, method, path }, index) =>
        method !== "GET" && path.startsWith("/api/") && installation === loserInstallation.name
        && (phase === loserPhase || index >= loserObservedAt));
      const remainingPublications = state.currentPublications().map(({ key }) => key).sort();
      assert.deepEqual(remainingPublications, publicationBaseline);
      assert.equal(remainingPublications.length, 2);
      return {
        ownerSeenByA,
        ownerSeenByB,
        loserCancelled: state.cancelledAttempts.has(loserAttemptId),
        loserWritesAfterObservation: writes.length,
        loserDisposition,
        duplicateCommentsDeleted: publicationBaseline.length - remainingPublications.length,
        extraOwnershipReadsBeforePublication: Math.max(0, readsBeforePublish - 2),
        requestLog: [...state.requestLog],
      };
    },
    async decisions() {
      const decisions: AgentDecision[] = [];
      for (const session of await run.sessions()) {
        const body = await readFile(join(dataDirectory, "sessions", session, "decision.json"), "utf8");
        if (body.trim()) decisions.push(JSON.parse(body) as AgentDecision);
      }
      return decisions;
    },
    async finish() {
      await untilState("assessment-review");
      await run.answer("approved");
      await untilState("plan-review");
      await run.answer("approved");
      await untilState("awaiting-merge");
      await run.mergeChangeRequest();
      await untilState("done");
    },
    async humanAnswers() {
      return state.comments
        .filter((comment) => comment.actor.providerId === MAINTAINER.providerId)
        .map((comment) => state.normalizedComment(comment));
    },
    async agentCommentIds() {
      return state.comments.filter(({ body }) => parsePublication(body).kind === "current").map(({ id }) => id);
    },
    async latestAgentComment() {
      const comment = state.comments.toReversed().find((candidate) => candidate.body.startsWith("<!-- agent-flow:v1"));
      return comment ? state.normalizedComment(comment) : null;
    },
    async maximumConcurrentAttempts() { return state.maximumActiveAttempts; },
    async mergeChangeRequest() { state.setChangeState("merged"); },
    async migrate(resume,agentOnly=false) {
      const control=requireControl(currentControl());
      const worktree=join(dataDirectory,"worktrees",control.flowInstanceId);
      const branch=(await execFile("git",["-C",worktree,"branch","--show-current"])).stdout.trim();
      if(!branch) await execFile("git",["-C",worktree,"switch","-c","fixture-implementation"]);
      if(agentOnly) {
        const manifest=join(configRepository,"agent-packages/developer/.apm/agents/developer.agent.md");
        await writeFile(manifest,(await readFile(manifest,"utf8"))+"\nRespect the accepted migration context.\n");
        await execFile("git",["-C",configRepository,"add","."]);await execFile("git",["-C",configRepository,"commit","-m","Update developer guidance"]);
      }
      const sha=(await execFile("git",["-C",configRepository,"rev-parse","HEAD"])).stdout.trim();
      state.addComment(`/agent-flow migrate --pr ${state.change!.number} --to latest${resume ? " --resume-from "+resume : ""}`,MAINTAINER);
      return sha;
    },
    async migrateCiPolicy(){
      const control=requireControl(currentControl());
      await cp(join(ROOT,"config/flows/development.yaml"),join(configRepository,"config/flows/development.yaml"));
      await mkdir(join(configRepository,"config/migrations"),{recursive:true});
      await writeFile(join(configRepository,"config/migrations/ci-policy.yaml"),stringify({apiVersion:"agent-flow/migration-v1",kind:"WorkflowMigration",id:"fixture-ci",source:control.configRevision,sourceFlow:"development",targetFlow:"development",activationLabel:"agent-flow:development",states:{"awaiting-merge":{target:"development",replay:["planning","development"],retain:[]}}}));
      await execFile("git",["-C",configRepository,"add","."]);await execFile("git",["-C",configRepository,"commit","-m","Require current-head CI and declare migration"]);
      state.incidentalReference=true;
      return run.migrate();
    },
    async migrationReceipts(){return state.comments.filter(c=>c.body.includes("<!-- agent-flow-migration:v1")).map(c=>c.body);},
    reconcile,
    async receipts() {
      const latest = currentControl()?.latestReceipt;
      if (latest) state.recordAcceptedReceipt(latest);
      return state.acceptedReceipts;
    },
    async reviewRequests() { return [...state.reviewRequests]; },
    async controllerCommentWrites() {
      return state.requestLog.filter(({ method, path }) => ["POST", "PUT", "PATCH"].includes(method)
        && (/\/issues(?:\/\d+)?\/(?:comments|notes)(?:\/\d+)?$/.test(path))).length;
    },
    async removeActivation() { state.removeActivation(); },
    restart,
    resetDatabaseAndRestart,
    async reactivateAfterStop() {
      await stopController();
      state.activate();
      running = await startController(runtimePath);
    },
    routing: async () => state.routing,
    async sessions() {
      const sessions = join(dataDirectory, "sessions");
      const flows = await readdir(sessions).catch(() => [] as string[]);
      const attempts = await Promise.all(flows.map(async (flow) =>
        (await readdir(join(sessions, flow)).catch(() => [] as string[])).map((attempt) => `${flow}/${attempt}`)));
      return attempts.flat();
    },
    async untilAttempt(status) {
      await waitFor(() => {
        const control = currentControl();
        const current = control?.attemptSeries?.current;
        return control?.attemptSeries?.stateId === control?.stateId
          && current?.status === status
          && (status !== "started" || state.readyAttempts.has(current.attemptId));
      });
    },
    async untilAgentComments(count) {
      await waitFor(() => state.comments.filter((comment) => comment.body.startsWith("<!-- agent-flow:v1 {")).length >= count);
    },
    untilState,
    async unauthenticatedProviderStatus() {
      return (await fetch(`${state.apiUrl}/user`)).status;
    },
  };
  return run;
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "fixture startup and cleanup failed");
    }
    throw error;
  }
}

class FixtureState {
  readonly provider: ProviderKind;
  readonly repository: string;
  readonly number: number;
  readonly ref: { provider: ProviderKind; repository: string; number: number };
  readonly comments: StoredComment[] = [];
  readonly reviews = new Map<string, StoredReview>();
  readonly reviewRequests: string[] = [];
  readonly acceptedReceipts: AgentReceipt[] = [];
  readonly nextModes = new Map<string, AttemptMode[]>();
  readonly activeAttempts = new Set<string>();
  readonly cancelledAttempts = new Set<string>();
  readonly readyAttempts = new Set<string>();
  readonly routing: Array<Omit<RoutingEvent, "kind">> = [];
  readonly requestLog: Array<{ method: string; path: string; phase: string; installation: string | null }> = [];
  readonly labelEvents: LabelEvent[] = [];
  incidentalReference=false;
  readonly implementationNumber:number;
  labels = ["agent-flow:development"];
  repairCiAfterFailure?: boolean;
  ciAfterReview?: "success" | "pending" | "failure";
  nextReviewVerdict: "approved" | "changes-requested" = "approved";
  ciStatus: "success" | "pending" | "failure" | "missing" = "success";
  open = true;
  change: StoredChange | null = null;
  activationId = 1;
  maximumActiveAttempts = 0;
  origin = "";
  phase = "initial";
  #raceResponses: Array<{ context: AttemptContext; response: import("node:http").ServerResponse }> = [];
  #raceParticipants: number;
  #commentId = 100;
  #reviewId = 700;
  #lastTimestamp = Date.now();

  constructor(provider: ProviderKind, firstAttempt?: AttemptMode,migrationCase=false) {
    this.provider = provider;
    this.repository = provider === "github" ? "owner/repo" : "group/project";
    this.number = migrationCase?2:provider === "github" ? 17 : 23;
    this.implementationNumber=migrationCase?8:provider==="github"?31:41;
    this.ref = { provider, repository: this.repository, number: this.number };
    this.#raceParticipants = firstAttempt === "race" ? 2 : 0;
    this.labelEvents.push({ id: this.activationId, action: "add", createdAt: this.timestamp() });
    if (firstAttempt && firstAttempt !== "race") this.nextModes.set("assessment", [firstAttempt]);
  }

  get apiUrl(): string {
    return this.provider === "github"
      ? `${this.origin}/api/github`
      : `${this.origin}/api/gitlab/api/v4`;
  }

  activate(): void {
    if (!this.labels.includes("agent-flow:development")) this.labels.push("agent-flow:development");
    this.activationId += 1;
    this.labelEvents.push({ id: this.activationId, action: "add", createdAt: this.touch() });
  }

  removeActivation(): void {
    this.labels = this.labels.filter((label) => label !== "agent-flow:development");
    this.activationId += 1;
    this.labelEvents.push({ id: this.activationId, action: "remove", createdAt: this.touch() });
  }

  changeHead(): void {
    if (!this.change) throw new Error("change request is missing");
    this.change.headSha = NEXT_HEAD;
    this.change.updatedAt = this.touch();
  }

  setChangeState(value: StoredChange["state"]): void {
    if (!this.change) throw new Error("change request is missing");
    this.change.state = value;
    this.change.updatedAt = this.touch();
  }

  addComment(body: string, actor = CONTROLLER): StoredComment {
    const timestamp = this.touch();
    const comment = { id: String(++this.#commentId), body, actor, createdAt: timestamp, updatedAt: timestamp };
    this.comments.push(comment);
    this.recordReceipt(body);
    return comment;
  }

  recordAcceptedReceipt(receipt: AgentReceipt): void {
    if (!this.acceptedReceipts.some(({ attemptId }) => attemptId === receipt.attemptId)) {
      this.acceptedReceipts.push(receipt);
    }
  }

  normalizedComment(comment: StoredComment): ProviderComment {
    return {
      id: comment.id,
      url: this.commentUrl(comment.id),
      body: comment.body,
      actor: comment.actor,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    };
  }

  normalizedChange(): NormalizedChangeRequest | null {
    if (!this.change) return null;
    return {
      provider: this.provider,
      repository: this.repository,
      number: this.change.number,
      url: this.changeUrl(),
      headRepository:this.repository,headBranch:"fixture-implementation",
      headSha: this.change.headSha,
      state: this.change.state,
      actor: { login: "developer", providerId: "8" },
      updatedAt: this.change.updatedAt,
    };
  }

  async handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.origin);
    this.requestLog.push({
      method: request.method ?? "GET",
      path: url.pathname,
      phase: this.phase,
      installation: this.installation(request),
    });
    const body = await requestBody(request);
    if (url.pathname === "/__fixture/attempt" && request.method === "POST") {
      return this.attempt(body as AttemptContext, request.headers["x-fixture-target"], response);
    }
    if (url.pathname === "/__fixture/cancelled" && request.method === "POST") {
      const attemptId = String((body as { attemptId: string }).attemptId);
      this.cancelledAttempts.add(attemptId);
      this.activeAttempts.delete(attemptId);
      this.readyAttempts.delete(attemptId);
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/__fixture/completed" && request.method === "POST") {
      const attemptId = String((body as { attemptId: string }).attemptId);
      if (!this.activeAttempts.has(attemptId) && !this.cancelledAttempts.has(attemptId)) {
        return json(response, 409, { message: "attempt is not active" });
      }
      this.activeAttempts.delete(attemptId);
      this.readyAttempts.delete(attemptId);
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/__fixture/ready" && request.method === "POST") {
      const attemptId = String((body as { attemptId: string }).attemptId);
      if (!this.activeAttempts.has(attemptId)) return json(response, 409, { message: "attempt is not active" });
      this.readyAttempts.add(attemptId);
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/__fixture/late" && request.method === "POST") {
      const context = body as AttemptContext;
      const attemptId = context.controlState.attemptSeries?.current?.attemptId;
      if (!attemptId) return json(response, 400, { message: "attempt is missing" });
      return json(response, 200, { decision: this.publish(context, attemptId) });
    }
    if (this.provider === "github" && url.pathname.startsWith("/api/github/")) {
      if (!this.validProviderHeaders(request)) return json(response, 400, { message: "invalid provider headers" });
      return this.github(request.method ?? "GET", url, body, response);
    }
    if (this.provider === "gitlab" && url.pathname.startsWith("/api/gitlab/api/v4/")) {
      if (!this.validProviderHeaders(request)) return json(response, 400, { message: "invalid provider headers" });
      return this.gitlab(request.method ?? "GET", url, body, response);
    }
    json(response, 404, { message: "not found" });
  }

  private validProviderHeaders(request: import("node:http").IncomingMessage): boolean {
    if (this.installation(request) === null) return false;
    if (this.provider === "github") {
      return request.headers.accept === "application/vnd.github+json"
        && request.headers["x-github-api-version"] === "2022-11-28";
    }
    return request.headers.accept === "application/json";
  }

  private installation(request: import("node:http").IncomingMessage): string | null {
    switch (request.headers.authorization) {
      case "Bearer fixture":
      case "Bearer fixture-a": return "a";
      case "Bearer fixture-b": return "b";
      default: return null;
    }
  }

  private attempt(
    context: AttemptContext,
    target: string | string[] | undefined,
    response: import("node:http").ServerResponse,
  ): void {
    const control = context.controlState;
    if (control.latestReceipt) this.recordAcceptedReceipt(control.latestReceipt);
    const attemptId = control.attemptSeries?.current?.attemptId;
    if (!attemptId) return json(response, 400, { message: "attempt is missing" });
    if (target !== "claude" && target !== "codex") {
      return json(response, 400, { message: "fixture target is missing" });
    }
    this.routing.push({ agentId: control.attemptSeries!.agentId, target });
    this.activeAttempts.add(attemptId);
    this.maximumActiveAttempts = Math.max(this.maximumActiveAttempts, this.activeAttempts.size);
    if (control.stateId === "assessment" && this.#raceParticipants > 0) {
      this.#raceResponses.push({ context, response });
      this.#raceParticipants -= 1;
      if (this.#raceParticipants === 0) {
        for (const participant of this.#raceResponses) {
          this.requestLog.push({
            method: "PUBLISH",
            path: this.commentUrl("new"),
            phase: "publication",
            installation: null,
          });
          this.publish(participant.context, participant.context.controlState.attemptSeries!.current!.attemptId);
        }
      }
      return;
    }
    const key = control.stateId === "needs-human" ? "needs-human" : control.stateId;
    const queue = this.nextModes.get(key) ?? [];
    const mode = queue.shift() ?? "success";
    if (mode === "crash-after-publish") {
      this.publish(context, attemptId);
      this.nextModes.set(key, ["reuse"]);
      return;
    }
    if (mode !== "success" && mode !== "reuse") return json(response, 200, { mode });

    const decision = this.publish(context, attemptId, mode === "reuse");
    json(response, 200, { mode, decision });
  }

  currentPublications(): Publication[] {
    return this.comments.flatMap((comment) => {
      const parsed = parsePublication(comment.body);
      return parsed.kind === "current" ? [{
        key: `${this.provider}:comment:${comment.id}`,
        createdAt: comment.createdAt,
        metadata: parsed.metadata,
      }] : [];
    });
  }

  raceAttemptId(controllerId: string): string {
    const participant = this.#raceResponses.find(({ context }) => {
      const parsed = parsePublication(context.publicationMarker);
      return parsed.kind === "current" && parsed.metadata.controller === controllerId;
    });
    const attemptId = participant?.context.controlState.attemptSeries?.current?.attemptId;
    if (!attemptId) throw new Error(`race attempt is missing for controller ${controllerId}`);
    return attemptId;
  }

  releaseRace(): void {
    for (const { response } of this.#raceResponses.splice(0)) {
      if (!response.destroyed) json(response, 200, { mode: "success", decision: { event: "agent-succeeded" } });
    }
  }

  private publish(context: AttemptContext, attemptId: string, reuse = false): AgentDecision {
    const state = context.controlState.stateId;
    if (context.mode === "human-input") {
      const source = context.artifacts
        .filter((artifact): artifact is ProviderComment =>
          "body" in artifact && "createdAt" in artifact
          && !(artifact as { body: string }).body.startsWith("<!-- agent-flow"))
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (!source) throw new Error("human input source comment is missing");
      const lower = source.body.toLowerCase();
      const verdict = lower.includes("cancel") ? "cancelled" as const
        : lower.includes("change") ? "changes-requested" as const
          : lower.includes("question") ? "question" as const
            : lower.includes("unclear") ? "unclear" as const
              : "approved" as const;
      if ((verdict === "question" || verdict === "unclear")) {
        this.addComment(`${context.publicationMarker}\nPlease clarify the requested action.`);
      }
      if (state === "needs-human") {
        return { event: verdict === "cancelled" ? "human-answer-cancelled"
          : verdict === "approved" ? "human-answer-accepted" : "human-answer-unclear" };
      }
      return { event: verdict === "cancelled" ? "human-cancelled"
        : verdict === "changes-requested" ? "human-changes-requested"
          : verdict === "question" ? "human-question"
            : verdict === "unclear" ? "human-unclear" : "human-approved" };
    }
    if (state === "assessment" || state === "planning") {
      const artifactKind = state === "assessment" ? "assessment" as const : "plan" as const;
      const existing = context.artifacts.some((artifact) => !context.migration?.baseline.comments.includes(String(artifact.id)) && "body" in artifact
        && artifact.body.split(/\r?\n/).includes(context.publicationMarker)
        && artifact.body.includes(`Fixture ${artifactKind}.`));
      if (!existing) this.addComment(`${context.publicationMarker}\nFixture ${artifactKind}.`);
      return { event: "agent-succeeded" };
    }
    if (state === "development") {
      if (context.migration) {
        const completion = this.comments.findLast((comment) =>
          !context.migration!.baseline.comments.includes(comment.id)
          && comment.body === context.publicationMarker + "\nFixture development revalidated.");
        const rejected = completion && [...this.reviews.values()].some((review) =>
          review.verdict === "changes-requested" && review.createdAt > completion.createdAt);
        if (!completion || rejected) this.addComment(context.publicationMarker + "\nFixture development revalidated.");
      }
      if (this.repairCiAfterFailure && this.change && this.ciStatus === "failure") {
        this.changeHead();
        this.ciStatus = "success";
      }
      const timestamp = this.touch();
      this.change ??= {
        number: this.implementationNumber,
        headSha: HEAD,
        state: "open",
        body: `${context.publicationMarker}\nFixture change request.`,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return { event: "agent-succeeded" };
    }
    if (state === "review") {
      if (!this.change) throw new Error("review change request is missing");
      const verdict = this.nextReviewVerdict;
      this.nextReviewVerdict = "approved";
      this.addReview(context.publicationMarker, verdict);
      if (this.ciAfterReview) {
        this.ciStatus = this.ciAfterReview;
        this.ciAfterReview = undefined;
      }
      return { event: verdict === "approved" ? "review-approved" : "review-changes-requested" };
    }
    if (state === "needs-human" && this.change?.state === "closed") {
      this.addComment(`${context.publicationMarker}\nReopen the existing change request or cancel the flow?`);
      return { event: "agent-needs-human" };
    }
    throw new Error(`unsupported fixture attempt state: ${state}`);
  }

  private addReview(publicationMarker: string, verdict: StoredReview["verdict"]) {
    const id = String(++this.#reviewId);
    const headSha = this.change!.headSha;
    const body = `${publicationMarker}\n<!-- agent-flow-review:v1 head=${headSha} verdict=${verdict} -->\nFixture review.`;
    this.reviews.set(id, { id, body, headSha, verdict, createdAt: this.touch() });
    return { kind: "review" as const, id, url: this.reviewUrl(id), headSha, verdict };
  }

  private github(method: string, url: URL, body: unknown, response: import("node:http").ServerResponse): void {
    const path = url.pathname.slice("/api/github/".length);
    if (method === "GET" && path.endsWith("/check-runs")) return json(response, 200, { check_runs: this.ciStatus === "missing" ? [] : [{
      name: "verify", head_sha: this.change?.headSha, status: this.ciStatus === "pending" ? "in_progress" : "completed", conclusion: this.ciStatus,
    }] });
    if (method === "GET" && path.endsWith("/statuses")) return json(response, 200, []);
    if (method === "POST" && path === "graphql") {
      const ids = (body as { variables?: { ids?: string[] } })?.variables?.ids;
      return json(response, 200, ids
        ? { data: { nodes: ids.map((id) => ({ id, __typename: "PullRequestReview", lastEditedAt: null })) } }
        : { data: { repository: { pullRequest: { lastEditedAt: null } } } });
    }
    if (method === "GET" && path === "user") return json(response, 200, { id: 51, login: "controller" });
    if (method === "GET" && path === `repos/${this.repository}`) return json(response, 200, this.githubRepository());
    if (method === "GET" && path === `repos/${this.repository}/issues`) return json(response, 200, this.listIssue(url));
    if (method === "GET" && path === `repos/${this.repository}/issues/${this.number}`) return json(response, 200, this.githubIssue());
    if (method === "GET" && path === `repos/${this.repository}/issues/${this.number}/timeline`) return json(response, 200, this.githubTimeline());
    if (method === "GET" && path === `repos/${this.repository}/issues/${this.number}/comments`) return json(response, 200, this.comments.map((comment) => this.githubComment(comment)));
    const permission = new RegExp(`^repos/${this.repository}/collaborators/([^/]+)/permission$`).exec(path);
    if (method === "GET" && permission) return json(response, 200, { permission: "maintain" });
    const comment = new RegExp(`^repos/${this.repository}/issues/comments/(\\d+)$`).exec(path);
    if (method === "GET" && comment) return this.replyGithubComment(comment[1]!, response);
    if (method === "PATCH" && comment) {
      const stored = this.requireComment(comment[1]!);
      stored.body = String((body as { body: string }).body);
      stored.updatedAt = this.touch();
      this.recordReceipt(stored.body);
      return json(response, 200, this.githubComment(stored));
    }
    if (method === "POST" && path === `repos/${this.repository}/issues/${this.number}/comments`) {
      return json(response, 201, this.githubComment(this.addComment(String((body as { body: string }).body))));
    }
    const label = new RegExp(`^repos/${this.repository}/issues/${this.number}/labels/(.+)$`).exec(path);
    if (method === "DELETE" && label) {
      const value = decodeURIComponent(label[1]!);
      const present = this.labels.includes(value);
      this.labels = this.labels.filter((candidate) => candidate !== value);
      if (present && value === "agent-flow:development") {
        this.activationId += 1;
        this.labelEvents.push({ id: this.activationId, action: "remove", createdAt: this.touch() });
      }
      return json(response, present ? 200 : 404, present ? this.labels.map((name) => ({ name })) : { message: "missing" });
    }
    if (method === "POST" && path === `repos/${this.repository}/issues/${this.number}/labels`) {
      for (const value of (body as { labels: string[] }).labels) {
        if (!this.labels.includes(value)) {
          this.labels.push(value);
          if (value === "agent-flow:development") {
            this.activationId += 1;
            this.labelEvents.push({ id: this.activationId, action: "add", createdAt: this.touch() });
          }
        }
      }
      this.touch();
      return json(response, 200, this.labels.map((name) => ({ name })));
    }
    const pull = new RegExp(`^repos/${this.repository}/pulls/(\\d+)$`).exec(path);
    if (method === "GET" && pull) {
      if(this.incidentalReference && pull[1]==="11") {
        const original=this.githubPull(),marker=parsePublication(this.change!.body);
        return json(response,200,{...original,number:11,html_url:`${this.origin}/${this.repository}/pull/11`,state:"closed",merged_at:this.change!.createdAt,body:marker.kind==="current"?renderPublication({...marker.metadata,config:"f".repeat(40)})+"\nCloses #9; mentions #2 as context.":"Policy update"});
      }
      return json(response, 200, this.githubPull());
    }
    const reviews = new RegExp(`^repos/${this.repository}/pulls/(\\d+)/reviews$`).exec(path);
    if (method === "GET" && reviews) {
      if(this.incidentalReference && reviews[1]==="11") return json(response,200,[]);
      if (!this.validChangeNumber(reviews[1]!)) return json(response, 400, { message: "unexpected change number" });
      const page = this.reviewPage(url);
      if (page === null) return json(response, 400, { message: "invalid review pagination" });
      this.reviewRequests.push(`${path}${url.search}`);
      if (page === 1) {
        const next = `${this.apiUrl}/${path}?per_page=100&page=2`;
        return json(response, 200, [this.githubReview(this.unrelatedReview())], {
          link: `<${next}>; rel="next"`,
        });
      }
      return json(response, 200, [...this.reviews.values()].map((review) => this.githubReview(review)));
    }
    const review = new RegExp(`^repos/${this.repository}/pulls/(\\d+)/reviews/(\\d+)$`).exec(path);
    if (method === "GET" && review) {
      if (!this.validChangeNumber(review[1]!)) return json(response, 400, { message: "unexpected change number" });
      const stored = this.reviews.get(review[2]!);
      if (!stored) return json(response, 404, { message: "review is missing" });
      this.reviewRequests.push(path);
      return json(response, 200, this.githubReview(stored));
    }
    json(response, 404, { message: `unhandled GitHub route ${method} ${path}` });
  }

  private gitlab(method: string, url: URL, body: unknown, response: import("node:http").ServerResponse): void {
    const project = `projects/${encodeURIComponent(this.repository)}`;
    const path = url.pathname.slice("/api/gitlab/api/v4/".length);
    if (method === "GET" && path === "user") return json(response, 200, { id: 51, username: "controller" });
    if (method === "GET" && path === project) return json(response, 200, this.gitlabProject());
    if (method === "GET" && path === `${project}/issues`) return json(response, 200, this.listIssue(url));
    if (method === "GET" && path === `${project}/issues/${this.number}`) return json(response, 200, this.gitlabIssue());
    if (method === "GET" && path === `${project}/issues/${this.number}/resource_label_events`) return json(response, 200, this.gitlabActivationEvents());
    if (method === "GET" && path === `${project}/issues/${this.number}/notes`) return json(response, 200, this.comments.map((comment) => this.gitlabNote(comment)));
    if (method === "GET" && path.endsWith("/pipelines")) return json(response, 200, this.ciStatus === "missing" ? [] : [{ id: 10, sha: this.change?.headSha }]);
    if (method === "GET" && path.endsWith("/pipelines/10/jobs")) return json(response, 200, [{ name: "verify", status: this.ciStatus === "pending" ? "running" : this.ciStatus === "failure" ? "failed" : "success" }]);
    if (method === "GET" && path === `${project}/issues/${this.number}/related_merge_requests`) return json(response, 200, this.change ? [this.gitlabRelated()] : []);
    const member = new RegExp(`^${project}/members/all/(\\d+)$`).exec(path);
    if (method === "GET" && member) return json(response, 200, { id: Number(member[1]), username: "maintainer", access_level: 40 });
    const note = new RegExp(`^${project}/issues/${this.number}/notes/(\\d+)$`).exec(path);
    if (method === "GET" && note) return this.replyGitlabNote(note[1]!, response);
    if (method === "PUT" && note) {
      const stored = this.requireComment(note[1]!);
      stored.body = String((body as { body: string }).body);
      stored.updatedAt = this.touch();
      this.recordReceipt(stored.body);
      return json(response, 200, this.gitlabNote(stored));
    }
    if (method === "POST" && path === `${project}/issues/${this.number}/notes`) {
      return json(response, 201, this.gitlabNote(this.addComment(String((body as { body: string }).body))));
    }
    if (method === "PUT" && path === `${project}/issues/${this.number}`) {
      const update = body as { add_labels?: string; remove_labels?: string };
      for (const value of update.remove_labels?.split(",").filter(Boolean) ?? []) {
        const present = this.labels.includes(value);
        this.labels = this.labels.filter((candidate) => candidate !== value);
        if (present && value === "agent-flow:development") {
          this.activationId += 1;
          this.labelEvents.push({ id: this.activationId, action: "remove", createdAt: this.touch() });
        }
      }
      for (const value of update.add_labels?.split(",").filter(Boolean) ?? []) {
        if (!this.labels.includes(value)) {
          this.labels.push(value);
          if (value === "agent-flow:development") {
            this.activationId += 1;
            this.labelEvents.push({ id: this.activationId, action: "add", createdAt: this.touch() });
          }
        }
      }
      this.touch();
      return json(response, 200, this.gitlabIssue());
    }
    const merge = new RegExp(`^${project}/merge_requests/(\\d+)$`).exec(path);
    if (method === "GET" && merge) return json(response, 200, this.gitlabMerge());
    const reviews = new RegExp(`^${project}/merge_requests/(\\d+)/notes$`).exec(path);
    if (method === "GET" && reviews) {
      if (!this.validChangeNumber(reviews[1]!)) return json(response, 400, { message: "unexpected change number" });
      const page = this.reviewPage(url);
      if (page === null) return json(response, 400, { message: "invalid review pagination" });
      this.reviewRequests.push(`${path}${url.search}`);
      if (page === 1) {
        return json(response, 200, [this.gitlabReview(this.unrelatedReview())], { "x-next-page": "2" });
      }
      return json(response, 200, [...this.reviews.values()].map((review) => this.gitlabReview(review)));
    }
    const review = new RegExp(`^${project}/merge_requests/(\\d+)/notes/(\\d+)$`).exec(path);
    if (method === "GET" && review) {
      if (!this.validChangeNumber(review[1]!)) return json(response, 400, { message: "unexpected change number" });
      const stored = this.reviews.get(review[2]!);
      if (!stored) return json(response, 404, { message: "review is missing" });
      this.reviewRequests.push(path);
      return json(response, 200, this.gitlabReview(stored));
    }
    json(response, 404, { message: `unhandled GitLab route ${method} ${path}` });
  }

  private listIssue(url: URL): unknown[] {
    const label = url.searchParams.get("labels");
    return !label || this.labels.includes(label)
      ? [this.provider === "github" ? { number: this.number } : { iid: this.number }]
      : [];
  }

  private validChangeNumber(value: string): boolean {
    return this.change !== null && value === String(this.change.number);
  }

  private reviewPage(url: URL): 1 | 2 | null {
    if ([...url.searchParams.keys()].some((name) => name !== "per_page" && name !== "page")) return null;
    const perPage = url.searchParams.getAll("per_page");
    const pages = url.searchParams.getAll("page");
    if (perPage.length !== 1 || perPage[0] !== "100" || pages.length > 1) return null;
    if (pages.length === 0) return 1;
    return pages[0] === "2" ? 2 : null;
  }

  private unrelatedReview(): StoredReview {
    if (!this.change) throw new Error("review change request is missing");
    return {
      id: "700",
      body: "Unrelated fixture review.",
      headSha: this.change.headSha,
      verdict: "commented",
      createdAt: this.timestamp(),
    };
  }

  private githubRepository() {
    return { full_name: this.repository, html_url: `${this.origin}/${this.repository}`, clone_url: `${this.origin}/${this.repository}.git` };
  }

  private githubIssue() {
    return { number: this.number, title: "Fixture ticket", body: "Exercise the configured workflow.", state: this.open ? "open" : "closed", updated_at: this.timestamp(), labels: this.labels.map((name) => ({ name })) };
  }

  private githubTimeline() {
    const events: unknown[] = this.labelEvents.map((event) => ({
      id: event.id,
      event: event.action === "add" ? "labeled" : "unlabeled",
      created_at: event.createdAt,
      actor: this.githubActor(MAINTAINER),
      label: { name: "agent-flow:development" },
    }));
    if (this.change) events.push({
      id: 900,
      event: "cross-referenced",
      created_at: this.change.updatedAt,
      actor: this.githubActor({ login: "developer", providerId: "8" }),
      source: { issue: { number: this.change.number, repository_url: `${this.apiUrl}/repos/${this.repository}`, pull_request: {} } },
    });
    if(this.incidentalReference) events.push({id:911,event:"cross-referenced",created_at:this.change!.createdAt,actor:this.githubActor(CONTROLLER),source:{issue:{number:11,repository_url:`${this.apiUrl}/repos/${this.repository}`,pull_request:{}}}});
    return events;
  }

  private githubComment(comment: StoredComment) {
    return { id: Number(comment.id), html_url: this.commentUrl(comment.id), body: comment.body, user: this.githubActor(comment.actor), created_at: comment.createdAt, updated_at: comment.updatedAt };
  }

  private githubActor(actor: { login: string; providerId: string }) { return { id: Number(actor.providerId), login: actor.login }; }

  private githubPull() {
    if (!this.change) throw new Error("pull request is missing");
    return {
      number: this.change.number,
      html_url: this.changeUrl(),
      state: this.change.state === "open" ? "open" : "closed",
      merged_at: this.change.state === "merged" ? this.change.updatedAt : null,
      body: this.change.body,
      created_at: this.change.createdAt,
      updated_at: this.change.updatedAt,
      head: { sha: this.change.headSha,ref:"fixture-implementation",repo:{full_name:this.repository} },
      user: this.githubActor({ login: "developer", providerId: "8" }),
    };
  }

  private githubReview(review: StoredReview) {
    return { id: Number(review.id), node_id: `PRR_${review.id}`, html_url: this.reviewUrl(review.id), body: review.body, state: review.verdict === "approved" ? "APPROVED" : review.verdict === "changes-requested" ? "CHANGES_REQUESTED" : "COMMENTED", commit_id: review.headSha, submitted_at: review.createdAt, user: this.githubActor(CONTROLLER) };
  }

  private gitlabProject() {
    return { id: 100, path_with_namespace: this.repository, web_url: `${this.origin}/api/gitlab/${this.repository}`, http_url_to_repo: `${this.origin}/api/gitlab/${this.repository}.git` };
  }

  private gitlabIssue() {
    return { id: 2300, iid: this.number, title: "Fixture ticket", description: "Exercise the configured workflow.", state: this.open ? "opened" : "closed", labels: this.labels, updated_at: this.timestamp(), web_url: `${this.origin}/api/gitlab/${this.repository}/-/issues/${this.number}` };
  }

  private gitlabActivationEvents() {
    return this.labelEvents.map((event) => ({
      id: event.id,
      action: event.action,
      label: { name: "agent-flow:development" },
      user: { id: 7, username: "maintainer" },
      created_at: event.createdAt,
    }));
  }

  private gitlabNote(comment: StoredComment) {
    return { id: Number(comment.id), body: comment.body, author: { id: Number(comment.actor.providerId), username: comment.actor.login }, created_at: comment.createdAt, updated_at: comment.updatedAt };
  }

  private gitlabRelated() { return { iid: this.change!.number, project_id: 100, references: { full: `${this.repository}!${this.change!.number}` } }; }

  private gitlabMerge() {
    if (!this.change) throw new Error("merge request is missing");
    return { id: 4100, iid: this.change.number, project_id: 100, state: this.change.state === "open" ? "opened" : this.change.state, sha: this.change.headSha, web_url: this.changeUrl(), description: this.change.body, author: { id: 8, username: "developer" }, created_at: this.change.createdAt, updated_at: this.change.updatedAt };
  }

  private gitlabReview(review: StoredReview) {
    return { id: Number(review.id), body: review.body, author: { id: 51, username: "controller" }, created_at: review.createdAt, updated_at: review.createdAt };
  }

  private replyGithubComment(id: string, response: import("node:http").ServerResponse): void {
    const comment = this.comments.find((candidate) => candidate.id === id);
    json(response, comment ? 200 : 404, comment ? this.githubComment(comment) : { message: "missing" });
  }

  private replyGitlabNote(id: string, response: import("node:http").ServerResponse): void {
    const comment = this.comments.find((candidate) => candidate.id === id);
    json(response, comment ? 200 : 404, comment ? this.gitlabNote(comment) : { message: "missing" });
  }

  private requireComment(id: string): StoredComment {
    const comment = this.comments.find((candidate) => candidate.id === id);
    if (!comment) throw new Error(`comment ${id} is missing`);
    return comment;
  }

  private recordReceipt(body: string): void {
    const receipt = parseControlComment(body)?.latestReceipt;
    if (receipt && !this.acceptedReceipts.some(({ attemptId }) => attemptId === receipt.attemptId)) {
      this.acceptedReceipts.push(receipt);
    }
  }

  private commentUrl(id: string): string {
    return this.provider === "github"
      ? `${this.origin}/${this.repository}/issues/${this.number}#issuecomment-${id}`
      : `${this.origin}/api/gitlab/${this.repository}/-/issues/${this.number}#note_${id}`;
  }

  private changeUrl(): string {
    const number = this.change?.number ?? (this.provider === "github" ? 31 : 41);
    return this.provider === "github"
      ? `${this.origin}/${this.repository}/pull/${number}`
      : `${this.origin}/api/gitlab/${this.repository}/-/merge_requests/${number}`;
  }

  private reviewUrl(id: string): string {
    return this.provider === "github"
      ? `${this.changeUrl()}#pullrequestreview-${id}`
      : `${this.changeUrl()}#note_${id}`;
  }

  private timestamp(): string { return new Date(this.#lastTimestamp).toISOString(); }
  private touch(): string {
    this.#lastTimestamp = Math.max(Date.now(), this.#lastTimestamp + 1);
    return this.timestamp();
  }
}

interface AttemptContext {
  migration?:import("../../src/provider/migration-receipt.ts").MigrationReceipt;
  ticket: unknown;
  controlState: ControlState;
  artifacts: Array<Record<string, unknown>>;
  mode: "stage" | "human-input";
  publicationMarker: string;
}

async function createCertificate(certificate: string, key: string): Promise<void> {
  await execFile("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:host.docker.internal",
    "-keyout", key, "-out", certificate,
  ]);
}

async function createConfiguration(
  provider: ProviderKind,
  repository: string,
  dataDirectory: string,
  apiUrl: string,
  healthPort: number,
  runtimeRepository = repository,
  runtimeDataDirectory = dataDirectory,
  tokenFile = join(dirname(repository), "provider-token"),
  codexAuthFile = join(dirname(repository), "auth/.codex/auth.json"),
  claudeAuthFile = join(dirname(repository), "auth/.claude/.credentials.json"),
  operatorAuthFile = join(dirname(repository), "operator-password"),
  pollingIntervalSeconds = 60,
  timeoutSeconds = 5,
  oldCiPolicy=false,
): Promise<string> {
  await mkdir(join(repository, "config/flows"), { recursive: true });
  await Promise.all([
    cp(join(ROOT, "schemas"), join(repository, "schemas"), { recursive: true }),
    cp(join(ROOT, "agent-packages"), join(repository, "agent-packages"), { recursive: true }),
    cp(join(ROOT, "config/flows/development.yaml"), join(repository, "config/flows/development.yaml")),
    cp(join(ROOT, "config/stack.yaml"), join(repository, "config/stack.yaml")),
  ]);
  await cp(join(ROOT, "config/agents.yaml"), join(repository, "config/agents.yaml"));
  const stackFile = join(repository, "config/stack.yaml");
  await writeFile(stackFile, (await readFile(stackFile, "utf8"))
    .replace("config/flows/development-autonomous.yaml", "config/flows/development.yaml"));
  if(oldCiPolicy) {
    const path=join(repository,"config/flows/development.yaml"),flow=parse(await readFile(path,"utf8"));delete flow.spec.requiredChecks;for(const state of Object.values(flow.spec.states) as Array<{on?:Record<string,unknown>}>) if(state.on) delete state.on["ci-failed"];await writeFile(path,stringify(flow));
  }
  await execFile("git", ["init", repository]);
  await execFile("git", ["-C", repository, "config", "user.email", "fixture@example.test"]);
  await execFile("git", ["-C", repository, "config", "user.name", "Fixture"]);
  await execFile("git", ["-C", repository, "add", "."]);
  await execFile("git", ["-C", repository, "commit", "-m", "fixture config"]);
  const revision = (await execFile("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  const execution = (harness: "claude" | "codex") => ({
    harness, model: "fixture-model", reasoning: "high",
    maxAttempts: 3, delaySeconds: 0, timeoutSeconds,
  });
  const runtimePath = join(dirname(repository), "runtime.yaml");
  await writeFile(runtimePath, stringify({
    apiVersion: "agent-flow/v1alpha1",
    kind: "RuntimeConfig",
    configuration: { repository: runtimeRepository, revision, stack: "config/stack.yaml" },
    provider: {
      type: provider,
      apiUrl,
      repositories: [provider === "github" ? "owner/repo" : "group/project"],
      tokenFile,
    },
    execution: {
      agents: {
        architect: execution("claude"), planner: execution("claude"),
        developer: execution("codex"), reviewer: execution("codex"),
        "bug-investigator": execution("claude"), bugfixer: execution("codex"),
      },
      harnesses: { codex: { authFile: codexAuthFile }, claude: { authFile: claudeAuthFile } },
    },
    polling: { intervalSeconds: pollingIntervalSeconds, maxCallsPerMinute: 20, quotaReservePercent: 25 },
    runtime: {
      concurrency: 2,
      dataDirectory: runtimeDataDirectory,
      http: { address: "0.0.0.0", port: healthPort, authFile: operatorAuthFile },
    },
  }), { mode: 0o600 });
  return runtimePath;
}

async function createTools(bin: string): Promise<void> {
  const executable = resolve(ROOT, "test/fixtures/fake-harness.ts");
  const events = join(dirname(bin), "events.ndjson");
  await Promise.all(["gh", "glab", "apm", "codex", "claude"].map(async (tool) => {
    const path = join(bin, tool);
    await writeFile(path, `#!/bin/sh\nAGENT_FLOW_FIXTURE_LOG=${JSON.stringify(events)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(executable)} ${tool} "$@"\n`);
    await chmod(path, 0o755);
  }));
}

async function runDockerFixture(root: string, port: number, healthPort: number): Promise<void> {
  const canonicalRoot = await realpath(root);
  const certificate = join(canonicalRoot, "fixture.crt");
  const key = join(canonicalRoot, "fixture.key");
  const repository = join(canonicalRoot, "config-repository");
  const data = join(canonicalRoot, "data");
  const bin = join(canonicalRoot, "bin");
  const auth = join(canonicalRoot, "auth");
  await Promise.all([mkdir(data), mkdir(bin), mkdir(auth)]);
  await Promise.all([chmod(canonicalRoot, 0o755), chmod(data, 0o777)]);
  await createCertificate(certificate, key);
  const state = new FixtureState("github");
  state.origin = `https://host.docker.internal:${port}`;
  await createDockerTools(bin);
  await createAuth(auth);
  const token = join(canonicalRoot, "provider-token");
  const operatorAuth = join(canonicalRoot, "operator-password");
  await Promise.all([
    writeFile(token, "fixture\n", { mode: 0o644 }),
    writeFile(operatorAuth, "operator-password-314159\n", { mode: 0o644 }),
  ]);
  const runtime = await createConfiguration(
    "github", repository, data, state.apiUrl, 8080, "/config", "/var/lib/agent-flow",
    "/run/secrets/agent-flow/provider-token",
    "/run/secrets/agent-flow/codex-auth",
    "/run/secrets/agent-flow/claude-auth",
    "/run/secrets/agent-flow/operator-password",
    0.05,
  );
  await Promise.all([
    chmod(join(auth, ".codex/auth.json"), 0o644),
    chmod(join(auth, ".claude/.credentials.json"), 0o644),
  ]);
  await writeFile(join(canonicalRoot, "compose.e2e.yaml"), `services:\n  controller:\n    restart: "no"\n    command: ["node", "/fixture-source/docker-controller.mjs"]\n    environment:\n      NODE_EXTRA_CA_CERTS: /fixture/fixture.crt\n      PATH: /fixture-bin:/opt/tools/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n      HOME: /home/agent\n    ports: !override\n      - "${healthPort}:8080"\n    volumes: !override\n      - ${runtime}:/etc/agent-flow/runtime.yaml:ro\n      - ${token}:/run/secrets/agent-flow/provider-token:ro\n      - ${join(auth, ".codex/auth.json")}:/run/secrets/agent-flow/codex-auth:ro\n      - ${join(auth, ".claude/.credentials.json")}:/run/secrets/agent-flow/claude-auth:ro\n      - ${operatorAuth}:/run/secrets/agent-flow/operator-password:ro\n      - ${repository}:/config:ro\n      - ${data}:/var/lib/agent-flow\n      - ${certificate}:/fixture/fixture.crt:ro\n      - ${bin}:/fixture-bin:ro\n      - ${resolve(ROOT, "test/fixtures")}:/fixture-source:ro\n`);
  const server = createServer({ cert: await readFile(certificate), key: await readFile(key) }, (request, response) => {
    void state.handle(request, response).catch((error: unknown) => json(response, 500, {
      error: error instanceof Error ? error.message : "fixture failed",
    }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolveListen());
  });
  driveHumanActions(state);
  await writeFile(join(canonicalRoot, "ready"), "ready\n");
}

function driveHumanActions(state: FixtureState): void {
  const handled = new Set<string>();
  setInterval(() => {
    const stage = state.labels.find((label) => label.startsWith("agent-stage:"))?.slice("agent-stage:".length);
    if (!stage || handled.has(stage)) return;
    if (stage === "assessment-review" || stage === "plan-review") {
      handled.add(stage);
      state.addComment("approved", MAINTAINER);
    } else if (stage === "awaiting-merge") {
      handled.add(stage);
      state.setChangeState("merged");
    }
  }, 20);
}

async function createDockerTools(bin: string): Promise<void> {
  for (const tool of ["gh", "glab", "apm", "codex", "claude"]) {
    const path = join(bin, tool);
    await writeFile(path, `#!/bin/sh\nexec /usr/local/bin/node /fixture-source/fake-harness.ts ${tool} "$@"\n`);
    await chmod(path, 0o755);
  }
}

async function createAuth(home: string): Promise<void> {
  await Promise.all([
    mkdir(join(home, ".codex"), { recursive: true }),
    mkdir(join(home, ".claude"), { recursive: true }),
    mkdir(join(home, ".config/gh"), { recursive: true }),
    mkdir(join(home, ".config/glab-cli"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(home, ".codex/auth.json"), "{}\n", { mode: 0o600 }),
    writeFile(join(home, ".claude/.credentials.json"), "{}\n", { mode: 0o600 }),
  ]);
}

async function startController(runtimePath: string): Promise<RunningController> {
  let timestamp = Date.now();
  const runtime = await RuntimeManager.create(runtimePath);
  const ready = await runPreflight(createProductionDependencies(runtime, {
    now: () => timestamp,
    sleep: async (milliseconds) => { timestamp += milliseconds; },
  }));
  const abort = new AbortController();
  const run = ready.controller.run(abort.signal);
  return { ready, abort, run };
}

function requireControl(control: ControlState | null): ControlState {
  if (!control) throw new Error("control comment is missing");
  return control;
}

function hasUnsettledSuccess(control: ControlState | null, state: FixtureState): boolean {
  const current = control?.attemptSeries?.current;
  return current?.status === "started" && !state.activeAttempts.has(current.attemptId);
}

async function requestBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4999",
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    ...headers,
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

async function waitFor(predicate: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("fixture polling timed out");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  && process.argv[2] === "--docker-server") {
  await runDockerFixture(
    resolve(process.argv[3]!),
    Number(process.argv[4] ?? "19443"),
    Number(process.argv[5] ?? "18080"),
  );
}
