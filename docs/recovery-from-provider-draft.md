# Recover execution from GitHub or GitLab

Status: Implemented recovery specification, September 4, 2026.

GitHub/GitLab is the commit point for work. SQLite stores local execution details. Recover from published results and
provider labels; repeat unpublished work. [ADR 0001](adr/0001-provider-commit-points-and-local-execution.md) records the
decision. The [architecture](agent-flow-architecture.md) and [data model](recovery-data-model.md) define the contracts.
The filename is retained so links from the design discussion remain valid.

## Accepted boundaries

- Start or resume automated work only when the ticket has the configured activation label. For the development flow,
  that label is `agent-flow:development`. A stage label, a managed label, a comment, or a PR alone cannot activate work.
- Process only authorized activations in repositories assigned to this controller. Installations normally have disjoint
  routing. Accidental overlap is allowed until ordinary reconciliation observes the first publication and selects its
  controller as owner. Stop the old controller and agents before transferring the same installation identity.
- Treat the stage label as the provider's recorded execution stage. Read comments and PR/MR evidence to determine
  whether that label needs reconciliation after an interrupted transition.
- Preserve published comments, PR/MR changes, and reviews as external results. Losing SQLite does not undo them.
- Discard local attempts, timers, process identities, unpublished edits, diagnostics, and uncommitted interpretations.
  Rebuild local execution records as needed. Retry consumption can reset after loss of the database.
- Use no separate controller state comment. Attach the small block below to substantive agent publications.
- Keep checking provider state during execution. Startup reconciliation does not replace cancellation and head checks.

The owner accepted the activation gate, publication boundary, two-field block, disposable local state, and eventual
collision resolution without a second ownership read. Ambiguity can require operator clarification.

## Exact common metadata

Each agent-authored comment carries one controller-generated block in its raw Markdown body:

```html
<!-- agent-flow:v1 {"config":"<full-configuration-commit-sha>","controller":"<controller-id>"} -->
```

`agent-flow` identifies an agent publication. `v1` versions this metadata format, not the controller or configuration.
`config` is the full commit SHA used for that publication. `controller` is the persistent installation UUID.
Both values are controller-supplied. These are the only common fields; the marker and validation rules are defined in
the data model. Neither value identifies an individual attempt.

The controller supplies the block as part of the original publication body and validates it on readback. It must not
depend on a later edit to add the block: a crash between publication and that edit would leave an unmarked result.
The controller owns the metadata even when an agent performs the API publication.

Do not add the block to human comments. An unmarked comment is a candidate for human input, subject to permission and
context checks. A marker is not authentication. A malformed block, unsupported version, or suspicious publication
requires inspection; it must not be silently reclassified as human approval.

Put the same block in an agent-created PR/MR description when that object can be the only publication of the work.
Preserve its configuration pin during edits within the same work. A native review can carry the block in its body.

The common block omits `run`, `seq`, `state`, `flow`, attempt counts, timestamps, URLs, and copied provider facts.
Object IDs, authors, timestamps, labels, and PR/MR status come from the provider. Result-specific facts remain in the
result or its native metadata: for example, the reviewed head SHA and the target ticket of a PR/MR.

The hidden block is readable through the provider API and comment editor. It is not confidential storage.

## Configuration and flow selection

Elect the owner first, then recover the pin from its publications associated with active work. Do not choose a pin
merely because its
comment has the latest edit timestamp. Old results can be edited, and one ticket can contain previous activations.

Resolve that SHA against the configured configuration repository. A replacement machine must have access to this
repository and the pinned commit. A SHA does not preserve the commit's contents. Missing configuration prevents work;
never silently substitute the latest revision.

The common block does not identify a repository or flow file. Machine transfer must preserve the configuration
repository identity and flow selection/routing, or those must be unambiguous from provider labels and the pinned
configuration. If two possible flows share an activation label and stage, the SHA alone cannot choose between them.
This is a deployment prerequisite, not an additional comment field.

If active work has no publications and no evidence of a missing former publication, start with the current
configuration. There is no published pin to recover. This does not permit falling back to current configuration when
a known pin is malformed, unavailable, or conflicting.

## Recovery procedure

1. Discover tickets with the configured activation label in the controller's assigned repositories. Verify activation
   authorization. Historical publications without activation do not start agents or cause recovery comments.
