# Prototype contracts

## Scope

The prototype runs one polling controller in one Docker container. It supports GitHub and GitLab through separate REST
adapters, compiles data-only flow YAML into XState v5, and launches Codex or Claude through fixed harness adapters. It
does not include webhooks, a database, a durable queue, multiple controller replicas, a UI, or automatic merge.

GitHub or GitLab remains the canonical operational store. Local repositories, worktrees, compiled APM output, context
files, receipts, and harness sessions are replaceable execution artifacts.

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
- `schemas/v1/agent-receipt.schema.json` defines the local receipt that a completed agent attempt returns to the
  controller.

The initial schemas use `v1alpha1` because the prototype may change them incompatibly. A running flow still pins the
configuration repository commit SHA, so a schema change cannot alter an existing instance without explicit migration.

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
- `human-answer-accepted`
- `human-answer-unclear`
- `authorized-comment`
- `change-request-updated`
- `change-request-merged`
- `change-request-closed`

Ticket closure and activation-label removal are controller-level cancellation events and do not need repetition in
every state. The controller also provides a fixed `$resume` target for `needs-human` and `blocked`.

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

At an explicit human gate or in `needs-human`, a new authorized comment starts the current-stage agent in human-input
mode before XState receives a verdict event. `blocked` is different: any new authorized, unmarked comment resets the
retry budget directly, as defined by the architecture.

## Cross-file validation

JSON Schema validates file shape. Before polling, the controller also verifies that:

- the initial state and every transition target exist;
- every `resumeTarget` exists and is used only for a transition into `needs-human` or `blocked`;
- every agent reference exists in the catalog and its package contains one `apm.yml`;
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

`artifact-kind` is `assessment`, `plan`, `question`, `review`, or `diagnostic`. The controller compares the marker with
the receipt and reads the provider object back before accepting it.

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
marker line carries the intended logical verdict, such as `approved`. The receipt contains that review's ID as one
`ReceiptReview`, and the controller reads it back from `/pulls/<number>/reviews/<id>`. The fallback is not an issue
comment. For native `APPROVED` and `CHANGES_REQUESTED` states, the marker verdict must agree with the provider state.

## Attempt files

The controller creates one immutable session directory per attempt:

```text
/data/sessions/<flow-instance-id>/<attempt-id>/
  context.json
  receipt.json
  harness.log
  harness-session/
```

The harness receives `AGENT_FLOW_CONTEXT_PATH` and `AGENT_FLOW_RECEIPT_PATH`. The controller treats `receipt.json` as
untrusted input, validates it, reads each referenced provider artifact back, then copies the accepted receipt into the
control comment. Losing the session directory does not lose operational state.

## Repository workspaces

The controller keeps one local base clone per allowlisted repository and one writable Git worktree per active flow
instance. Attempts for the same ticket reuse its worktree sequentially. Different tickets never share a working tree.
The controller validates the provider repository identity before each attempt and removes a worktree only after the
flow reaches a terminal state and no harness process is running.

## Docker contract

The image contains Node.js, Git, `gh`, `glab`, APM, Codex, and Claude. The container runs as one controller process and
mounts:

- the configuration repository at `/config`;
- persistent repositories, worktrees, and sessions at `/data`;
- provider and harness authentication directories through explicit Compose mounts.

The controller performs a startup preflight for every harness and provider enabled by the pinned catalog. Missing
binaries, authentication, or writable mounts fail startup before polling begins.

The prototype exposes a health endpoint on port `8080`. `/health/live` reports process liveness. `/health/ready`
returns success only after configuration validation, provider authentication, filesystem checks, and harness preflight
complete.
