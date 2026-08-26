import type { Actor } from "../config/types.js";

export type { Actor } from "../config/types.js";

export type ProviderKind = "github" | "gitlab";
export type Permission = "none" | "read" | "triage" | "write" | "maintain" | "admin";
export type RequestPriority = "background" | "active";

export interface TicketRef {
  provider: ProviderKind;
  repository: string;
  number: number;
}

export interface ProviderRepository {
  provider: ProviderKind;
  name: string;
  host: string;
  cloneRoot: string;
  cloneUrl: string;
}

export interface ProviderComment {
  id: string;
  url: string;
  body: string;
  actor: Actor;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedChangeRequest {
  provider: ProviderKind;
  repository: string;
  number: number;
  url: string;
  headSha: string;
  state: "open" | "closed" | "merged";
  actor: Actor;
  updatedAt: string;
}

export interface NormalizedReview {
  id: string;
  url: string;
  actor: Actor;
  submittedAt: string;
  headSha: string;
  verdict: "approved" | "changes-requested" | "commented";
  body: string;
}

export type ProviderArtifact = ProviderComment | NormalizedChangeRequest | NormalizedReview;

export interface ProviderTicketSnapshot {
  ref: TicketRef;
  repository: ProviderRepository;
  open: boolean;
  labels: string[];
  updatedAt: string;
  activation: {
    present: boolean;
    eventId: string | null;
    actor: Actor | null;
    occurredAt: string | null;
  };
  comments: ProviderComment[];
  changeRequest: NormalizedChangeRequest | null;
}

export interface DiscoveryWindow {
  updatedAfter: string;
  overlapSeconds: number;
}

export interface DiscoveryPage {
  tickets: TicketRef[];
  nextCursor: string | null;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  verifyAuth(): Promise<Actor>;
  discover(repository: string, window: DiscoveryWindow, cursor?: string): Promise<DiscoveryPage>;
  bootstrap(repository: string): Promise<TicketRef[]>;
  readRepository(repository: string): Promise<ProviderRepository>;
  readTicket(ref: TicketRef): Promise<ProviderTicketSnapshot>;
  permission(repository: string, actor: Actor): Promise<Permission>;
  readComment(ref: TicketRef, id: string): Promise<ProviderComment>;
  createComment(ref: TicketRef, body: string): Promise<ProviderComment>;
  updateComment(ref: TicketRef, id: string, body: string): Promise<ProviderComment>;
  setControllerLabels(ref: TicketRef, remove: string[], add: string[]): Promise<string[]>;
  readChangeRequest(ref: TicketRef, number: number): Promise<NormalizedChangeRequest>;
  readReview(ref: TicketRef, changeNumber: number, id: string): Promise<NormalizedReview>;
}

export interface ProviderRequest {
  path: string;
  priority: RequestPriority;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  etagKey?: string;
  signal?: AbortSignal;
}

export interface ProviderPagination {
  next: string | null;
}

export interface ProviderResponse<T> {
  status: number;
  data: T | null;
  headers: Record<string, string>;
  pagination: ProviderPagination;
  notModified: boolean;
}

export interface RateLimitedHttpClient {
  request<T>(request: ProviderRequest): Promise<ProviderResponse<T>>;
}