2. Read the ticket, stage labels, relevant comments, linked PR/MR objects, and reviews.
   Fetch the pages needed to decide.
   A failed or incomplete read is an unavailable snapshot, not evidence that a result is absent.
   Retry the read first.
3. Establish the boundary of active work using the rules above. Use provider activation history when available
   and sufficient. A currently present activation label establishes eligibility, not the identity of a repeated run.
4. Elect the owner as defined in the data model. If foreign, stop local work without provider writes.
   Load the winning pinned flow. Match the recorded stage against its states and inspect the required published
   evidence.
   Do not invent a stage if labels conflict, a recorded stage is invalid, or several reconstructions remain possible.
   For a verified new activation after a terminal run, initialize the entry stage if the new work has no publications.
   An old `done` or `cancelled` label does not complete the new work. An uncertain run boundary follows C11.
5. Choose one outcome: no work, wait for human input, continue an existing result, repeat unpublished work, finish the
   flow, or pause this ticket for clarification. Other unambiguous tickets can continue.
6. Persist the reconstructed working state in SQLite and act on ordinary reconciliation evidence. Do not perform
   a second ownership read before publication. Keep required result readback and review-head checks; observed
   cancellation, ownership loss, or input changes prevent stale callbacks from advancing the flow.

A closed ticket does not launch another agent. A verified merge completing the existing flow can explain closure;
otherwise treat closure as cancellation. If activation is absent, perform no recovery-driven work on this ticket.
Terminal cleanup must finish before removing activation, because a fresh controller will not rediscover an inactive
ticket as runnable work. A deployment may separately display historical tickets without activating them.

## Publication and stage transitions

Publish the substantive result with its block, read it back, validate its identity and required evidence, and then
update the stage label. Treat the provider update as the recorded transition only after verifying it.

There is no transaction spanning a result publication and a label update. After a crash, compare both. Never equate
the existence of a marked comment or a PR with successful completion of a stage.

The pinned flow's result contract must distinguish a completed result from a question, progress note, or partial
implementation. After local data loss, a human gate returns through its unique preceding result-producing agent for
reassessment. An open bugfix merge wait similarly reassesses the preceding verification result. Native reviews are
checked against their logical verdict, author permission and current head; stale or missing approval returns through
review. After migration, authorized approvals for superseded heads remain historical evidence when reconstructing
downstream stages, so a head-change review cycle does not count both approvals as current results. Recovery still
requires an authorized current-head approval before restoring merge wait. The
reassessment uses existing agent decisions and provider readback, preserves the original publication identity, and
keeps an authorized answer after that publication eligible. It adds no common metadata fields. Recovery can rerun an
agent to interpret published content and inspect code. An interpretation that
existed only in SQLite can be recomputed. Natural-language interpretation is not guaranteed to be identical on replay.
If a single prior candidate is incomplete, the agent may publish one new result or question. Readback distinguishes
that new object from the pre-attempt candidate by object identity, then validates the selected result. Multiple new
matching objects remain ambiguous. If the available evidence does not justify a transition, continue unfinished work
or ask for clarification.

An external operation with an uncertain API response must be read back before retrying publication. Reuse an existing
matching PR/MR or result. If several objects match and identity is unclear, pause instead of choosing arbitrarily.

Clarification can be a substantive question on an active ticket when the pin and question context are known. Reuse an
existing unresolved question instead of posting it on every reconciliation. If the pin or routing is unknown, report
the missing fact through the operator interface; do not invent a configuration just to publish a marked question.
An operator correction must be reflected in provider evidence or stable deployment configuration to survive another
database reset. These are proposed handling rules, not permission to send messages during this document-writing task.

## Recovery cases and expected decisions

The following cases preserve the scenarios and answers discussed before drafting. The activation gate applies to all
cases. Each case describes a decision from provider evidence, not from a surviving SQLite record.

### C1: No published result

An active ticket is in `planning`; the agent worked locally but published nothing. Repeat planning. Use the pin from
earlier publications of this work, or current configuration if the work has never published anything. Do not recover
attempt counts or unpublished files.

### C2: Result and stage agree

A complete plan is published with the block; the stage is `plan-review`. Load the pinned configuration and have the
planning agent reassess the published plan through the ordinary
result/readback path. Reuse a suitable plan without publishing it again, then return to `plan-review` and look for
an authorized answer. Wait if no answer exists; otherwise follow C7. Do not create the plan again.

### C3: Publication succeeded before the stage update

