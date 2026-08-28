# GitOps Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the reviewed GitOps configuration boundary with a pinned Git stack, one mounted runtime file,
file-based credentials, safe reload and drain behavior, provider-visible execution snapshots, and the complete Docker
contract.

**Architecture:** Split the current mixed controller configuration into a Git-owned `Stack` and a deployment-owned
`RuntimeConfig`. A small runtime manager owns validation, stable digests, reload boundaries, and restart/drain status;
the existing reconciler remains provider-backed and loads every unfinished flow's exact pinned stack revision before
starting work. Existing provider, scheduler, harness, and health components receive the minimum dynamic inputs needed
instead of gaining a second configuration API.

**Tech Stack:** TypeScript, Node.js standard library, YAML, AJV JSON Schema, XState, Node test runner, Git, Docker
Compose.

**Spec:** `docs/plans/2026-08-29-gitops-configuration-design.md`

## Global Constraints

- GitHub or GitLab remains the only canonical operational store.
- The only runtime configuration path is `/etc/agent-flow/runtime.yaml`; no environment or CLI override is added.
- Configuration revisions are full 40-character commit SHAs; branches, tags, abbreviated SHAs, and fallback revisions
  are rejected.
- Git flow files stay data-only and cannot contain executable code, shell commands, or inline scripts.
- Secret values are read from regular mounted files only at startup and never enter logs, digests, snapshots, provider
  metadata, or dashboard responses.
- No database, durable queue, distributed lease, webhook, second controller, signal reload, watcher, mutation API, or
  speculative Kubernetes implementation is introduced.
- Every behavior change follows a red-green test cycle. Each integration checkpoint runs typecheck, relevant unit tests,
  and the complete unit suite before its local commit.

---

## Checkpoint 1: Git-owned stack and required pinned revisions

### Task 1: Replace the mixed Git documents with one stack entry point

**Files:**

- Create: `schemas/v1/stack.schema.json`
- Create: `config/stack.yaml`
- Modify: `schemas/v1/agent-catalog.schema.json`
- Modify: `config/agents.yaml`
- Delete: `config/agents-codex.yaml`
- Modify: `src/config/types.ts`
- Modify: `src/config/schema-validator.ts`
- Test: `test/config/schema-validator.test.ts`

**Interfaces:**

- Produces `StackDefinition`, containing the flow, logical catalog, contract, and schema paths for one revision.
- Produces a logical `AgentCatalog` whose entries contain only `{ package: string }`.

- [ ] Write schema tests that accept `config/stack.yaml`, reject stack paths outside the pinned repository, reject
  execution settings in the logical catalog, and reject the removed target-specific catalog.
- [ ] Run the focused tests and confirm they fail because `Stack` is unknown and the catalog still owns execution.
- [ ] Add the minimal types, schema registration, `Stack` schema, stack manifest, and logical catalog migration.
- [ ] Run `node --test test/config/schema-validator.test.ts` and confirm it passes.

### Task 2: Load and validate every stack reference from the same commit

**Files:**

- Modify: `src/config/load.ts`
- Modify: `src/config/semantic.ts`
- Modify: `src/config/repository.ts`
- Test: `test/config/semantic.test.ts`
- Test: `test/config/repository.test.ts`

**Interfaces:**

- `loadStackBundle(root, stackPath, revision): Promise<ConfigBundle>` loads the stack, flow, logical catalog, and every
  declared contract/schema through the existing pinned-root traversal protection.
- `loadPinnedConfig(repository, dataDirectory, revision, stackPath)` retains verified cached materializations and never
  resolves `HEAD` when a revision is supplied.

- [ ] Write failing tests for missing, unreferenced, escaping, symlinked, or cross-revision stack references.
- [ ] Extend materialization from hard-coded controller paths to the stack-owned roots without allowing arbitrary files
  or symbolic links.
- [ ] Validate package manifests and committed APM lockfiles without consulting a harness target.
- [ ] Run the focused config tests and confirm they pass.

### Task 3: Preload current and unfinished flow revisions before reconciliation

**Files:**

- Modify: `src/provider/types.ts`
- Modify: `src/provider/github.ts`
- Modify: `src/provider/gitlab.ts`
- Modify: `src/runtime/controller.ts`
- Modify: `src/preflight.ts`
- Test: `test/provider/github.test.ts`
- Test: `test/provider/gitlab.test.ts`
- Test: `test/runtime/controller.test.ts`
- Test: `test/preflight.test.ts`

**Interfaces:**

- Provider bootstrap returns ticket references plus the parsed unfinished `configRevision` values discovered from
  provider-visible control comments.
- Preflight loads and validates the runtime revision and every unfinished revision before any ticket reconciliation.

- [ ] Write failing provider tests proving bootstrap collects exact SHAs from unfinished control comments while ignoring
  terminal history.
