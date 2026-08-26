import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { loadPinnedConfig } from "../../src/config/repository.ts";

const exec = promisify(execFile);

class TestRepository {
  readonly path: string;

  private constructor(path: string) {
    this.path = path;
  }

  static async create(): Promise<TestRepository> {
    const path = await mkdtemp(join(tmpdir(), "agent-flow-config-repository-"));
    await Promise.all(
      ["config", "schemas/v1", "agent-packages"].map((directory) =>
        cp(join(process.cwd(), directory), join(path, directory), { recursive: true }),
      ),
    );
    await exec("git", ["init", path]);
    await exec("git", ["-C", path, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", path, "config", "user.name", "Test User"]);
    await exec("git", ["-C", path, "add", "."]);
    await exec("git", ["-C", path, "commit", "-m", "initial configuration"]);
    return new TestRepository(path);
  }

  async commitChangedFlow(): Promise<void> {
    const flow = join(this.path, "config/flows/development.yaml");
    await writeFile(flow, (await readFile(flow, "utf8")).replace("development", "changed-development"));
    await exec("git", ["-C", this.path, "add", "config/flows/development.yaml"]);
    await exec("git", ["-C", this.path, "commit", "-m", "change flow"]);
  }
}

test("loads HEAD once and preserves an older requested revision", async (t) => {
  const repo = await TestRepository.create();
  const data = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  t.after(async () => Promise.all([rm(repo.path, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]));

  const first = await loadPinnedConfig(repo.path, data);
  await repo.commitChangedFlow();
  const pinned = await loadPinnedConfig(repo.path, data, first.revision);

  assert.equal(pinned.revision, first.revision);
  assert.equal(pinned.flow.metadata.id, first.flow.metadata.id);
});

test("rejects malformed and missing revisions before materialization", async (t) => {
  const repo = await TestRepository.create();
  const data = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  t.after(async () => Promise.all([rm(repo.path, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]));

  await assert.rejects(loadPinnedConfig(repo.path, data, "not-a-sha"));
  await assert.rejects(loadPinnedConfig(repo.path, data, "0000000000000000000000000000000000000000"));
  await assert.rejects(access(join(data, "config")));
});

test("rejects a symlinked materialization root without writing through it", async (t) => {
  const repo = await TestRepository.create();
  const data = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-flow-config-outside-"));
  t.after(async () => Promise.all([
    rm(repo.path, { recursive: true, force: true }),
    rm(data, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await symlink(outside, join(data, "config"));

  await assert.rejects(loadPinnedConfig(repo.path, data), /config/i);
  assert.deepEqual(await readdir(outside), []);
});
