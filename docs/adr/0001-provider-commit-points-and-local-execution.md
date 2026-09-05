# Provider commit points and disposable local execution

## Status

Accepted

#### Date

2026-09-04

#### Owner

@denifilatoff

#### Participants and approvers

Repository owner, through the design discussion. Documentation and implementation planning assisted by Codex.

#### Related ADRs

None.

## Context

The prototype stores execution state in a separate mutable GitHub/GitLab comment. That exposes machine JSON in ticket
conversations and requires provider reads and writes for attempt bookkeeping. The owner wants substantive agent
publications to be the recovery boundary, with intermediate execution stored locally in SQLite.

Installations normally run different workflows against different repositories. Overlapping installations indicate a
configuration mistake. Preventing every simultaneous first publication would cost coordination and extra API calls
for a rare scenario. The owner accepts duplicate work before the next ordinary reconciliation.

## Decision

We will treat GitHub/GitLab publications and labels as committed operational facts and use disposable SQLite for local
execution. Work not published to the provider can run again after local data loss. Published work is inspected and
reused; the existence of a comment or PR/MR alone does not prove stage completion.

Automated work requires an authorized activation label. The stage label records the current stage. Every agent
publication contains a controller-generated hidden block with only the configuration commit and controller identity:

```html
<!-- agent-flow:v1 {"config":"<configuration-sha>","controller":"<controller-id>"} -->
```

The block is part of the original comment or PR/MR description. Human comments are not marked. `v1` versions this
format. Configuration and controller identity are not chosen by the agent. Review-specific evidence, including the
reviewed code SHA, stays in the review rather than becoming common metadata.

Each installation generates a persistent controller UUID outside SQLite. Multiple installations can share a machine
using distinct data directories. Resetting SQLite preserves identity. Moving an installation preserves its identity
and routing configuration after the old executor and agents stop. No controller-assignment label is introduced.

For identifiable active work, the first eligible marked publication determines the owner. All installations apply the
same provider-based ordering. Other controllers stop their local work when ordinary reconciliation observes this
owner. Losing comments remain in history but cannot satisfy result or human-input guards. Ambiguous external changes
require operator inspection; do not delete PRs or undo code automatically.

We will not add a second ownership read before publication, a distributed lock, a lease, or a central coordinator.
Two controllers can publish before observing each other. Once they read the same complete evidence, the ordering rule
selects the same owner. Ordinary result readback, authorization, cancellation, and review-head checks remain required.

### Justification

Keeping one technical comment was recoverable but retained the unwanted machine-state conversation artifact.
Copying its entire payload into each result would duplicate state and preserve unnecessary retry bookkeeping.
A distributed ownership protocol would solve a stronger concurrency problem than this deployment requires.

The chosen approach keeps publications useful to humans, limits common metadata to two fields, and accepts rework
instead of protecting unpublished local progress. SQLite is local implementation state, not another canonical store.

## Consequences

- Provider API traffic no longer includes attempt-state comment writes. Required evidence reads remain.
- Losing SQLite can reset retry counts and require repeated work or repeated interpretation of human replies.
- Automatic recovery depends on sufficient published evidence. Ambiguous run boundaries, flow selection, result
  identity, or resume targets pause the affected ticket instead of guessing.
- Configuration repository identity, flow routing, pinned commits, credentials, and controller identity must be
  available after transfer. A fresh UUID cannot silently take over work owned by a missing installation.
- Accidental overlap can produce duplicate comments or external changes. This design provides eventual ownership
  selection, not mutual exclusion, exactly-once publication, or fencing of a stale executor.
- Existing legacy control comments require an explicit migration path. The new reader must not interpret them as human
  input or silently claim unowned work.
- The architecture, recovery specification, data model, and implementation plan define the concrete contracts. This
  record accepts the decision; it does not claim that the code already implements it.
