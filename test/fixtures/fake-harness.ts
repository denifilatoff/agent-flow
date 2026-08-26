import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const [tool, ...args] = process.argv.slice(2);

if (tool === "gh" || tool === "glab") {
  if (args[0] === "repo" && args[1] === "clone") clone(args[2]!, args[3]!);
  process.exit(0);
}

if (tool === "apm") {
  if (args[0] === "compile") await compile(args.at(-1)!);
  process.exit(0);
}

if (tool === "codex" || tool === "claude") {
  const contextPath = process.env.AGENT_FLOW_CONTEXT_PATH;
  const receiptPath = process.env.AGENT_FLOW_RECEIPT_PATH;
  if (!contextPath || !receiptPath) process.exit(0);
  const context = JSON.parse(await readFile(contextPath, "utf8")) as {
    ticket: { repository: { cloneRoot: string } };
    controlState: { attemptSeries: { current: { attemptId: string } } };
  };
  const endpoint = new URL("/__fixture/attempt", context.ticket.repository.cloneRoot);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(context),
  });
  if (!response.ok) {
    console.error(await response.text());
    process.exit(2);
  }
  const result = await response.json() as { mode: string; receipt?: unknown };
  if (result.mode === "exit-failure") process.exit(1);
  if (result.receipt) await writeFile(receiptPath, `${JSON.stringify(result.receipt)}\n`, { mode: 0o600 });
  const completed = () => fetch(new URL("/__fixture/completed", endpoint), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attemptId: context.controlState.attemptSeries.current.attemptId }),
  }).catch(() => undefined);
  if (result.mode === "block" || result.mode === "late") {
    await new Promise<void>(() => {
      const keepAlive = setInterval(() => undefined, 1_000);
      process.once("SIGTERM", () => {
        clearInterval(keepAlive);
        void completed().finally(() => process.exit(0));
      });
    });
  }
  await completed();
  process.exit(0);
}

process.exit(2);

function clone(url: string, destination: string): void {
  execFileSync("git", ["init", destination]);
  execFileSync("git", ["-C", destination, "config", "user.email", "fixture@example.test"]);
  execFileSync("git", ["-C", destination, "config", "user.name", "Fixture"]);
  execFileSync("git", ["-C", destination, "remote", "add", "origin", url]);
  execFileSync("git", ["-C", destination, "commit", "--allow-empty", "-m", "fixture"]);
}

async function compile(target: string): Promise<void> {
  const source = await readFile(join(process.cwd(), "apm.yml"), "utf8");
  const id = /^name:\s*([a-z][a-z0-9-]*)$/m.exec(source)?.[1] ?? basename(process.cwd());
  if (target === "claude") {
    await mkdir(join(process.cwd(), ".claude/agents"), { recursive: true });
    await writeFile(join(process.cwd(), "CLAUDE.md"), "Fixture root instructions.\n");
    await writeFile(
      join(process.cwd(), ".claude/agents", `${id}.md`),
      `---\nname: ${id}\n---\nFixture ${id} instructions.\n`,
    );
  } else {
    await mkdir(join(process.cwd(), ".codex/agents"), { recursive: true });
    await writeFile(join(process.cwd(), "AGENTS.md"), "Fixture root instructions.\n");
    await writeFile(
      join(process.cwd(), ".codex/agents", `${id}.toml`),
      `name = ${JSON.stringify(id)}\ndeveloper_instructions = ${JSON.stringify(`Fixture ${id} instructions.`)}\n`,
    );
  }
}
