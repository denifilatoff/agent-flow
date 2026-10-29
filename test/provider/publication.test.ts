import assert from "node:assert/strict";
import test from "node:test";

import { electOwner, parsePublication, renderPublication } from "../../src/provider/publication.ts";

test("first publication wins regardless of discovery order", () => {
  const metadata = { config: "a".repeat(40), controller: "11111111-1111-4111-8111-111111111111" };
  assert.deepEqual(parsePublication(renderPublication(metadata)), { kind: "current", metadata });
  const first = { key: "a", createdAt: "2026-09-04T10:00:00Z", metadata };
  const second = { ...first, key: "b", metadata: { ...metadata,
    controller: "22222222-2222-4222-8222-222222222222" } };
  assert.equal(electOwner([second, first])?.metadata.controller, metadata.controller);
  assert.equal(electOwner([first, second])?.key, first.key);
});

test("renders metadata in the canonical field order", () => {
  const metadata = { controller: "11111111-1111-4111-8111-111111111111", config: "a".repeat(40) };
  assert.equal(
    renderPublication(metadata),
    '<!-- agent-flow:v1 {"config":"' + "a".repeat(40) + '","controller":"11111111-1111-4111-8111-111111111111"} -->',
  );
});

test("C13 rejects unknown fields and malformed metadata", () => {
  const controller = "11111111-1111-4111-8111-111111111111";
  const valid = renderPublication({ config: "a".repeat(40), controller });
  for (const body of [
    valid.replace(`"controller":"${controller}"`, `"controller":"${controller}","extra":"value"`),
    valid.replace("a".repeat(40), "A".repeat(40)),
    valid.replace(controller, "not-a-uuid"),
    valid.replace(`"config":"${"a".repeat(40)}"`, `"config":"${"b".repeat(40)}","extra":null`),
  ]) {
    assert.equal(parsePublication(body).kind, "invalid");
  }
});

test("distinguishes unmarked, legacy, malformed, and duplicate markers", () => {
  const current = renderPublication({ config: "a".repeat(40), controller: "11111111-1111-4111-8111-111111111111" });
  assert.deepEqual(parsePublication("ordinary comment"), { kind: "unmarked" });
  assert.deepEqual(parsePublication(`> ${current}`), { kind: "unmarked" });
  assert.deepEqual(parsePublication("```markdown\n" + current + "\n```"), { kind: "unmarked" });
  assert.deepEqual(parsePublication("<!-- agent-flow:v1 flow=x attempt=y artifact=plan -->"), { kind: "legacy" });
  assert.deepEqual(parsePublication("<!-- agent-flow-control:v1 -->\n```json\n{}\n```"), { kind: "legacy" });
  assert.deepEqual(parsePublication(current.replace(" -->", "")), { kind: "invalid" });
  assert.deepEqual(parsePublication(`${current}\n${current}`), { kind: "invalid" });
  assert.deepEqual(parsePublication(`${current}\n<!-- agent-flow:v1 flow=x -->`), { kind: "invalid" });
  assert.deepEqual(parsePublication(`<!-- agent-flow-control:v1 --> ${current}`), { kind: "invalid" });
});

test("ignores quoted and fenced examples while parsing standalone markers", () => {
  const current = renderPublication({ config: "a".repeat(40), controller: "11111111-1111-4111-8111-111111111111" });
  const body = `> Example: ${current}\n\n\`\`\`markdown\n${current}\n\`\`\`\n\n${current}`;
  assert.deepEqual(parsePublication(body), {
    kind: "current",
    metadata: { config: "a".repeat(40), controller: "11111111-1111-4111-8111-111111111111" },
  });
});

test("C19 validates timestamps and applies the equal-time publication-key ordering", () => {
  const metadata = { config: "a".repeat(40), controller: "11111111-1111-4111-8111-111111111111" };
  assert.throws(
    () => electOwner([{ key: "bad", createdAt: "not-a-timestamp", metadata }]),
    /createdAt must be a valid timestamp/,
  );
  const older = { key: "z", createdAt: "2026-09-04T09:00:00Z", metadata };
  const newer = { key: "a", createdAt: "2026-09-04T10:00:00Z", metadata };
  assert.equal(electOwner([newer, older])?.key, older.key);
  assert.equal(electOwner([{ ...older, key: "b" }, older])?.key, "b");
});
