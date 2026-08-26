import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  loadPinnedConfig,
  normalizeConfigurationSource,
  prepareConfigurationRepository,
  configurationGitAuthentication,
  resolveRevision,
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

  async replaceHistory(): Promise<void> {
    const branch = (await exec("git", ["-C", this.path, "branch", "--show-current"])).stdout.trim();
    await exec("git", ["-C", this.path, "checkout", "--orphan", "replacement"]);
    await exec("git", ["-C", this.path, "add", "."]);
    await exec("git", ["-C", this.path, "commit", "-m", "replace configuration history"]);
    await exec("git", ["-C", this.path, "branch", "-M", branch]);
    await exec("git", ["-C", this.path, "reflog", "expire", "--expire=now", "--all"]);
    await exec("git", ["-C", this.path, "gc", "--prune=now"]);
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

test("a production dependency retains its verified bundle for the service lifetime", async (t) => {
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
  await rm(join(data, "config", first.revision, ".source.git"), { recursive: true });

  assert.equal((await dependencies.loadConfig()).revision, first.revision);
  await assert.rejects(createProductionDependencies({
    AGENT_FLOW_CONFIG_REPOSITORY: source,
    AGENT_FLOW_DATA_DIRECTORY: data,
  }, 8080).loadConfig());
});

test("a production dependency never caches a bundle that failed runtime validation", async (t) => {
  const repo = await TestRepository.create();
  const data = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  t.after(async () => Promise.all([rm(repo.path, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]));
  const dependencies = createProductionDependencies({
    AGENT_FLOW_CONFIG_REPOSITORY: pathToFileURL(repo.path).href,
    AGENT_FLOW_DATA_DIRECTORY: data,
  }, 8080);

  await assert.rejects(dependencies.loadConfig(), /runtime paths/i);
  await assert.rejects(dependencies.loadConfig(), /runtime paths/i);
});

test("loads a verified materialization after its pinned commit is pruned from the mirror", async (t) => {
  const repo = await TestRepository.create();
  const data = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  t.after(async () => Promise.all([rm(repo.path, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]));
  const source = pathToFileURL(repo.path).href;
  await repo.configure(source, data);
  const prepared = await prepareConfigurationRepository(source, data);
  const pinned = await loadPinnedConfig(prepared.repository, data);

  await repo.replaceHistory();
  await prepareConfigurationRepository(source, data);
  await exec("git", ["-C", prepared.repository, "reflog", "expire", "--expire=now", "--all"]);
  await exec("git", ["-C", prepared.repository, "gc", "--prune=now"]);
  await assert.rejects(resolveRevision(prepared.repository, pinned.revision));

  const recovered = await loadPinnedConfig(prepared.repository, data, pinned.revision);
  assert.equal(recovered.revision, pinned.revision);
  assert.equal(recovered.flow.metadata.id, pinned.flow.metadata.id);
  const productionRecovered = await createProductionDependencies({
    AGENT_FLOW_CONFIG_REPOSITORY: source,
    AGENT_FLOW_CONFIG_REVISION: pinned.revision,
    AGENT_FLOW_DATA_DIRECTORY: data,
  }, 8080).loadConfig();
  assert.equal(productionRecovered.revision, pinned.revision);
  await writeFile(join(data, "config", pinned.revision, "config/agents.yaml"), "spoofed: true\n");
  await assert.rejects(loadPinnedConfig(prepared.repository, data, pinned.revision));
});

test("rejects a marker-only materialization for a pruned revision", async (t) => {
  const repo = await TestRepository.create();
  const data = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  t.after(async () => Promise.all([rm(repo.path, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]));
  const sha = "a".repeat(40);
  const target = join(data, "config", sha);
  await Promise.all(["config", "schemas/v1", "agent-packages"].map((path) => mkdir(join(target, path), { recursive: true })));
  await writeFile(join(target, ".complete"), `${sha}\n`);

  await assert.rejects(loadPinnedConfig(repo.path, data, sha), /revision|materialization/i);
});

test("rejects a materialization rewritten through a Git replacement ref", async (t) => {
  const repo = await TestRepository.create();
  const data = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  t.after(async () => Promise.all([rm(repo.path, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]));
  const pinned = await loadPinnedConfig(repo.path, data);
  await repo.commitChangedFlow();
  const replacement = await repo.head();
  const materialized = join(data, "config", pinned.revision);
  const objectStore = join(materialized, ".source.git");
  await exec("git", ["-C", objectStore, "fetch", repo.path, replacement]);
  await exec("git", ["-C", objectStore, "replace", pinned.revision, replacement]);
  await cp(join(repo.path, "config/flows/development.yaml"), join(materialized, "config/flows/development.yaml"));

  await assert.rejects(loadPinnedConfig(repo.path, data, pinned.revision));
});

test("uses noninteractive GitHub and GitLab credential helpers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-git-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = join(root, "helper");
  await writeFile(helper, `#!/bin/sh
[ "$1 $2" = "auth git-credential" ] || exit 9
cat >/dev/null
printf 'username=fixture\\npassword=fixture-token\\n'
`);
  await chmod(helper, 0o700);

  for (const [source, command] of [
    ["https://github.com/example/config.git", "gh"],
    ["https://gitlab.com/example/config.git", "glab"],
  ] as const) {
    const auth = configurationGitAuthentication(source);
    assert.equal(auth.environment.GIT_TERMINAL_PROMPT, "0");
    const executable = join(root, command);
    await symlink(helper, executable);
    const result = spawnSync("git", [...auth.arguments, "credential", "fill"], {
      input: `protocol=https\nhost=${new URL(source).hostname}\n\n`,
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, ...auth.environment },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /username=fixture/);
    assert.match(result.stdout, /password=fixture-token/);
  }

  assert.deepEqual(configurationGitAuthentication("file:///tmp/config.git").arguments, []);
  assert.deepEqual(configurationGitAuthentication("https://git.example.test/config.git").arguments, []);
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
