# Prototype contracts

## Implementation status

[ADR 0001](adr/0001-provider-commit-points-and-local-execution.md), the
[architecture](agent-flow-architecture.md), and [data model](recovery-data-model.md) define the implemented contract:
SQLite-local execution, `config`/`controller` publication metadata, and ownership observed on ordinary reconciliation.
No second ownership read is added before publication. Agent attempts write a minimal local `AgentDecision`; the
controller reads provider evidence and stores the verified `AgentReceipt` in local SQLite.

New successful assessment, plan and diagnostic comments also append a separate
`<!-- agent-flow-result:v1 state=planning -->` line with the actual agent state. It identifies comment results during
recovery across multiple human gates; it does not extend the common `config`/`controller` object, establish ownership,
or replace result validation and author authorization. Questions and progress notes do not carry it. Existing
publications need no rewrite; ambiguous legacy multi-gate histories require clarification. See
[workflow migration recovery](workflow-migrations.md) for the eligibility rules.

## Scope

The prototype runs one polling controller in one Docker container. It supports GitHub and GitLab through separate REST
adapters, compiles data-only flow YAML into XState v5, and launches Codex or Claude through fixed harness adapters. It
uses one disposable local SQLite database and does not include webhooks, a durable queue, multiple cooperating
controller replicas or automatic merge. Its operator UI is read-only.

GitHub or GitLab remains the canonical operational store. Local repositories, worktrees, compiled APM output, context
files, decisions, and harness sessions are replaceable execution artifacts.

## Repository structure

```text
agent-packages/                 APM source packages, one package per agent type
config/                         Default controller, catalog, and flow configuration
docs/                           Architecture and runtime contracts
schemas/v1/                     JSON Schema contracts for all controller inputs and machine records
src/                            TypeScript controller
  config/                       YAML loading and JSON Schema validation
  flow/                         XState compilation and provider-derived transitions
  provider/                     GitHub and GitLab REST adapters
  runtime/                      Reconciliation, rate limiting, workspaces, and attempts
  harness/                      Codex and Claude process adapters
test/                           Node test runner suites and provider fixtures
Dockerfile                     Single-controller runtime image
compose.yaml                   macOS-oriented local deployment
```

## Versioned inputs

Stack, runtime configuration, flow, catalog, control-state, and receipt documents have `apiVersion: agent-flow/v1alpha1`
and a fixed
`kind`. `AgentDecision` is a local one-field document, and `LocalExecution` is the local SQLite wrapper. The controller
rejects unknown fields and unsupported versions before reconciliation starts.

- `schemas/v1/flow.schema.json` defines states, agent references, context inputs, transitions, guards, and actions.
- `schemas/v1/stack.schema.json` defines the flow, catalog, schemas, and contracts owned by one Git revision.
- `schemas/v1/agent-catalog.schema.json` maps logical agent IDs to APM packages.
- `schemas/v1/runtime-config.schema.json` defines provider, execution, polling, and local runtime values.
- `schemas/v1/control-state.schema.json` defines local flow and attempt bookkeeping retained inside a local execution
  record.
- `schemas/v1/local-execution.schema.json` defines the validated JSON stored in SQLite.
- `schemas/v1/agent-decision.schema.json` defines the minimal local JSON decision returned by a completed agent attempt.
- `schemas/v1/agent-receipt.schema.json` defines the controller-built, provider-verified attempt record stored in the
  local execution record. The model does not write this record.

The initial schemas use `v1alpha1` because the prototype may change them incompatibly. A running flow still pins the
configuration repository commit SHA, so a schema change cannot alter an existing instance without explicit migration.

`config/agents.yaml` contains no harness or model choices. The mounted runtime configuration binds every required agent
ID to a harness, model, reasoning level, retry policy, and timeout.

## Fixed flow vocabulary

Flow YAML may use only these controller events:

