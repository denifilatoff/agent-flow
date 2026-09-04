import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parse } from "yaml";

class TestEvent {
  defaultPrevented = false;
  type: string;
  init: Record<string, unknown>;

  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    this.init = init;
    Object.assign(this, init);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class TestElement {
  children: TestElement[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  className = "";
  disabled = false;
  hidden = false;
  id = "";
  open = false;
  options: TestElement[] = [];
  parent: TestElement | null = null;
  tabIndex = 0;
  textContent = "";
  type = "";
  value = "";
  checked = false;
  listeners = new Map<string, Array<(event: TestEvent) => void>>();
  tagName: string;
  private document: TestDocument;

  constructor(tagName: string, document: TestDocument) {
    this.tagName = tagName;
    this.document = document;
  }

  get classList() {
    return {
      contains: (name: string) => this.className.split(/\s+/).includes(name),
      toggle: (name: string, force?: boolean) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        const enabled = force ?? !names.has(name);
        if (enabled) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
      },
    };
  }

  set innerHTML(_value: string) {
    throw new Error("The UI must not render session content as HTML");
  }

  append(...nodes: TestElement[]) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: TestElement[]) {
    this.children = [];
    this.textContent = "";
    this.append(...nodes);
  }

  hasChildNodes() {
    return this.children.length > 0 || this.textContent.length > 0;
  }

  setAttribute(name: string, value: unknown) {
    const text = String(value);
    this.attributes.set(name, text);
    if (name === "id") this.id = text;
    if (name === "class") this.className = text;
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      this.dataset[key] = text;
    }
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: (event: TestEvent) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: TestEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return !event.defaultPrevented;
  }

  focus() {
    this.document.activeElement = this;
  }

  querySelectorAll(selector: string): TestElement[] {
    return this.descendants().filter((node) => node.matches(selector));
  }

  matches(selector: string) {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    const attribute = /^\[([^=\]]+)(?:="([^"]+)")?\]$/.exec(selector);
    if (attribute) {
      const [, name, value] = attribute;
      const actual = name.startsWith("data-")
        ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())]
        : this.attributes.get(name);
      return value === undefined ? actual !== undefined : actual === value;
    }
    return this.tagName === selector;
  }

  private descendants(): TestElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

class TestDocument {
  activeElement: TestElement | null = null;
  body = new TestElement("body", this);
  elements = new Map<string, TestElement>();

  createElement(tag: string) {
    return new TestElement(tag, this);
  }

  createElementNS(_namespace: string, tag: string) {
    return this.createElement(tag);
  }

  createTextNode(text: string) {
    const node = this.createElement("#text");
    node.textContent = text;
    return node;
  }

  getElementById(id: string) {
    let node = this.elements.get(id);
    if (!node) {
      node = this.createElement("div");
      node.id = id;
      this.elements.set(id, node);
    }
    return node;
  }

  querySelectorAll(selector: string) {
    if (selector === "#journal .event-card") {
      return this.getElementById("journal").querySelectorAll(".event-card");
    }
    if (selector.includes(",") || selector.includes(" ")) return [];
    return this.body.querySelectorAll(selector);
  }

  execCommand() {
    return false;
  }
}

function deferredResponse(content: string) {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => { resolve = done; });
  return {
    promise,
    resolve: () => resolve({ ok: true, json: async () => ({ available: true, content, truncated: false }) }),
  };
}

