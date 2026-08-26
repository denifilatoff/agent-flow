import { RateLimiter } from "../runtime/rate-limiter.ts";
import type {
  ProviderPagination,
  ProviderRequest,
  ProviderResponse,
  RateLimitedHttpClient,
} from "./types.js";

export class ProviderHttpError extends Error {
  readonly status: number | null;
  readonly transient: boolean;
  readonly body: unknown;
  readonly headers: Record<string, string>;

  constructor(
    message: string,
    status: number | null,
    transient: boolean,
    body: unknown,
    headers: Record<string, string>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderHttpError";
    this.status = status;
    this.transient = transient;
    this.body = body;
    this.headers = headers;
  }
}

export function createRateLimitedHttpClient(
  baseUrl: URL,
  defaultHeaders: () => Record<string, string>,
  limiter: RateLimiter,
  fetchImpl: typeof fetch = globalThis.fetch,
): RateLimitedHttpClient {
  const etags = new Map<string, string>();

  return {
    async request<T>(request: ProviderRequest): Promise<ProviderResponse<T>> {
      const url = new URL(request.path, baseUrl);
      if (url.origin !== baseUrl.origin) throw new Error("request path must use the same provider origin");

      await limiter.acquire(request.priority);
      const headers = new Headers(defaultHeaders());
      for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(name, value);
      if (request.etagKey && etags.has(request.etagKey)) {
        headers.set("if-none-match", etags.get(request.etagKey)!);
      }

      let body: BodyInit | undefined;
      if (request.body !== undefined) {
        headers.set("content-type", headers.get("content-type") ?? "application/json");
        body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
      }

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: request.method ?? "GET",
          headers,
          body,
          signal: request.signal,
        });
      } catch (error) {
        throw new ProviderHttpError("provider request failed", null, true, null, {}, { cause: error });
      }

      const responseHeaders = Object.fromEntries(response.headers.entries());
      observeLimits(response.headers, limiter);
      if (request.etagKey) {
        const etag = response.headers.get("etag");
        if (etag) etags.set(request.etagKey, etag);
      }

      const data = await parseBody(response, responseHeaders);
      if (!response.ok && response.status !== 304) {
        throw new ProviderHttpError(
          `provider request failed with status ${response.status}`,
          response.status,
          response.status === 429 || response.status >= 500,
          data,
          responseHeaders,
        );
      }

      return {
        status: response.status,
        data: response.status === 304 ? null : data as T | null,
        headers: responseHeaders,
        pagination: pagination(response.headers, url, baseUrl.origin),
        notModified: response.status === 304,
      };
    },
  };
}

async function parseBody(response: Response, headers: Record<string, string>): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  if (!response.headers.get("content-type")?.toLowerCase().includes("json")) return text;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProviderHttpError(
      "provider returned invalid JSON",
      response.status,
      response.status === 429 || response.status >= 500,
      text,
      headers,
      { cause: error },
    );
  }
}

function observeLimits(headers: Headers, limiter: RateLimiter): void {
  const remaining = integerHeader(headers, "x-ratelimit-remaining", "ratelimit-remaining");
  const limit = integerHeader(headers, "x-ratelimit-limit", "ratelimit-limit");
  const reset = integerHeader(headers, "x-ratelimit-reset", "ratelimit-reset");
  if (remaining !== null && limit !== null && reset !== null) {
    limiter.observe({ remaining, limit, resetAt: reset * 1_000 });
  }

  const retryAfter = headers.get("retry-after");
  const minimumInterval = integerHeader(headers, "x-poll-interval", "poll-interval");
  if (retryAfter !== null) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfter.trim())) {
      limiter.pauseFor(Number(retryAfter) * 1_000);
    } else {
      const timestamp = Date.parse(retryAfter);
      if (!Number.isNaN(timestamp)) limiter.pauseUntil(timestamp);
    }
  }
  if (minimumInterval !== null) limiter.pauseFor(minimumInterval * 1_000);
}

function integerHeader(headers: Headers, ...names: string[]): number | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null && /^\d+$/.test(value.trim())) return Number(value);
  }
  return null;
}

function pagination(headers: Headers, requestUrl: URL, allowedOrigin: string): ProviderPagination {
  const link = headers.get("link");
  if (link) {
    for (const part of link.split(",")) {
      const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part);
      if (!match || !match[2]!.split(/\s+/).includes("next")) continue;
      const next = new URL(match[1]!, requestUrl);
      if (next.origin !== allowedOrigin) throw new Error("pagination URL must use the same provider origin");
      return { next: `${next.pathname}${next.search}` };
    }
  }

  const nextPage = headers.get("x-next-page");
  if (nextPage) {
    const next = new URL(requestUrl);
    next.searchParams.set("page", nextPage);
    return { next: `${next.pathname}${next.search}` };
  }
  return { next: null };
}