- `agent-succeeded`
- `agent-needs-human`
- `attempts-exhausted`
- `review-approved`
- `review-changes-requested`
- `human-approved`
- `human-changes-requested`
- `human-question`
- `human-unclear`
- `human-cancelled`
- `human-answer-accepted`
- `human-answer-cancelled`
- `human-answer-unclear`
- `authorized-comment`
- `change-request-updated`
- `change-request-merged`
- `change-request-closed`

Ticket closure and activation-label removal are controller-level cancellation events and do not need repetition in
every state. The controller also provides a fixed `$resume` target for `needs-human` and `blocked`.

The controller assigns each fixed event one source: `agent`, `provider`, or `controller`. A generated runtime prompt
contains only the current state's outgoing `agent` events. `attempts-exhausted`, `authorized-comment`, and every
`change-request-*` event are never included in model choices. Event-source metadata is controller code, not executable
flow configuration.

Flow YAML may name only these guards:

- `authorized-actor`
- `activation-present`
- `ticket-open`
- `head-matches`
- `receipt-valid`

Flow YAML may name only these actions:

- `record-receipt`
- `remember-resume-state`
- `clear-resume-state`
- `reset-retry-budget`
- `remove-activation-label`

The YAML cannot contain commands, scripts, expressions, module names, or inline JavaScript.

A transition into `needs-human` or `blocked` may set `resumeTarget`. Otherwise, the controller resumes the source
state. This handles provider-wait states that must return to an agent after human input.

`needs-human` must declare an `agent-needs-human` self-transition with `record-receipt`. The controller uses it when a
provider-wait transition enters the paused state before the responsible agent has published its question, including the
closed, unmerged change-request path. This keeps the question publication inside the state-machine contract while
preserving the existing resume target.

At an explicit human gate or in `needs-human`, a new authorized comment starts the current-stage agent in human-input
mode before XState receives a verdict event. `blocked` is different: any new authorized, unmarked comment resets the
retry budget directly, as defined by the architecture.

In human-input mode, the generated prompt exposes only the gate events configured on the current state. In
`needs-human`, `human-answer-cancelled` transitions directly to the terminal `cancelled` state. It does not resume the
paused stage.

## Generated runtime prompt

The controller generates the orchestration part of every attempt prompt from the pinned flow state, attempt mode,
result contract, and outgoing transitions. Compiled APM instructions precede this runtime section and describe only the
agent's domain role. Agent packages do not repeat event names, JSON shapes, markers, environment paths, or machine
record fields.

The runtime section contains:

- the context and decision file paths;
- the exact `config`/`controller` marker to place on each required provider publication;
- the pinned change-request identity and head when the stage needs them;
- the allowed model-origin events and one exact JSON example for each;
- the provider evidence required for each event; and
- a prohibition on reserved-label changes and additional decision fields.

The decision file contains exactly one JSON object:

```json
{"event":"<allowed-agent-event>"}
```

The session directory and active attempt bind that object to its flow instance and attempt. The model therefore does
not repeat those identifiers. JSON Schema validates the fixed shape, and runtime validation rejects an event that is
not both model-owned and configured on the current state.

After a successful harness exit, the controller reads the decision and discovers its evidence through the provider:

- `agent-succeeded` requires the stage's marked assessment, plan, or diagnostic comment. Verification requires a
  diagnostic whose second line is exactly `BUG RECEIPT · VERIFIED`; the linked change request must remain open at the
  pinned head throughout readback. A development attempt without a linked change request creates one linked open
  change request during the current attempt. A retry with a pinned change request keeps that exact request open and
  updates it during the current attempt instead of creating another;
- `agent-needs-human` requires one marked question comment;
- `review-approved` and `review-changes-requested` require one native review on the pinned head whose logical verdict
  agrees with the decision;
- human gate question or unclear events require one marked clarification question; and
- human gate approval, changes-requested, and cancellation events require no new publication.

The controller reads every discovered object back and constructs the `AgentReceipt` stored in SQLite. It
fills flow and attempt IDs, provider IDs and URLs, head SHA, normalized change-request state, and other deterministic
fields. The model never supplies those values.

