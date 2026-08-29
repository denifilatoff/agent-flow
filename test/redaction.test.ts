import assert from "node:assert/strict";
import test from "node:test";

import { createStartupRedactor } from "../src/redaction.ts";

test("redacts startup secrets and their common literal encodings", () => {
  const redactor = createStartupRedactor();
  const provider = "provider-token+/=42";
  const access = "harness access token";
  const refresh = "refresh-token-9f3d";
  redactor.register(provider);
  redactor.register(Buffer.from(JSON.stringify({ access, nested: { refresh }, short: "id" }) + "\n"));

  for (const secret of [provider, access, refresh]) {
    for (const encoded of [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("hex"),
    ]) {
      assert.equal(redactor.redact(`before:${encoded}:after`), "before:[REDACTED]:after", encoded);
    }
  }
  assert.equal(redactor.redact("short=id"), "short=id");
  assert.equal(JSON.stringify(redactor).includes(provider), false);
});
