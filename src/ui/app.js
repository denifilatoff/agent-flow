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
  let remaining = Number(refreshInterval.value);
  let loading = false;

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
    for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.view === view));
    if (save) safeSet(storageKeys.view, view);
  }

  function setMenuCollapsed(collapsed, save = true) {
    shell.classList.toggle("menu-collapsed", collapsed);
    menuToggle.setAttribute("aria-expanded", String(!collapsed));
    menuToggle.textContent = collapsed ? "→" : "←";
    menuToggle.setAttribute("aria-label", collapsed ? "Развернуть меню" : "Свернуть меню");
    if (save) safeSet(storageKeys.menu, String(collapsed));
  }

  for (const tab of tabs) tab.addEventListener("click", () => showView(tab.dataset.view));
  for (const button of document.querySelectorAll("[data-open-view]")) {
    button.addEventListener("click", () => showView(button.dataset.openView));
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
      refreshCountdown.textContent = "выкл.";
      return;
    }
    if (remaining <= 0) {
      remaining = Number(refreshInterval.value);
      void loadDashboard();
    }
    refreshCountdown.textContent = `через ${remaining} с`;
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
    document.getElementById("snapshot-time").textContent = "Недоступно";
    const message = `Dashboard недоступен: ${reason}`;
    for (const id of ["status-metrics", "repositories-table", "queue-panel", "waiting-panel", "errors-panel", "journal", "locks-panel", "configuration-source", "configuration-grid", "resources", "agents", "node-inspector"]) {
      replace(id, empty(message));
    }
    replace("flow-graph", svg("title", {}, message));
    document.getElementById("flow-revision").textContent = "Pinned Flow недоступен";
    document.getElementById("node-kind").textContent = "Недоступно";
    setWizardEnabled(false, "Текущий RuntimeConfig недоступен.");
  }

  function renderDashboard(snapshot) {
    document.getElementById("snapshot-time").textContent = `Снимок ${new Date().toLocaleTimeString("ru-RU")}`;
    renderStatus(snapshot);
    renderConfiguration(snapshot);
    renderGraph(snapshot.flow, snapshot.configuration.revision);
    configureWizard(snapshot);
  }

  function metric(label, value, foot, attention = false) {
    const card = element("article", `metric${attention ? " attention" : ""}`);
    card.append(element("div", "metric-label", label), element("div", "metric-value", value), element("div", "metric-foot", foot));
    return card;
  }

  function renderStatus(snapshot) {
    const controller = snapshot.controller;
    const waiting = controller.tickets.filter((ticket) => {
      const kind = snapshot.flow.spec.states[ticket.stateId]?.kind;
      return kind === "human-gate" || kind === "provider-wait" || kind === "paused";
    });
    replace("status-metrics",
      metric("Controller", controller.lifecycle, snapshot.status.restartRequired ? "требуется restart" : "runtime активен", controller.lifecycle === "failed" || snapshot.status.restartRequired),
      metric("Репозитории", controller.repositories.length, "configured repositories"),
      metric("Активная работа", controller.activeWork.length, `${controller.queue.active} scheduler active`),
      metric("Очередь", controller.queue.queued, `concurrency ${controller.queue.concurrency}`),
      metric("Внешнее ожидание", waiting.length, "human / provider", waiting.length > 0),
    );
    renderRepositories(snapshot);
    renderQueue(snapshot);
    renderWaiting(snapshot, waiting);
    renderErrors(snapshot);
    renderJournal(snapshot);
    renderLocks(snapshot);
  }

  function renderRepositories(snapshot) {
    const repositories = snapshot.controller.repositories;
    if (!repositories.length) {
      replace("repositories-table", empty("Подключённых репозиториев нет."));
      return;
    }
    const table = element("table");
    const head = element("thead");
    const row = element("tr");
    for (const heading of ["Provider", "Репозиторий", "Наблюдения", "Cursor"]) row.append(element("th", "", heading));
    head.append(row);
    const body = element("tbody");
    for (const repository of repositories) {
      const observations = snapshot.controller.tickets.filter((ticket) => ticket.provider === repository.provider && ticket.repository === repository.repository).length;
      const item = element("tr");
      item.append(element("td", "mono", repository.provider), element("td", "mono", repository.repository), element("td", "", observations), element("td", "mono", formatDate(repository.nextWindowStartedAt, "Cursor ещё не установлен")));
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
    rows.append(dataRow("observed provider quota", "Недоступно: snapshot не содержит quota telemetry"));
    const bar = element("div", "rate-bar");
    bar.append(element("div", "rate-fill"));
    rows.append(bar);
    const line = element("div", "rate-line");
    line.append(element("span", "", "configured guard"), element("span", "", "observed usage unavailable"));
    rows.append(line);
    replace("queue-panel", rows);
  }

  function renderWaiting(snapshot, waiting) {
    if (!waiting.length) {
      replace("waiting-panel", empty("Human gate, provider wait и paused observations отсутствуют."));
      return;
    }
    const list = element("div", "row-list");
    for (const ticket of waiting) {
      const kind = snapshot.flow.spec.states[ticket.stateId]?.kind || "state недоступен";
      list.append(dataRow(ticketIdentity(ticket), `${ticket.stateId || "state недоступен"} · ${kind}`));
    }
    replace("waiting-panel", list);
  }

  function renderErrors(snapshot) {
    const errors = [...snapshot.controller.errors, ...snapshot.status.validationErrors].slice(-10);
    if (!errors.length) {
      replace("errors-panel", empty("Runtime-ошибок в текущем snapshot нет."));
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
    const journal = document.getElementById("journal");
    if (!entries.length) {
      journal.replaceChildren(empty(snapshot.sessions.available ? "Наблюдений и диагностических сессий нет." : snapshot.sessions.reason));
      return;
    }
    journal.replaceChildren(...entries.map(journalCard));
    filterJournal();
  }

  function journalCard(entry) {
    const { ticket, session } = entry;
    const card = element("details", "event-card");
    const identity = ticket ? ticketIdentity(ticket) : "Ticket identity недоступен";
    card.dataset.search = ticket ? `${ticket.provider} ${ticket.repository} ${ticket.number}`.toLowerCase() : "";
    const summary = element("summary");
    summary.append(
      eventField("Наблюдение", formatDate(session?.modifiedAt || ticket?.observedAt, "Время недоступно")),
      eventField("Работа агента", "Недоступно"),
      eventField("Переход", ticket?.stateId ? `История не хранится · current: ${ticket.stateId}` : "История не хранится"),
      eventField("Ticket", ticket ? `#${ticket.number}` : "Недоступно"),
      eventField("Репозиторий", ticket ? `${ticket.provider}:${ticket.repository}` : identity),
    );
    card.append(summary);
    if (session) {
      const reader = element("div", "session-reader");
      const head = element("div", "session-reader-head");
      head.append(element("strong", "", "Диагностическая сессия"), element("code", "", `${session.flowUuid}/${session.attemptUuid}`));
      const tabs = element("div", "session-tabs");
      tabs.setAttribute("role", "tablist");
      const content = element("div", "session-content");
      const definitions = [
        ["events", "События", null],
        ["harness", "harness.log", "harness.log"],
        ["decision", "decision.json", "decision.json"],
        ["context", "context.json", "context.json"],
      ];
      for (const [key, label, file] of definitions) {
        const button = element("button", "session-tab", label);
        button.type = "button";
        button.dataset.sessionTab = key;
        button.setAttribute("aria-selected", String(key === "events"));
        button.addEventListener("click", () => void renderSessionTab(session, tabs, content, key, file));
        tabs.append(button);
      }
      reader.append(head, tabs, content);
      card.append(reader);
      card.addEventListener("toggle", () => {
        if (card.open && !content.hasChildNodes()) void renderSessionTab(session, tabs, content, "events", null);
      });
    } else {
      card.append(empty(ticket?.flowInstanceId ? "Диагностическая сессия для flowInstanceId не найдена." : "flowInstanceId ещё не наблюдался; сессия недоступна."));
    }
    return card;
  }

  async function renderSessionTab(session, tabs, content, key, file) {
    for (const button of tabs.querySelectorAll("[data-session-tab]")) button.setAttribute("aria-selected", String(button.dataset.sessionTab === key));
    const pre = element("pre");
    content.replaceChildren(pre);
    if (!file) {
      pre.textContent = "Поток событий не сохраняется; вкладка доступна только как явное состояние unavailable.";
      return;
    }
    if (!session.files.includes(file)) {
      pre.textContent = `${file}: файл отсутствует в session snapshot.`;
      return;
    }
    pre.textContent = `${file}: загрузка…`;
    try {
      const path = `/api/sessions/${encodeURIComponent(session.flowUuid)}/${encodeURIComponent(session.attemptUuid)}/${encodeURIComponent(file)}`;
      const response = await fetch(path, { headers: { accept: "application/json" } });
      const result = await response.json();
      pre.textContent = response.ok && result.available === true
        ? `${result.content}${result.truncated ? "\n\n[Содержимое ограничено сервером]" : ""}`
        : `${file}: ${result.reason || `HTTP ${response.status}`}`;
    } catch {
      pre.textContent = `${file}: загрузка недоступна.`;
    }
  }

  function filterJournal() {
    const query = document.getElementById("journal-search").value.trim().toLowerCase();
    for (const card of document.querySelectorAll("#journal .event-card")) card.hidden = Boolean(query && !card.dataset.search.includes(query));
  }
  document.getElementById("journal-search").addEventListener("input", filterJournal);

  function renderLocks(snapshot) {
    if (!snapshot.controller.activeWork.length) {
      replace("locks-panel", empty("Активных per-ticket locks нет. На human gate блокировка освобождается."));
      return;
    }
    const list = element("div", "row-list");
    for (const ref of snapshot.controller.activeWork) {
      const observation = snapshot.controller.tickets.find((ticket) => ticket.provider === ref.provider && ticket.repository === ref.repository && ticket.number === ref.number);
      list.append(dataRow(`${ref.provider}:${ref.repository}#${ref.number}`, observation?.stateId ? `holder: ${observation.stateId}` : "holder state недоступен"));
    }
    replace("locks-panel", list);
  }

  function renderConfiguration(snapshot) {
    const source = document.getElementById("configuration-source");
    const sourceMain = element("div");
    sourceMain.append(element("small", "", "Источник конфигурации"), element("code", "", `${snapshot.configuration.repository} · ${snapshot.configuration.stackPath}`));
    const revision = element("div", "revision");
    revision.append(element("span", "", "pinned revision"), document.createElement("br"), element("strong", "", snapshot.configuration.revision), document.createElement("br"), element("span", "", "read-only"));
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
      configPanel("Stack", [["kind", stack.kind], ["flow", stack.spec.flow], ["catalog", stack.spec.catalog], ["contracts", stack.spec.contracts.join(", ")], ["schemas", stack.spec.schemas.join(", ")]]),
      configPanel("Flow", [["id", flow.metadata.id], ["activationLabel", flow.metadata.activationLabel], ["managedLabel", flow.metadata.managedLabel], ["initial", flow.spec.initial], ["states", Object.keys(flow.spec.states).length]]),
      configPanel("AgentCatalog", [["kind", snapshot.catalog.kind], ["agents", Object.keys(snapshot.catalog.agents).join(", ")], ["source", stack.spec.catalog]]),
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
      "credential path: не возвращается dashboard API",
    ]));
    for (const harness of snapshot.runtime.execution.harnesses) {
      const users = Object.entries(snapshot.runtime.execution.agents).filter(([, execution]) => execution.harness === harness).map(([agent]) => agent);
      resources.push(resource(harness, snapshot.preflight.harnesses.includes(harness) ? "ready" : "unavailable", [`agents: ${users.join(", ") || "нет"}`, "secret path: не возвращается dashboard API"]));
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
      summary.append(element("span", "mono", agentId), element("span", "tag", execution ? `${execution.harness} · ${execution.maxAttempts} × ${execution.timeoutSeconds} с` : "execution binding недоступен"));
      const body = element("div", "agent-body");
      body.append(definitionList([
        ["package", catalog.package], ["harness", execution?.harness || "Недоступно"], ["model", execution?.model || "Недоступно"],
        ["reasoning", execution?.reasoning || "Недоступно"], ["maxAttempts", execution?.maxAttempts ?? "Недоступно"],
        ["delaySeconds", execution?.delaySeconds ?? "Недоступно"], ["timeoutSeconds", execution?.timeoutSeconds ?? "Недоступно"],
        ["states", states.map(([id]) => id).join(", ") || "Нет"],
        ["resultContract", states.map(([, state]) => state.resultContract || "none").join(", ") || "Нет"],
        ["context", [...new Set(states.flatMap(([, state]) => state.context || []))].join(", ") || "Нет"],
      ]));
      details.append(summary, body);
      agents.push(details);
    }
    replace("agents", ...(agents.length ? agents : [empty("В pinned AgentCatalog нет агентов.")]));
  }

  function renderGraph(flow, revision) {
    document.getElementById("flow-revision").textContent = `pinned · ${revision}`;
    const graph = document.getElementById("flow-graph");
    const title = svg("title", { id: "flow-graph-title" }, `Граф состояний ${flow.metadata.id}`);
    const positions = graphPositions(Object.keys(flow.spec.states));
    const edges = [];
    for (const [sourceId, state] of Object.entries(flow.spec.states)) {
      const source = positions[sourceId];
      for (const [eventName, transition] of Object.entries(state.on ?? {})) {
        const target = transition.target === "$resume" ? source : positions[transition.target];
        if (!target) continue;
        let edge;
        if (target === source) {
          edge = svg("path", { class: "flow-edge", fill: "none", d: `M ${source.x + 75} ${source.y} C ${source.x + 30} ${source.y - 48}, ${source.x + 120} ${source.y - 48}, ${source.x + 75} ${source.y}` });
        } else {
          edge = svg("line", { class: "flow-edge", x1: source.x + 75, y1: source.y + 33, x2: target.x + 75, y2: target.y + 33 });
        }
        edge.append(svg("title", {}, `${sourceId}: ${eventName} → ${transition.target}`));
        edges.push(edge);
      }
    }
    const nodes = Object.entries(flow.spec.states).map(([id, state]) => graphNode(id, state, positions[id], () => selectNode(flow, id)));
    graph.replaceChildren(title, ...edges, ...nodes);
    selectNode(flow, flow.spec.initial);
  }

  function graphPositions(ids) {
    const known = {
      assessment: [45, 75], "assessment-review": [260, 75], planning: [475, 75], "plan-review": [690, 75], development: [905, 75],
      review: [690, 272], "awaiting-merge": [905, 272], "needs-human": [260, 450], blocked: [690, 540], done: [905, 432], cancelled: [475, 450],
    };
    return Object.fromEntries(ids.map((id, index) => {
      const [x, y] = known[id] || [45 + (index % 5) * 215, 75 + Math.floor(index / 5) * 160];
      return [id, { x, y }];
    }));
  }

  function graphNode(id, state, position, select) {
    const node = svg("g", { class: "flow-node", transform: `translate(${position.x} ${position.y})`, tabindex: "0", role: "button", "data-node": id, "data-kind": state.kind, "aria-label": `State ${id}, ${state.kind}` });
    node.append(svg("rect", { width: "150", height: "66" }), svg("text", { x: "14", y: "27" }, id), svg("text", { class: "sub", x: "14", y: "46" }, `${state.kind}${state.agent ? ` · ${state.agent}` : ""}`));
    node.addEventListener("click", select);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
    });
    return node;
  }

  function selectNode(flow, id) {
    for (const node of document.querySelectorAll(".flow-node")) node.classList.toggle("active", node.dataset.node === id);
    const state = flow.spec.states[id];
    document.getElementById("node-kind").textContent = state.kind;
    const inspector = document.getElementById("node-inspector");
    const title = element("h3", "inspector-title", id);
    const values = definitionList([["agent", state.agent || "Не настроен"], ["resultContract", state.resultContract || "Не настроен"], ["context", state.context?.join(", ") || "Не настроен"]]);
    const transitions = element("ul", "inspector-list");
    const configured = Object.entries(state.on ?? {});
    if (!configured.length) transitions.append(element("li", "", "Переходов нет."));
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

  groupSelect.addEventListener("change", updateDraftFields);
  fieldSelect.addEventListener("change", updateDraftValue);
  agentSelect.addEventListener("change", updateDraftValue);

  function configureWizard(snapshot) {
    agentSelect.replaceChildren(...Object.keys(snapshot.runtime.execution.agents).map((agent) => option(agent, agent)));
    setWizardEnabled(true, "");
    updateDraftFields();
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
    bounds.textContent = `${definition.exclusiveMin ? ">" : "min"} ${definition.min}${definition.max === undefined ? "" : ` · max ${definition.max}`}${definition.integer ? " · целое" : ""}`;
    draftError.textContent = "";
  }

  function validateDraft() {
    const definition = fields[groupSelect.value][fieldSelect.value];
    const value = Number(valueInput.value);
    const valid = Number.isFinite(value)
      && (definition.exclusiveMin ? value > definition.min : value >= definition.min)
      && (definition.max === undefined || value <= definition.max)
      && (!definition.integer || Number.isInteger(value));
    draftError.textContent = valid ? "" : `Значение не соответствует RuntimeConfig schema: ${bounds.textContent}.`;
    return valid;
  }

  function buildDraft() {
    const definition = fields[groupSelect.value][fieldSelect.value];
    const agent = groupSelect.value === "agent" ? agentSelect.value : null;
    const path = definition.path.map((part) => part === "$agent" ? agent : part);
    const current = path.reduce((value, key) => value?.[key], dashboard.runtime);
    const value = Number(valueInput.value);
    const summary = definitionList([["Файл", "/etc/agent-flow/runtime.yaml"], ["Поле", path.join(".")], ["Текущее значение", current], ["Новое значение", value]]);
    replace("change-summary", ...summary.children);
    const lines = [];
    path.forEach((part, index) => lines.push(`${"  ".repeat(index)}${part}:${index === path.length - 1 ? ` ${value}` : ""}`));
    document.getElementById("yaml-output").value = `${lines.join("\n")}\n`;
    document.getElementById("copy-status").textContent = "";
  }

  document.getElementById("wizard-next").addEventListener("click", () => {
    if (wizardStep === 1 && !validateDraft()) return;
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
      document.getElementById("copy-status").textContent = "YAML скопирован.";
    } catch {
      output.select();
      const copied = document.execCommand("copy");
      document.getElementById("copy-status").textContent = copied ? "YAML скопирован." : "Не удалось скопировать YAML. Выделите текст вручную.";
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
    field.append(element("small", "", label), element("strong", "", value));
    return field;
  }

  function dataRow(label, value) {
    const row = element("div", "data-row");
    row.append(element("strong", "", label), element("span", "", value));
    return row;
  }

  function definitionList(values) {
    const list = element("dl", "kv-list");
    for (const [key, value] of values) list.append(element("dt", "", key), element("dd", "", value));
    return list;
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
    return Number.isNaN(date.valueOf()) ? unavailable : date.toLocaleString("ru-RU");
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
