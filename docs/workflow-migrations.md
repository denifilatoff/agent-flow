# Authoring workflow migrations

Read this guide before changing workflows, execution contracts, or migration rules. Configuration commits select
workflow data, schemas, agent packages, and committed lockfiles; they do not select the controller binary. Updating
only the controller does not require migration. Operators request migration using
[the operator procedure](operating-workflow-migrations.md).

## Rule location and format

Rules are optional, target-pinned YAML files in `config/migrations/`. File names use lowercase letters, digits and
hyphens with a `.yaml` or `.yml` extension. Directories, symbolic links and executable extensions are rejected.
The controller loads rules from the verified configuration commit, never an uncommitted working tree.
`schemas/v1/workflow-migration.schema.json` defines the format independently of old Stack contracts. Do not add
this schema to an old bundle's required agent contracts. Unknown fields and versions are errors.

A rule identifies one exact full lowercase source SHA, source/target flow IDs and the existing activation label.
Each `states` entry names a source state, a default `target`, an explicit `replay` allowlist, and a `retain` allowlist
of preceding agent stages whose contracts are unchanged. State names do not establish compatibility. Rule IDs must
be unique, and exactly one rule must match the source SHA, flows and activation route. Only direct migrations are
supported; the controller never searches a chain of intermediate versions to invent a mapping.

The controller validates source references, target executability, activation routes and replay order. An explicit
replay selects an agent stage at or before the declared default destination. It cannot select a human gate, paused
state, terminal state, unrelated route or future stage. A paused source requires a verifiable resume state.
Rule authors own the semantic meaning of their mapping; mechanical validation establishes executability.

## Compatibility

Without a rule, deterministic digests must match for the complete normalized flow (excluding stage-to-agent bindings)
and every Stack-referenced contract/schema's parsed JSON content. Changes to transitions, guards, actions, context,
activation routes, required CI checks or contracts therefore require a rule. Object key order is immaterial; array
order is compared conservatively. Package/catalog-only changes can use identity state mapping when behavior matches.
The target catalog, manifests, committed locks, runtime bindings and harnesses must be executable. Production
acceptance stages each pinned package, runs frozen APM installation/compilation and preflights the selected harness.
A failed latest revision never falls back to another cached revision.

`retain` permits retention; it does not require every historical publication to remain eligible. Historical results
and owner answers always remain context. The current implementation explicitly references an unchanged-contract,
current-head review when retaining merge wait without replay or replaying verification. Verification replay requires
that permitted preceding approval; missing, stale-head or unauthorized approval is rejected before receipt commitment
with a request to replay review instead. The retained approval cannot cover a later PR head.
A no-replay migration at a human gate explicitly retains its verified predecessor comment (assessment, plan, or
reproduction), including its content digest. Recovery keeps that gate waiting from the retained result rather than repeating the predecessor; later justified progress
is reconstructed from the gate onward. Optional receipt `source.humanInput` records the ID and body digest of the
last interpreted human comment so recovery can skip consumed input while leaving a pending answer eligible.
Missing predecessor evidence rejects the migration and requests an explicit replay. If later feedback produces
revised predecessor publications, empty-store recovery revalidates the newest publication before selecting its
pending human answer. Completed gate revisions remain history when reconstructing downstream development, review
and merge-wait paths.
Recovery uses authorized human input between publications to separate completed gate revisions from downstream
results; a current agent result remains available for revalidation. Completed development/review rework pairs are also
history when a marked, authorized changes-requested review closes a development completion. Recovery checks the
review head and verdict evidence before isolating the corrected completion and current-head approval; earlier
rejections can refer to an older head. This does not discard the current completion candidate or accept stale approval.
A review-only replay can return to development before its receipt start stage. Recovery first verifies the
post-migration rejection and its author, then reconstructs correction and fresh approval from the declared
development target. Missing or invalid rejection evidence cannot justify that backward transition.
A compatible migration that retains merge wait retains approval only for the receipt's observed PR head.
If that head changes, recovery follows the flow's declared `change-request-updated` transition to review before
reconstructing later results. Empty-store recovery can resume that review, but returning to merge wait requires
an authorized fresh approval of the current head; the retained approval cannot satisfy it.
A verification replay requested from merge wait first applies its verified receipt destination, even if the source
merge-wait label survives receipt commitment. Recovery revalidates the verification result before returning to merge
wait; a stale label cannot select review before the replay starts.
A verification-stage replay follows its declared head-change transition to review as well. After SQLite loss,
recovery reconstructs that review from the receipt head change and requires a fresh current-head approval
before verification resumes. An unexplained review label at the unchanged receipt head remains ambiguous.
When required CI routes back to development, successive authorized development completions can supersede earlier
completions without a rejection review. Recovery keeps the newest completion available for revalidation and still
requires current-head CI and approval. Intervening human input remains subject to human-gate recovery checks.
Other preceding publications remain context rather than being automatically accepted again. Rules that change
contracts cannot retain those changed result contracts.