test("keeps session reader selection stable across slow responses", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const document = new TestDocument();
  const journal = document.getElementById("journal");
  document.body.append(journal);
  document.getElementById("refresh-interval").value = "30";
  document.getElementById("draft-group").value = "polling";
  const harness = deferredResponse("slow harness output");
  const decision = deferredResponse('<img src=x onerror="steal()">');
  const requests: string[] = [];
  const responses = [harness.promise, decision.promise];
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: () => null, setItem: () => undefined },
    navigator: { clipboard: { writeText: async () => undefined } },
    fetch: (path: string) => {
      requests.push(path);
      return responses.shift();
    },
    MouseEvent: TestEvent,
    setInterval: () => 0,
    URLSearchParams,
    console,
  };
  context.window = context;
  const instrumented = script.replace(
    "  renderWizard();\n  void loadDashboard();",
    "  renderWizard();\n  globalThis.__uiTest = { journalCard };",
  );
  vm.runInNewContext(instrumented, context);
  const journalCard = (context as { __uiTest?: { journalCard: Function } }).__uiTest?.journalCard;
  assert.ok(journalCard, "app.js test hook was not installed");

  const session = {
    flowUuid: "11111111-1111-4111-8111-111111111111",
    attemptUuid: "22222222-2222-4222-8222-222222222222",
    modifiedAt: "2026-08-29T10:00:00Z",
    files: ["harness.log", "decision.json", "context.json"],
  };
  const discovery = { available: true, truncated: false };
  const card = journalCard({ ticket: { provider: "github", repository: "owner/repo", number: 42 }, session }, discovery);
  journal.append(card);
  const tabs = card.querySelectorAll('[role="tab"]');
  const harnessTab = tabs.find((tab) => tab.dataset.sessionTab === "harness");
  const decisionTab = tabs.find((tab) => tab.dataset.sessionTab === "decision");
  assert.ok(harnessTab && decisionTab);

  harnessTab.dispatchEvent(new TestEvent("click"));
  const panel = card.querySelectorAll('[role="tabpanel"]')[0];
  const staleHarnessOutput = panel.children[0];
  const arrow = new TestEvent("keydown", { key: "ArrowRight" });
  harnessTab.dispatchEvent(arrow);
  assert.equal(document.activeElement, decisionTab, "arrow navigation must stay within the session tablist");
  assert.equal(arrow.defaultPrevented, true);
  assert.deepEqual(requests.map((path) => path.split("/").at(-1)), ["harness.log", "decision.json"]);

  decision.resolve();
  await new Promise(setImmediate);
  assert.equal(panel.children[0].textContent, '<img src=x onerror="steal()">');
  harness.resolve();
  await new Promise(setImmediate);
  assert.equal(panel.children[0].textContent, '<img src=x onerror="steal()">');
  assert.equal(staleHarnessOutput.textContent, "harness.log: loading…", "stale requests must not write a result");
  assert.equal(panel.children[0].children.length, 0, "session content must remain text-only");
  assert.equal(decisionTab.attributes.get("aria-selected"), "true");
});

test("shows and searches the latest 100 journal entries in pages of 20", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const document = new TestDocument();
  for (const id of ["journal", "journal-search", "journal-page", "journal-previous", "journal-next"]) {
    document.body.append(document.getElementById(id));
  }
  document.getElementById("refresh-interval").value = "30";
  document.getElementById("draft-group").value = "polling";
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: () => null, setItem: () => undefined },
    navigator: { clipboard: { writeText: async () => undefined } },
    fetch: async () => ({ ok: false }),
    MouseEvent: TestEvent,
    setInterval: () => 0,
    URLSearchParams,
    console,
  };
  context.window = context;
  const instrumented = script.replace(
    "  renderWizard();\n  void loadDashboard();",
    "  renderWizard();\n  globalThis.__uiTest = { renderJournal };",
  );
  vm.runInNewContext(instrumented, context);
  const renderJournal = (context as { __uiTest?: { renderJournal: Function } }).__uiTest?.renderJournal;
  assert.ok(renderJournal, "app.js test hook was not installed");

  const tickets = Array.from({ length: 105 }, (_, index) => {
    const number = index + 1;
    return {
      provider: "github",
      repository: `owner/ticket-${String(number).padStart(3, "0")}`,
      number,
      observedAt: new Date(Date.UTC(2026, 7, 29, 10, 0, number)).toISOString(),
    };
  });
  renderJournal({ controller: { tickets }, sessions: { available: true, entries: [], truncated: false } });

  const journal = document.getElementById("journal");
  assert.equal(journal.querySelectorAll(".event-card").length, 20);
  assert.match(journal.children[0].dataset.search, /ticket-105/);
  assert.match(journal.children[19].dataset.search, /ticket-086/);
  assert.equal(document.getElementById("journal-page").textContent, "1–20 of 100");

  document.getElementById("journal-next").dispatchEvent(new TestEvent("click"));
  assert.match(journal.children[0].dataset.search, /ticket-085/);
  assert.match(journal.children[19].dataset.search, /ticket-066/);
  assert.equal(document.getElementById("journal-page").textContent, "21–40 of 100");

  const search = document.getElementById("journal-search");
  search.value = "ticket-051";
  search.dispatchEvent(new TestEvent("input"));
  assert.equal(journal.querySelectorAll(".event-card").length, 1);
  assert.match(journal.children[0].dataset.search, /ticket-051/);
  assert.equal(document.getElementById("journal-page").textContent, "1–1 of 1");

  search.value = "ticket-005";
  search.dispatchEvent(new TestEvent("input"));
  assert.equal(journal.querySelectorAll(".event-card").length, 0);
  assert.equal(document.getElementById("journal-page").textContent, "0 of 0");
});

