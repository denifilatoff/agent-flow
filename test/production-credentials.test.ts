import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "yaml";

import { loadConfigBundle } from "../src/config/load.ts";
import type { AgentReceipt, ControlState } from "../src/config/types.ts";
import type { SpawnedProcess } from "../src/harness/process.ts";
import { createProductionDependencies } from "../src/main.ts";
import { parseControlComment } from "../src/provider/control-comment.ts";
import type {
  ProviderAdapter,
  ProviderComment,
  ProviderRepository,
  ProviderTicketSnapshot,
  TicketRef,
} from "../src/provider/types.ts";
import { createAttemptSession } from "../src/runtime/sessions.ts";

const REVISION = "a".repeat(40);
const NOW = "2026-08-26T12:00:00.000Z";
const TICKET = { provider: "gitlab", repository: "group/repo", number: 7 } as const;
const GHES_TICKET = { provider: "github", repository: "owner/repo", number: 8 } as const;
const ACTOR = { login: "operator", providerId: "1" };
const GITLAB_OAUTH_METADATA: Record<string, string> = {
  host: "gitlab.test", api_host: "gitlab.test", api_protocol: "https", git_protocol: "https",
  user: "operator", use_keyring: "true", is_oauth2: "true", oauth2_expiry_date: "2026-08-27T12:00:00Z",
};

class Child extends EventEmitter implements SpawnedProcess {
  readonly stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 42;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals): boolean {
    queueMicrotask(() => this.finish(null, signal));
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => {
      this.emit("exit", code, signal);
      this.emit("close", code, signal);
    });
  }
}

class Provider implements ProviderAdapter {
  readonly kind: "github" | "gitlab";
  readonly comments: ProviderComment[] = [];
  labels = ["agent-flow:development"];
  private readonly ticket: TicketRef;
  private readonly host: string;

  constructor(
    kind: "github" | "gitlab" = "gitlab",
    ticket: TicketRef = TICKET,
    host = "gitlab.test",
  ) {
    this.kind = kind;
    this.ticket = ticket;
    this.host = host;
  }

  async verifyAuth() { return ACTOR; }
  async discover() { return { tickets: [], nextCursor: null }; }
  async bootstrap() { return [this.ticket]; }
  async readRepository(): Promise<ProviderRepository> {
    return { provider: this.kind, name: this.ticket.repository, host: this.host,
      cloneRoot: `https://${this.host}/`, cloneUrl: `https://${this.host}/${this.ticket.repository}.git` };
  }
  async readTicket(): Promise<ProviderTicketSnapshot> {
    return {
      ref: this.ticket, repository: await this.readRepository(), title: "Test scoped credentials", description: "Test.",
      open: true, labels: [...this.labels], updatedAt: NOW,
      activation: {
        present: true, label: "agent-flow:development", eventId: "activation-1", actor: ACTOR, occurredAt: NOW,
      },
      comments: structuredClone(this.comments), changeRequest: null,
    };
  }
  async permission() { return "maintain" as const; }
  async readComment(_ref: TicketRef, id: string) {
    const comment = this.comments.find((candidate) => candidate.id === id);
    if (!comment) throw new Error("comment not found");
    return structuredClone(comment);
  }
  async createComment(_ref: TicketRef, body: string) {
    const comment = this.comment(String(this.comments.length + 1), body);
    this.comments.push(comment);
    return structuredClone(comment);
  }
  async updateComment(_ref: TicketRef, id: string, body: string) {
    const index = this.comments.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error("comment not found");
    this.comments[index] = this.comment(id, body);
    return structuredClone(this.comments[index]!);
  }
  async setControllerLabels(_ref: TicketRef, remove: string[], add: string[]) {
    this.labels = [...new Set([...this.labels.filter((label) => !remove.includes(label)), ...add])];
    return [...this.labels];
  }
  async readChangeRequest(): Promise<never> { throw new Error("unused"); }
  async findReview(): Promise<never> { throw new Error("unused"); }
  async readReview(): Promise<never> { throw new Error("unused"); }

  private comment(id: string, body: string): ProviderComment {
    return { id, url: `https://${this.host}/${this.ticket.repository}/issues/${this.ticket.number}#comment-${id}`, body,
      actor: ACTOR, createdAt: NOW, updatedAt: NOW };
  }
}

