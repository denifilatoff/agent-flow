import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  WorkspaceManager,
  type CommandRunner,
} from "../../src/runtime/workspaces.ts";
import type { ProviderRepository, TicketRef } from "../../src/provider/types.ts";

const execFile = promisify(execFileCallback);
const FLOW_1 = "11111111-1111-4111-8111-111111111111";
const FLOW_2 = "22222222-2222-4222-8222-222222222222";
const REPOSITORY: ProviderRepository = {
  provider: "github",
  name: "owner/repo",
  host: "github.example.test",
  cloneUrl: "https://github.example.test/owner/repo.git",
};

function ticket(number: number, repository = REPOSITORY.name): TicketRef {
  return { provider: "github", repository, number };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd })).stdout.trim();
}

async function fixture(): Promise<{
  root: string;
  data: string;
  source: string;
  run: CommandRunner;
  cloneCommands: Array<{ file: string; args: string[] }>;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-workspaces-"));
  const source = join(root, "source");
  const data = join(root, "data");
  await mkdir(source);
  await git(source, "init");
  await git(source, "config", "user.name", "Agent Flow Test");
  await git(source, "config", "user.email", "agent-flow@example.test");
  await writeFile(join(source, "README.md"), "fixture\n");
  await git(source, "add", "README.md");
  await git(source, "commit", "-m", "fixture");

  const cloneCommands: Array<{ file: string; args: string[] }> = [];
  const run: CommandRunner = async (file, args, options = {}) => {
    if (file === "gh" || file === "glab") {
      cloneCommands.push({ file, args: [...args] });
      assert.deepEqual(args.slice(0, 2), ["repo", "clone"]);
      await execFile("git", ["clone", source, args[3]!]);
      await execFile("git", ["remote", "set-url", "origin", args[2]!], {
        cwd: args[3],
      });
      return { stdout: "", stderr: "" };
    }
    return execFile(file, args, options);
  };
  return { root, data, source, run, cloneCommands };
}

test("different tickets never share a worktree", async (t) => {
  const { root, data, run, cloneCommands } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WorkspaceManager(data, run);

  const first = await manager.prepareWorkspace(REPOSITORY, ticket(1), FLOW_1);
  const second = await manager.prepareWorkspace(REPOSITORY, ticket(2), FLOW_2);

  assert.notEqual(first.worktree, second.worktree);
  assert.equal(await git(first.worktree, "remote", "get-url", "origin"), REPOSITORY.cloneUrl);
  assert.equal(await git(second.worktree, "remote", "get-url", "origin"), REPOSITORY.cloneUrl);
  assert.equal(first.baseClone, second.baseClone);
  assert.deepEqual(cloneCommands, [{
    file: "gh",
    args: ["repo", "clone", REPOSITORY.cloneUrl, first.baseClone],
  }]);
});

test("concurrent tickets create one base clone", async (t) => {
  const { root, data, run, cloneCommands } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WorkspaceManager(data, run);

  const [first, second] = await Promise.all([
    manager.prepareWorkspace(REPOSITORY, ticket(1), FLOW_1),
    manager.prepareWorkspace(REPOSITORY, ticket(2), FLOW_2),
  ]);

  assert.equal(first.baseClone, second.baseClone);
  assert.equal(cloneCommands.length, 1);
});

test("concurrent prepares for one flow share the bound worktree", async (t) => {
  const { root, data, run } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WorkspaceManager(data, run);

  const [first, second] = await Promise.all([
    manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1),
    manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1),
  ]);

  assert.equal(second.worktree, first.worktree);
  assert.equal(JSON.parse(await readFile(`${first.worktree}.json`, "utf8")).ticketNumber, 7);
});

test("a concurrent different-ticket loser preserves the winner binding", async (t) => {
  const { root, data, run } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WorkspaceManager(data, run);

  const [winner, loser] = await Promise.allSettled([
    manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1),
    manager.prepareWorkspace(REPOSITORY, ticket(8), FLOW_1),
  ]);

  assert.equal(winner.status, "fulfilled");
  assert.equal(loser.status, "rejected");
  const workspace = await manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1);
  assert.equal(JSON.parse(await readFile(`${workspace.worktree}.json`, "utf8")).ticketNumber, 7);
});

