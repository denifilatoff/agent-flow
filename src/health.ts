import { createServer, type Server } from "node:http";

export interface Readiness {
  isReady(): boolean;
  markReady(): void;
  markNotReady(): void;
}

export function createReadiness(): Readiness {
  let ready = false;
  return {
    isReady: () => ready,
    markReady: () => { ready = true; },
    markNotReady: () => { ready = false; },
  };
}

export function createHealthServer(port: number, readiness: Readiness): Server {
  const server = createServer((request, response) => {
    const status = request.url === "/health/live"
      ? 200
      : request.url === "/health/ready"
        ? readiness.isReady() ? 200 : 503
        : 404;
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    response.end(`${status}\n`);
  });
  server.listen(port);
  return server;
}
