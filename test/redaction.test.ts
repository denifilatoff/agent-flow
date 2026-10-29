import assert from "node:assert/strict";
import test from "node:test";

import { createStartupRedactor } from "../src/redaction.ts";

test("redacts startup secrets and their common literal encodings", () => {
  const redactor = createStartupRedactor();
  const provider = "provider token+/=42";
  const access = "harness access \\\"token+/=";
  const refresh = "refresh-token-9f3d";
  redactor.register(provider);
  redactor.register(Buffer.from(JSON.stringify({ access, nested: { refresh }, short: "id" }) + "\n"));

  for (const secret of [provider, access, refresh]) {
    for (const encoded of [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (value) => value.toLowerCase()),
      new URLSearchParams({ value: secret }).toString().slice("value=".length),
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("base64").replace(/=+$/, ""),
      Buffer.from(secret).toString("base64").replaceAll("+", "-").replaceAll("/", "_"),
      Buffer.from(secret).toString("base64url"),
      Buffer.from(secret).toString("hex"),
      Buffer.from(secret).toString("hex").toUpperCase(),
    ]) {
      assert.equal(redactor.redact(`before:${encoded}:after`), "before:[REDACTED]:after", encoded);
    }
  }
  assert.equal(redactor.redact("short=id"), "short=[REDACTED]");
  const mixedPercent = encodeURIComponent(access).replace(/%([0-9A-F])([0-9A-F])/g, (_value, first, second) =>
    `%${first.toLowerCase()}${second}`);
  assert.equal(redactor.redact(`before:${mixedPercent}:after`), "before:[REDACTED]:after");
  assert.equal(JSON.stringify(redactor).includes(provider), false);
});

test("redacts the longest mixed-case percent encoding before overlapping literals", () => {
  const redactor = createStartupRedactor();
  redactor.register(Buffer.from(JSON.stringify({ token: "abc/def+ghi", suffix: "def" })));

  assert.equal(redactor.redact("abc%2fdef%2Bghi"), "[REDACTED]");
});

test("rejects excessive source strings without leaving partial coverage", () => {
  const redactor = createStartupRedactor();
  redactor.register("retained-secret");

  assert.throws(
    () => redactor.register(Buffer.from(JSON.stringify(Array.from({ length: 300 }, (_, index) => `value-${index}`)))),
    /redaction limits exceeded/,
  );
  assert.equal(redactor.redact("retained-secret"), "[REDACTED]");
  assert.equal(redactor.redact("value-0"), "value-0");
});

test("rejects excessive generated literals and total literal bytes", () => {
  const literals = createStartupRedactor();
  assert.throws(() => {
    for (let index = 0; index < 300; index += 1) {
      literals.register(`secret ${index}+/=\\"${index.toString(16).padStart(4, "0")}`);
    }
  }, /redaction limits exceeded/);

  const bytes = createStartupRedactor();
  assert.throws(() => {
    for (let index = 0; index < 16; index += 1) bytes.register(`${index}:${"x".repeat(65_000)}`);
  }, /redaction limits exceeded/);
});
