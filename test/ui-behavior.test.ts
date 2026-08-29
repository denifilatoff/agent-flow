import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

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

test("keeps session reader selection stable across slow responses and journal search", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const document = new TestDocument();
  const journal = document.getElementById("journal");
  const search = document.getElementById("journal-search");
  document.body.append(journal, search);
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
  const other = journalCard({ ticket: { provider: "gitlab", repository: "other/repo", number: 7 }, session: null }, discovery);
  journal.append(card, other);
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

  search.value = "owner/repo";
  search.dispatchEvent(new TestEvent("input"));
  assert.equal(card.hidden, false);
  assert.equal(other.hidden, true);
});
