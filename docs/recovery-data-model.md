# Recovery data model

Status: Implemented. See [ADR 0001](adr/0001-provider-commit-points-and-local-execution.md).
The SQL layout is a local implementation choice; it is not a provider protocol or a durable workflow ledger.

## Provider publication

```html
<!-- agent-flow:v1 {"config":"<configuration-sha>","controller":"<controller-id>"} -->
```

| Element | Contract |
| --- | --- |
| `agent-flow:v1` | Exact format marker; not a controller release number or an authentication mechanism. |
| `config` | Full 40-character lowercase configuration commit SHA, matching the existing configuration loader. |
| `controller` | Lowercase UUID generated for the installation, independent of the provider user account. |

The v1 object requires exactly these two fields. Reject duplicate blocks, invalid fields, or unsupported formats.
An absent block is different from a malformed or legacy block; only unmarked, authorized human input is eligible for
human gates. Parse the raw Markdown body, not rendered HTML. Do not extract quoted examples or fenced code as markers.
Append one standalone block outside code fences to substantive publications. Supply it on creation, not in a later edit.

Do not persist stage, attempt, retry count, run ID, sequence, or timestamp in this common block. Native metadata
supplies object identity and time. A review still needs its reviewed head and logical verdict, including the existing
`agent-flow-review:v1` fallback where native self-approval cannot express the verdict.

The selected configuration repository and flow path are installation settings. Preserve them during transfer.
The comment SHA does not identify the repository or select between different flow files with the same activation label.

## Installation files

```text
<data-directory>/
  controller-id
  execution.sqlite
  sessions/
  repositories/
  worktrees/
```

`controller-id` contains one UUID and a newline. Generate it once using `crypto.randomUUID()`. Write a unique temporary
file in the same directory, then atomically hard-link it to `controller-id` without replacement. On `EEXIST`, read the
winning complete file. Remove the temporary name in either case. Invalid existing content
fails startup. Identity creation is not an execution lock. Each directory is operated by one supervised controller
process, with the existing per-ticket in-process exclusion. No cross-machine lock is introduced.

Separate data directories permit multiple installations per host. Clone configuration, not identity, for an independent
installation. Preserve identity when moving the same installation, and stop its old executor and agents first.
If identity is lost but published work exists, recover the original identity through an explicit operator recovery;
never automatically adopt a foreign publication's UUID. Keep credentials outside these records.

## SQLite schema

Use the built-in Node 24 `node:sqlite` API with short synchronous transactions. No ORM, database server, or new SQLite
package is needed. See [Node SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).
The pinned Node 24 image runs a `DatabaseSync` smoke check during its Docker build.

One table is enough. Keep the existing validated control-state shape as local runtime payload during migration.
Its fields are no longer a published wire contract. Avoid separate tables for artifacts already stored by the provider.

```sql
PRAGMA user_version = 1;
CREATE TABLE ticket_execution (
  provider_scope TEXT NOT NULL,
  repository TEXT NOT NULL,
  ticket_number INTEGER NOT NULL CHECK (ticket_number > 0),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (provider_scope, repository, ticket_number)
) STRICT;
```

`provider_scope` is a canonical tuple of provider kind and credential-free API base URL, serialized consistently.
It prevents identical repository names on different provider hosts from sharing a row. `revision` is a local
compare-and-swap revision used by callbacks and reconciliation. It is never an ownership or fencing token.

The validated JSON payload has this TypeScript shape:

```typescript
interface LocalExecution {
  controllerId: string;
  observedAt: string;
  owner: { controllerId: string; publicationKey: string } | null;
  disposition: "ready" | "waiting" | "foreign" | "ambiguous" | "inactive";
  reason: string | null;
  publicationKeys: string[];
  control: ControlState | null;
}
```

`ControlState` refers to the existing type in `src/config/types.ts`, retained locally for the first implementation.
It contains the local flow identity, flow selection, config revision, stage/resume stage, activation evidence, latest
verified receipt, human-input cursor, linked PR/MR, and current attempt series. Its `sequence` is local bookkeeping;
keep it equal to the SQL revision for non-null control records. Do not use it to order provider publications.

| Field group | Purpose and recovery |
| --- | --- |
| Owner and publication keys | Cached observation; always subordinate to provider evidence. |
| Disposition and reason | Scheduling and operator diagnostics; `foreign` or `ambiguous` starts no agent. |
| Flow, configuration, activation | Local execution context; rebuild from labels, publication pins, and routing. |
| Stage, resume, human gate | Derived facts and interpretations; recompute or clarify after reset. |
| Attempt series and latest receipt | Preserve normal restart bookkeeping; reset/rebuild after database loss. |
| Linked change request | Cached identity and head; validate against provider facts before accepting results. |
| Session/process data | Sessions remain files, live process handles remain in memory; do not restore PIDs. |

`publicationKeys` is the baseline of relevant objects for the current attempt/iteration, not the entire ticket history.
Use stable provider keys, never only wall-clock timestamps, to associate newly observed results during normal execution.
After reset, this baseline is rebuilt from sufficient publication context; ambiguity must not become fabricated
evidence.
The payload stores no provider credentials or complete comment bodies.

