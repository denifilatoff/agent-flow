import { createServer, type Server } from "node:http";

import type { RuntimeManager } from "./config/runtime.ts";

export interface OperationalStatus {
  isReady(): boolean;
  markReady(): void;
  markNotReady(): void;
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

export function createOperationalStatus(runtime: RuntimeManager): OperationalStatus {
  let startupReady = false;
  return {
    isReady: () => startupReady && runtime.mayStartWork(),
    markReady: () => { startupReady = true; },
    markNotReady: () => { startupReady = false; },
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
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET", "content-type": "text/plain; charset=utf-8" });
      response.end("405\n");
      return;
    }
    if (request.url === "/api/status") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify(status.snapshot())}\n`);
      return;
    }
    const code = request.url === "/health/live"
      ? 200
      : request.url === "/health/ready"
        ? status.isReady() ? 200 : 503
        : 404;
    response.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
    response.end(`${code}\n`);
  });
  server.listen(port, address);
  return server;
}
