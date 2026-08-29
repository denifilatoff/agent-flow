import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import test from "node:test";

import {
  loadPinnedConfig,
  normalizeConfigurationSource,
  prepareConfigurationRepository,
  configurationGitAuthentication,
  resolveRevision,
} from "../../src/config/repository.ts";

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

test("uses an exact cached revision when the configuration remote is unavailable", async (t) => {
  const repo = await TestRepository.create();
  const data = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  const unavailable = `${repo.path}-unavailable`;
  t.after(async () => Promise.all([
    rm(unavailable, { recursive: true, force: true }),
    rm(data, { recursive: true, force: true }),
  ]));
  const source = pathToFileURL(repo.path).href;
  const prepared = await prepareConfigurationRepository(source, data);
  const revision = await repo.head();
  await rename(repo.path, unavailable);

  const cached = await prepareConfigurationRepository(source, data);
  assert.equal((await loadPinnedConfig(cached.repository, data, revision)).revision, revision);
  assert.equal(cached.repository, prepared.repository);
});

test("restores a mutated materialization after its pinned commit is pruned from the mirror", async (t) => {
  const repo = await TestRepository.create();
  const data = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  t.after(async () => Promise.all([rm(repo.path, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]));
  const source = pathToFileURL(repo.path).href;
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
  const catalogPath = join(data, "config", pinned.revision, "config/agents.yaml");
  const expectedCatalog = await readFile(catalogPath, "utf8");
  await writeFile(catalogPath, "spoofed: true\n");

  const restored = await loadPinnedConfig(prepared.repository, data, pinned.revision);
  assert.equal(restored.revision, pinned.revision);
  assert.equal(await readFile(catalogPath, "utf8"), expectedCatalog);
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

test("restores a materialization rewritten through a Git replacement ref", async (t) => {
  const repo = await TestRepository.create();
  const data = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  t.after(async () => Promise.all([rm(repo.path, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]));
  const pinned = await loadPinnedConfig(repo.path, data);
  await repo.commitChangedFlow();
  const replacement = await repo.head();
  const materialized = join(data, "config", pinned.revision);
  const objectStore = join(materialized, ".source.git");
  const flowPath = join(materialized, "config/flows/development.yaml");
  const expectedFlow = await readFile(flowPath, "utf8");
  await exec("git", ["-C", objectStore, "fetch", repo.path, replacement]);
  await exec("git", ["-C", objectStore, "replace", pinned.revision, replacement]);
  await cp(join(repo.path, "config/flows/development.yaml"), flowPath);

  const restored = await loadPinnedConfig(repo.path, data, pinned.revision);
  assert.equal(restored.revision, pinned.revision);
  assert.equal(await readFile(flowPath, "utf8"), expectedFlow);
});

test("rejects a loose Git object whose bytes do not match its object ID", async (t) => {
  const repo = await TestRepository.create();
  const data = await mkdtemp(join(tmpdir(), "agent-flow-config-data-"));
  t.after(async () => Promise.all([rm(repo.path, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]));
  const pinned = await loadPinnedConfig(repo.path, data);
  const materialized = join(data, "config", pinned.revision);
  const objectStore = join(materialized, ".source.git");
  const path = "config/flows/development.yaml";
  const objectId = (await exec("git", ["--no-replace-objects", "-C", objectStore, "rev-parse", `${pinned.revision}:${path}`])).stdout.trim();
  const original = await readFile(join(materialized, path), "utf8");
  const spoofed = original.replace("id: development", "id: spoofed-development");
  assert.notEqual(spoofed, original);
  const loose = join(objectStore, "objects", objectId.slice(0, 2), objectId.slice(2));
  await mkdir(join(objectStore, "objects", objectId.slice(0, 2)), { recursive: true });
  await rm(loose, { force: true });
  await writeFile(loose, deflateSync(Buffer.concat([
    Buffer.from(`blob ${Buffer.byteLength(spoofed)}\0`),
    Buffer.from(spoofed),
  ])));
  await writeFile(join(materialized, path), spoofed);

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
  const enterprise = configurationGitAuthentication("https://github.enterprise.test/config.git", {
    provider: "github", name: "GH_ENTERPRISE_TOKEN", value: "mounted-token",
    apiUrl: "https://github.enterprise.test/api/v3",
  });
  assert.match(enterprise.arguments.join(" "), /gh auth git-credential/);
  assert.equal(enterprise.environment.GH_ENTERPRISE_TOKEN, "mounted-token");
  const enterpriseCloud = configurationGitAuthentication("https://example.ghe.com/config.git", {
    provider: "github", name: "GH_TOKEN", value: "mounted-token",
    apiUrl: "https://api.example.ghe.com",
  });
  assert.match(enterpriseCloud.arguments.join(" "), /gh auth git-credential/);
  assert.equal(enterpriseCloud.environment.GH_TOKEN, "mounted-token");
  assert.equal(JSON.stringify(configurationGitAuthentication("https://other.test/config.git", {
    provider: "github", name: "GH_ENTERPRISE_TOKEN", value: "mounted-token",
    apiUrl: "https://github.enterprise.test/api/v3",
  })).includes("mounted-token"), false);
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