A plan exists, but the stage is still `planning`. Validate that it is the completed plan for the current iteration.
If it is, advance the stage. A progress note is not completion. If iteration or completion is ambiguous, reassess the
published work or clarify; do not skip work merely because an old plan exists.

### C4: Stage advanced, but the required result is missing

The stage is `plan-review`, but no plan is available. Complete provider reads before declaring absence. If the result
is truly missing, regenerate it through a flow-permitted recovery path. If no such path is defined, pause for operator
correction. Never ask a human to approve nonexistent content. This can result from deletion or manual label edits.

### C5: PR/MR exists without an agent summary comment

Read the block from the PR/MR description and reuse the linked object. Inspect the code and stage requirements.
Continue development for partial or draft work, or advance if completion is verified. A PR's existence alone is not
success. An ambiguous link to multiple PRs/MRs requires clarification.

### C6: Published question has no answer

The stage is `needs-human`, with an unresolved marked question. Wait without posting a duplicate. Infer the stage to
resume from the question, prior results, and flow. If several resume stages are possible, clarify instead of guessing.

### C7: Human answer exists, but processing was interrupted

Read the authorized answer in the context of its question and interpret it again under the pinned flow. A local-only
interpretation was not committed. A warm restart preserves the unfinished attempt's publication baseline, so a result
published before its receipt was saved remains eligible for reuse. If the stage already advanced and its required
evidence exists, do not apply the
same answer again. An unclear answer requires clarification. The marker does not prove human authorization.

### C8: Several rounds of feedback

Old and revised plans and approvals coexist. Associate each answer with the result it addresses using published
context and chronology. An approval of an old plan does not approve a replacement. Editing an old comment does not
make it a new result automatically. If the relationship cannot be established, request clarification.

### C9: Code changed after review

For an open PR/MR, compare the reviewed SHA from native review metadata or the published review with the current
head. Review the new head if they differ. If the reviewed SHA is unavailable, do not reuse the approval; review again.
The common
configuration SHA is not the reviewed code SHA.

### C10: PR/MR merged or closed while the controller was absent

For an active ticket awaiting merge, verify the linked merge and finish the flow. Merge is the final human decision,
including after SQLite loss when a prior review is missing, stale, or requests changes. Preserve ownership, pinned
configuration, activation boundary, linked-object identity, and the recorded merge-wait stage. A merged object
inconsistent with that work requires reconciliation. If the PR/MR closed without merge, ask whether to reopen
or cancel; do not create a replacement automatically. A closed ticket or removed activation prevents new agent work.

### C11: The same ticket was activated again

Old publications can have the same configuration SHA. Use sufficient provider activation history and publication
context to distinguish the new work. If that boundary cannot be recovered, clarify which results to reuse. Activation
alone does not identify a run. No `run` field is introduced to hide this limitation.

### C12: Pins conflict or configuration is unavailable

Elect the owner first and ignore losing publications as configuration evidence. Different SHAs from the winning
controller may represent old activations, an explicit migration, or an erroneous publication. Resolve the active
pin only from sufficient evidence. Do not select the latest comment blindly. Pause if the pin is ambiguous or its
configuration cannot be loaded. Never silently migrate to the current revision.

### C13: Deleted, edited, or malformed publication

Use the remaining trustworthy provider evidence. A deleted result is unavailable. A damaged marker is neither a valid
agent receipt nor automatic human approval. Check context and authorship. Regenerate missing work where permitted;
otherwise clarify. An unsupported marker version requires a compatible reader or an explicit migration.

### C14: Activation is absent

Stage labels, old agent comments, a managed label, and an open PR/MR do not authorize execution. Ignore the ticket for
automatic recovery. This gate precedes result interpretation and configuration selection.

### C15: Stage labels are missing or contradictory

For a verified fresh activation with no publications of the new work, initialize the configured entry stage.
This includes a verified reactivation after a completed or canceled run whose terminal label is still present.
If the new activation boundary is uncertain, follow C11 instead. Otherwise reconstruct only if provider evidence and
the pinned flow admit one valid stage. Conflicting or unexplained labels require correction. A hidden block with only
`config` and `controller` cannot reconstruct an arbitrary lost stage.

### C16: Retry exhaustion survived only as a stage label

A surviving `blocked` label remains a stop even though SQLite's attempt counts are gone. Follow the flow's authorized
resume policy. If the original stage or blocking cause cannot be recovered, ask for correction. If no blocked state
was published, restart local retry accounting and repeat unfinished work.