test("renders operational links and directed graph focus from the dashboard projection", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const document = new TestDocument();
  document.getElementById("refresh-interval").value = "30";
  document.getElementById("draft-group").value = "polling";
  for (const id of [
    "flow-graph", "flow-revision", "flow-scenarios", "flow-mode", "node-kind", "node-inspector", "waiting-panel",
    "configuration-source", "configuration-grid", "resources", "agents",
  ]) document.body.append(document.getElementById(id));
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: () => null, setItem: () => undefined },
    navigator: { clipboard: { writeText: async () => undefined } },
    fetch: async () => ({ ok: false }),
    MouseEvent: TestEvent,
    setInterval: () => 0,
    URL,
    URLSearchParams,
    console,
  };
  context.window = context;
  const instrumented = script.replace(
    "  renderWizard();\n  void loadDashboard();",
    "  globalThis.__uiTest = { renderWaiting, renderGraph, renderConfiguration, selectNode };",
  );
  vm.runInNewContext(instrumented, context);
  const ui = (context as { __uiTest?: Record<string, Function> }).__uiTest;
  assert.ok(ui, "app.js test hook was not installed");

  ui.renderWaiting([{
    provider: "github", repository: "owner/repo", number: 42,
    stateId: "assessment-review", stateKind: "human-gate", configRevision: "a".repeat(40),
    actionUrl: "https://github.example.test/owner/repo/issues/42",
  }]);
  const waitingLink = document.getElementById("waiting-panel").querySelectorAll("a")[0];
  assert.equal(waitingLink?.attributes.get("href"), "https://github.example.test/owner/repo/issues/42");
  assert.equal(waitingLink?.attributes.get("target"), "_blank");
  assert.equal(waitingLink?.attributes.get("rel"), "noreferrer noopener");

  const flow = {
    metadata: { id: "development", activationLabel: "agent-flow:development" },
    spec: {
      initial: "assessment",
      states: {
        assessment: { kind: "agent", agent: "architect", on: { complete: { target: "review" } } },
        review: { kind: "human-gate", agent: "architect", on: { approve: { target: "done" } } },
        done: { kind: "final" },
      },
    },
  };
  ui.renderGraph(flow, "a".repeat(40));
  const graph = document.getElementById("flow-graph");
  assert.equal(graph.querySelectorAll("marker")[0]?.attributes.get("id"), "flow-arrow");
  const edges = graph.querySelectorAll(".flow-edge");
  assert.equal(edges.length, 2);
  assert.ok(edges.every((edge) => edge.attributes.get("marker-end") === "url(#flow-arrow)"));
  assert.notEqual(edges[0]?.attributes.get("x2"), "765", "the arrow must stop at the target border, not under the node");
  assert.ok(edges[0]?.classList.contains("outgoing"));
  assert.ok(edges.every((edge) => !edge.classList.contains("muted")));

  ui.selectNode(flow, "review");
  assert.ok(!edges[0]?.classList.contains("incoming"));
  assert.ok(edges[1]?.classList.contains("outgoing"));
  assert.ok(edges.every((edge) => !edge.classList.contains("muted")));

  ui.renderConfiguration({
    configuration: {
      repository: "https://github.com/example/agent-stack.git",
      revision: "a".repeat(40),
      stackPath: "config/stack.yaml",
      stack: { kind: "Stack", spec: { flow: "config/flows/development.yaml", catalog: "config/agents.yaml", contracts: [], schemas: [] } },
      provenance: {
        repositoryUrl: "https://github.com/example/agent-stack",
        revisionUrl: `https://github.com/example/agent-stack/tree/${"a".repeat(40)}`,
        stackUrl: `https://github.com/example/agent-stack/blob/${"a".repeat(40)}/config/stack.yaml`,
        flowUrl: `https://github.com/example/agent-stack/blob/${"a".repeat(40)}/config/flows/development.yaml`,
        catalogUrl: `https://github.com/example/agent-stack/blob/${"a".repeat(40)}/config/agents.yaml`,
        agentPackageUrls: { architect: `https://github.com/example/agent-stack/tree/${"a".repeat(40)}/agent-packages/architect` },
      },
    },
    runtime: {
      apiVersion: "agent-flow/v1alpha1", kind: "RuntimeConfig",
      provider: { type: "github", apiUrl: "https://api.github.com", repositories: ["owner/repo"] },
      execution: { harnesses: ["codex"], agents: { architect: { harness: "codex", model: "gpt", reasoning: "high", maxAttempts: 1, delaySeconds: 0, timeoutSeconds: 60 } } },
      polling: { intervalSeconds: 30, maxCallsPerMinute: 20, quotaReservePercent: 25 },
      runtime: { concurrency: 1, http: { port: 8080 } },
    },
    flow,
    catalog: { kind: "AgentCatalog", agents: { architect: { package: "agent-packages/architect" } } },
    preflight: { status: "ready", harnesses: ["codex"] },
  });
  const configurationLinks = [
    ...document.getElementById("configuration-source").querySelectorAll("a"),
    ...document.getElementById("configuration-grid").querySelectorAll("a"),
    ...document.getElementById("agents").querySelectorAll("a"),
  ];
  assert.ok(configurationLinks.some((link) => link.attributes.get("href") === "https://github.com/example/agent-stack"));
  assert.ok(configurationLinks.some((link) => link.attributes.get("href")?.endsWith("/config/flows/development.yaml")));
  assert.ok(configurationLinks.some((link) => link.attributes.get("href")?.endsWith("/agent-packages/architect")));
  for (const name of ["development", "development-autonomous"]) {
    const shippedFlow = parse(await readFile(`config/flows/${name}.yaml`, "utf8"));
    ui.renderGraph(shippedFlow, "b".repeat(40));
    const choices = document.getElementById("flow-scenarios").querySelectorAll("button");
    assert.equal(choices.length, 2);
    for (const label of ["agent-flow:development", "bugfix"]) {
      choices.find((button) => button.dataset.scenario === label)!.dispatchEvent(new TestEvent("click"));
      const nodes = graph.querySelectorAll(".flow-node");
      const width = graph.attributes.get("viewBox")!.split(" ")[2];
      assert.equal(graph.attributes.get("style"), `min-width: ${width}px`);
      assert.equal(new Set(nodes.map((node) => node.attributes.get("transform"))).size, nodes.length);
      const ids = nodes.map((node) => node.dataset.node);
      assert.equal(ids.includes("assessment"), label !== "bugfix");
      assert.equal(ids.includes("bug-reproduction"), label === "bugfix");
      assert.ok(ids.includes("done") && ids.includes("cancelled") && ids.includes("needs-human"));
      assert.equal(graph.querySelectorAll(".flow-start")[0]?.querySelectorAll("circle").length, 1);
      for (const node of nodes.filter((node) => node.dataset.kind === "final")) {
        assert.equal(node.querySelectorAll("rect").length, 0);
        assert.equal(node.querySelectorAll("circle").length, 2);
      }
      for (const edge of graph.querySelectorAll(".flow-edge")) {
        assert.ok(ids.includes(edge.dataset.source) && ids.includes(edge.dataset.target));
      }
    }
    ui.renderGraph(shippedFlow, "b".repeat(40));
    assert.equal(document.getElementById("flow-scenarios").querySelectorAll("button")
      .find((button) => button.attributes.get("aria-pressed") === "true")?.dataset.scenario, "bugfix");
    shippedFlow.spec.activationRoutes.documentary = "write-docs";
    shippedFlow.spec.states["write-docs"] = { kind: "agent", agent: "writer", on: { complete: { target: "archived" } } };
    shippedFlow.spec.states.archived = { kind: "final" };
    ui.renderGraph(shippedFlow, "c".repeat(40));
    const third = document.getElementById("flow-scenarios").querySelectorAll("button");
    assert.equal(third.length, 3);
    third.find((button) => button.dataset.scenario === "documentary")!.dispatchEvent(new TestEvent("click"));
    assert.deepEqual(graph.querySelectorAll(".flow-node").map((node) => node.dataset.node), ["write-docs", "archived"]);
    assert.equal(graph.querySelectorAll('[data-node="archived"]')[0]?.querySelectorAll("circle").length, 2);
    delete shippedFlow.spec.activationRoutes.documentary;
    ui.renderGraph(shippedFlow, "d".repeat(40));
    assert.equal(document.getElementById("flow-scenarios").querySelectorAll("button").length, 2);
    assert.ok(graph.querySelectorAll(".flow-node").some((node) => node.dataset.node === "assessment"));
    shippedFlow.spec.activationRoutes[shippedFlow.metadata.activationLabel] = "bug-reproduction";
    ui.renderGraph(shippedFlow, "e".repeat(40));
    const overridden = document.getElementById("flow-scenarios").querySelectorAll("button");
    assert.equal(overridden.length, 2);
    assert.equal(overridden.filter((button) => button.attributes.get("aria-pressed") === "true").length, 1);
    assert.ok(graph.querySelectorAll(".flow-node").some((node) => node.dataset.node === "bug-reproduction"));
    assert.ok(!graph.querySelectorAll(".flow-node").some((node) => node.dataset.node === "assessment"));
  }
});