## Complete examples

### Agent-only update without a rule

Keep `config/stack.yaml`, its referenced flow and contract/schema contents unchanged. Update, for example,
`agent-packages/developer/.apm/agents/developer.agent.md`; commit any changed external dependencies with their
`apm.lock.yaml`. Publish the configuration commit. Do not add a migration rule for this update.
For an active development-route ticket at merge wait with PR 8, either command selects a valid earlier stage:

```text
/agent-flow migrate --pr 8 --to latest --resume-from development
/agent-flow migrate --pr 8 --to latest --resume-from planning
```

The configuration SHA is resolved once. The same commands also support same-configuration replay. A same-SHA
request without `--resume-from` is a no-op and cannot reset attempts. Without replay, unchanged compatible workflows
keep the current stage; retaining merge wait requires a verified current-head approval whose contract is unchanged.

### Changed CI policy with an exact direct mapping

The following is the complete shipped `config/migrations/old-ci-policy.yaml`. It applies to the old autonomous
source configuration and the target autonomous flow. The target SHA is the commit containing this file; embedding
its own future SHA is unnecessary. The bugfix route has the separate shipped `old-ci-policy-bugfix.yaml` rule.

```yaml
apiVersion: agent-flow/migration-v1
kind: WorkflowMigration
id: old-ci-policy-development
source: 896c0003dd5c42350ee0628a4dc30b680409fefa
sourceFlow: development-autonomous
targetFlow: development-autonomous
activationLabel: agent-flow:development
states:
  awaiting-merge:
    target: development
    replay: [assessment, planning, development]
    retain: []
```

```text
/agent-flow migrate --pr 8 --to latest
```

This returns `awaiting-merge` to `development`. The bugfix rule maps `bug-awaiting-merge` to `bug-development`.
New development completion still passes ordinary exact-head required `verify` CI and fresh review before manual merge.
Neither the rule nor the receipt manufactures passing CI or approval.

### Earlier-stage replay on the same PR

Use the complete rule above with the explicit permitted earlier stage:

```text
/agent-flow migrate --pr 8 --to latest --resume-from planning
```

The receipt binds the existing PR's repository, number, URL, head repository, branch, observed head and original
marker, plus the original activation/owner, request identity, compatibility basis and workspace identity. It does not
rewrite the PR description or earlier publications. Old planning results, downstream development results, reviews
and approvals cannot finish the replay, even on the same SHA or head. Replayed planning publishes a fresh result;
configured human gates require new answers. The developer updates the same branch/PR and publishes a fresh marked
completion comment, including when revalidation needs no code change. New comments/reviews use the target pin.

### Rejected unsupported mapping

The complete document below is invalid because `done` is not an executable agent destination. Publishing it in the
target configuration makes that target unavailable for migration; the source pin and stage remain unchanged.

```yaml
apiVersion: agent-flow/migration-v1
kind: WorkflowMigration
id: unsupported-terminal
source: 896c0003dd5c42350ee0628a4dc30b680409fefa
sourceFlow: development-autonomous
targetFlow: development-autonomous
activationLabel: agent-flow:development
states:
  awaiting-merge:
    target: done
    replay: []
    retain: []
```

Likewise, a malformed/missing source SHA, unknown source state, missing source mapping, two matching rules, changed
contracts without a rule, forbidden replay target or unavailable lock/artifact is rejected. Resolve the diagnostic
and submit a new authorized request. Do not edit historical markers or receipts, relabel activation, or patch SQLite.

## Validation and recovery testing

Run these existing commands from the repository root before publishing a target configuration:

```sh
node --test test/config/migrations.test.ts
node --test test/runtime/migration.test.ts test/runtime/migration-recovery.test.ts
npm run typecheck
npm test
npm run build
npm run test:e2e
```

The configuration tests load these guide examples and the real old source bundle. Positive cases cover agent-only
planning/development replay and both old-CI routes; negative cases cover invalid source identities, missing or
ambiguous mappings, changed contracts and forbidden targets. There is no separate migration validation CLI.

One immutable provider receipt is the commit point. Before its verified readback no target work starts. Recovery
validates the original owner/activation, request content identity and unique receipt chain, then the target pin,
selected PR, result boundary and later justified progress. Edited requests/receipts, forks or incomplete provider
reads stop with a diagnostic. A crash between receipt and labels repairs the labels/cache without another replay.
Surviving SQLite retains retry consumption; complete SQLite loss may reset retries or repeat unpublished work.
The receipt preserves the migration decision, not a durable ledger of every later model attempt. Activation removal,
closure or ownership loss prevents new work. GitHub migration is supported initially; GitLab migration is rejected
before changing execution, while ordinary GitLab flows remain supported.
