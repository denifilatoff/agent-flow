import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  loadPinnedConfig,
  normalizeConfigurationSource,
  prepareConfigurationRepository,
} from "../../src/config/repository.ts";
import { createProductionDependencies } from "../../src/main.ts";

const exec = promisify(execFile);

async function resolveHead(repository: string): Promise<string> {
  return (await exec("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
}

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

  async head(): Promise<string> {
    return (await exec("git", ["-C", this.path, "rev-parse", "HEAD"])).stdout.trim();
  }

  async configure(source: string, dataDirectory: string): Promise<void> {
    const controller = join(this.path, "config/controller.example.yaml");
    const contents = (await readFile(controller, "utf8"))
      .replace("repository: /config", `repository: ${source}`)
      .replace("dataDirectory: /data", `dataDirectory: ${dataDirectory}`);
    await writeFile(controller, contents);
    await exec("git", ["-C", this.path, "add", "config/controller.example.yaml"]);
    await exec("git", ["-C", this.path, "commit", "-m", "configure remote source"]);
  }
}

test("clones a remote configuration source and fetches its new HEAD only on a later startup", async (t) => {
  const repo = await TestRepository.create();
  const data = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  t.after(async () => Promise.all([rm(repo.path, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]));
  const source = pathToFileURL(repo.path).href;

  const first = await prepareConfigurationRepository(source, data);
  const firstSha = await resolveHead(first.repository);
  await repo.commitChangedFlow();
  assert.equal(await resolveHead(first.repository), firstSha);

  const second = await prepareConfigurationRepository(source, data);
  assert.equal(second.source, source);
  assert.equal(second.repository, first.repository);
  assert.equal(await resolveHead(second.repository), await repo.head());
  assert.notEqual(await resolveHead(second.repository), firstSha);
  assert.equal((await loadPinnedConfig(second.repository, data, firstSha)).revision, firstSha);
});

test("a production dependency prepares its Git source once per service startup", async (t) => {
  const repo = await TestRepository.create();
  const data = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  t.after(async () => Promise.all([rm(repo.path, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]));
  const source = pathToFileURL(repo.path).href;
  await repo.configure(source, data);
  const dependencies = createProductionDependencies({
    AGENT_FLOW_CONFIG_REPOSITORY: source,
    AGENT_FLOW_DATA_DIRECTORY: data,
  }, 8080);

  const first = await dependencies.loadConfig();
  await repo.commitChangedFlow();
  const sameStartup = await dependencies.loadConfig();

  assert.equal(sameStartup.revision, first.revision);
  assert.notEqual(first.revision, await repo.head());
  const nextStartup = await createProductionDependencies({
    AGENT_FLOW_CONFIG_REPOSITORY: source,
    AGENT_FLOW_DATA_DIRECTORY: data,
  }, 8080).loadConfig();
  assert.equal(nextStartup.revision, await repo.head());
});

test("rejects a configuration mirror with the wrong origin", async (t) => {
  const [first, second] = await Promise.all([TestRepository.create(), TestRepository.create()]);
  const data = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  t.after(async () => Promise.all([
    rm(first.path, { recursive: true, force: true }),
    rm(second.path, { recursive: true, force: true }),
    rm(data, { recursive: true, force: true }),
  ]));
  await prepareConfigurationRepository(pathToFileURL(first.path).href, data);

  await assert.rejects(
    prepareConfigurationRepository(pathToFileURL(second.path).href, data),
    /origin/i,
  );
});

test("rejects a symlinked or incomplete configuration mirror", async (t) => {
  const repo = await TestRepository.create();
  const source = pathToFileURL(repo.path).href;
  const outside = await mkdtemp(join(tmpdir(), "agent-flow-config-outside-"));
  const symlinkData = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  const incompleteData = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  const checkoutData = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  t.after(async () => Promise.all([
    rm(repo.path, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
    rm(symlinkData, { recursive: true, force: true }),
    rm(incompleteData, { recursive: true, force: true }),
    rm(checkoutData, { recursive: true, force: true }),
  ]));
  await symlink(outside, join(symlinkData, "config-repository"));
  await mkdir(join(incompleteData, "config-repository"));
  await exec("git", ["clone", source, join(checkoutData, "config-repository")]);

  await assert.rejects(prepareConfigurationRepository(source, symlinkData), /symbolic link/i);
  await assert.rejects(prepareConfigurationRepository(source, incompleteData), /configuration repository/i);
  await assert.rejects(prepareConfigurationRepository(source, checkoutData), /configuration repository/i);
});

test("rejects unsafe Git URLs and cleans a failed clone without exposing its source", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  assert.throws(() => normalizeConfigurationSource("https://user:secret@example.test/config.git"), /source/i);
  assert.throws(() => normalizeConfigurationSource("ssh://example.test/config.git"), /source/i);

  const source = "file:///definitely-missing-agent-flow-credential-secret";
  await assert.rejects(
    prepareConfigurationRepository(source, data),
    (error: unknown) => error instanceof Error && /clone/i.test(error.message) && !error.message.includes("secret"),
  );
  assert.deepEqual(await readdir(data), []);
});

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
