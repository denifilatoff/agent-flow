# Operating workflow migrations

Deploy the migration-capable controller and publish the target configuration before requesting migration.
Configuration pins select workflow definitions, contracts, agent packages and locks, independently of the controller
binary. A controller upgrade alone leaves active pins unchanged. Migration is currently supported on GitHub only;
GitLab requests receive an unsupported-provider diagnostic without changing execution.

An authorized user with write, maintain or admin access comments on the active, open ticket:

```text
/agent-flow migrate --pr 8 --to latest
/agent-flow migrate --pr 8 --to latest --resume-from development
/agent-flow migrate --pr 8 --to latest --resume-from planning
```

Flags may be reordered. `--pr` explicitly selects the existing open linked PR. `--to` accepts `latest`, a tag (including
namespaced tags), or a full commit SHA. `latest` freshly resolves the configuration repository's advertised default
branch; a local repository must have a symbolic default HEAD. The controller freezes the resolved SHA in the receipt.
Moving a tag/branch later cannot move the accepted execution. Refresh, bundle, artifact or compatibility failure does
not fall back to an older cached revision.

Without `--resume-from`, unchanged contracts retain the current stage; changed contracts require a target-shipped
direct rule and use its default destination. `--resume-from` names the executable agent stage to repeat, at the current
or an earlier permitted point on the same activation route. It does not count transitions. Same-SHA replay is valid;
same-SHA without replay is a no-op that does not reset budgets. Requests never become ordinary human-gate answers or
blocked-stage retry resets.

The controller verifies the source activation/owner/pin, selected PR identity/provenance, target bundle and migration
rule. It drains old local work and requires confirmed process termination, then rechecks mutable input. It publishes
one immutable receipt comment and verifies readback before changing the effective pin, stage labels/cache or starting
target work. The receipt's stable request identity is its idempotency key. After uncertain delivery, complete provider
readback reconciles the same decision before another write. An uncommitted local proposal can be lost with complete
local-state loss; provider acceptance begins at the verified receipt.

The original PR branch, history, marker and controller identity are retained. New comments/reviews use the target pin.
Old assessments, plans, answers and reviews remain context. Replayed work and downstream approvals need fresh eligible
evidence, including on the same head/SHA. Development replay publishes a marked completion comment on the original
ticket as well as updating or revalidating the existing PR. A comment on the PR does not satisfy the ticket-comment
requirement. Migration receipts are control records and cannot substitute for stage results. CI and review remain
ordinary target-workflow checks, and merge stays manual.

A closed unmerged PR must be reopened by the operator before requesting migration. A merged PR cannot resume the same
implementation; follow-up work needs a separate decision. An unavailable/unlinked/foreign-repository PR, competing open
implementation, invalid or ambiguous mapping, forbidden replay, edited evidence, failed termination or changed source
produces a specific diagnostic. Resolve it and submit a new request. Do not edit receipts, rewrite old markers, change
activation labels as a migration mechanism, patch SQLite or create an automatic replacement PR. Automatic bulk
migration, ownership transfer and transitive mapping are unsupported.

Restart or receipt-before-label crashes recover the frozen decision and repair labels/cache. Surviving local records
preserve retry consumption; complete SQLite loss can reset retries and repeat unpublished substantive work. Later
justified provider progress must not rewind to the initial replay stage. Missing/contradictory provider history requires
clarification; the receipt is not a tamper-proof store or a durable model-attempt ledger. Closure, activation removal
and ownership loss prevent new work.

For the issue #2 / PR #8 case, publish and deploy this feature first, then separately authorize the desired migration.
The shipped old-CI rules return merge wait to development under required exact-head `verify` checks and fresh review.
Implementing this feature does not migrate that live ticket or repair PR #8's E2E timeout.

## DECISION_EVIDENCE_UNAVAILABLE during replay

The agent returned a decision without an eligible provider result. During development replay, the controller requires
both the selected open PR and a marked completion comment on the original ticket. A completion report on the PR alone
leaves the stage incomplete, even when its CI is green.

The next attempt's runtime prompt identifies the ticket and excluded comment IDs. It also reports this failure code
and asks the agent to repair the publication. The agent can reuse an eligible ticket result outside the excluded IDs;
comments in the migration baseline or the attempt's publication baseline cannot complete that attempt. If no eligible
result exists, the agent revalidates the work and publishes its completion on the ticket. Completed implementation and
checks need not be repeated without a new change or unresolved failure. The finite retry budget remains in force.

Maintainers author and test rules using [the canonical authoring guide](workflow-migrations.md). Pre-Stack upgrades
still follow [the existing upgrade restrictions](upgrading.md); this command is not a legacy-state converter.