### C17: Provider reads fail or change during recovery

Retry incomplete reads without assuming comments or PRs are missing. Use ordinary reconciliation for mutable facts and
preserve required result/head checks. A changed
head invalidates stale review evidence; removed activation cancels execution. SQLite reconstruction alone grants no
authority to proceed with an obsolete snapshot.

## Data sufficiency and review criteria

The common block identifies the format, publication configuration, and originating controller. Labels and provider
objects supply other facts. It is not a standalone execution checkpoint or proof of stage completion.

Automatic continuation requires unambiguous evidence for activation, configuration, selected flow, stage, result
identity, and any human approval or code revision used by a transition. Recompute unpublished interpretations and
repeat unpublished work. Pause when these requirements cannot be established from available evidence.

The format intentionally does not guarantee automatic recovery of repeated-run boundaries, arbitrary stage loss,
ambiguous human answers, or a shared `needs-human` resume target. These cases need clarification or a separately agreed
stronger publication contract. No additional common fields have been approved.

Implementation acceptance must check C1-C20 against the rules above and the conversation. Classify each as recoverable,
recomputable, or ambiguous with an explicit fallback. Report any case that requires missing data for its claimed
automatic action. Distinguish accepted owner decisions from proposed fallbacks and implementation prerequisites.
Verify that no path bypasses activation, silently changes configuration, or treats the block as an approval receipt.

## Additional ownership cases

### C18: Another controller already owns current work

Ordinary reconciliation finds the earliest eligible publication with a different controller UUID. Cancel local agents,
mark the local record foreign, and perform no provider writes. Do not remove activation, change stages, or publish an
ownership warning. The owner's continued absence does not authorize takeover.

### C19: Two controllers publish before observing each other

Read sufficient current-work publications and apply the shared `(createdAt, publicationKey)` ordering. The loser stops;
the winner ignores losing comments for results and human input. Leave duplicate comments intact. Do not add a second
ownership read to prevent recurrence. Conflicting PRs/code require inspection and clarification if ambiguous. Losing
labels can also have changed: the winner reconciles them against its flow and actual results rather than trusting an
otherwise unexplained forward stage. If the competing workflows are incompatible, pause instead of inventing a stage.

### C20: Identity or the ownership anchor is unavailable

Resetting SQLite preserves the separate identity file, so the original installation can resume after reconstruction.
If the identity file is lost, the replacement must not silently take another controller's work. Recover the identity
explicitly after the old process stops. If the active-work boundary or earliest publication cannot be established,
pause the ticket. Deleted provider history is not guaranteed to be reconstructible from an empty database.

## Review and acceptance status

An independent agent reviewed the earlier configuration-only draft and cases C1-C17. Its two findings were fixed:
C2 handles an existing human answer, and C15 distinguishes reactivation from a previous terminal stage.
That review predates `controller` metadata and eventual collision resolution; it is not approval of those additions.
The runtime and provider fixture suites cover the recovery, ownership, ambiguity, legacy, and API-budget boundaries.

A subsequent independent review covered the two-field block, ownership cases C18-C20, updated architecture, data model,
and implementation plan. Its findings were corrected and rechecked. Runtime support is implemented with provider
fixture and unit coverage; full live-provider restart and collision acceptance remains separate end-to-end validation.

## Migration receipt boundaries

Before ordinary mixed-pin/result classification, validate immutable migration receipts against their original
activation/owner anchor, accepted request content and unique predecessor chain. Validate the exact source/target
bundles and declared compatibility decision, selected PR repository/branch/original marker, workspace identity,
explicit retained-result references and comment/review baseline. Only a verified receipt establishes a new
pin/replay boundary. A carried old PR marker binds only that PR; it grants no target ownership or approval. Same-pin
replay excludes prior selected/downstream results. Receipts and migration commands are not stage results or human
answers. After a receipt-before-label/cache crash, repair the same committed decision; after later work advances,
use justified provider evidence rather than resetting to the receipt’s initial stage. Uncertain writes require
complete readback before retry. Edited requests/receipts, forks, incomplete evidence, unavailable pins or
contradictory stages stop with diagnostics. Activation removal, closure and foreign ownership still stop work.
Surviving SQLite retains retry counts; complete loss may reset them or repeat unpublished work. The receipt is not
an attempt ledger. See [the migration authoring guide](workflow-migrations.md).