test("production retries keep the pinned provider credential scoped to the child", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-flow-production-credential-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const worktree = join(root, "worktree");
  await mkdir(codexHome, { recursive: true });
  await mkdir(join(root, ".codex/agents"), { recursive: true });
  await mkdir(worktree);
  await writeFile(join(codexHome, "auth.json"), "{}\n", { mode: 0o600 });
  await writeFile(join(root, ".codex/agents/architect.toml"), 'name = "architect"\n');

  const bundle = await loadConfigBundle(process.cwd(), "config/controller.example.yaml", REVISION);
  bundle.controller.providers = {
    gitlab: { apiUrl: "https://gitlab.test/api/v4", tokenEnv: "OAUTH_TOKEN", repositories: [TICKET.repository] },
  };
  bundle.controller.runtime.dataDirectory = join(root, "data");
  bundle.catalog.agents.architect!.target = "codex";
  bundle.catalog.agents.architect!.retry = { maxAttempts: 2, delaySeconds: 0, timeoutSeconds: 5 };

  const environments: NodeJS.ProcessEnv[] = [];
  const events: string[] = [];
  const exitCodes = [1, 0];
  const provider = new Provider();
  const production = createProductionDependencies({
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: codexHome,
    AGENT_FLOW_DATA_DIRECTORY: join(root, "data"),
    OAUTH_TOKEN: "pinned-gitlab-token",
    CHANGED_TOKEN: "changed-token",
    GITHUB_TOKEN: "github-token",
    OPENAI_API_KEY: "openai-secret",
    UNRELATED_SECRET: "unrelated-secret",
  }, 8080, undefined, {
    harnessProcesses: {
      spawn: (_file, _args, options) => {
        events.push("spawn");
        environments.push({ ...options.env });
        if (environments.length === 1) {
          bundle.controller.providers.gitlab!.tokenEnv = "CHANGED_TOKEN";
          bundle.controller.providers.gitlab!.apiUrl = "https://changed.test/api/v4";
        }
        const child = new Child();
        setImmediate(() => child.finish(exitCodes.shift()!, null));
        return child;
      },
      runCommand: async (_file, args) => ({ stdout: `${GITLAB_OAUTH_METADATA[args[2]!] ?? ""}\n`, stderr: "" }),
    },
    attemptRunner: {
      workspaceManager: { async prepareWorkspace(_repository, _ticket, flowInstanceId) {
        events.push("workspace");
        return { baseClone: join(root, "base"), worktree, repository: TICKET.repository,
          ticketNumber: TICKET.number, flowInstanceId };
      } },
      async compileAgent(agentId, _package, target) {
        events.push("compile");
        return { agentId, target, instructions: "Test production credentials.", runtimeDirectory: root };
      },
      async createSession(...args) {
        events.push("session");
        return createAttemptSession(...args);
      },
      async verifyDecision(_path, expected): Promise<AgentReceipt> {
        return { apiVersion: "agent-flow/v1alpha1", kind: "AgentReceipt",
          flowInstanceId: expected.flowInstanceId, attemptId: expected.attemptId, outcome: "succeeded",
          summary: "assessment published", artifacts: [{ kind: "comment", id: "99",
            url: "https://gitlab.test/group/repo/-/issues/7#note_99",
            marker: `<!-- agent-flow:v1 flow=${expected.flowInstanceId} attempt=${expected.attemptId} artifact=assessment -->`,
            artifactKind: "assessment" }] };
      },
      async delay() {},
      now: () => NOW,
    },
  });
  const harnesses = production.createHarnesses();
  const controller = production.createController(bundle, { gitlab: provider }, harnesses);

  await controller.bootstrap();
  await waitFor(() => environments.length === 2);
  await waitFor(
    () => currentControl(provider)?.stateId === "assessment-review",
    () => `events=${events.join(",")}; control=${JSON.stringify(currentControl(provider))}`,
  );

  assert.equal(environments.length, 2, `events=${events.join(",")}; control=${JSON.stringify(currentControl(provider))}`);
  for (const environment of environments) {
    assert.equal(environment.OAUTH_TOKEN, undefined);
    for (const name of ["CHANGED_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "UNRELATED_SECRET"]) {
      assert.equal(environment[name], undefined);
    }
    assert.match(environment.GH_CONFIG_DIR!, /\/sessions\/.*\/harness-session\/codex-.*\/cli-config\/gh$/);
    assert.match(environment.GLAB_CONFIG_DIR!, /\/sessions\/.*\/harness-session\/codex-.*\/cli-config\/glab$/);
    const path = join(environment.GLAB_CONFIG_DIR!, "config.yml");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(parse(await readFile(path, "utf8")).hosts), ["gitlab.test"]);
    assert.doesNotMatch(await readFile(path, "utf8"), /token|refresh|pinned-gitlab-token/i);
  }
  assert.equal(currentControl(provider)?.attemptSeries?.consumed, 2);
  assert.equal(currentControl(provider)?.stateId, "assessment-review");
  const sessions = join(root, "data/sessions", currentControl(provider)!.flowInstanceId);
  for (const attemptId of await readdir(sessions)) {
    for (const file of ["context.json", "harness.log"]) {
      assert.doesNotMatch(
        await readFile(join(sessions, attemptId, file), "utf8"),
        /pinned-gitlab-token|github-token|openai-secret|unrelated-secret/,
      );
    }
  }
});