## Transactions and lifecycle

- Open one connection per installation. Use SQLite's default rollback journal and a bounded busy timeout. No WAL or
  shared database across hosts is required. Do not hold a transaction across a provider call or agent execution.
- Validate JSON at the application boundary. `json_valid` checks syntax only. Use bound parameters for all values.
- A row update compares the expected local revision and increments it atomically. A stale callback reloads/reconciles;
  it cannot overwrite a cancellation, foreign-owner decision, or a newer local attempt.
- Commit an attempt start locally before launching it. A database write failure prevents launch. Record outcome and
  verified receipt locally; publish the stage label only after checking the relevant provider evidence.
- On ordinary restart, reconcile before using cached records. No persisted `started` status proves a process is alive.
  With the old executor stopped, mark interrupted attempts locally and inspect publications before repeating work.
- An empty database triggers reconstruction from active tickets. A surviving `blocked` stage remains blocked even when
  local retry counts are gone. Historical records never activate inactive tickets.
- Stop the process before resetting the database. Keep `controller-id`. Do not automatically delete corrupt databases
  or silently reinterpret unknown `user_version` values. Report the problem; an operator can move the stopped database
  aside and restart with an empty one. Known schema upgrades use a transaction.
- A warm database and an empty database both obey provider ownership. A stale cache cannot grant permission to work.

## Ownership observation

An eligible publication is a validated marked ticket comment, linked PR/MR description, or native review belonging to
identifiable current work and an authorized agent publisher. Human comments, legacy/damaged markers, unrelated PRs,
and previous activations do not elect an owner. Fetch enough pages and linked objects to establish this set.

Select the minimum tuple `(createdAt, publicationKey)` from eligible publications. For a review, `createdAt` is its
provider submission time. Use provider UTC timestamps, never local times or edit times. `publicationKey` is the tuple
`[providerKind, apiBaseUrl, repository, objectKind, objectId]` encoded as canonical JSON; break time ties by ordinal
string comparison, not locale collation. This deterministic tie-break is not a claim of real-time order within a tie.

PR/MR creation times are valid ownership times only when the block was included at original creation. Do not
retroactively mark an old object to win an election. If provenance cannot be established for legacy objects, stop for
migration.
A changed PR/MR description can remain result evidence when an earlier intact publication independently establishes
the same owner and configuration. It cannot win ownership at its original creation time. An edited or unverified
native review cannot supply approval; retain its identity in the attempt baseline and run a fresh review. An edited
assessment or plan remains ambiguous and does not inherit an earlier human approval.

The earliest owner also determines the configuration of active work; ignore losing pins rather than treating those
pins as a configuration migration. Conflicting pins from the winning controller require explicit resolution.

Election is recomputed from provider evidence on ordinary reconciliation. A partial read elects nobody. The loser
cancels local work and emits no provider mutations. Its agent comments never become human input. The winner can ignore
losing duplicate comments but must inspect conflicting PRs/code before continuing. No automatic deletion or rollback.

Ownership is an observation, not a lease. Deleting or modifying the earliest publication can destroy evidence. When
ownership cannot be established, pause rather than choosing a cached or arbitrary owner. Database loss also loses any
knowledge of deleted evidence; the system does not promise recovery of facts removed from the provider.

## Legacy rollout

The existing space-delimited `agent-flow:v1 flow=...` marker is a different legacy format despite the shared version
text. Detect it explicitly, together with `agent-flow-control:v1`; never treat either as a human comment.

For the first rollout, complete or cancel legacy active work with the old controller before switching implementations.
Inactive legacy history stays untouched. A new activation must be distinguishable from that history. If active legacy
work is detected, report that migration is required and do not publish or assign a controller implicitly. No dual-write
mode, automatic historical rewrites, or silent takeover is implemented.

## Immutable migration receipt metadata

`schemas/v1/migration-receipt.schema.json` defines the separately versioned `agent-flow-migration:v1` comment block
alongside the unchanged two-field common marker. It records provider/ticket identity, original activation and
ownership anchor, stable accepted request ID/actor/body digest, source pin/stage/resume, frozen target
pin/flow/route/compatibility basis, exact carried PR URL/repository/branch/head/source marker, workspace UUID,
restart stage, baseline comment/review IDs, explicit retained-result references/digests and predecessor receipt ID.
A no-replay human-gate migration retains its predecessor result; optional `source.humanInput` stores the last
interpreted human comment ID/body digest. Recovery verifies that comment and its author permission before restoring
the input cutoff, leaving any later pending answer eligible. Older receipts without this optional context remain valid.
Publication authors and original provenance remain provider-validated facts. Receipt comments are append-only commit
points, not mutable control state. Optional local `LocalExecution.migrationId` caches the verified boundary; it does
not alter old pinned ControlState schemas. The boundary participates in logical attempt input identity. Losing the
cache reconstructs provider commitment while retaining the existing disposable retry limitations.