test("reserves exact ticket identity before adding the worktree", async (t) => {
  const { root, data, run } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkingRun: CommandRunner = async (file, args, options = {}) => {
    if (file === "git" && args.slice(0, 3).join(" ") === "worktree add --detach") {
      const binding = JSON.parse(await readFile(`${args[3]}.json`, "utf8"));
      assert.equal(binding.ticketNumber, 7);
      assert.equal(binding.name, REPOSITORY.name);
      assert.equal(binding.flowInstanceId, FLOW_1);
    }
    return run(file, args, options);
  };

  await new WorkspaceManager(data, checkingRun).prepareWorkspace(REPOSITORY, ticket(7), FLOW_1);
});

test("sequential attempts for one flow reuse its bound worktree", async (t) => {
  const { root, data, run } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WorkspaceManager(data, run);
  const first = await manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1);
  await writeFile(join(first.worktree, "attempt.txt"), "kept\n");

  const second = await manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1);

  assert.equal(second.worktree, first.worktree);
  assert.equal(await readFile(join(second.worktree, "attempt.txt"), "utf8"), "kept\n");
});

test("rejects a flow path bound to another ticket", async (t) => {
  const { root, data, run } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WorkspaceManager(data, run);
  await manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1);

  await assert.rejects(
    manager.prepareWorkspace(REPOSITORY, ticket(8), FLOW_1),
    /workspace binding mismatch/,
  );
});

test("rejects a reused worktree whose origin identity changed", async (t) => {
  const { root, data, run } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WorkspaceManager(data, run);
  const workspace = await manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1);
  await git(workspace.worktree, "remote", "set-url", "origin", "https://github.example.test/other/repo.git");

  await assert.rejects(
    manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1),
    /repository identity mismatch/,
  );
});

test("recovers after post-create validation fails", async (t) => {
  const { root, data, run } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  let failWorktreeOrigin = true;
  const failingRun: CommandRunner = async (file, args, options = {}) => {
    if (
      failWorktreeOrigin &&
      file === "git" &&
      args.join(" ") === "remote get-url origin" &&
      options.cwd?.includes(`/worktrees/${FLOW_1}`)
    ) {
      failWorktreeOrigin = false;
      return { stdout: "https://github.example.test/other/repo.git\n", stderr: "" };
    }
    return run(file, args, options);
  };
  const manager = new WorkspaceManager(data, failingRun);

  await assert.rejects(
    manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1),
    /repository identity mismatch/,
  );
  const workspace = await manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1);

  assert.equal(await git(workspace.worktree, "remote", "get-url", "origin"), REPOSITORY.cloneUrl);
});

test("resumes an exact binding reservation after a crash", async (t) => {
  const { root, data, run } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WorkspaceManager(data, run);
  const first = await manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1);
  await git(first.baseClone, "worktree", "remove", "--force", first.worktree);

  const recovered = await new WorkspaceManager(data, run).prepareWorkspace(REPOSITORY, ticket(7), FLOW_1);

  assert.equal(recovered.worktree, first.worktree);
  assert.equal(JSON.parse(await readFile(`${recovered.worktree}.json`, "utf8")).ticketNumber, 7);
});

test("rejects a missing-binding orphan for another ticket", async (t) => {
  const { root, data, run } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WorkspaceManager(data, run);
  const first = await manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1);
  const bindingPath = `${first.worktree}.json`;
  await rm(bindingPath);

  await assert.rejects(
    manager.prepareWorkspace(REPOSITORY, ticket(8), FLOW_1),
    /workspace binding mismatch/,
  );
  await assert.rejects(readFile(bindingPath), { code: "ENOENT" });
  assert.equal(await readFile(join(first.worktree, ".git"), "utf8").then(() => true), true);
});

