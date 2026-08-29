import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, css, script] = await Promise.all([
  readFile("src/ui/index.html", "utf8"),
  readFile("src/ui/styles.css", "utf8"),
  readFile("src/ui/app.js", "utf8"),
]);

test("ships the four-screen read-only dashboard contract", () => {
  for (const screen of ["status", "configuration", "flow", "draft"]) {
    assert.match(html, new RegExp(`data-screen="${screen}"`));
    assert.match(html, new RegExp(`data-view="${screen}"`));
  }

  assert.match(script, /fetch\("\/api\/dashboard"/);
  assert.match(script, /agent-flow-admin-view/);
  assert.match(script, /agent-flow-menu-collapsed/);
  assert.match(css, /grid-template-columns:\s*232px minmax\(0, 1fr\)/);
  assert.match(css, /grid-template-columns:\s*48px minmax\(0, 1fr\)/);
  assert.doesNotMatch(html, /Обновить снимок|demo|демонстрац/i);
});

test("keeps the approved visual and responsive constraints", () => {
  const colors = [...`${html}\n${css}`.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(([color]) => color.toLowerCase());
  assert.deepEqual([...new Set(colors)].sort(), ["#27272a", "#71717a", "#969696", "#fafafa", "#ff5a00", "#ffffff"].sort());
  const radii = [...css.matchAll(/border-radius:\s*([^;]+)/g)].map(([, value]) => value.trim());
  assert.ok(radii.every((value) => value === "2px" || value === "var(--radius)"));
  assert.match(css, /--radius:\s*2px/);
  assert.match(css, /min-width:\s*320px/);
  assert.match(css, /overflow-x:\s*(?:hidden|clip)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test("persists refresh settings and exposes safe diagnostic readers", () => {
  for (const seconds of [15, 30, 60, 300]) assert.match(html, new RegExp(`value="${seconds}"`));
  assert.match(html, /value="30" selected/);
  assert.doesNotMatch(html, /value="300" selected/);
  assert.match(script, /agent-flow-auto-refresh/);
  assert.match(script, /agent-flow-refresh-interval/);
  assert.match(script, /flowInstanceId/);
  assert.match(script, /encodeURIComponent/);
  assert.match(script, /harness\.log/);
  assert.match(script, /decision\.json/);
  assert.match(script, /context\.json/);
  assert.match(`${html}\n${script}`, /События/);
  assert.match(script, /Поток событий не сохраняется/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /innerHTML/);
});

test("uses exact observation, lock, and bounded session evidence", () => {
  const lockRenderer = script.slice(script.indexOf("function renderLocks"), script.indexOf("function renderConfiguration"));
  const missingSession = script.slice(script.indexOf("function sessionMissingMessage"), script.indexOf("async function renderSessionTab"));
  assert.match(lockRenderer, /controller\.locks/);
  assert.doesNotMatch(lockRenderer, /activeWork/);
  assert.match(script, /ticket\.stateKind/);
  assert.match(script, /ticket\.configRevision/);
  assert.doesNotMatch(script, /flow\.spec\.states\[ticket\.stateId\]/);
  assert.match(missingSession, /if \(!discovery\.available\).*Список сессий недоступен/);
  assert.match(missingSession, /if \(discovery\.truncated\).*ограниченном snapshot/);
  assert.match(missingSession, /return "Диагностическая сессия для flowInstanceId не найдена\."/);
});

test("preserves wizard input across refresh and invalidates stale previews", () => {
  assert.match(script, /wizardConfigured/);
  assert.match(script, /invalidateDraft/);
  assert.equal(script.match(/fieldSelect\.addEventListener\("change"/g)?.length, 1);
  assert.match(script, /rawValue !== "" && valueInput\.checkValidity\(\)/);
  assert.match(script, /inputValid \? Number\(rawValue\) : Number\.NaN/);
});

test("exposes interactive graph nodes, tabs, and refresh controls accessibly", () => {
  assert.doesNotMatch(html, /<svg[^>]+role="img"/);
  assert.match(script, /button\.setAttribute\("role", "tab"\)/);
  assert.match(script, /aria-controls/);
  assert.match(script, /button\.tabIndex = key === "events" \? 0 : -1/);
  assert.match(script, /content\.setAttribute\("role", "tabpanel"\)/);
  assert.match(script, /content\.setAttribute\("aria-labelledby"/);
  assert.match(script, /ArrowRight/);
  assert.match(script, /ArrowLeft/);
  assert.match(css, /\.auto-refresh label \{[^}]*min-height:\s*44px/);
  assert.match(css, /\.refresh-interval \{[^}]*min-height:\s*44px/);
});

test("builds every flow node and one validated RuntimeConfig field", () => {
  assert.match(script, /createElementNS/);
  assert.match(script, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(script, /Object\.entries\(state\.on \?\? \{\}\)/);
  assert.match(script, /\/etc\/agent-flow\/runtime\.yaml/);
  for (const field of [
    "intervalSeconds", "maxCallsPerMinute", "quotaReservePercent", "concurrency", "port",
    "maxAttempts", "delaySeconds", "timeoutSeconds",
  ]) assert.match(script, new RegExp(field));
  assert.match(script, /min:/);
  assert.match(script, /max:/);
  assert.match(script, /navigator\.clipboard\.writeText/);
  assert.match(script, /document\.execCommand\("copy"\)/);
  assert.doesNotMatch(script, /fetch\([^\n]+method:\s*["'](?:POST|PUT|PATCH|DELETE)/);
});
