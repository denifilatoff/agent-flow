# Prototype contracts

## Implementation status

The runtime agent protocol in this document is the approved target for the next implementation change. The prototype
code still accepts a model-generated `AgentReceipt` until that change is implemented. The implementation plan must
replace that temporary contract without changing the provider-backed state-machine semantics defined here.

## Scope

The prototype runs one polling controller in one Docker container. It supports GitHub and GitLab through separate REST
adapters, compiles data-only flow YAML into XState v5, and launches Codex or Claude through fixed harness adapters. It
does not include webhooks, a database, a durable queue, multiple controller replicas, a UI, or automatic merge.

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

Every YAML or JSON contract has `apiVersion: agent-flow/v1alpha1` and a fixed `kind`. The controller rejects unknown
fields and unsupported versions before reconciliation starts.

- `schemas/v1/flow.schema.json` defines states, agent references, context inputs, transitions, guards, and actions.
- `schemas/v1/agent-catalog.schema.json` maps agent IDs to APM packages, harness targets, timeouts, and retry policy.
- `schemas/v1/controller-config.schema.json` defines providers, the repository allowlist, polling limits, and local
  runtime paths.
- `schemas/v1/control-state.schema.json` defines the JSON payload inside the ticket's mutable control comment.
- `schemas/v1/agent-decision.schema.json` defines the minimal local JSON decision returned by a completed agent attempt.
- `schemas/v1/agent-receipt.schema.json` defines the controller-built, provider-verified attempt record stored in the
  control comment. The model does not write this record.

The initial schemas use `v1alpha1` because the prototype may change them incompatibly. A running flow still pins the
configuration repository commit SHA, so a schema change cannot alter an existing instance without explicit migration.

`config/agents.yaml` is the mixed Claude/Codex catalog. For a local acceptance run that uses the authenticated Codex
harness for every stage, set `configuration.catalog` to `config/agents-codex.yaml`.

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
- the exact marker to place on each required provider publication;
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

- `agent-succeeded` requires the stage's marked assessment or plan comment, or the linked open change request;
- `agent-needs-human` requires one marked question comment;
- `review-approved` and `review-changes-requested` require one native review on the pinned head whose logical verdict
  agrees with the decision;
- human gate question or unclear events require one marked clarification question; and
- human gate approval, changes-requested, and cancellation events require no new publication.

The controller reads every discovered object back and constructs the `AgentReceipt` stored in the control comment. It
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
- configured repositories are unique across provider entries; and
- the checked-out configuration revision contains the applicable `apm.lock.yaml` files.

## Control comment

The controller owns one mutable ticket comment per flow instance. Its first line is the exact marker:

```text
<!-- agent-flow-control:v1 -->
```

The marker is followed by one fenced JSON object validated by `control-state.schema.json`. The controller edits this
comment in place and increments `sequence` for each accepted change. It records the pinned config SHA, current state,
resume state, accepted activation event ID, current attempt series, latest validated receipt, human gate result, and
linked change request. A terminal flow starts again only for a different authorized activation event ID; timestamps do
not determine reactivation because provider and controller clocks may differ.

The controller writes an attempt with status `started` and reads the comment back before launching a harness. A restart
therefore cannot restore a consumed retry. Older attempt series do not need to remain in the control comment because
they cannot affect the next transition.

## Agent publication markers

Every agent-authored provider comment starts with this marker:

```text
<!-- agent-flow:v1 flow=<flow-instance-id> attempt=<attempt-id> artifact=<artifact-kind> -->
```

`artifact-kind` is `assessment`, `plan`, `question`, `review`, or `diagnostic`. The generated runtime prompt supplies
the exact marker. The controller compares it with the active attempt and reads the provider object back before
accepting it.

Every stage-mode review publication, including a comment-style provider review, starts with these two lines in this
order:

```text
<!-- agent-flow:v1 flow=<flow-instance-id> attempt=<attempt-id> artifact=review -->
<!-- agent-flow-review:v1 head=<sha> verdict=<verdict> -->
```

`head` is the pinned 40-character lowercase hexadecimal SHA. `verdict` is exactly `approved`, `changes-requested`, or
`commented`. The controller reads both lines back before accepting the review. A changed head invalidates the review,
so the agent must publish no verdict after observing a different provider head. Human-input questions remain ordinary
`artifact=question` publications and do not include review metadata.

When GitHub prevents self-approval, the agent submits a native pull-request review with event `COMMENT`. Its second
marker line carries the intended logical verdict, such as `approved`. The controller locates that review by the active
attempt marker and reads it back from the pull-request reviews API. The fallback is not an issue comment. For native
`APPROVED` and `CHANGES_REQUESTED` states, the marker verdict must agree with the provider state.

Only an open linked change request follows the pinned-head review path and produces a verified review result. A closed,
unmerged linked change request may run the reviewer in stage mode only once after the flow enters `needs-human` with
`review` as the resume state. This run does not inspect the closed head or publish review metadata or a verdict. It
publishes one reopen-or-cancel question with the supplied `artifact=question` marker and writes
`{"event":"agent-needs-human"}`. A merged change request never uses this path.

The first later authorized unmarked answer runs the reviewer in human-input mode. The reviewer interprets reopen,
cancel, or unclear intent without reviewing code. Reopen produces `human-answer-accepted`; cancel produces
`human-answer-cancelled`; unclear or question intent produces `human-answer-unclear` and one marked clarification
question. Cancellation removes the activation label, preserves `agent-flow:managed`, and exposes only
`agent-stage:cancelled`. Human-input mode never publishes a review verdict.

## Attempt files

The controller creates one immutable session directory per attempt:

```text
/data/sessions/<flow-instance-id>/<attempt-id>/
  context.json
  decision.json
  harness.log
  harness-session/
```

The harness receives `AGENT_FLOW_CONTEXT_PATH` and `AGENT_FLOW_DECISION_PATH`. The controller treats `decision.json` as
untrusted input, validates it, discovers and reads the required provider artifacts, then stores its own verified result
in the control comment. Losing the session directory does not lose operational state.

## Repository workspaces

The controller keeps one local base clone per allowlisted repository and one writable Git worktree per active flow
instance. Attempts for the same ticket reuse its worktree sequentially. Different tickets never share a working tree.
The controller validates the provider repository identity before each attempt and removes a worktree only after the
flow reaches a terminal state and no harness process is running.

## Docker contract

The image contains Node.js, Git, `gh`, `glab`, APM, Codex, and Claude. Set `AGENT_FLOW_CONFIG_REPOSITORY` to an absolute
local path or a credential-free `https://` or `file://` Git URL. A URL is mirrored under `/data` once during startup;
the next service restart fetches remote changes. Git uses the mounted `gh` credentials for `github.com` and the mounted
`glab` credentials for `gitlab.com`. A custom HTTPS host requires a preconfigured Git credential helper. Secrets must
not appear in the URL. Set `AGENT_FLOW_CONFIG_REVISION` to an existing 40-character commit SHA to start from that
revision instead of the prepared repository's HEAD. A materialized revision retains the Git objects needed to verify
and load its files after the source history is rewritten. The container runs as one controller process and mounts:

- the configuration repository at `/config` for the default local-path mode;
- persistent repositories, worktrees, and sessions at `/data`;
- provider and harness authentication directories through explicit Compose mounts.

The controller performs a startup preflight for every harness and provider enabled by the pinned catalog. Missing
binaries, authentication, or writable mounts fail startup before polling begins.

The prototype exposes a health endpoint on port `8080`. `/health/live` reports process liveness. `/health/ready`
returns success only after configuration validation, provider authentication, filesystem checks, and harness preflight
complete.