- [ ] Write a failing preflight/controller test proving no reconciliation starts when any required revision is missing
  or invalid.
- [ ] Add the smallest provider bootstrap metadata and preflight preload step; reuse control-comment parsing and the
  existing verified materialization cache.
- [ ] Run the provider, controller, preflight, config, and repository tests.
- [ ] Run `npm run typecheck` and `npm test`.
- [ ] Commit checkpoint 1 as `feat: load Git-owned stacks by pinned revision`.

---

## Checkpoint 2: Runtime generations, file credentials, and execution snapshots

### Task 4: Add the fixed mounted runtime contract and stable digest

**Files:**

- Create: `schemas/v1/runtime-config.schema.json`
- Create: `config/runtime.example.yaml`
- Create: `src/config/runtime.ts`
- Modify: `src/config/types.ts`
- Modify: `src/config/schema-validator.ts`
- Test: `test/config/runtime.test.ts`

**Interfaces:**

- `RUNTIME_CONFIG_PATH` is exactly `/etc/agent-flow/runtime.yaml`.
- `loadRuntimeConfig(path = RUNTIME_CONFIG_PATH): Promise<RuntimeGeneration>` validates one complete YAML document.
- `RuntimeGeneration` contains `{ config, runtimeDigest }`; the digest is SHA-256 over recursively key-sorted runtime
  data and includes secret paths but never secret contents.
- `ExecutionSnapshot` contains `{ harness, model, reasoning, maxAttempts, delaySeconds, timeoutSeconds }`.

- [ ] Write failing tests for the example runtime, exact SHA enforcement, unknown fields, unsafe paths, stable digest
  normalization, and secret-content exclusion.
- [ ] Add the runtime schema, example, types, canonical JSON normalization, and digest computation using `node:crypto`.
- [ ] Run `node --test test/config/runtime.test.ts test/config/schema-validator.test.ts`.

### Task 5: Read provider and harness credentials only from mounted files

**Files:**

- Delete: `src/config/provider-credentials.ts`
- Modify: `src/harness/types.ts`
- Modify: `src/harness/process.ts`
- Modify: `src/harness/codex.ts`
- Modify: `src/harness/claude.ts`
- Modify: `src/main.ts`
- Modify: `src/preflight.ts`
- Test: `test/harness/process.test.ts`
- Test: `test/production-credentials.test.ts`
- Test: `test/preflight.test.ts`

**Interfaces:**

- Startup reads each configured token/auth file with no-follow, regular-file, bounded-size checks and retains only the
  required in-memory value or source path.
- Provider CLI credentials use fixed internal environment names derived from provider/API host; runtime YAML never names
  environment variables.
- Harness adapters receive runtime-owned auth paths and run with the selected `model` and `reasoning` arguments.

- [ ] Write failing tests that start production dependencies without `HOME`, token variables, `CODEX_HOME`, or
  `CLAUDE_CONFIG_DIR`, and prove mounted secret values stay out of logs and unrelated child environment.
- [ ] Write failing harness tests for Codex `--model` plus reasoning config and Claude `--model` plus `--effort`.
- [ ] Replace environment lookups and host-directory discovery with validated mounted file inputs.
- [ ] Run the harness, credential, main, and preflight tests.

### Task 6: Implement reload acceptance, drain status, and dynamic scheduling limits

**Files:**

- Modify: `src/config/runtime.ts`
- Modify: `src/runtime/rate-limiter.ts`
- Modify: `src/runtime/scheduler.ts`
- Modify: `src/runtime/controller.ts`
- Test: `test/config/runtime.test.ts`
- Test: `test/runtime/rate-limiter.test.ts`
- Test: `test/runtime/scheduler.test.ts`
- Test: `test/runtime/controller.test.ts`

**Interfaces:**

- `RuntimeManager.reload(boundary)` keeps the last valid generation, accepts only reloadable changes, and exposes
  `restartRequired`, reason, validation errors, and changed restart-only fields.
- `RuntimeManager.mayStartWork()` is false for invalid or restart-only replacements and becomes true after correction.
- Rate-limit settings apply on the next provider request; scheduler concurrency applies to newly claimed jobs only;
  polling interval applies before the next delay.

- [ ] Write failing table tests for every reloadable and restart-only field, invalid replacement recovery, and a
  correction back to valid configuration.
- [ ] Write failing tests proving reduced concurrency does not cancel active jobs and rate-limit updates affect only the
  next acquisition.
- [ ] Implement one in-memory runtime manager and minimal setters/getters on the existing limiter, scheduler, and
  controller.
- [ ] Run the runtime manager, limiter, scheduler, and controller tests.

### Task 7: Persist one execution snapshot for every logical attempt series

**Files:**

