import assert from "node:assert/strict";
import test from "node:test";
import { parseDocumentation, renderDocumentation } from "../../src/provider/documentation.ts";

const report = { change: 31, inputHead: "a".repeat(40), resultHead: "b".repeat(40) };

test("documentation metadata round trips edited and no-op reports", () => {
  for (const resultHead of [report.inputHead, report.resultHead]) {
    const value = { ...report, resultHead };
    assert.deepEqual(parseDocumentation(`Report.\n${renderDocumentation(value)}\nChecks passed.`), value);
  }
});

test("documentation metadata rejects malformed, duplicate, and quoted evidence", () => {
  const line = renderDocumentation(report);
  for (const body of ["", `${line}\n${line}`, `> ${line}`, `\`\`\`\n${line}\n\`\`\``,
    line.replace('"change":31', '"change":0'), line.replace('"change":31', '"change":1.5'),
    line.replace(report.inputHead, "short"), line.replace('"inputHead":', '"unknown":'),
    line.replace('"change":31', '"extra":true,"change":31'), `${line} trailing`,
    line.replace("v1", "v2"), '<!-- agent-flow-documentation:v1 broken -->',
  ]) assert.equal(parseDocumentation(body), null, body);
  assert.throws(() => renderDocumentation({ ...report, change: -1 }));
});