A missing or malformed decision, an unavailable required artifact, or a syntactically valid event that lacks required
evidence is a retryable attempt failure. Evidence that refers to another ticket, change request, flow, attempt, or
pinned head is a non-retryable trust-boundary failure. Neither case advances XState.

## Cross-file validation

JSON Schema validates file shape. Before polling, the controller also verifies that:

- the initial state and every transition target exist;
- every `resumeTarget` exists and is used only for a transition into `needs-human` or `blocked`;
- every agent reference exists in the catalog and its package contains one `apm.yml` that supports the selected target;
- every final state has no transitions and every non-final state has at least one transition;
- every referenced action and guard is implemented by the controller;
- configured repositories are unique in the runtime provider allowlist; and
- the checked-out configuration revision contains the applicable `apm.lock.yaml` files.

## Local execution record

The controller stores flow identity, retry accounting, receipts, and cached provider interpretation in
`/var/lib/agent-flow/execution.sqlite`. It validates each JSON payload with `local-execution.schema.json` and uses a
local revision
for compare-and-swap updates. Attempt starts are committed before harness launch. Surviving local state preserves retry
consumption on an ordinary restart; an empty database reconstructs active work from provider evidence.

`/var/lib/agent-flow/controller-id` contains the installation UUID outside SQLite. Startup rejects a corrupt identity,
corrupt
database, or unsupported `user_version` without replacing it. The SQLite connection opens before readiness and closes
after controller work drains.

## Agent publication markers

Every substantive agent publication contains this standalone block in raw Markdown:

```html
<!-- agent-flow:v1 {"config":"<configuration-sha>","controller":"<controller-id>"} -->
```

The controller supplies the exact block to runtime prompts and reads the provider object back before accepting it.
The fields identify the pinned configuration and installation. They do not identify an attempt, prove completion, or
authorize an actor. Result identity comes from provider object metadata, current stage context, and the publication
keys captured before an attempt.

Every stage-mode review publication, including a comment-style provider review, starts with these two lines in this
order:

```html
<!-- agent-flow:v1 {"config":"<configuration-sha>","controller":"<controller-id>"} -->
<!-- agent-flow-review:v1 head=<sha> verdict=<verdict> -->
```

`head` is the pinned 40-character lowercase hexadecimal SHA. `verdict` is exactly `approved`, `changes-requested`, or
`commented`. The controller reads both lines back before accepting the review. A changed head invalidates the review,
so the agent must publish no verdict after observing a different provider head. Human-input questions use only the
common publication block.

When GitHub prevents self-approval, the agent submits a native pull-request review with event `COMMENT`. Its second
marker line carries the intended logical verdict, such as `approved`. The controller locates a review with the exact
common marker, excludes reviews present before the attempt, and reads the result back from the pull-request reviews
API. The fallback is not an issue comment. For native `APPROVED` and `CHANGES_REQUESTED` states, the marker verdict must
agree with the provider state. Recovery reads native review edit provenance through batched GraphQL node queries.
An edit after submission or unavailable edit provenance cannot establish original publication; equal timestamps do
not prove that a draft edit preceded submission. The ownership timestamp remains the native submission time. An earlier
intact publication can preserve the owner and configuration while a PR/MR description changes. Such edited objects
cannot elect ownership, and edited reviews cannot supply approval. The reviewer receives their excluded IDs.

Only an open linked change request follows the pinned-head review path and produces a verified review result. A closed,
unmerged linked change request may run the reviewer in stage mode only once after the flow enters `needs-human` with
`review` as the resume state. This run does not inspect the closed head or publish review metadata or a verdict. It
publishes one reopen-or-cancel question with the common publication block and writes
`{"event":"agent-needs-human"}`. A merged change request never uses this path.

The first later authorized unmarked answer runs the reviewer in human-input mode. The reviewer interprets reopen,
cancel, or unclear intent without reviewing code. Reopen produces `human-answer-accepted`; cancel produces
`human-answer-cancelled`; unclear or question intent produces `human-answer-unclear` and one marked clarification
question. Cancellation removes the activation label, preserves `agent-flow:managed`, and exposes only
`agent-stage:cancelled`. Human-input mode never publishes a review verdict.

