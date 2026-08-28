export type SchemaKind = "Flow" | "AgentCatalog" | "ControllerConfig" | "ControlState" | "AgentReceipt" | "AgentDecision";
export type HarnessTarget = "codex" | "claude";
export type ResultContract = "assessment" | "plan" | "diagnostic" | "verification" | "development" | "review" | "human-gate" | "none";

export type AgentEventType =
  | "agent-succeeded"
  | "agent-needs-human"
  | "review-approved"
  | "review-changes-requested"
  | "human-approved"
  | "human-changes-requested"
  | "human-question"
  | "human-unclear"
  | "human-cancelled"
  | "human-answer-accepted"
  | "human-answer-cancelled"
  | "human-answer-unclear";

export interface AgentDecision {
  event: AgentEventType;
}

export interface FlowDefinition {
  apiVersion: "agent-flow/v1alpha1";
  kind: "Flow";
  metadata: { id: string; activationLabel: "agent-flow:development"; managedLabel: "agent-flow:managed" };
  spec: { initial: string; activationRoutes?: Record<string, string>; states: Record<string, FlowState> };
}

export interface FlowState {
  kind: "agent" | "human-gate" | "provider-wait" | "paused" | "final";
  agent?: string;
  resultContract?: ResultContract;
  context?: Array<"ticket" | "control-state" | "assessment" | "plan" | "diagnostic" | "change-request" | "review" | "human-comment">;
  on?: Record<string, FlowTransition>;
}

export interface FlowTransition {
  target: string;
  resumeTarget?: string;
  guards?: Array<"authorized-actor" | "activation-present" | "ticket-open" | "head-matches" | "receipt-valid">;
  actions?: Array<"record-receipt" | "remember-resume-state" | "clear-resume-state" | "reset-retry-budget" | "remove-activation-label">;
}

export interface AgentCatalog {
  apiVersion: "agent-flow/v1alpha1";
  kind: "AgentCatalog";
  agents: Record<string, { package: string; target: HarnessTarget; retry: RetryConfig }>;
}

export interface RetryConfig {
  maxAttempts: number;
  delaySeconds: number;
  timeoutSeconds: number;
}

export interface ControllerConfig {
  apiVersion: "agent-flow/v1alpha1";
  kind: "ControllerConfig";
  configuration: { repository: string; flow: string; catalog: string };
  providers: Partial<Record<"github" | "gitlab", ProviderConfig>>;
  polling: { intervalSeconds: number; maxCallsPerMinute: number; quotaReservePercent: number };
  runtime: { concurrency: number; dataDirectory: string; healthPort: number };
}

export interface ProviderConfig {
  apiUrl: string;
  tokenEnv: string;
  repositories: string[];
}

export interface AgentReceipt {
  apiVersion: "agent-flow/v1alpha1";
  kind: "AgentReceipt";
  flowInstanceId: string;
  attemptId: string;
  outcome: "succeeded" | "needs-human" | "failed";
  summary: string;
  artifacts: ReceiptArtifact[];
  humanGate?: ReceiptHumanGate;
  error?: ReceiptError;
}

export type ReceiptArtifact = ReceiptComment | ReceiptChangeRequest | ReceiptReview;

export interface ReceiptComment {
  kind: "comment";
  id: string;
  url: string;
  marker: string;
  artifactKind: "assessment" | "plan" | "question" | "review" | "diagnostic";
}

export interface ReceiptChangeRequest {
  kind: "change-request";
  number: number;
  url: string;
  headSha: string;
  state: "open" | "closed" | "merged";
}

export interface ReceiptReview {
  kind: "review";
  id: string;
  url: string;
  headSha: string;
  verdict: "approved" | "changes-requested" | "commented";
}

export interface ReceiptHumanGate {
  sourceCommentId: string;
  verdict: "approved" | "changes-requested" | "cancelled" | "question" | "unclear";
  notes: string[];
}

export interface ReceiptError {
  code: string;
  message: string;
}

export interface ControlState {
  apiVersion: "agent-flow/v1alpha1";
  kind: "ControlState";
  flowInstanceId: string;
  flowId: string;
  configRevision: string;
  sequence: number;
  stateId: string;
  resumeStateId: string | null;
  activatedBy: Actor;
  activatedAt: string;
  activationEventId: string;
  activationLabel?: string;
  updatedAt: string;
  attemptSeries: AttemptSeries | null;
  latestReceipt: AgentReceipt | null;
  humanGate: ControlHumanGate | null;
  changeRequest: ControlChangeRequest | null;
}

export interface Actor {
  login: string;
  providerId: string;
}

export interface AttemptSeries {
  seriesId: string;
  agentId: string;
  stateId: string;
  inputRevision: string;
  maxAttempts: number;
  consumed: number;
  current: Attempt | null;
}

export interface Attempt {
  attemptId: string;
  status: "started" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  error?: ReceiptError;
}

export interface ControlHumanGate {
  sourceCommentId: string;
  actor: Actor;
  verdict: "approved" | "changes-requested" | "cancelled" | "question" | "unclear";
  interpretedByAttemptId: string;
  notes: string[];
}

export interface ControlChangeRequest {
  provider: "github" | "gitlab";
  repository: string;
  number: number;
  url: string;
  headSha: string;
  state: "open" | "closed" | "merged";
}