- Modify: `schemas/v1/control-state.schema.json`
- Modify: `src/config/types.ts`
- Modify: `src/runtime/attempt-runner.ts`
- Modify: `src/runtime/reconcile.ts`
- Modify: `src/main.ts`
- Test: `test/provider/control-comment.test.ts`
- Test: `test/runtime/attempt-runner.test.ts`
- Test: `test/runtime/reconcile.test.ts`

**Interfaces:**

- `AttemptSeries` persists `runtimeDigest` and `executionSnapshot` before its first process starts.
- Retries and restart recovery use the persisted snapshot; a new state or input revision obtains a fresh snapshot after
  `RuntimeManager.reload("attempt-series")`.
- Active-attempt counting feeds runtime drain status without becoming canonical state.

- [ ] Write failing tests proving a runtime replacement between retries does not alter the series and a new series uses
  the new generation.
- [ ] Write a failing control-state round-trip test for `runtimeDigest` and `executionSnapshot`, including rejection of
  credential fields.
- [ ] Move retry and harness selection from the Git catalog into series creation and persist the exact snapshot before
  workspace or harness work.
- [ ] Run attempt-runner, reconcile, control-comment, config, harness, and production credential tests.
- [ ] Run `npm run typecheck` and `npm test`.
- [ ] Commit checkpoint 2 as `feat: manage mounted runtime generations`.

---

## Checkpoint 3: Read-only status, health, and Docker contract

### Task 8: Expose read-only configuration and restart status

**Files:**

- Modify: `src/health.ts`
- Modify: `src/main.ts`
- Test: `test/health.test.ts`
- Test: `test/main.test.ts`

**Interfaces:**

- `GET /health/live` stays process liveness.
- `GET /health/ready` is false while configuration is invalid, restart is required, or new work is drained.
- `GET /api/status` returns Git repository/SHA, runtime digest, validation errors, restart state, changed fields, active
  attempt count, and `safeToRestart`; no mutating method or secret field exists.

- [ ] Write failing HTTP tests for ready/draining/live status, safe restart transitions, status JSON redaction, 404s,
  and rejection of mutation methods.
- [ ] Replace the boolean readiness holder with one read-only status source shared by main and the runtime manager.
- [ ] Run the health and main tests outside the sandbox if local socket creation is blocked.

### Task 9: Enforce the Docker filesystem and startup contract

**Files:**

- Modify: `compose.yaml`
- Modify: `Dockerfile`
- Modify: `test/docker-contract.test.ts`

**Interfaces:**

- Compose mounts runtime YAML at `/etc/agent-flow/runtime.yaml:ro`, credential files below
  `/run/secrets/agent-flow/:ro`, persistent data at `/var/lib/agent-flow/`, and no complete host CLI directories.
- The image declares the fixed paths and starts without `AGENT_FLOW_*`, provider-token, `HOME`-configuration, or runtime
  configuration environment variables.

- [ ] Rewrite the Docker contract test first so the old broad mounts and environment interface fail.
- [ ] Make the minimal Compose and image path changes; retain the existing pinned toolchain and unprivileged user.
- [ ] Run `node --test test/docker-contract.test.ts`.

### Task 10: Integrate and verify the complete startup and recovery path

**Files:**

- Modify: `test/e2e/github-flow.test.ts`
- Modify: `test/e2e/gitlab-flow.test.ts`
- Modify: `test/e2e/recovery.test.ts`
- Modify only if required by a failing behavior test: implementation files from Tasks 1-9

- [ ] Update E2E fixtures to create one runtime YAML and mounted credential files while keeping provider state as the
  recovery source.
- [ ] Add an E2E case that starts with two unfinished flow revisions and fails closed when either cannot be verified.
- [ ] Add an E2E case that drains on a restart-only replacement, lets an active attempt finish, reports
  `safeToRestart`, and resumes after correction.
- [ ] Run `npm run typecheck`, `npm test`, and `npm run test:e2e` outside the sandbox when sockets are required.
- [ ] Build the Docker image and run its health/status smoke check with mounted runtime, secrets, and persistent data.
- [ ] Re-read the design acceptance criteria and map each criterion to a passing test or explicit Docker observation.
- [ ] Review `git diff origin/main...HEAD` and the working tree for secret leakage, configuration mutation surfaces,
  moving-revision fallback, and unrelated changes; fix every finding with a reproducing test.
- [ ] Run the full verification suite again after the final fix.
- [ ] Commit checkpoint 3 as `feat: complete the GitOps runtime contract`.

## Explicitly skipped

- Kubernetes and Argo CD manifests: add them only when deployment packaging is requested.
- Runtime file watchers, signals, reload endpoints, CLI mutation, and dashboard controls: the reviewed design forbids
  them.
- Multiple controllers, external state stores, retention automation, and credential rotation: each requires a separate
  approved architecture change.
