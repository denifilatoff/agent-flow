import { timingSafeEqual } from "node:crypto";
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

export function createHealthServer(
  address: string,
  port: number,
  status: OperationalStatus,
  operatorPassword: string,
): Server {
  const expectedAuthorization = Buffer.from(`operator:${operatorPassword}`);
  const server = createServer((request, response) => void route(request, response));
  server.listen(port, address);
  return server;

  async function route(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
    const rawPathname = request.url?.split("?", 1)[0] ?? "/";
    const apiRequest = rawPathname === "/api" || rawPathname.startsWith("/api/");
    const publicHealth = rawPathname === "/health/live" || rawPathname === "/health/ready";
    if (!publicHealth && !authorized(request.headers.authorization, expectedAuthorization)) {
      response.writeHead(401, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "www-authenticate": 'Basic realm="agent-flow", charset="UTF-8"',
      });
      response.end("401\n");
      return;
    }
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

function authorized(header: string | undefined, expected: Buffer): boolean {
  if (!header || header.length > 87_400) return false;
  const match = /^Basic ((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/i.exec(header);
  if (!match?.[1]) return false;
  const credentials = Buffer.from(match[1], "base64");
  if (credentials.length > 65_545 || credentials.toString("base64") !== match[1]) return false;
  const comparable = Buffer.alloc(expected.length);
  credentials.copy(comparable, 0, 0, expected.length);
  const equal = timingSafeEqual(comparable, expected);
  return credentials.length === expected.length && equal;
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
  const payload = `${JSON.stringify(body)}\n`;
  if (status === 200 && Buffer.byteLength(payload) > 1_048_576) {
    writeJson(response, 413, { available: false, reason: "session file too large" });
    return;
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
