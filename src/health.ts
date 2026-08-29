import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";

import type { RuntimeManager } from "./config/runtime.ts";
import {
  createDashboardSnapshot,
  readDashboardSessionFile,
  type DescriptorPathResolver,
  type SessionFileResult,
} from "./dashboard.ts";
import type { ReadyDependencies } from "./preflight.ts";

export interface OperationalStatus {
  isReady(): boolean;
  markReady(): void;
  markNotReady(): void;
  bindReady(ready: ReadyDependencies): void;
  dashboard(): ReturnType<typeof createDashboardSnapshot> | Promise<null>;
  sessionFile(flowUuid: string, attemptUuid: string, file: string): Promise<SessionFileResult | null>;
  snapshot(): {
    configurationRepository: string;
    configurationRevision: string;
    runtimeDigest: string;
    validationErrors: string[];
    restartRequired: boolean;
    restartReason: string | null;
    changedRestartFields: string[];
    activeAttempts: number;
    safeToRestart: boolean;
  };
}

export function createOperationalStatus(
  runtime: RuntimeManager,
  resolveDescriptorPath?: DescriptorPathResolver,
): OperationalStatus {
  let startupReady = false;
  let ready: ReadyDependencies | undefined;
  return {
    isReady: () => startupReady && runtime.mayStartWork(),
    markReady: () => { startupReady = true; },
    markNotReady: () => { startupReady = false; },
    bindReady: (value) => { ready = value; },
    dashboard: () => ready ? createDashboardSnapshot(runtime, ready) : Promise.resolve(null),
    sessionFile: (flowUuid, attemptUuid, file) => ready
      ? readDashboardSessionFile(
          runtime.effective().runtime.dataDirectory,
          flowUuid,
          attemptUuid,
          file,
          ready.redactSessionContent,
          undefined,
          resolveDescriptorPath,
        )
      : Promise.resolve(null),
    snapshot: () => {
      const configuration = runtime.effective().configuration;
      return {
        configurationRepository: configuration.repository,
        configurationRevision: configuration.revision,
        ...runtime.status(),
      };
    },
  };
}

export function createHealthServer(address: string, port: number, status: OperationalStatus): Server {
  const server = createServer((request, response) => void route(request, response));
  server.listen(port, address);
  return server;

  async function route(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
    const rawPathname = request.url?.split("?", 1)[0] ?? "/";
    const apiRequest = rawPathname === "/api" || rawPathname.startsWith("/api/");
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      writeText(response, 400, apiRequest);
      return;
    }
    if (request.method !== "GET") {
      writeText(response, 405, apiRequest, { allow: "GET" });
      return;
    }
    if (pathname === "/api/status") {
      writeJson(response, 200, status.snapshot());
      return;
    }
    const asset = staticAsset(rawPathname);
    if (asset) {
      try {
        response.writeHead(200, {
          "cache-control": "no-cache",
          "content-type": asset.contentType,
        });
        response.end(await readFile(new URL(asset.file, import.meta.url)));
      } catch {
        writeText(response, 404);
      }
      return;
    }
    if (pathname === "/api/dashboard") {
      try {
        const dashboard = await status.dashboard();
        writeJson(response, dashboard ? 200 : 503, dashboard ?? { available: false, reason: "preflight unavailable" });
      } catch {
        writeJson(response, 503, { available: false, reason: "dashboard unavailable" });
      }
      return;
    }
    const session = sessionPath(rawPathname);
    if (session) {
      const result = await status.sessionFile(session.flowUuid, session.attemptUuid, session.file).catch(() => ({
        status: 404 as const,
        body: { available: false as const, reason: "session file unavailable" as const },
      }));
      writeSessionJson(
        response,
        result?.status ?? 503,
        result?.body ?? { available: false, reason: "preflight unavailable" },
      );
      return;
    }
    const code = pathname === "/health/live"
      ? 200
      : pathname === "/health/ready"
        ? status.isReady() ? 200 : 503
        : 404;
    writeText(response, code, apiRequest);
  }
}

function sessionPath(rawPathname: string): { flowUuid: string; attemptUuid: string; file: string } | null {
  const parts = rawPathname.split("/");
  if (parts.length !== 6 || parts[1] !== "api" || parts[2] !== "sessions") return null;
  return { flowUuid: parts[3]!, attemptUuid: parts[4]!, file: parts[5]! };
}

function staticAsset(pathname: string): { file: string; contentType: string } | undefined {
  return {
    "/": { file: "./ui/index.html", contentType: "text/html; charset=utf-8" },
    "/index.html": { file: "./ui/index.html", contentType: "text/html; charset=utf-8" },
    "/assets/styles.css": { file: "./ui/styles.css", contentType: "text/css; charset=utf-8" },
    "/assets/app.js": { file: "./ui/app.js", contentType: "text/javascript; charset=utf-8" },
  }[pathname];
}

function writeJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  writeJsonPayload(response, status, `${JSON.stringify(body)}\n`);
}

function writeText(
  response: import("node:http").ServerResponse,
  status: number,
  noStore = false,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...headers,
    ...(noStore ? { "cache-control": "no-store" } : {}),
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(`${status}\n`);
}

function writeSessionJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  let payload = `${JSON.stringify(body)}\n`;
  const file = body as { available?: boolean; content?: string; truncated?: boolean };
  if (status === 200 && typeof file.content === "string" && Buffer.byteLength(payload) > 1_048_576) {
    let lower = 0;
    let upper = file.content.length;
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      const candidate = `${JSON.stringify({ ...file, content: file.content.slice(0, middle), truncated: true })}\n`;
      if (Buffer.byteLength(candidate) <= 1_048_576) lower = middle;
      else upper = middle - 1;
    }
    payload = `${JSON.stringify({ ...file, content: file.content.slice(0, lower), truncated: true })}\n`;
  }
  writeJsonPayload(response, status, payload);
}

function writeJsonPayload(response: import("node:http").ServerResponse, status: number, payload: string): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(payload);
}
