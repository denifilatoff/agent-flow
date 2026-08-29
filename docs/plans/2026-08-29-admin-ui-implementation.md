# Admin UI implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task.

**Goal:** Replace the prototype dashboard with a production, read-only operator UI that uses the mounted runtime
configuration, the exact pinned stack revision, controller observations, and bounded redacted attempt-session files.

**Architecture:** The existing Node HTTP server serves a small static application, a dashboard endpoint, and bounded
session file endpoints. The dashboard projects runtime and pinned Git configuration without secrets. The controller
exposes an in-memory observation snapshot; it does not become an operational store. The HTTP API reads only three
allowlisted attempt files through verified Linux descriptors, caps every session response, and redacts the startup
credential snapshot. GitHub or GitLab remains the only canonical operational state.

**Tech stack:** TypeScript, Node.js standard library, HTML, CSS, browser JavaScript, and the Node test runner. No
frontend framework or new package is required.

**Visual source:** `/Users/denifilatov/Downloads/Tom-Modern-Design-Design-System.zip`, especially
`agent-flow-admin.html`, plus the supplied design handoff.

## Constraints

- Keep the four approved screens and their responsive, keyboard, persistence, and clipboard behavior.
- Use real snapshot values or an explicit empty or unavailable state. Do not ship prototype ticket or metric data.
- Keep all HTTP routes read-only. Do not add configuration mutation, provider mutation, or session mutation.
- Never return secret values or secret file paths.
- Treat controller observations and session files as ephemeral diagnostic projections, not canonical state.
- Bound session discovery and expose only redacted `harness.log`, `decision.json`, and `context.json` content.
- Preserve the approved six-color palette, 2 px radius, 8 px spacing grid, 44 px controls, focus visibility, and
  reduced-motion behavior.
- Do not edit `README.md`, push, or create a pull request.

## Checkpoint 0: Close the backend verification blocker

### Task 0: Snapshot harness credentials at startup

**Files:**

- Modify: `src/harness/process.ts`
- Modify: `src/harness/codex.ts`
- Modify: `src/harness/claude.ts`
- Test: `test/harness/process.test.ts`

- [x] Add failing tests that replace a mounted Codex or Claude credential after preflight and prove later runs keep the
  startup bytes.
- [x] Read and cache configured harness credential bytes during preflight, then stage private files only under the
  ephemeral harness home.
- [x] Keep provider and harness credential contents out of runtime snapshots, persistent storage, and logs.

**Checkpoint:** Run typecheck, the complete harness suite, and the production credential tests.

## Checkpoint 1: Read-only dashboard contract

### Task 1: Describe controller work without creating another store

**Files:**

- Modify: `src/runtime/scheduler.ts`
- Modify: `src/runtime/controller.ts`
- Test: `test/runtime/scheduler.test.ts`
- Test: `test/runtime/controller.test.ts`

- [x] Add failing tests for scheduler counts and the controller's lifecycle, repository scan, ticket observation,
  queue, active-work, and bounded-error snapshot.
- [x] Add the smallest synchronous `snapshot()` methods backed by existing in-memory collections.
- [x] Confirm snapshots contain no provider response bodies, credentials, or new durable state.

### Task 2: Project runtime, pinned configuration, flow, and sessions

**Files:**

- Create: `src/dashboard.ts`
- Modify: `src/preflight.ts`
- Modify: `src/health.ts`
- Modify: `src/main.ts`
- Modify: `src/runtime/controller.ts`
- Test: `test/dashboard.test.ts`
- Test: `test/health.test.ts`
- Test: `test/main.test.ts`
- Test: `test/runtime/controller.test.ts`

- [x] Add failing tests for the dashboard schema, redaction, 11-state flow, unavailable-before-preflight response, and
  bounded session discovery.
- [x] Bind the successful preflight bundle and controller to operational status.
- [x] Include the observed flow instance, state, and observation time for active tickets so human gates and provider
  waits are rendered from controller evidence rather than inferred from stale session files.
- [x] Serve `GET /api/dashboard` with bounded session metadata. Return explicit unavailable states when runtime
  evidence does not exist.
- [x] Keep every non-GET request rejected and preserve existing health and status behavior.

**Checkpoint:** Run typecheck, focused runtime and HTTP tests, then the complete unit suite.

### Task 2a: Expose exact operator evidence required by the UI

**Files:**

- Modify: `src/runtime/reconcile.ts`
- Modify: `src/runtime/controller.ts`
- Modify: `src/dashboard.ts`
- Test: `test/runtime/reconcile.test.ts`
- Test: `test/runtime/controller.test.ts`
- Test: `test/dashboard.test.ts`

- [x] Add the pinned `configRevision` and exact `stateKind` to each ticket observation instead of classifying it through
  the current flow.