test("production passes a custom GHES credential without exposing public GitHub auth", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-flow-production-ghes-credential-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const worktree = join(root, "worktree");
  await mkdir(codexHome, { recursive: true });
  await mkdir(join(root, ".codex/agents"), { recursive: true });
  await mkdir(worktree);
  await writeFile(join(codexHome, "auth.json"), "{}\n", { mode: 0o600 });
  await writeFile(join(root, ".codex/agents/architect.toml"), 'name = "architect"\n');

  const bundle = await loadConfigBundle(process.cwd(), "config/controller.example.yaml", REVISION);
  bundle.controller.providers = {
    github: {
      apiUrl: "https://github.enterprise.test/api/v3",
      tokenEnv: "GH_ENTERPRISE_TOKEN",
      repositories: [GHES_TICKET.repository],
    },
  };
  bundle.controller.runtime.dataDirectory = join(root, "data");
  bundle.catalog.agents.architect!.target = "codex";
  bundle.catalog.agents.architect!.retry = { maxAttempts: 1, delaySeconds: 0, timeoutSeconds: 5 };

  const environments: NodeJS.ProcessEnv[] = [];
  const provider = new Provider("github", GHES_TICKET, "github.enterprise.test");
  const production = createProductionDependencies({
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: codexHome,
    AGENT_FLOW_DATA_DIRECTORY: join(root, "data"),
    GH_ENTERPRISE_TOKEN: "ghes-token",
    GITHUB_TOKEN: "public-github-token",
    OAUTH_TOKEN: "gitlab-token",
    OPENAI_API_KEY: "openai-secret",
  }, 8080, undefined, {
    harnessProcesses: {
      spawn: (_file, _args, options) => {
        environments.push({ ...options.env });
        const child = new Child();
        setImmediate(() => child.finish(0, null));
        return child;
      },
    },
    attemptRunner: {
      workspaceManager: { async prepareWorkspace(_repository, _ticket, flowInstanceId) {
        return { baseClone: join(root, "base"), worktree, repository: GHES_TICKET.repository,
          ticketNumber: GHES_TICKET.number, flowInstanceId };
      } },
      async compileAgent(agentId, _package, target) {
        return { agentId, target, instructions: "Test GHES credentials.", runtimeDirectory: root };
      },
      async createSession(...args) { return createAttemptSession(...args); },
      async verifyDecision(_path, expected): Promise<AgentReceipt> {
        return { apiVersion: "agent-flow/v1alpha1", kind: "AgentReceipt",
          flowInstanceId: expected.flowInstanceId, attemptId: expected.attemptId, outcome: "succeeded",
          summary: "assessment published", artifacts: [{ kind: "comment", id: "99",
            url: "https://github.enterprise.test/owner/repo/issues/8#issuecomment-99",
            marker: `<!-- agent-flow:v1 flow=${expected.flowInstanceId} attempt=${expected.attemptId} artifact=assessment -->`,
            artifactKind: "assessment" }] };
      },
      async delay() {},
      now: () => NOW,
    },
  });
  const controller = production.createController(bundle, { github: provider }, production.createHarnesses());

  await controller.bootstrap();
  await waitFor(() => environments.length === 1);
  await waitFor(() => currentControl(provider)?.attemptSeries?.current?.status === "succeeded");

  const environment = environments[0]!;
  assert.equal(environment.GH_ENTERPRISE_TOKEN, "ghes-token");
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "OAUTH_TOKEN", "OPENAI_API_KEY"]) {
    assert.equal(environment[name], undefined);
  }

  const wrongBundle = structuredClone(bundle);
  wrongBundle.controller.providers.github!.tokenEnv = "GH_TOKEN";
  const wrongProvider = new Provider("github", GHES_TICKET, "github.enterprise.test");
  const wrongController = production.createController(
    wrongBundle,
    { github: wrongProvider },
    production.createHarnesses(),
  );
  await assert.rejects(wrongController.bootstrap(), /provider token environment is not supported/);
  assert.equal(environments.length, 1);
});

function currentControl(provider: Provider): ControlState | null {
  for (const comment of provider.comments) {
    const control = parseControlComment(comment.body);
    if (control) return control;
  }
  return null;
}

async function waitFor(predicate: () => boolean, detail = () => "condition was not met"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await delay(1);
  assert.equal(predicate(), true, `${detail()} before the deadline`);
}
