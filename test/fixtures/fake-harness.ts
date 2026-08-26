import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const [tool, ...args] = process.argv.slice(2);

if (tool === "gh" || tool === "glab") {
  if (args[0] === "repo" && args[1] === "clone") clone(args[2]!, args[3]!);
  process.exit(0);
}

if (tool === "apm") {
  if (args[0] === "compile") {
    const target = args.at(-1)!;
    const agentId = await compile(target);
    await record({ kind: "compile", agentId, target });
  }
  process.exit(0);
}

if (tool === "codex" || tool === "claude") {
  process.exit(await runAgent(tool));
}

process.exit(2);

async function runAgent(target: "codex" | "claude"): Promise<number> {
  const contextPath = process.env.AGENT_FLOW_CONTEXT_PATH;
  const receiptPath = process.env.AGENT_FLOW_RECEIPT_PATH;
  if (!contextPath || !receiptPath) return 0;
  const context = JSON.parse(await readFile(contextPath, "utf8")) as {
    ticket: { repository: { cloneRoot: string } };
    controlState: { attemptSeries: { agentId: string; current: { attemptId: string } } };
  };
  const endpoint = new URL("/__fixture/attempt", context.ticket.repository.cloneRoot);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fixture-target": target },
    body: JSON.stringify(context),
  });
  if (!response.ok) {
    console.error(await response.text());
    return 2;
  }
  const result = await response.json() as { mode: string; receipt?: unknown };
  const completed = () => fetch(new URL("/__fixture/completed", endpoint), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attemptId: context.controlState.attemptSeries.current.attemptId }),
  }).catch(() => undefined);
  try {
    if (result.mode === "exit-failure") return 1;
    if (result.mode === "late") {
      await terminated(async () => {
        const late = await fetch(new URL("/__fixture/late", endpoint), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(context),
        });
        if (!late.ok) throw new Error(await late.text());
        const published = await late.json() as { receipt: unknown };
        await writeFile(receiptPath, `${JSON.stringify(published.receipt)}\n`, { mode: 0o600 });
      });
      return 0;
    }
    if (result.receipt) await writeFile(receiptPath, `${JSON.stringify(result.receipt)}\n`, { mode: 0o600 });
    if (result.mode === "block") await terminated();
    return 0;
  } finally {
    await completed();
  }
}

function terminated(onSignal: () => Promise<void> = async () => undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const keepAlive = setInterval(() => undefined, 1_000);
    process.once("SIGTERM", () => {
      clearInterval(keepAlive);
      void onSignal().then(resolve, reject);
    });
  });
}

async function record(event: Record<string, string>): Promise<void> {
  const path = process.env.AGENT_FLOW_FIXTURE_LOG;
  if (path) await appendFile(path, `${JSON.stringify(event)}\n`);
}

function clone(url: string, destination: string): void {
  execFileSync("git", ["init", destination]);
  execFileSync("git", ["-C", destination, "config", "user.email", "fixture@example.test"]);
  execFileSync("git", ["-C", destination, "config", "user.name", "Fixture"]);
  execFileSync("git", ["-C", destination, "remote", "add", "origin", url]);
  execFileSync("git", ["-C", destination, "commit", "--allow-empty", "-m", "fixture"]);
}

async function compile(target: string): Promise<string> {
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
  return id;
}