test("rejects a symlinked worktree root without writing through it", async (t) => {
  const { root, data, run } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, "outside");
  await mkdir(data, { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(data, "worktrees"), "dir");

  await assert.rejects(
    new WorkspaceManager(data, run).prepareWorkspace(REPOSITORY, ticket(7), FLOW_1),
    /symbolic link/,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("cleanup rejects a symlinked binding before deleting the worktree", async (t) => {
  const { root, data, run } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WorkspaceManager(data, run);
  const workspace = await manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1);
  const bindingPath = `${workspace.worktree}.json`;
  const outsideBinding = join(root, "outside-binding.json");
  await writeFile(outsideBinding, await readFile(bindingPath));
  await rm(bindingPath);
  await symlink(outsideBinding, bindingPath);

  await assert.rejects(
    manager.removeWorkspace(workspace, true, false),
    /symbolic link/,
  );
  assert.equal(await readFile(outsideBinding, "utf8").then(() => true), true);
  assert.equal(await readFile(join(workspace.worktree, ".git"), "utf8").then(() => true), true);
});

test("cleanup rejects a changed repository identity before forced removal", async (t) => {
  const { root, data, run } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WorkspaceManager(data, run);
  const workspace = await manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1);
  await git(workspace.worktree, "remote", "set-url", "origin", "https://github.example.test/other/repo.git");

  await assert.rejects(
    manager.removeWorkspace(workspace, true, false),
    /repository identity mismatch/,
  );
  assert.equal(await readFile(join(workspace.worktree, ".git"), "utf8").then(() => true), true);
});

test("removes a worktree only after terminal state with no running process", async (t) => {
  const { root, data, run } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WorkspaceManager(data, run);
  const workspace = await manager.prepareWorkspace(REPOSITORY, ticket(7), FLOW_1);

  await manager.removeWorkspace(workspace, false, false);
  assert.equal(await readFile(join(workspace.worktree, ".git"), "utf8").then(() => true), true);
  await manager.removeWorkspace(workspace, true, true);
  assert.equal(await readFile(join(workspace.worktree, ".git"), "utf8").then(() => true), true);
  await writeFile(join(workspace.worktree, "untracked.txt"), "terminal diagnostic\n");
  await manager.removeWorkspace(workspace, true, false);
  await assert.rejects(readFile(join(workspace.worktree, ".git")), { code: "ENOENT" });
});

test("accepts a GitLab clone URL below a trusted instance path", async (t) => {
  const { root, data, run } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository: ProviderRepository = {
    provider: "gitlab",
    name: "group/project",
    host: "gitlab.example.test",
    cloneUrl: "https://gitlab.example.test/gitlab/group/project.git",
  };

  const workspace = await new WorkspaceManager(data, run).prepareWorkspace(
    repository,
    { provider: "gitlab", repository: repository.name, number: 9 },
    FLOW_1,
  );

  assert.equal(await git(workspace.worktree, "remote", "get-url", "origin"), repository.cloneUrl);
  await git(
    workspace.worktree,
    "remote",
    "set-url",
    "origin",
    "https://gitlab.example.test/other/group/project.git",
  );
  await assert.rejects(
    new WorkspaceManager(data, run).prepareWorkspace(
      repository,
      { provider: "gitlab", repository: repository.name, number: 9 },
      FLOW_1,
    ),
    /repository identity mismatch/,
  );
});

test("rejects a prefixed GitHub clone path", async (t) => {
  const { root, data, run, cloneCommands } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository: ProviderRepository = {
    ...REPOSITORY,
    cloneUrl: "https://github.example.test/attacker/owner/repo.git",
  };

  await assert.rejects(
    new WorkspaceManager(data, run).prepareWorkspace(repository, ticket(7), FLOW_1),
    /repository identity mismatch/,
  );
  assert.deepEqual(cloneCommands, []);
});

test("rejects noncanonical flow UUIDs", async (t) => {
  const { root, data, run } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WorkspaceManager(data, run);

  await assert.rejects(
    manager.prepareWorkspace(REPOSITORY, ticket(7), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase()),
    /flow instance ID must be a canonical UUID/,
  );
});

test("uses glab for a GitLab repository", async (t) => {
  const { root, data, run, cloneCommands } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository: ProviderRepository = {
    provider: "gitlab",
    name: "group/project",
    host: "gitlab.example.test",
    cloneUrl: "https://gitlab.example.test/group/project.git",
  };
  const manager = new WorkspaceManager(data, run);

  await manager.prepareWorkspace(
    repository,
    { provider: "gitlab", repository: repository.name, number: 9 },
    FLOW_1,
  );

  assert.equal(cloneCommands[0]?.file, "glab");
  assert.equal(cloneCommands[0]?.args[2], repository.cloneUrl);
});
