(() => {
  "use strict";

  const storageKeys = {
    view: "agent-flow-admin-view",
    menu: "agent-flow-menu-collapsed",
    autoRefresh: "agent-flow-auto-refresh",
    refreshInterval: "agent-flow-refresh-interval",
  };
  const svgNamespace = "http://www.w3.org/2000/svg";
  const screens = [...document.querySelectorAll("[data-screen]")];
  const tabs = [...document.querySelectorAll("[data-view]")];
  const shell = document.getElementById("app-shell");
  const menuToggle = document.getElementById("menu-toggle");
  const refreshToggle = document.getElementById("auto-refresh-toggle");
  const refreshInterval = document.getElementById("refresh-interval");
  const refreshCountdown = document.getElementById("auto-refresh-countdown");
  let dashboard = null;
  let selectedScenario = null;
  let remaining = Number(refreshInterval.value);
  let loading = false;
  let wizardConfigured = false;
  let sessionReaderCount = 0;
  let journalEntries = [];
  let journalDiscovery = { available: false, entries: [], reason: "sessions unavailable" };
  let journalPage = 0;
  let journalEmptyMessage = "No observations or diagnostic sessions.";
  const journalLimit = 100;
  const journalPageSize = 20;

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* Navigation remains usable without storage. */ }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function replace(id, ...children) {
    document.getElementById(id).replaceChildren(...children);
  }

  function empty(message) {
    return element("p", "empty", message);
  }

  function showView(view, save = true) {
    if (!screens.some((screen) => screen.dataset.screen === view)) view = "status";
    for (const screen of screens) screen.hidden = screen.dataset.screen !== view;
    for (const tab of tabs) {
      const selected = tab.dataset.view === view;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    if (save) safeSet(storageKeys.view, view);
  }

  function setMenuCollapsed(collapsed, save = true) {
    shell.classList.toggle("menu-collapsed", collapsed);
    menuToggle.setAttribute("aria-expanded", String(!collapsed));
    menuToggle.textContent = collapsed ? "→" : "←";
    menuToggle.setAttribute("aria-label", collapsed ? "Expand menu" : "Collapse menu");
    if (save) safeSet(storageKeys.menu, String(collapsed));
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => showView(tab.dataset.view));
    tab.addEventListener("keydown", (event) => {
      const current = tabs.indexOf(tab);
      let index;
      if (event.key === "ArrowRight") index = (current + 1) % tabs.length;
      else if (event.key === "ArrowLeft") index = (current - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") index = 0;
      else if (event.key === "End") index = tabs.length - 1;
      else return;
      event.preventDefault();
      showView(tabs[index].dataset.view);
      tabs[index].focus();
    });
  }
  for (const button of document.querySelectorAll("[data-open-view]")) {
    button.addEventListener("click", () => {
      const destination = tabs.find((tab) => tab.dataset.view === button.dataset.openView);
      showView(button.dataset.openView);
      destination.focus();
    });
  }
  menuToggle.addEventListener("click", () => setMenuCollapsed(!shell.classList.contains("menu-collapsed")));
  showView(safeGet(storageKeys.view) || "status", false);
  setMenuCollapsed(safeGet(storageKeys.menu) === "true", false);

  const savedInterval = safeGet(storageKeys.refreshInterval);
  if ([...refreshInterval.options].some((option) => option.value === savedInterval)) refreshInterval.value = savedInterval;
  refreshToggle.checked = safeGet(storageKeys.autoRefresh) === "true";
  refreshInterval.disabled = !refreshToggle.checked;
  remaining = Number(refreshInterval.value);
  refreshToggle.addEventListener("change", () => {
    refreshInterval.disabled = !refreshToggle.checked;
    remaining = Number(refreshInterval.value);
    safeSet(storageKeys.autoRefresh, String(refreshToggle.checked));
    updateCountdown();
  });
  refreshInterval.addEventListener("change", () => {
    remaining = Number(refreshInterval.value);
    safeSet(storageKeys.refreshInterval, refreshInterval.value);
    updateCountdown();
  });

  function updateCountdown() {
    if (!refreshToggle.checked) {
      refreshCountdown.textContent = "off";
      return;
    }
    if (remaining <= 0) {
      remaining = Number(refreshInterval.value);
      void loadDashboard();
    }
    refreshCountdown.textContent = `in ${remaining} s`;
    remaining -= 1;
  }
  updateCountdown();
  window.setInterval(updateCountdown, 1000);

  async function loadDashboard() {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch("/api/dashboard", { headers: { accept: "application/json" } });
      const snapshot = await response.json();
      if (!response.ok || snapshot.available !== true) throw new Error(String(snapshot.reason || `HTTP ${response.status}`));
      dashboard = snapshot;
      renderDashboard(snapshot);
    } catch (error) {
      renderUnavailable(error instanceof Error ? error.message : "dashboard unavailable");
    } finally {
      loading = false;
    }
  }

  function renderUnavailable(reason) {
    document.getElementById("snapshot-time").textContent = "Unavailable";
    const message = `Dashboard unavailable: ${reason}`;
    for (const id of ["status-metrics", "repositories-table", "queue-panel", "waiting-panel", "errors-panel", "journal", "locks-panel", "configuration-source", "configuration-grid", "resources", "agents", "node-inspector"]) {
      replace(id, empty(message));
    }
    journalEntries = [];
    journalPage = 0;
    updateJournalPagination(0, 0);
    replace("flow-graph", svg("title", {}, message));
    replace("flow-scenarios", empty(message));
    document.getElementById("flow-mode").textContent = "Scenarios unavailable";
    document.getElementById("flow-revision").textContent = "Pinned Flow unavailable";
    document.getElementById("node-kind").textContent = "Unavailable";
    setWizardEnabled(false, "The current RuntimeConfig is unavailable.");
  }

  function renderDashboard(snapshot) {
    document.getElementById("snapshot-time").textContent = `Snapshot ${new Date().toLocaleTimeString("en-US")}`;
    renderStatus(snapshot);
    renderConfiguration(snapshot);
    renderGraph(snapshot.flow, snapshot.configuration.revision);
    if (!wizardConfigured) configureWizard(snapshot);
    else {
      invalidateDraftOnRefresh();
      setWizardEnabled(true, "");
    }
  }

  function metric(label, value, foot, attention = false) {
    const card = element("article", `metric${attention ? " attention" : ""}`);
    card.append(element("div", "metric-label", label), element("div", "metric-value", value), element("div", "metric-foot", foot));
    return card;
  }

  function renderStatus(snapshot) {
    const controller = snapshot.controller;
    const waiting = controller.tickets.filter((ticket) => ["human-gate", "provider-wait", "paused"].includes(ticket.stateKind));
    replace("status-metrics",
      metric("Controller", controller.lifecycle, snapshot.status.restartRequired ? "restart required" : "runtime active", controller.lifecycle === "failed" || snapshot.status.restartRequired),
      metric("Repositories", controller.repositories.length, "configured repositories"),
      metric("Active work", controller.activeWork.length, `${controller.queue.active} scheduler active`),
      metric("Queue", controller.queue.queued, `concurrency ${controller.queue.concurrency}`),
      metric("External wait", waiting.length, "human / provider", waiting.length > 0),
    );
    renderRepositories(snapshot);
    renderQueue(snapshot);
    renderWaiting(waiting);
    renderErrors(snapshot);
    renderJournal(snapshot);
    renderLocks(snapshot);
  }

  function renderRepositories(snapshot) {
    const repositories = snapshot.controller.repositories;
    if (!repositories.length) {
      replace("repositories-table", empty("No repositories are connected."));
      return;
    }
    const table = element("table");
    const head = element("thead");
    const row = element("tr");
    for (const heading of ["Provider", "Repository", "Observations", "Cursor"]) row.append(element("th", "", heading));
    head.append(row);
    const body = element("tbody");
    for (const repository of repositories) {
      const observations = snapshot.controller.tickets.filter((ticket) => ticket.provider === repository.provider && ticket.repository === repository.repository);
      const repositoryUrl = observations.find((ticket) => ticket.repositoryUrl)?.repositoryUrl;
      const counts = new Map();
      for (const ticket of observations) counts.set(ticket.stateKind || "unclassified", (counts.get(ticket.stateKind || "unclassified") || 0) + 1);
      const countText = [...counts].map(([kind, count]) => `${kind}: ${count}`).join(" · ") || "none";
      const item = element("tr");
      const repositoryCell = element("td", "mono");
      repositoryCell.append(repositoryUrl ? externalLink(repository.repository, repositoryUrl) : document.createTextNode(repository.repository));
      item.append(element("td", "mono", repository.provider), repositoryCell, element("td", "mono", countText), element("td", "mono", formatDate(repository.nextWindowStartedAt, "Cursor not set")));
      body.append(item);
    }
    table.append(head, body);
    replace("repositories-table", table);
  }

  function renderQueue(snapshot) {
    const queue = snapshot.controller.queue;
    const polling = snapshot.runtime.polling;
    const rows = element("div", "row-list");
    rows.append(dataRow("scheduler", `${queue.active} active · ${queue.queued} queued · ${queue.concurrency} concurrency`));
    rows.append(dataRow("active attempts", snapshot.status.activeAttempts));
    rows.append(dataRow("configured rate cap", `${polling.maxCallsPerMinute} calls/min`));
    rows.append(dataRow("configured reserve", `${polling.quotaReservePercent}%`));
    rows.append(dataRow("observed provider quota", "Unavailable: the snapshot does not include quota telemetry"));
    const bar = element("div", "rate-bar");
    bar.append(element("div", "rate-fill"));
    rows.append(bar);
    const line = element("div", "rate-line");
    line.append(element("span", "", "configured limit"), element("span", "", "observed usage unavailable"));
    rows.append(line);
    replace("queue-panel", rows);
  }

  function renderWaiting(waiting) {
    if (!waiting.length) {
      replace("waiting-panel", empty("No human-gate, provider-wait, or paused observations."));
      return;
    }
    const list = element("div", "row-list");
    for (const ticket of waiting) {
      const revision = ticket.configRevision || "configRevision unavailable";
      const action = ticket.actionUrl ? externalLink(ticketIdentity(ticket), ticket.actionUrl) : ticketIdentity(ticket);
      list.append(dataRow(action, `${ticket.stateId || "state unavailable"} · ${ticket.stateKind || "kind unavailable"} · ${revision}`));
    }
    replace("waiting-panel", list);
  }

  function renderErrors(snapshot) {
    const errors = [...snapshot.controller.errors, ...snapshot.status.validationErrors].slice(-10);
    if (!errors.length) {
      replace("errors-panel", empty("No runtime errors in this snapshot."));
      return;
    }
    const list = element("div", "row-list");
    errors.forEach((error, index) => list.append(dataRow(`error ${index + 1}`, error)));
    replace("errors-panel", list);
  }

  function renderJournal(snapshot) {
    const sessions = snapshot.sessions.available ? snapshot.sessions.entries : [];
    const used = new Set();
    const entries = [];
    for (const ticket of snapshot.controller.tickets) {
      const matches = ticket.flowInstanceId ? sessions.filter((session) => session.flowUuid === ticket.flowInstanceId) : [];
      if (matches.length) {
        for (const session of matches) {
          used.add(session);
          entries.push({ ticket, session });
        }
      } else {
        entries.push({ ticket, session: null });
      }
    }
    for (const session of sessions) if (!used.has(session)) entries.push({ ticket: null, session });
    entries.sort((left, right) => String(right.session?.modifiedAt || right.ticket?.observedAt || "").localeCompare(String(left.session?.modifiedAt || left.ticket?.observedAt || "")));
    journalEntries = entries.slice(0, journalLimit);
    journalDiscovery = snapshot.sessions;
    journalEmptyMessage = snapshot.sessions.available ? "No observations or diagnostic sessions." : "Session discovery unavailable.";
    renderJournalPage();
  }

  function journalCard(entry, discovery) {
    const { ticket, session } = entry;
    const card = element("details", "event-card");
    card.journalEntry = entry;
    card.dataset.key = JSON.stringify(session ? [session.flowUuid, session.attemptUuid]
      : [ticket?.provider, ticket?.repository, ticket?.number]);
    const identity = ticket
      ? ticket.ticketUrl ? externalLink(ticketIdentity(ticket), ticket.ticketUrl) : ticketIdentity(ticket)
      : "Ticket identifier unavailable";
    card.dataset.search = journalSearch(entry);
    const summary = element("summary");
    summary.append(
      eventField("Observed", formatDate(session?.modifiedAt || ticket?.observedAt, "Time unavailable")),
      eventField("Agent work", "Unavailable"),
      eventField("Transition", ticket?.stateId ? `History not stored · current: ${ticket.stateId} · pinned: ${ticket.configRevision || "configRevision unavailable"}` : "History not stored"),
      eventField("Ticket", ticket ? `#${ticket.number}` : "Unavailable"),
      eventField("Repository", identity),
    );
    card.append(summary);
    if (session) {
      const reader = element("div", "session-reader");
      const head = element("div", "session-reader-head");
      head.append(element("strong", "", "Diagnostic session"), element("code", "", `${session.flowUuid}/${session.attemptUuid}`));
      const sessionTabs = element("div", "session-tabs");
      sessionTabs.setAttribute("role", "tablist");
      sessionTabs.setAttribute("aria-label", "Diagnostic session files");
      const content = element("div", "session-content");
      const readerId = `session-reader-${++sessionReaderCount}`;
      content.id = `${readerId}-panel`;
      content.setAttribute("role", "tabpanel");
      const definitions = [
        ["events", "Events", null],
        ["harness", "harness.log", "harness.log"],
        ["decision", "decision.json", "decision.json"],
        ["context", "context.json", "context.json"],
      ];
      for (const [key, label, file] of definitions) {
        const button = element("button", "session-tab", label);
        button.type = "button";
        button.id = `${readerId}-${key}`;
        button.dataset.sessionTab = key;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-controls", content.id);
        button.setAttribute("aria-selected", String(key === "events"));
        button.tabIndex = key === "events" ? 0 : -1;
        button.addEventListener("click", () => void renderSessionTab(session, sessionTabs, content, key, file));
        button.addEventListener("keydown", (event) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          const buttons = [...sessionTabs.querySelectorAll('[role="tab"]')];
          const offset = event.key === "ArrowRight" ? 1 : -1;
          const next = buttons[(buttons.indexOf(button) + offset + buttons.length) % buttons.length];
          event.preventDefault();
          next.focus();
          next.dispatchEvent(new MouseEvent("click"));
        });
        sessionTabs.append(button);
      }
      content.setAttribute("aria-labelledby", `${readerId}-events`);
      reader.append(head, sessionTabs, content);
      card.append(reader);
      card.addEventListener("toggle", () => {
        if (card.open && !content.hasChildNodes()) void renderSessionTab(session, sessionTabs, content, "events", null);
      });
    } else {
      card.append(empty(sessionMissingMessage(ticket, discovery)));
    }
    return card;
  }

  function sessionMissingMessage(ticket, discovery) {
    if (!discovery.available) return "Session discovery is unavailable; the session for this flowInstanceId may still exist.";
    if (!ticket?.flowInstanceId) return "No flowInstanceId has been observed, so the session is unavailable.";
    if (discovery.truncated) return "Session status is unknown because this flowInstanceId is not in the limited snapshot.";
    return "No diagnostic session found for this flowInstanceId.";
  }

  async function renderSessionTab(session, sessionTabs, content, key, file) {
    const requestId = String(Number(content.dataset.requestId || 0) + 1);
    content.dataset.requestId = requestId;
    for (const button of sessionTabs.querySelectorAll("[data-session-tab]")) {
      const selected = button.dataset.sessionTab === key;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected) content.setAttribute("aria-labelledby", button.id);
    }
    const pre = element("pre");
    content.replaceChildren(pre);
    if (!file) {
      pre.textContent = "The event stream is not stored, so this tab is unavailable.";
      return;
    }
    if (!session.files.includes(file)) {
      pre.textContent = `${file}: file not present in the session snapshot.`;
      return;
    }
    pre.textContent = `${file}: loading…`;
    try {
      const path = `/api/sessions/${encodeURIComponent(session.flowUuid)}/${encodeURIComponent(session.attemptUuid)}/${file}`;
      const response = await fetch(path, { headers: { accept: "application/json" } });
      const result = await response.json();
      if (content.dataset.requestId !== requestId) return;
      pre.textContent = response.ok && result.available === true
        ? `${result.content}${result.truncated ? "\n\n[Content truncated by the server]" : ""}`
        : `${file}: ${result.reason || `HTTP ${response.status}`}`;
    } catch {
      if (content.dataset.requestId !== requestId) return;
      pre.textContent = `${file}: unavailable.`;
    }
  }

  function filterJournal() {
    journalPage = 0;
    renderJournalPage();
  }

  function journalSearch(entry) {
    const ticket = entry.ticket;
    return ticket ? `${ticket.provider} ${ticket.repository} ${ticket.number}`.toLowerCase() : "";
  }

  function renderJournalPage() {
    const query = document.getElementById("journal-search").value.trim().toLowerCase();
    const matches = journalEntries.filter((entry) => !query || journalSearch(entry).includes(query));
    const lastPage = Math.max(0, Math.ceil(matches.length / journalPageSize) - 1);
    journalPage = Math.min(journalPage, lastPage);
    const start = journalPage * journalPageSize;
    const visible = matches.slice(start, start + journalPageSize);
    const journal = document.getElementById("journal");
    const existing = new Map([...journal.children].map((card) => [card.dataset.key, card]));
    const cards = visible.length
      ? visible.map((entry) => {
        const fresh = journalCard(entry, journalDiscovery);
        const previous = existing.get(fresh.dataset.key);
        if (!previous?.open || !entry.session) return fresh;
        Object.assign(previous.journalEntry.session, entry.session);
        previous.replaceChild(fresh.children[0], previous.children[0]);
        previous.dataset.search = fresh.dataset.search;
        return previous;
      })
      : [empty(journalEntries.length ? "No journal entries match this search." : journalEmptyMessage)];
    if (cards.length !== journal.children.length || cards.some((card, index) => card !== journal.children[index])) {
      journal.replaceChildren(...cards);
    }
    updateJournalPagination(start, matches.length);
  }

  function updateJournalPagination(start, total) {
    const visible = Math.min(journalPageSize, Math.max(0, total - start));
    document.getElementById("journal-page").textContent = total ? `${start + 1}–${start + visible} of ${total}` : "0 of 0";
    document.getElementById("journal-previous").disabled = start === 0;
    document.getElementById("journal-next").disabled = start + visible >= total;
  }
  document.getElementById("journal-search").addEventListener("input", filterJournal);
  document.getElementById("journal-previous").addEventListener("click", () => {
    journalPage = Math.max(0, journalPage - 1);
    renderJournalPage();
  });
  document.getElementById("journal-next").addEventListener("click", () => {
    journalPage += 1;
    renderJournalPage();
  });

  function renderLocks(snapshot) {
    if (!snapshot.controller.locks.length) {
      replace("locks-panel", empty("No active per-ticket locks. Human gates release their locks."));
      return;
    }
    const list = element("div", "row-list");
    for (const ref of snapshot.controller.locks) {
      const observation = snapshot.controller.tickets.find((ticket) => ticket.provider === ref.provider && ticket.repository === ref.repository && ticket.number === ref.number);
      const evidence = observation
        ? `${observation.stateId || "state not yet observed"} · ${observation.configRevision || "configRevision unavailable"}`
        : "observation still pending";
      const identity = observation?.ticketUrl
        ? externalLink(ticketIdentity(ref), observation.ticketUrl)
        : ticketIdentity(ref);
      list.append(dataRow(identity, evidence));
    }
    replace("locks-panel", list);
  }

  function renderConfiguration(snapshot) {
    const source = document.getElementById("configuration-source");
    const provenance = snapshot.configuration.provenance;
    const sourceMain = element("div");
    const sourceValue = element("code");
    sourceValue.append(
      provenance.repositoryUrl
        ? externalLink(provenance.repositoryUrl, provenance.repositoryUrl)
        : document.createTextNode(`${snapshot.configuration.repository} (local mount; web URL unavailable)`),
      document.createTextNode(" · "),
      provenance.stackUrl
        ? externalLink(snapshot.configuration.stackPath, provenance.stackUrl)
        : document.createTextNode(snapshot.configuration.stackPath),
    );
    sourceMain.append(element("small", "", "Configuration source"), sourceValue);
    const revision = element("div", "revision");
    const revisionValue = provenance.revisionUrl
      ? externalLink(snapshot.configuration.revision, provenance.revisionUrl)
      : element("strong", "", snapshot.configuration.revision);
    revision.append(element("span", "", "pinned revision"), document.createElement("br"), revisionValue, document.createElement("br"), element("span", "", "read only"));
    source.replaceChildren(sourceMain, revision);

    const runtime = snapshot.runtime;
    const flow = snapshot.flow;
    const stack = snapshot.configuration.stack;
    replace("configuration-grid",
      configPanel("RuntimeConfig", [
        ["apiVersion", runtime.apiVersion], ["kind", runtime.kind], ["polling.intervalSeconds", runtime.polling.intervalSeconds],
        ["polling.maxCallsPerMinute", runtime.polling.maxCallsPerMinute], ["polling.quotaReservePercent", runtime.polling.quotaReservePercent],
        ["runtime.concurrency", runtime.runtime.concurrency], ["runtime.http.port", runtime.runtime.http.port],
      ]),
      configPanel("Stack", [["kind", stack.kind], ["source", sourceReference(snapshot.configuration.stackPath, provenance.stackUrl)], ["flow", sourceReference(stack.spec.flow, provenance.flowUrl)], ["catalog", sourceReference(stack.spec.catalog, provenance.catalogUrl)], ["contracts", stack.spec.contracts.join(", ")], ["schemas", stack.spec.schemas.join(", ")]]),
      configPanel("Flow", [["id", flow.metadata.id], ["source", sourceReference(stack.spec.flow, provenance.flowUrl)], ["activationLabel", flow.metadata.activationLabel], ["managedLabel", flow.metadata.managedLabel], ["initial", flow.spec.initial], ...Object.entries(flow.spec.activationRoutes ?? {}).map(([label, state]) => [`activation: ${label}`, state]), ["states", Object.keys(flow.spec.states).length]]),
      configPanel("AgentCatalog", [["kind", snapshot.catalog.kind], ["agents", Object.keys(snapshot.catalog.agents).join(", ")], ["source", sourceReference(stack.spec.catalog, provenance.catalogUrl)]]),
    );
    renderResources(snapshot);
    renderAgents(snapshot);
  }

  function configPanel(title, values) {
    const panel = element("article", "panel");
    const head = element("div", "panel-head");
    head.append(element("h2", "", title), element("span", "panel-meta", "pinned / effective"));
    const body = element("div", "panel-body");
    body.append(definitionList(values));
    panel.append(head, body);
    return panel;
  }

  function renderResources(snapshot) {
    const resources = [];
    resources.push(resource(snapshot.runtime.provider.type, snapshot.preflight.status, [
      `API: ${snapshot.runtime.provider.apiUrl}`,
      `repositories: ${snapshot.runtime.provider.repositories.join(", ")}`,
      "credential path: omitted from the dashboard API",
    ]));
    for (const harness of snapshot.runtime.execution.harnesses) {
      const users = Object.entries(snapshot.runtime.execution.agents).filter(([, execution]) => execution.harness === harness).map(([agent]) => agent);
      resources.push(resource(harness, snapshot.preflight.harnesses.includes(harness) ? "ready" : "unavailable", [`agents: ${users.join(", ") || "none"}`, "secret path: omitted from the dashboard API"]));
    }
    replace("resources", ...resources);
  }

  function resource(name, status, lines) {
    const item = element("div", "resource");
    const head = element("div", "resource-head");
    head.append(element("h3", "", name), element("span", "tag", status));
    const description = element("p");
    lines.forEach((line, index) => {
      if (index) description.append(document.createElement("br"));
      description.append(document.createTextNode(line));
    });
    item.append(head, description);
    return item;
  }

  function renderAgents(snapshot) {
    const agents = [];
    for (const [agentId, catalog] of Object.entries(snapshot.catalog.agents)) {
      const execution = snapshot.runtime.execution.agents[agentId];
      const states = Object.entries(snapshot.flow.spec.states).filter(([, state]) => state.agent === agentId);
      const details = element("details");
      const summary = element("summary");
      summary.append(element("span", "mono", agentId), element("span", "tag", execution ? `${execution.harness} · ${execution.maxAttempts} × ${execution.timeoutSeconds} s` : "execution binding unavailable"));
      const body = element("div", "agent-body");
      body.append(definitionList([
        ["package", sourceReference(catalog.package, snapshot.configuration.provenance.agentPackageUrls[agentId])], ["harness", execution?.harness || "Unavailable"], ["model", execution?.model || "Unavailable"],
        ["reasoning", execution?.reasoning || "Unavailable"], ["maxAttempts", execution?.maxAttempts ?? "Unavailable"],
        ["delaySeconds", execution?.delaySeconds ?? "Unavailable"], ["timeoutSeconds", execution?.timeoutSeconds ?? "Unavailable"],
        ["states", states.map(([id]) => id).join(", ") || "None"],
        ["resultContract", states.map(([, state]) => state.resultContract || "none").join(", ") || "None"],
        ["context", [...new Set(states.flatMap(([, state]) => state.context || []))].join(", ") || "None"],
      ]));
      details.append(summary, body);
      agents.push(details);
    }
    replace("agents", ...(agents.length ? agents : [empty("The pinned AgentCatalog contains no agents.")]));
  }

  function renderGraph(flow, revision) {
    document.getElementById("flow-revision").textContent = `pinned · ${revision}`;
    const entries = Object.entries({ [flow.metadata.activationLabel]: flow.spec.initial, ...flow.spec.activationRoutes });
    if (!entries.some(([label]) => label === selectedScenario)) selectedScenario = entries[0][0];
    const choices = entries.map(([label, initial]) => {
      const button = element("button", "scenario-choice");
      button.type = "button";
      button.dataset.scenario = label;
      button.setAttribute("aria-controls", "flow-graph");
      const name = label.replace(/^agent-flow:/, "").replace(/-/g, " ");
      button.append(element("strong", "", name.charAt(0).toUpperCase() + name.slice(1)),
        element("span", "", `Loaded · ${label}`));
      button.addEventListener("click", () => choose(label, initial));
      return button;
    });
    function choose(label, initial) {
      selectedScenario = label;
      for (const button of choices) button.setAttribute("aria-pressed", String(button.dataset.scenario === label));
      const states = reachableStates(flow, initial);
      const mode = Object.values(states).some((state) => state.kind === "human-gate")
        ? "Intermediate human review" : "No intermediate human review";
      document.getElementById("flow-mode").textContent = `${entries.length} scenarios loaded · ${flow.metadata.id} · ${mode}`;
      renderScenario({ ...flow, spec: { ...flow.spec, initial, states } }, label);
    }
    replace("flow-scenarios", ...choices);
    choose(...entries.find(([label]) => label === selectedScenario));
  }

  function reachableStates(flow, initial) {
    const visited = new Set();
    const pending = [initial];
    for (let i = 0; i < pending.length; i += 1) {
      const id = pending[i];
      if (visited.has(id) || !Object.hasOwn(flow.spec.states, id)) continue;
      visited.add(id);
      for (const transition of Object.values(flow.spec.states[id].on ?? {})) {
        pending.push(transition.target);
        if (transition.resumeTarget) pending.push(transition.resumeTarget);
      }
    }
    return Object.fromEntries([...visited].map((id) => [id, flow.spec.states[id]]));
  }

  function renderScenario(flow, label) {
    const graph = document.getElementById("flow-graph");
    const title = svg("title", { id: "flow-graph-title" }, `States for ${label}`);
    const arrow = svg("marker", { id: "flow-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
    arrow.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "context-stroke" }));
    const definitions = svg("defs", {});
    definitions.append(arrow);
    const positions = graphPositions(flow.spec.states);
    const width = Math.max(800, ...Object.values(positions).map((position) => position.x + 250));
    graph.setAttribute("viewBox", `0 0 ${width} 500`);
    graph.setAttribute("style", `min-width: ${width}px`);
    const edges = [];
    for (const [sourceId, state] of Object.entries(flow.spec.states)) {
      const source = positions[sourceId];
      for (const [eventName, transition] of Object.entries(state.on ?? {})) {
        const target = positions[transition.target];
        if (!target) continue;
        let edge;
        if (target === source) {
          edge = svg("path", { class: "flow-edge", fill: "none", d: `M ${source.x + 70} ${source.y} C ${source.x + 35} ${source.y - 48}, ${source.x + 165} ${source.y - 48}, ${source.x + 130} ${source.y}`, "marker-end": "url(#flow-arrow)" });
        } else if (source.y === target.y && target.x < source.x) {
          const lane = 35 + Math.min(45, (source.x - target.x) / 12);
          edge = svg("path", { class: "flow-edge", fill: "none", d: `M ${source.x + 100} ${source.y} C ${source.x + 100} ${source.y - lane}, ${target.x + 100} ${target.y - lane}, ${target.x + 100} ${target.y}`, "marker-end": "url(#flow-arrow)" });
        } else {
          edge = svg("line", { class: "flow-edge", ...edgeEndpoints(source, target), "marker-end": "url(#flow-arrow)" });
        }
        edge.setAttribute("data-source", sourceId);
        edge.setAttribute("data-target", transition.target);
        edge.append(svg("title", {}, `${sourceId}: ${eventName} → ${transition.target}`));
        edges.push(edge);
      }
    }
    const nodes = Object.entries(flow.spec.states).map(([id, state]) => graphNode(id, state, positions[id], () => selectNode(flow, id)));
    const first = positions[flow.spec.initial];
    const start = svg("g", { class: "flow-start" });
    start.append(svg("title", {}, `Start: ${label}`), svg("circle", { cx: "36", cy: first.y + 36, r: "10" }),
      svg("text", { x: "36", y: first.y + 65, "text-anchor": "middle" }, "Start"),
      svg("line", { class: "flow-start-edge", ...edgeEndpoints({ x: -64, y: first.y, radius: 10 }, first), "marker-end": "url(#flow-arrow)" }));
    graph.replaceChildren(title, definitions, start, ...edges, ...nodes);
    selectNode(flow, flow.spec.initial);
  }

  function graphPositions(states) {
    const main = Object.entries(states).filter(([, state]) => state.kind !== "paused" && state.kind !== "final");
    const mainTargets = new Set(main.flatMap(([, state]) => Object.values(state.on ?? {}).map((transition) => transition.target)));
    let stage = 0;
    let auxiliary = 0;
    return Object.fromEntries(Object.entries(states).map(([id, state]) => {
      const below = state.kind === "paused" || (state.kind === "final" && !mainTargets.has(id));
      const column = below ? auxiliary++ : stage++;
      return [id, { x: 100 + column * 240, y: below ? 350 : 100, radius: state.kind === "final" ? 24 : null }];
    }));
  }

  function edgeEndpoints(source, target) {
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const boundary = (point) => point.radius ? point.radius / Math.hypot(dx, dy)
      : 1 / Math.max(Math.abs(dx) / 100, Math.abs(dy) / 36);
    const from = boundary(source);
    const to = boundary(target);
    return {
      x1: source.x + 100 + dx * from,
      y1: source.y + 36 + dy * from,
      x2: target.x + 100 - dx * to,
      y2: target.y + 36 - dy * to,
    };
  }

  function graphNode(id, state, position, select) {
    const node = svg("g", { class: "flow-node", transform: `translate(${position.x} ${position.y})`, tabindex: "0", role: "button", "aria-pressed": "false", "data-node": id, "data-kind": state.kind, "aria-label": `State ${id}, ${state.kind}` });
    if (state.kind === "final") {
      node.append(svg("circle", { cx: "100", cy: "36", r: "24" }),
        svg("circle", { class: "terminal-core", cx: "100", cy: "36", r: "17" }),
        svg("text", { x: "100", y: "86", "text-anchor": "middle" }, id));
    } else {
      node.append(svg("rect", { width: "200", height: "72" }), svg("text", { x: "14", y: "30" }, id), svg("text", { class: "sub", x: "14", y: "51" }, `${state.kind}${state.agent ? ` · ${state.agent}` : ""}`));
    }
    node.addEventListener("click", select);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
      if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(event.key)) return;
      const nodes = [...document.querySelectorAll(".flow-node")];
      const offset = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      const next = nodes[(nodes.indexOf(node) + offset + nodes.length) % nodes.length];
      event.preventDefault();
      next.focus();
      next.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    return node;
  }

  function selectNode(flow, id) {
    for (const node of document.querySelectorAll(".flow-node")) {
      const selected = node.dataset.node === id;
      node.classList.toggle("active", selected);
      node.setAttribute("aria-pressed", String(selected));
    }
    for (const edge of document.querySelectorAll(".flow-edge")) {
      edge.classList.toggle("outgoing", edge.dataset.source === id);
    }
    const state = flow.spec.states[id];
    document.getElementById("node-kind").textContent = state.kind;
    const inspector = document.getElementById("node-inspector");
    const title = element("h3", "inspector-title", id);
    const values = definitionList([["agent", state.agent || "Not configured"], ["resultContract", state.resultContract || "Not configured"], ["context", state.context?.join(", ") || "Not configured"]]);
    const transitions = element("ul", "inspector-list");
    const configured = Object.entries(state.on ?? {});
    if (!configured.length) transitions.append(element("li", "", "No transitions."));
    for (const [eventName, transition] of configured) {
      const guards = transition.guards?.length ? ` · guards: ${transition.guards.join(", ")}` : "";
      const actions = transition.actions?.length ? ` · actions: ${transition.actions.join(", ")}` : "";
      const resume = transition.resumeTarget ? ` · resumeTarget: ${transition.resumeTarget}` : "";
      transitions.append(element("li", "", `${eventName} → ${transition.target}${resume}${guards}${actions}`));
    }
    inspector.replaceChildren(title, values, transitions);
  }

  const fields = {
    polling: {
      intervalSeconds: { path: ["polling", "intervalSeconds"], min: 0, exclusiveMin: true, step: "any" },
      maxCallsPerMinute: { path: ["polling", "maxCallsPerMinute"], min: 1, max: 20, integer: true },
      quotaReservePercent: { path: ["polling", "quotaReservePercent"], min: 1, max: 90, integer: true },
    },
    runtime: {
      concurrency: { path: ["runtime", "concurrency"], min: 1, max: 32, integer: true },
      port: { path: ["runtime", "http", "port"], min: 1, max: 65535, integer: true },
    },
    agent: {
      maxAttempts: { path: ["execution", "agents", "$agent", "maxAttempts"], min: 1, max: 10, integer: true },
      delaySeconds: { path: ["execution", "agents", "$agent", "delaySeconds"], min: 0, max: 3600, integer: true },
      timeoutSeconds: { path: ["execution", "agents", "$agent", "timeoutSeconds"], min: 1, max: 86400, integer: true },
    },
  };
  const groupSelect = document.getElementById("draft-group");
  const fieldSelect = document.getElementById("draft-field");
  const agentSelect = document.getElementById("draft-agent");
  const agentField = document.getElementById("agent-field");
  const valueInput = document.getElementById("draft-value");
  const bounds = document.getElementById("draft-bounds");
  const draftError = document.getElementById("draft-error");
  let wizardStep = 1;

  groupSelect.addEventListener("change", () => { invalidateDraft(); updateDraftFields(); });
  fieldSelect.addEventListener("change", () => { invalidateDraft(); updateDraftValue(); });
  agentSelect.addEventListener("change", () => { invalidateDraft(); updateDraftValue(); });
  valueInput.addEventListener("input", invalidateDraft);

  function configureWizard(snapshot) {
    agentSelect.replaceChildren(...Object.keys(snapshot.runtime.execution.agents).map((agent) => option(agent, agent)));
    setWizardEnabled(true, "");
    updateDraftFields();
    wizardConfigured = true;
  }

  function setWizardEnabled(enabled, message) {
    for (const control of document.querySelectorAll("#config-wizard input, #config-wizard select, #config-wizard button")) control.disabled = !enabled;
    draftError.textContent = message;
  }

  function updateDraftFields() {
    fieldSelect.replaceChildren(...Object.keys(fields[groupSelect.value]).map((key) => option(key, key)));
    agentField.hidden = groupSelect.value !== "agent";
    updateDraftValue();
  }

  function updateDraftValue() {
    if (!dashboard) return;
    const definition = fields[groupSelect.value][fieldSelect.value];
    const path = definition.path.map((part) => part === "$agent" ? agentSelect.value : part);
    const current = path.reduce((value, key) => value?.[key], dashboard.runtime);
    valueInput.value = current ?? "";
    valueInput.step = definition.step || "1";
    if (definition.exclusiveMin) valueInput.min = String(Number.EPSILON);
    else valueInput.min = String(definition.min);
    if (definition.max === undefined) valueInput.removeAttribute("max");
    else valueInput.max = String(definition.max);
    bounds.textContent = `${definition.exclusiveMin ? ">" : "min"} ${definition.min}${definition.max === undefined ? "" : ` · max ${definition.max}`}${definition.integer ? " · integer" : ""}`;
    draftError.textContent = "";
  }

  function invalidateDraft() {
    if (wizardStep !== 1) {
      wizardStep = 1;
      renderWizard();
    }
    replace("change-summary");
    document.getElementById("yaml-output").value = "";
    document.getElementById("copy-status").textContent = "";
    draftError.textContent = "";
  }

  function invalidateDraftOnRefresh() {
    if (wizardStep > 1) invalidateDraft();
  }

  function validateDraft() {
    const definition = fields[groupSelect.value][fieldSelect.value];
    const rawValue = valueInput.value.trim();
    const inputValid = rawValue !== "" && valueInput.checkValidity();
    const value = inputValid ? Number(rawValue) : Number.NaN;
    const valid = inputValid
      && Number.isFinite(value)
      && (definition.exclusiveMin ? value > definition.min : value >= definition.min)
      && (definition.max === undefined || value <= definition.max)
      && (!definition.integer || Number.isInteger(value));
    draftError.textContent = valid ? "" : `Value does not match the RuntimeConfig schema: ${bounds.textContent}.`;
    return valid;
  }

  function buildDraft() {
    const definition = fields[groupSelect.value][fieldSelect.value];
    const agent = groupSelect.value === "agent" ? agentSelect.value : null;
    const path = definition.path.map((part) => part === "$agent" ? agent : part);
    const current = path.reduce((value, key) => value?.[key], dashboard.runtime);
    const value = Number(valueInput.value);
    const summary = definitionList([["File", "/etc/agent-flow/runtime.yaml"], ["Field", path.join(".")], ["Current value", current], ["New value", value]]);
    replace("change-summary", ...summary.children);
    const lines = [];
    path.forEach((part, index) => lines.push(`${"  ".repeat(index)}${part}:${index === path.length - 1 ? ` ${value}` : ""}`));
    document.getElementById("yaml-output").value = `${lines.join("\n")}\n`;
    document.getElementById("copy-status").textContent = "";
  }

  document.getElementById("wizard-next").addEventListener("click", () => {
    if (wizardStep === 1 && !validateDraft()) {
      valueInput.reportValidity();
      return;
    }
    buildDraft();
    wizardStep = Math.min(3, wizardStep + 1);
    renderWizard();
  });
  document.getElementById("wizard-back").addEventListener("click", () => {
    wizardStep = Math.max(1, wizardStep - 1);
    renderWizard();
  });
  document.getElementById("wizard-copy").addEventListener("click", async () => {
    const output = document.getElementById("yaml-output");
    try {
      await navigator.clipboard.writeText(output.value);
      document.getElementById("copy-status").textContent = "YAML copied.";
    } catch {
      output.select();
      const copied = document.execCommand("copy");
      document.getElementById("copy-status").textContent = copied ? "YAML copied." : "Cannot copy YAML. Select the text manually.";
    }
  });

  function renderWizard() {
    for (const pane of document.querySelectorAll("[data-step]")) pane.hidden = Number(pane.dataset.step) !== wizardStep;
    for (const label of document.querySelectorAll("[data-step-label]")) label.classList.toggle("active", Number(label.dataset.stepLabel) === wizardStep);
    document.getElementById("wizard-back").hidden = wizardStep === 1;
    document.getElementById("wizard-next").hidden = wizardStep === 3;
    document.getElementById("wizard-copy").hidden = wizardStep !== 3;
  }

  function eventField(label, value) {
    const field = element("span", "event-field");
    const content = element("strong");
    content.append(value && typeof value === "object" ? value : document.createTextNode(String(value)));
    field.append(element("small", "", label), content);
    return field;
  }

  function dataRow(label, value) {
    const row = element("div", "data-row");
    const heading = element("strong");
    heading.append(label && typeof label === "object" ? label : document.createTextNode(String(label)));
    row.append(heading, element("span", "", value));
    return row;
  }

  function definitionList(values) {
    const list = element("dl", "kv-list");
    for (const [key, value] of values) {
      const description = element("dd");
      description.append(value && typeof value === "object" ? value : document.createTextNode(String(value)));
      list.append(element("dt", "", key), description);
    }
    return list;
  }

  function sourceReference(path, url) {
    return url ? externalLink(path, url) : document.createTextNode(path);
  }

  function externalLink(label, url) {
    let parsed;
    try { parsed = new URL(url); } catch { return document.createTextNode(label); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return document.createTextNode(label);
    const link = element("a", "external-link", label);
    link.setAttribute("href", parsed.href);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noreferrer noopener");
    return link;
  }

  function option(value, label) {
    const node = element("option", "", label);
    node.value = value;
    return node;
  }

  function ticketIdentity(ticket) {
    return `${ticket.provider}:${ticket.repository}#${ticket.number}`;
  }

  function formatDate(value, unavailable) {
    if (!value) return unavailable;
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? unavailable : date.toLocaleString("en-US");
  }

  function svg(tag, attributes, text) {
    const node = document.createElementNS(svgNamespace, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  renderWizard();
  void loadDashboard();
})();