The reader recognizes the previous `agent-flow-control:v1` comment and space-delimited `agent-flow:v1 flow=...`
publication marker. Neither is human input. Active legacy work records a migration-required local status and causes no
provider writes. Finish or cancel it with the old controller before switching. Inactive history remains unchanged; the
new controller does not migrate, rewrite, adopt, or dual-write legacy state.

## Attempt files

The controller creates one immutable session directory per attempt:

```text
/var/lib/agent-flow/sessions/<flow-instance-id>/<attempt-id>/
  context.json
  decision.json
  harness.log
  harness-session/
```

The harness receives `AGENT_FLOW_CONTEXT_PATH` and `AGENT_FLOW_DECISION_PATH`. The controller treats `decision.json` as
untrusted input, validates it, discovers and reads the required provider artifacts, then stores its own verified result
in SQLite. Losing the session directory does not lose provider-committed work.

## Repository workspaces

The controller keeps one local base clone per allowlisted repository and one writable Git worktree per active flow
instance. Attempts for the same ticket reuse its worktree sequentially. Different tickets never share a working tree.
The controller validates the provider repository identity before each attempt and removes a worktree only after the
flow reaches a terminal state and no harness process is running.

## Docker contract

The image contains Node.js, Git, `gh`, `glab`, APM, Codex, and Claude. The container reads one mounted runtime YAML file
from `/etc/agent-flow/runtime.yaml`. That file selects an exact 40-character configuration commit, its stack manifest,
the provider repository allowlist, and the execution bindings. The controller scopes the mounted provider token to a
matching configuration Git host and keeps verified revision materializations for offline recovery.

- runtime configuration at `/etc/agent-flow/runtime.yaml` as one read-only file;
- provider and harness credentials under `/run/secrets/agent-flow/` as individual read-only files;
- persistent identity, SQLite, Git caches, worktrees, and sessions at `/var/lib/agent-flow/`;
- temporary harness homes under `/tmp/agent-flow/`.

The controller creates or validates `controller-id`, opens `execution.sqlite`, binds each provider API scope, and then
performs startup preflight for every harness and provider enabled by the pinned catalog. Corrupt identities,
unsupported database versions, missing binaries, failed authentication, or unwritable mounts fail startup before
readiness. Bootstrap discovers activation and managed labels but schedules work only with its valid activation; ordinary
polling continues to observe
cancellation for active workers. Shutdown drains controller work before closing SQLite.

The prototype exposes health endpoints on the runtime-configured address and port. `/health/live` reports process
liveness. `/health/ready` returns success after configuration validation, identity and SQLite initialization, provider
authentication, filesystem checks, harness preflight, and startup reconciliation complete. `/api/status` exposes safe
runtime and restart status. The read-only dashboard includes recovery disposition and reason for paused tickets,
including tickets whose local flow identity could not be reconstructed. Secret values and paths remain excluded.

## Workflow migration contracts

Migration rules live in target-pinned `config/migrations/` and use `schemas/v1/workflow-migration.schema.json`.
Their format is independent of required Stack agent contracts so old Stack bundles remain loadable. Separately
versioned immutable receipt metadata uses `schemas/v1/migration-receipt.schema.json`, preserving the common
publication marker’s exact two-field contract. The controller resolves latest/tag/full-SHA selectors strictly only
for explicit migration acceptance, validates and freezes compatibility, confirms old process termination, and
verifies provider readback before target work. A verified carried PR exception applies only to that exact
repository/number/URL/head repository/branch/original marker. Replayed development additionally requires a fresh
marked completion comment, allowing explicit revalidation without rewriting the PR marker. Context retains history;
baseline identities exclude stale results and human approvals, including same-pin replay. GitHub is supported
initially; GitLab migration is explicitly rejected. See [workflow-migrations.md](workflow-migrations.md) for the
canonical rule format, tested examples and validation commands.