- [x] Expose only scheduler-held ticket locks, separate from the existing unfinished-flow projection.
- [x] Mark the session index as truncated when more than 100 entries exist so absence is not presented as proof.
- [x] Keep these fields ephemeral, bounded, and free of provider payloads or new durable state.

### Task 2b: Read bounded session files without disclosing startup credentials

**Files:**

- Create: `src/redaction.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/preflight.ts`
- Modify: `src/health.ts`
- Modify: `src/main.ts`
- Modify: `src/harness/codex.ts`
- Modify: `src/harness/claude.ts`
- Test: `test/redaction.test.ts`
- Test: `test/dashboard.test.ts`
- Test: `test/health.test.ts`
- Test: `test/harness/process.test.ts`
- Test: `test/production-credentials.test.ts`

- [x] Snapshot provider and harness credentials during startup and register their raw, parsed string, JSON-escaped,
  URL-encoded, base64, and hexadecimal forms in an in-memory redactor.
- [x] Pass only the redaction function through preflight and operational status. Do not expose registered values.
- [x] Read only canonical UUID paths and the three allowlisted files through `O_NOFOLLOW` descriptors verified via
  `/proc/self/fd`, with a one MiB response cap and fail-closed behavior.
- [x] Keep discovery at 101 visited directory entries plus three fixed safe-file checks per advertised session.

### Task 2c: Authenticate operator access without exposing another credential

**Files:**

- Modify: `schemas/v1/runtime-config.schema.json`
- Modify: `src/config/runtime.ts`
- Modify: `src/health.ts`
- Modify: `src/main.ts`
- Modify: `compose.yaml`
- Test: `test/health.test.ts`
- Test: `test/main.test.ts`
- Test: `test/e2e/docker-mac.sh`

- [x] Require an absolute `runtime.http.authFile`, mount it read-only, and snapshot its single bounded value before the
  server binds.
- [x] Leave liveness and readiness public while requiring fixed-user HTTP Basic authentication for every other route.
- [x] Register the startup password in the shared session redactor and keep its value and path out of API projections.
- [x] Treat an authentication-path change as restart-only, reject missing, invalid, or oversized credentials before
  listening, and publish the default Compose port on host loopback only.

## Checkpoint 2: Production static application

### Task 3: Serve the application from the controller image

**Files:**

- Create: `src/ui/index.html`
- Create: `src/ui/styles.css`
- Create: `src/ui/app.js`
- Modify: `src/health.ts`
- Modify: `package.json`
- Test: `test/health.test.ts`
- Test: `test/docker-contract.test.ts`

- [x] Add failing route and Docker contract tests for the page and assets.
- [x] Copy the static assets into `dist` during build. The existing final-image `COPY /app/dist` includes them without
  another Dockerfile layer.
- [x] Serve exact content types, cache static assets, and keep API responses uncached.

### Task 4: Bind all four screens to the real contract

**Files:**

- Modify: `src/ui/index.html`
- Modify: `src/ui/styles.css`
- Modify: `src/ui/app.js`
- Create: `test/ui-contract.test.ts`

- [x] Add a failing static contract test for the four screens, palette, radius, navigation storage, collapsed menu,
  refresh intervals, session reader tabs, graph keyboard controls, numeric validation, and clipboard fallback.
- [x] Adapt the approved mockup structure and styling without its demonstration banner, placeholder SHA, or fake data.
- [x] Render status, repositories, queues, human gates, errors, journal, locks, runtime configuration, agent execution,
  pinned flow states, and explicit empty or unavailable states from `/api/dashboard`.
- [x] Generate one-field RuntimeConfig YAML fragments from the current values without writing them anywhere.
- [x] Keep the document free of horizontal page scrolling at 320 px.

**Checkpoint:** Run typecheck, focused UI and HTTP tests, the complete unit suite, and the end-to-end suite.

## Checkpoint 3: Visual and container proof

### Task 5: Verify the running system

- [x] Build and run the real server with a pinned local fixture and mounted file secrets.
- [x] Verify all four screens in the in-app browser at desktop and mobile widths.
- [x] Exercise navigation persistence, menu persistence, automatic refresh, search, graph keyboard selection,
  validation, YAML generation, and clipboard fallback.
- [x] Verify the bounded redacted session tabs in the running Linux container and in-app browser.
- [x] Compare desktop screenshots with the approved mockup and correct material spacing, typography, color, overflow,
  focus, and responsive differences.
- [x] Build the Docker image and prove health, status, dashboard, page, and asset routes from the container.

### Task 6: Review and commit

- [x] Run the complete unit and end-to-end suites from a clean build.
- [x] Review the diff for secret exposure, write paths, stale prototype language, accessibility, and unnecessary logic.
- [x] Run a second code review and fix every confirmed issue.
- [x] Create local scope-only commits. Do not push or create a pull request.
- [x] Report verification evidence and collect unresolved product questions for the next design iteration.
