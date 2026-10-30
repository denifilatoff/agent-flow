import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMigrationRequest,
  isMigrationCommand,
} from "../../src/runtime/migration-request.ts";
test("migration commands accept reordered options and reject malformed flags without becoming human input", () => {
  assert.deepEqual(
    parseMigrationRequest(
      "/agent-flow migrate --resume-from planning --to latest --pr 8",
    ),
    { pr: 8, to: "latest", resume: "planning" },
  );
  for (const s of [
    "--pr 0 --to latest",
    "--pr 8 --to latest --to x",
    "--pr 8",
    "--pr 8 --to HEAD~1",
    "--pr 8 --to latest --what x",
  ]) {
    const body = "/agent-flow migrate " + s;
    assert.equal(isMigrationCommand(body), true);
    assert.throws(() => parseMigrationRequest(body));
  }
  assert.equal(parseMigrationRequest("ordinary answer"), null);
});
