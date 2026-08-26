# Mac Docker prototype implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved single-controller prototype so it runs in Docker on macOS and moves allowlisted GitHub or
GitLab tickets through the development flow with Codex or Claude agents.

**Architecture:** The controller polls provider REST APIs and reconstructs every decision from provider-visible state.
It validates a pinned configuration revision, compiles the data-only flow into XState v5, and runs one harness process
at a time in each ticket's worktree. Local files are replaceable diagnostics; GitHub or GitLab remains canonical.

**Tech stack:** Node.js 24, TypeScript 7.0.2, XState 5.32.6, YAML 2.9.0, Ajv 8.20.0, ajv-formats 3.0.1, the Node test
runner, APM CLI 0.28.0, Git, `gh` 2.96.0, `glab` 1.111.0, Codex CLI 0.150.0-alpha.8, Claude Code 2.1.217, and Docker
Compose.

**Spec:** `docs/agent-flow-architecture.md`, `docs/prototype-contracts.md`, `schemas/v1/*.json`,
`config/agents.yaml`, `config/controller.example.yaml`, and `config/flows/development.yaml`.

## Global constraints

- Keep `apiVersion: agent-flow/v1alpha1` and every schema `kind` exact.
- Reject unsupported versions, unknown fields, invalid JSON Schema shapes, and semantic cross-file errors before
  polling.
- Keep flow YAML data-only. Accept only the events, guards, and actions declared by `schemas/v1/flow.schema.json`.
- Keep GitHub or GitLab as the only canonical operational store. Do not add a database, queue, lease, or retry ledger.
- Run one controller instance. Allow parallel tickets, but never run two attempts for the same ticket.
- Use periodic reconciliation only. Do not add webhooks, a UI, Kubernetes, automerge, or multiple controllers.
- Keep one active flow instance and one linked pull or merge request per ticket.
- Pin a new flow instance to the configuration repository's 40-character commit SHA. Never move that pin implicitly.
- Keep one mutable control comment per flow instance and exactly one `agent-stage:<state-id>` label.
- Run each attempt in a new process and immutable session directory. Reuse only that flow instance's Git worktree.
- Treat receipts and provider publications as untrusted until schema validation and provider readback succeed.
- Make every agent package handle both stage and `human-input` modes. Human-input receipts cite the source comment;
  `unclear` publishes a marked clarification question and does not advance.
- Publish final artifacts and bounded outcomes only. Never publish full harness transcripts or claim host isolation.
- Pin JavaScript dependencies in `package-lock.json` and pin every installed CLI version in the Docker build.
- Implement the smallest named interface below. Do not add extension frameworks, generic plugin systems, or caches.
- End each task with the listed commit. A fresh implementation agent starts only after the previous task passes review.

## Shared interface map

Keep these names stable across tasks:

```typescript
type ProviderKind = "github" | "gitlab";
type HarnessTarget = "codex" | "claude";
type Permission = "none" | "read" | "triage" | "write" | "maintain" | "admin";

interface TicketRef {
  provider: ProviderKind;
  repository: string;
  number: number;
}

interface ProviderRepository {
  provider: ProviderKind;
  name: string;
  host: string;
  cloneUrl: string;
}

interface ConfigBundle {
  revision: string;
  root: string;
  controller: ControllerConfig;
  flow: FlowDefinition;
  catalog: AgentCatalog;
}

interface MachineInput {
  stateId: string;
  resumeStateId: string | null;
  event: FlowEvent;
}

interface MachineResult {
  changed: boolean;
  stateId: string;
  resumeStateId: string | null;
  actions: FlowActionName[];
}

interface AttemptContext {
  ticket: ProviderTicketSnapshot;
  controlState: ControlState;
  artifacts: ProviderArtifact[];
  mode: "stage" | "human-input";
}
```

All schema-backed types use the field names and unions in `schemas/v1/*.json`. Do not rename wire fields to suit
TypeScript style.

---

### Task 1: Bootstrap TypeScript and strict schema validation

**Files:**

- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `src/config/types.ts`
- Create: `src/config/schema-validator.ts`
- Create: `test/config/schema-validator.test.ts`
- Read: `schemas/v1/*.json`
- Read: `config/agents.yaml`, `config/controller.example.yaml`, `config/flows/development.yaml`

**Interfaces:**

- Consumes: the five JSON Schema files and YAML documents already in the repository.
- Produces: `SchemaKind`, `FlowDefinition`, `AgentCatalog`, `ControllerConfig`, `ControlState`, `AgentReceipt`,
  `parseYaml(path): Promise<unknown>`, and
  `validateDocument<T>(kind: SchemaKind, value: unknown): T`.

- [ ] **Step 1: Add failing schema boundary tests**

```typescript
test("rejects unknown fields and unsupported versions", async () => {
  const value = await parseYaml("config/flows/development.yaml") as Record<string, unknown>;
  assert.throws(() => validateDocument("Flow", { ...value, extra: true }));
  assert.throws(() => validateDocument("Flow", { ...value, apiVersion: "agent-flow/v1" }));
});

test("accepts every shipped YAML document", async () => {
  validateDocument("Flow", await parseYaml("config/flows/development.yaml"));
  validateDocument("AgentCatalog", await parseYaml("config/agents.yaml"));
  validateDocument("ControllerConfig", await parseYaml("config/controller.example.yaml"));
});
```

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/config/schema-validator.test.ts`

Expected: FAIL because `src/config/schema-validator.ts` does not exist.

- [ ] **Step 3: Add the minimal project and validator**

Use exact dependencies and commit the generated lockfile:

```bash
npm install --save-exact xstate@5.32.6 yaml@2.9.0 ajv@8.20.0 ajv-formats@3.0.1
npm install --save-dev --save-exact typescript@7.0.2 @types/node@26.3.0
```

Set `"type": "module"` and scripts for `build`, `typecheck`, and `test`. Configure `NodeNext`, strict checking, erasable
TypeScript syntax, `src` to `dist` output, and no test emission.

Implement one Ajv 2020 instance with formats, load all five schemas once, and preserve relative
`agent-receipt.schema.json` resolution. Convert validation errors into one `ConfigValidationError` that includes the
schema kind, instance path, and message.

```typescript
export async function parseYaml(path: string): Promise<unknown>;
export function validateDocument<T>(kind: SchemaKind, value: unknown): T;
```

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/config/schema-validator.test.ts`

Expected: PASS for shipped documents and PASS for both rejection assertions.

- [ ] **Step 5: Verify the task**

Run: `npm run typecheck && npm test`

Expected: both commands exit 0. `npm test` runs only the schema test at this point.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/config/types.ts \
  src/config/schema-validator.ts test/config/schema-validator.test.ts
git commit -m "feat(config): validate versioned documents"
```

---

### Task 2: Add the architect APM package

**Files:**

- Create: `agent-packages/architect/apm.yml`
- Create: `agent-packages/architect/apm.lock.yaml`
- Create: `agent-packages/architect/.apm/agents/architect.agent.md`
- Create: `agent-packages/architect/.apm/instructions/architect.instructions.md`
- Create: `test/config/agent-packages.test.ts`

**Interfaces:**

- Consumes: `AgentReceipt` and the assessment marker contract in `docs/prototype-contracts.md`.
- Produces: one logical `architect` entry agent at `agent-packages/architect` for the catalog's Claude target.

- [ ] **Step 1: Add a failing package contract test**

```typescript
test("architect package has one entry agent and a lockfile", async () => {
  await assertAgentPackage("architect", "assessment");
});
```

The shared test helper must parse `apm.yml`, require `name: architect` and `version: 1.0.0`, require exactly one
`.apm/agents/*.agent.md`, require one matching always-on entry instruction, require `apm.lock.yaml`, and assert that
both primitives name the `assessment` artifact.

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/config/agent-packages.test.ts`

Expected: FAIL because `agent-packages/architect/apm.yml` is missing.

- [ ] **Step 3: Author the minimal architect package**

Use this manifest:

```yaml
name: architect
version: 1.0.0
description: Assess a ticket and publish its architecture assessment.
author: agent-flow
targets: [claude]
```

The entry agent must read `AGENT_FLOW_CONTEXT_PATH`, assess only the ticket and accepted human context, publish the full
assessment or a marked question, never edit `agent-flow:*` or `agent-stage:*` labels, and write a receipt to
`AGENT_FLOW_RECEIPT_PATH`. Every published comment starts with the exact agent marker from the prototype contract.
The short `**/*` instruction selects `architect` as the package's only logical entry agent and repeats the environment
and receipt boundary so target compilation produces a usable root instruction file. Run `apm lock --target claude
--no-policy` in the package directory to produce the lockfile without adding generated target files to the source
package.

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/config/agent-packages.test.ts`

Expected: PASS for the architect package.

- [ ] **Step 5: Verify the APM source**

Copy the package to a temporary directory, then run a frozen install, compile, and `apm audit --ci --no-policy` there.
Do not commit generated `.claude/` or root `CLAUDE.md` output.

```bash
scratch=$(mktemp -d)
cp -R agent-packages/architect/. "$scratch"
(cd "$scratch" && apm install --frozen --target claude && \
  apm compile --validate --target claude && apm audit --ci --no-policy)
rm -rf "$scratch"
```

Expected: all three APM commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add agent-packages/architect test/config/agent-packages.test.ts
git commit -m "feat(agents): add architect package"
```

---

### Task 3: Add the planner APM package

**Files:**

- Create: `agent-packages/planner/apm.yml`
- Create: `agent-packages/planner/apm.lock.yaml`
- Create: `agent-packages/planner/.apm/agents/planner.agent.md`
- Create: `agent-packages/planner/.apm/instructions/planner.instructions.md`
- Modify: `test/config/agent-packages.test.ts`

**Interfaces:**

- Consumes: accepted assessment and human comments from `AttemptContext`.
- Produces: one logical `planner` entry agent at `agent-packages/planner` for the catalog's Claude target.

- [ ] **Step 1: Add the failing planner assertion**

```typescript
test("planner package has one entry agent and a lockfile", async () => {
  await assertAgentPackage("planner", "plan");
});
```

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/config/agent-packages.test.ts`

Expected: FAIL only for the missing planner package.

- [ ] **Step 3: Author the minimal planner package**

```yaml
name: planner
version: 1.0.0
description: Turn an accepted assessment into a complete implementation plan.
author: agent-flow
targets: [claude]
```

The entry agent must consume the accepted assessment, ticket, control state, and authorized human comment. It publishes
the complete plan or a marked question, leaves reserved labels unchanged, and writes a schema-valid receipt. In
human-input mode it maps the cited comment to `approved`, `changes-requested`, `question`, or `unclear` without
inventing command syntax. The `**/*` entry instruction selects `planner` and repeats the environment and receipt
boundary for target compilation. Run `apm lock --target claude --no-policy` to produce the lockfile without adding
generated target files to the source package.

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/config/agent-packages.test.ts`

Expected: PASS for architect and planner.

- [ ] **Step 5: Verify the APM source**

Copy the package to a temporary directory, then run a frozen install, compile, and `apm audit --ci --no-policy` there.
Do not commit generated `.claude/` or root `CLAUDE.md` output.

```bash
scratch=$(mktemp -d)
cp -R agent-packages/planner/. "$scratch"
(cd "$scratch" && apm install --frozen --target claude && \
  apm compile --validate --target claude && apm audit --ci --no-policy)
rm -rf "$scratch"
```

Expected: all three commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add agent-packages/planner test/config/agent-packages.test.ts
git commit -m "feat(agents): add planner package"
```

---

### Task 4: Add the developer APM package

**Files:**

- Create: `agent-packages/developer/apm.yml`
- Create: `agent-packages/developer/apm.lock.yaml`
- Create: `agent-packages/developer/.apm/agents/developer.agent.md`
- Create: `agent-packages/developer/.apm/instructions/developer.instructions.md`
- Modify: `test/config/agent-packages.test.ts`

**Interfaces:**

- Consumes: accepted ticket, assessment, plan, linked change request, review, and authorized human comments.
- Produces: one logical `developer` entry agent at `agent-packages/developer` for the catalog's Codex target.

- [ ] **Step 1: Add the failing developer assertion**

```typescript
test("developer package has one entry agent and a lockfile", async () => {
  await assertAgentPackage("developer", "change-request");
});
```

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/config/agent-packages.test.ts`

Expected: FAIL only for the missing developer package.

- [ ] **Step 3: Author the minimal developer package**

```yaml
name: developer
version: 1.0.0
description: Implement an accepted plan in the ticket's change request.
author: agent-flow
targets: [codex]
```

The entry agent must work only in the supplied repository worktree, create or update the one linked pull or merge
request, and never replace a closed change request. It must run repository tests, publish marked diagnostics or
questions when blocked, leave controller labels untouched, and bind the receipt's change request and head SHA to the
provider result. The `**/*` entry instruction selects `developer` and repeats the environment and receipt boundary for
target compilation. Run `apm lock --target codex --no-policy` to produce the lockfile without adding generated target
files to the source package.

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/config/agent-packages.test.ts`

Expected: PASS for architect, planner, and developer.

- [ ] **Step 5: Verify the APM source**

Copy the package to a temporary directory, then run a frozen install, compile, and `apm audit --ci --no-policy` there.
Do not commit generated `.codex/` or root `AGENTS.md` output.

```bash
scratch=$(mktemp -d)
cp -R agent-packages/developer/. "$scratch"
(cd "$scratch" && apm install --frozen --target codex && \
  apm compile --validate --target codex && apm audit --ci --no-policy)
rm -rf "$scratch"
```

Expected: all three commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add agent-packages/developer test/config/agent-packages.test.ts
git commit -m "feat(agents): add developer package"
```

---

### Task 5: Add the reviewer APM package

**Files:**

- Create: `agent-packages/reviewer/apm.yml`
- Create: `agent-packages/reviewer/apm.lock.yaml`
- Create: `agent-packages/reviewer/.apm/agents/reviewer.agent.md`
- Create: `agent-packages/reviewer/.apm/instructions/reviewer.instructions.md`
- Modify: `test/config/agent-packages.test.ts`

**Interfaces:**

- Consumes: the linked change request at the exact `headSha` in `AttemptContext`.
- Produces: one logical `reviewer` entry agent at `agent-packages/reviewer` for the catalog's Codex target.

- [ ] **Step 1: Add the failing reviewer assertion**

```typescript
test("reviewer package has one entry agent and a lockfile", async () => {
  await assertAgentPackage("reviewer", "review");
});
```

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/config/agent-packages.test.ts`

Expected: FAIL only for the missing reviewer package.

- [ ] **Step 3: Author the minimal reviewer package**

```yaml
name: reviewer
version: 1.0.0
description: Review the linked change request at its pinned head.
author: agent-flow
targets: [codex]
```

The entry agent must stop if the provider head differs from the supplied SHA. It publishes an approved,
changes-requested, or commented verdict tied to that SHA. When GitHub prevents self-approval, it publishes a marked
comment plus the same machine-readable verdict. It never merges or edits controller labels. Run `apm lock --target
codex --no-policy` to produce the lockfile without adding generated target files to the source package. The `**/*`
entry instruction selects `reviewer` and repeats the environment and receipt boundary for target compilation.

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/config/agent-packages.test.ts`

Expected: PASS for all four packages.

- [ ] **Step 5: Verify the complete APM catalog**

For each package, use a temporary copy for frozen install, compile, and `apm audit --ci --no-policy`. Do not commit
target-native or root generated output. Use the exact package target:

```bash
set -e
for package in architect planner developer reviewer; do
  target=codex
  case "$package" in architect|planner) target=claude ;; esac
  scratch=$(mktemp -d)
  cp -R "agent-packages/$package/." "$scratch"
  (cd "$scratch" && apm install --frozen --target "$target" && \
    apm compile --validate --target "$target" && apm audit --ci --no-policy)
  rm -rf "$scratch"
done
```

Expected: all 12 APM commands exit 0 and each package compiles one logical agent.

- [ ] **Step 6: Commit**

```bash
git add agent-packages/reviewer test/config/agent-packages.test.ts
git commit -m "feat(agents): add reviewer package"
```

---

### Task 6: Validate the configuration bundle semantically

**Files:**

- Create: `src/config/load.ts`
- Create: `src/config/semantic.ts`
- Create: `test/config/semantic.test.ts`
- Create: `test/fixtures/config/invalid-target/flow.yaml`
- Create: `test/fixtures/config/duplicate-repository/controller.yaml`

**Interfaces:**

- Consumes: `parseYaml`, `validateDocument`, the shipped flow and catalog, four APM package directories, and fixed
  controller guard and action registries.
- Produces:
  `loadConfigBundle(root: string, controllerPath: string, revision: string): Promise<ConfigBundle>` and
  `validateSemantics(bundle: ConfigBundle): Promise<void>`.

- [ ] **Step 1: Add failing semantic tests**

```typescript
test("accepts the shipped bundle", async () => {
  const bundle = await loadConfigBundle(process.cwd(), "config/controller.example.yaml", REVISION);
  await assert.doesNotReject(validateSemantics(bundle));
});

test("rejects missing targets and duplicate repositories", async () => {
  await assert.rejects(loadFixture("invalid-target"), /transition target .* does not exist/);
  await assert.rejects(loadFixture("duplicate-repository"), /repository .* is configured more than once/);
});
```

- [ ] **Step 2: Run the tests and confirm the red state**

Run: `node --test test/config/semantic.test.ts`

Expected: FAIL because `loadConfigBundle` does not exist.

- [ ] **Step 3: Implement every specified semantic check**

Keep the checks in one pass that reports all errors in deterministic path order:

```typescript
export const IMPLEMENTED_GUARDS = new Set<FlowGuardName>([
  "authorized-actor", "activation-present", "ticket-open", "head-matches", "receipt-valid",
]);
export const IMPLEMENTED_ACTIONS = new Set<FlowActionName>([
  "record-receipt", "remember-resume-state", "clear-resume-state",
  "reset-retry-budget", "remove-activation-label",
]);
```

Check the initial state, every target, `$resume` use, `resumeTarget` scope and existence, agent references, one
`apm.yml` and one logical entry agent per package, committed `apm.lock.yaml` files, final and non-final transition
rules, implemented guards and actions, and repository uniqueness across providers. Reject paths that escape the pinned
root. Do not start provider or harness work from this module.

- [ ] **Step 4: Run the focused tests and confirm green**

Run: `node --test test/config/schema-validator.test.ts test/config/semantic.test.ts`

Expected: PASS for strict shape validation, the shipped bundle, and both semantic failures.

- [ ] **Step 5: Verify the task**

Run: `npm run typecheck && npm test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/config/load.ts src/config/semantic.ts test/config/semantic.test.ts test/fixtures/config
git commit -m "feat(config): validate bundle semantics"
```

---

### Task 7: Materialize pinned configuration revisions

**Files:**

- Create: `src/config/repository.ts`
- Create: `test/config/repository.test.ts`

**Interfaces:**

- Consumes: a read-only Git configuration repository and `loadConfigBundle`.
- Produces:
  `resolveRevision(repository: string, requested?: string): Promise<string>`,
  `materializeRevision(repository: string, revision: string, dataDirectory: string): Promise<string>`, and
  `loadPinnedConfig(repository: string, dataDirectory: string, requested?: string): Promise<ConfigBundle>`.

- [ ] **Step 1: Add a failing pinning test**

```typescript
test("loads HEAD once and preserves an older requested revision", async () => {
  const first = await loadPinnedConfig(repo.path, data.path);
  repo.commitChangedFlow();
  const pinned = await loadPinnedConfig(repo.path, data.path, first.revision);
  assert.equal(pinned.revision, first.revision);
  assert.equal(pinned.flow.metadata.id, first.flow.metadata.id);
});
```

Also assert that a missing or non-40-character revision fails before materialization.

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/config/repository.test.ts`

Expected: FAIL because `loadPinnedConfig` does not exist.

- [ ] **Step 3: Implement read-only revision materialization**

Use `execFile` with `git rev-parse`, `git ls-tree`, and `git show`. Copy only `config/`, `schemas/v1/`, and
`agent-packages/` from the selected commit into `<dataDirectory>/config/<sha>`. Reject symlinks, absolute paths, `..`,
and files outside those roots. Write into a temporary sibling and rename it atomically. Reuse an existing completed
directory for the same SHA.

```typescript
export async function loadPinnedConfig(
  repository: string,
  dataDirectory: string,
  requested?: string,
): Promise<ConfigBundle>;
```

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/config/repository.test.ts`

Expected: PASS and the second load still reads the first commit.

- [ ] **Step 5: Verify the task**

Run: `npm run typecheck && npm test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/config/repository.ts test/config/repository.test.ts
git commit -m "feat(config): pin repository revisions"
```

---

### Task 8: Compile flow YAML into an XState machine

**Files:**

- Create: `src/flow/compile.ts`
- Create: `src/flow/types.ts`
- Create: `test/flow/compile.test.ts`

**Interfaces:**

- Consumes: a semantically valid `FlowDefinition` and fixed guard and action names.
- Produces:
  `compileFlow(definition: FlowDefinition): CompiledFlow` and
  `CompiledFlow.transition(input: MachineInput): MachineResult`.

- [ ] **Step 1: Add failing state transition tests**

```typescript
test("uses XState for the shipped assessment transition", async () => {
  const machine = compileFlow(await loadDevelopmentFlow());
  const result = machine.transition({
    stateId: "assessment",
    resumeStateId: null,
    event: succeededEvent({ receiptValid: true, activationPresent: true, ticketOpen: true }),
  });
  assert.deepEqual(result, {
    changed: true,
    stateId: "assessment-review",
    resumeStateId: null,
    actions: ["record-receipt"],
  });
});
```

Add cases for a failed guard, `needs-human` remembering and resuming the source state through `$resume`, `blocked`
resetting retries, review head mismatch, and final states refusing transitions.

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/flow/compile.test.ts`

Expected: FAIL because `compileFlow` does not exist.

- [ ] **Step 3: Implement the fixed XState compilation boundary**

```typescript
export interface CompiledFlow {
  readonly initialStateId: string;
  transition(input: MachineInput): MachineResult;
}

export type FlowEvent = {
  type: FlowEventType;
  authorizedActor: boolean;
  activationPresent: boolean;
  ticketOpen: boolean;
  headMatches: boolean;
  receiptValid: boolean;
};
```

Build the machine with XState `createMachine`. Map YAML states, events, targets, guards, and actions without evaluating
strings as code. The adapter around XState resolves `$resume` from `resumeStateId` and returns action names for the
reconciler to apply. Keep ticket closure and activation-label cancellation outside the YAML machine, as specified.

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/flow/compile.test.ts`

Expected: PASS for the shipped flow, guards, resume behavior, and final states.

- [ ] **Step 5: Verify the task**

Run: `npm run typecheck && npm test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/flow/compile.ts src/flow/types.ts test/flow/compile.test.ts
git commit -m "feat(flow): compile YAML with XState"
```

---

### Task 9: Parse and update control comments

**Files:**

- Create: `src/provider/control-comment.ts`
- Create: `test/provider/control-comment.test.ts`

**Interfaces:**

- Consumes: `validateDocument<ControlState>("ControlState", value)`.
- Produces:
  `parseControlComment(body: string): ControlState | null`,
  `renderControlComment(state: ControlState): string`,
  `listControlComments(comments: ProviderComment[]): ParsedControlComment[]`,
  `selectActiveControlComment(comments: ParsedControlComment[], finalStates: Set<string>):
  ParsedControlComment | null`, and
  `advanceControlState(current: ControlState, patch: ControlStatePatch, now: string): ControlState`.

- [ ] **Step 1: Add failing marker and sequence tests**

```typescript
test("round trips the exact control marker and increments sequence", () => {
  const body = renderControlComment(controlState({ sequence: 4 }));
  assert.equal(body.split("\n")[0], "<!-- agent-flow-control:v1 -->");
  const next = advanceControlState(parseControlComment(body)!, { stateId: "planning" }, NOW);
  assert.equal(next.sequence, 5);
  assert.equal(next.stateId, "planning");
});

test("keeps terminal history but rejects two comments for one flow", () => {
  assert.equal(listControlComments([terminalComment(FLOW_1), terminalComment(FLOW_2)]).length, 2);
  assert.throws(
    () => listControlComments([terminalComment(FLOW_1), terminalComment(FLOW_1)]),
    /duplicate control comment for flow/,
  );
});
```

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/provider/control-comment.test.ts`

Expected: FAIL because `renderControlComment` does not exist.

- [ ] **Step 3: Implement the bounded comment codec**

Render exactly the marker, one `json` fence, the schema-valid JSON object, and a trailing newline. Return `null` only
when the first line is not the marker. Reject malformed fences, invalid JSON, schema failures, and more than one
comment with the same `flowInstanceId`. Preserve terminal comments from older flow instances. Reject more than one
non-final flow when selecting the active comment. `advanceControlState` preserves `flowInstanceId`, `flowId`,
`configRevision`, and activation metadata; only an explicit migration path outside this prototype may change the
revision.

```typescript
export type ControlStatePatch = Partial<Pick<
  ControlState,
  "stateId" | "resumeStateId" | "attemptSeries" | "latestReceipt" | "humanGate" | "changeRequest"
>>;
```

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/provider/control-comment.test.ts`

Expected: PASS for round trips, sequence changes, terminal history, malformed JSON, schema errors, duplicate flow IDs,
and multiple active flows.

- [ ] **Step 5: Verify the task**

Run: `npm run typecheck && npm test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/provider/control-comment.ts test/provider/control-comment.test.ts
git commit -m "feat(provider): manage control comments"
```

---

### Task 10: Define provider normalization and rate-limited HTTP

**Files:**

- Create: `src/provider/types.ts`
- Create: `src/provider/http.ts`
- Create: `src/runtime/rate-limiter.ts`
- Create: `test/runtime/rate-limiter.test.ts`
- Create: `test/provider/http.test.ts`

**Interfaces:**

- Consumes: Node 24 `fetch` and controller polling limits.
- Produces the shared provider boundary:

```typescript
export interface ProviderAdapter {
  readonly kind: ProviderKind;
  verifyAuth(): Promise<Actor>;
  discover(repository: string, window: DiscoveryWindow, cursor?: string): Promise<DiscoveryPage>;
  bootstrap(repository: string): Promise<TicketRef[]>;
  readRepository(repository: string): Promise<ProviderRepository>;
  readTicket(ref: TicketRef): Promise<ProviderTicketSnapshot>;
  permission(repository: string, actor: Actor): Promise<Permission>;
  readComment(ref: TicketRef, id: string): Promise<ProviderComment>;
  createComment(ref: TicketRef, body: string): Promise<ProviderComment>;
  updateComment(ref: TicketRef, id: string, body: string): Promise<ProviderComment>;
  setControllerLabels(ref: TicketRef, remove: string[], add: string[]): Promise<string[]>;
  readChangeRequest(ref: TicketRef, number: number): Promise<NormalizedChangeRequest>;
  readReview(ref: TicketRef, changeNumber: number, id: string): Promise<NormalizedReview>;
}

export interface RateLimitedHttpClient {
  request<T>(request: ProviderRequest): Promise<ProviderResponse<T>>;
}
```

`ProviderRequest` includes `priority: "background" | "active"`. Discovery and bootstrap use `background`; ticket
reconciliation, control updates, cancellation, and receipt readback use `active`.

`ProviderTicketSnapshot` contains the ticket reference, repository identity, open state, labels, update time,
activation label event and actor, comments, and the linked change request when one exists. Provider comments and
artifacts keep stable string IDs, URLs, actors, timestamps, and normalized provider-independent verdicts.
`setControllerLabels` preserves every label outside `agent-flow:*` and `agent-stage:*`.

- [ ] **Step 1: Add failing limiter and HTTP tests**

```typescript
test("spreads calls and pauses at the quota reserve", async () => {
  const limiter = new RateLimiter({ maxCallsPerMinute: 20, quotaReservePercent: 25 }, fakeClock);
  await limiter.acquire();
  await limiter.acquire("active");
  assert.equal(fakeClock.lastDelay, 3_000);
  limiter.observe({ remaining: 25, limit: 100, resetAt: fakeClock.now + 60_000 });
  await limiter.acquire("background");
  assert.equal(fakeClock.lastDelay, 60_000);
});
```

Add HTTP cases for `Retry-After`, provider reset headers, provider minimum poll intervals, pagination metadata, JSON
errors, and transient `429` or `5xx` classification.

- [ ] **Step 2: Run the tests and confirm the red state**

Run: `node --test test/runtime/rate-limiter.test.ts test/provider/http.test.ts`

Expected: FAIL because `RateLimiter` and `createRateLimitedHttpClient` do not exist.

- [ ] **Step 3: Implement one request path for every controller API call**

Use one limiter per configured provider account, a FIFO promise chain, and an injected clock. At 20 calls per minute,
wait at least 3,000 ms between starts. Pause background discovery when remaining quota is at or below the configured
percentage, then resume it at provider reset. Active reconciliation still observes ordinary spacing.
`Retry-After` and provider minimum intervals pause both priorities and override ordinary spacing. Keep ETags optional
and in memory only.

```typescript
export function createRateLimitedHttpClient(
  baseUrl: URL,
  headers: () => Record<string, string>,
  limiter: RateLimiter,
): RateLimitedHttpClient;
```

Return response headers with data so GitHub and GitLab adapters can update quota state. Do not call `fetch` anywhere
else in provider code.

- [ ] **Step 4: Run the focused tests and confirm green**

Run: `node --test test/runtime/rate-limiter.test.ts test/provider/http.test.ts`

Expected: PASS without real sleeps or network access.

- [ ] **Step 5: Verify the task**

Run: `npm run typecheck && npm test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/provider/types.ts src/provider/http.ts src/runtime/rate-limiter.ts \
  test/runtime/rate-limiter.test.ts test/provider/http.test.ts
git commit -m "feat(provider): add rate-limited HTTP boundary"
```

---

### Task 11: Implement the GitHub REST adapter

**Files:**

- Create: `src/provider/github.ts`
- Create: `test/provider/github.test.ts`
- Create: `test/fixtures/github/*.json`

**Interfaces:**

- Consumes: `ProviderAdapter`, `RateLimitedHttpClient`, GitHub token environment configuration, and normalized types.
- Produces: `createGitHubAdapter(config: GitHubConfig, client: RateLimitedHttpClient): ProviderAdapter`.

- [ ] **Step 1: Add failing GitHub fixture tests**

```typescript
test("discovers changed issues and normalizes one snapshot", async () => {
  const adapter = githubFixtureAdapter();
  const page = await adapter.discover("owner/repo", { updatedAfter: SINCE, overlapSeconds: 1 });
  assert.deepEqual(page.tickets, [{ provider: "github", repository: "owner/repo", number: 17 }]);
  const ticket = await adapter.readTicket(page.tickets[0]);
  assert.equal(ticket.activation.actor?.login, "maintainer");
  assert.equal(ticket.changeRequest?.headSha, HEAD_SHA);
});
```

Cover repository clone identity, bootstrap queries, pagination, issue versus pull request filtering, permissions,
comment CRUD, preservation of non-controller labels, change request state, review readback, and activation label
timeline actor.

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/provider/github.test.ts`

Expected: FAIL because `createGitHubAdapter` does not exist.

- [ ] **Step 3: Implement only the required GitHub endpoints**

Use `GET /user` for auth, repository metadata for canonical host and clone URL, repository issues with `since` for
discovery, label-filtered issue lists for bootstrap, issue timeline events for activation authorship, collaborator
permission, issue comments, issue labels, pull requests, and reviews. Send GitHub's REST version and JSON accept
headers. Follow `Link` pagination through the shared client.

Bootstrap is the union of `agent-flow:managed` and `agent-flow:development` queries. Normal discovery uses one
incremental issue-list request per repository and fetches details only for returned tickets. Ignore list entries that
represent pull requests.

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/provider/github.test.ts`

Expected: PASS against fixtures with no network access.

- [ ] **Step 5: Verify the task**

Run: `npm run typecheck && npm test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/provider/github.ts test/provider/github.test.ts test/fixtures/github
git commit -m "feat(provider): add GitHub REST adapter"
```

---

### Task 12: Implement the GitLab REST adapter

**Files:**

- Create: `src/provider/gitlab.ts`
- Create: `test/provider/gitlab.test.ts`
- Create: `test/fixtures/gitlab/*.json`

**Interfaces:**

- Consumes: `ProviderAdapter`, `RateLimitedHttpClient`, GitLab token environment configuration, and normalized types.
- Produces: `createGitLabAdapter(config: GitLabConfig, client: RateLimitedHttpClient): ProviderAdapter`.

- [ ] **Step 1: Add failing GitLab fixture tests**

```typescript
test("uses updated_after and normalizes issue and merge request state", async () => {
  const adapter = gitlabFixtureAdapter();
  const page = await adapter.discover("group/project", { updatedAfter: SINCE, overlapSeconds: 1 });
  assert.equal(page.tickets[0].number, 23);
  const ticket = await adapter.readTicket(page.tickets[0]);
  assert.equal(ticket.activation.actor?.login, "maintainer");
  assert.equal(ticket.changeRequest?.state, "open");
});
```

Cover project clone identity, bootstrap queries, `X-Next-Page` pagination, project member access levels, notes,
preservation of non-controller labels, merge request state, review-note readback, and resource label event actor.

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/provider/gitlab.test.ts`

Expected: FAIL because `createGitLabAdapter` does not exist.

- [ ] **Step 3: Implement only the required GitLab endpoints**

URL-encode the full project path. Use `GET /user`, project metadata for canonical host and clone URL, project issues
with `updated_after`, label-filtered issue lists, resource label events, project members, issue notes, issue label
updates, merge requests, and merge request notes. Map access levels 40 and above to `maintain` or `admin`, 30 to
`write`, and lower levels below activation authority.

Bootstrap and incremental discovery follow the same normalized contract as GitHub. Do not expose GitLab payload shapes
to flow or runtime modules.

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/provider/gitlab.test.ts`

Expected: PASS against fixtures with no network access.

- [ ] **Step 5: Verify the task**

Run: `npm run typecheck && npm test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/provider/gitlab.ts test/provider/gitlab.test.ts test/fixtures/gitlab
git commit -m "feat(provider): add GitLab REST adapter"
```

---

### Task 13: Create per-ticket worktrees and immutable attempt sessions

**Files:**

- Create: `src/runtime/workspaces.ts`
- Create: `src/runtime/sessions.ts`
- Create: `test/runtime/workspaces.test.ts`
- Create: `test/runtime/sessions.test.ts`

**Interfaces:**

- Consumes: `ProviderRepository`, flow and attempt UUIDs, `AttemptContext`, and `runtime.dataDirectory`.
- Produces:

```typescript
interface Workspace {
  baseClone: string;
  worktree: string;
  repository: string;
  ticketNumber: number;
  flowInstanceId: string;
}

interface AttemptSession {
  root: string;
  contextPath: string;
  receiptPath: string;
  logPath: string;
  harnessSessionDirectory: string;
}

prepareWorkspace(repository: ProviderRepository, ticket: TicketRef, flowInstanceId: string): Promise<Workspace>;
removeWorkspace(workspace: Workspace, terminal: boolean, processRunning: boolean): Promise<void>;
createAttemptSession(dataDirectory: string, flowInstanceId: string, attemptId: string, context: AttemptContext):
  Promise<AttemptSession>;
```

- [ ] **Step 1: Add failing isolation tests**

```typescript
test("different tickets never share a worktree", async () => {
  const first = await manager.prepareWorkspace(REPOSITORY, ticket(1), FLOW_1);
  const second = await manager.prepareWorkspace(REPOSITORY, ticket(2), FLOW_2);
  assert.notEqual(first.worktree, second.worktree);
  assert.equal(await originIdentity(first.worktree), "owner/repo");
});

test("creates the immutable attempt file layout", async () => {
  const session = await createAttemptSession(DATA, FLOW_1, ATTEMPT_1, CONTEXT);
  assert.deepEqual(await relativeFiles(session.root), [
    "context.json", "harness-session/", "harness.log", "receipt.json",
  ]);
});
```

- [ ] **Step 2: Run the tests and confirm the red state**

Run: `node --test test/runtime/workspaces.test.ts test/runtime/sessions.test.ts`

Expected: FAIL because the workspace and session functions do not exist.

- [ ] **Step 3: Implement filesystem and Git isolation**

Use `execFile` for Git commands. Create the base clone with authenticated `gh repo clone` or `glab repo clone` from the
normalized repository host and name, then use native Git worktrees. Keep one base clone per allowlisted repository and
one worktree path per flow UUID. Validate the normalized origin host and repository identity before every attempt.
Reuse the same worktree for sequential attempts in one flow. Reject a path already bound to another ticket or flow.

Create `/data/sessions/<flow>/<attempt>/` once with mode 0700. Write `context.json` before launch, reserve
`receipt.json`, create `harness.log`, and create `harness-session/`. Refuse to reuse an existing attempt directory.
Remove a worktree only for a terminal flow with no running process.

- [ ] **Step 4: Run the focused tests and confirm green**

Run: `node --test test/runtime/workspaces.test.ts test/runtime/sessions.test.ts`

Expected: PASS for reuse, cross-ticket isolation, identity mismatch, immutable attempts, and cleanup gates.

- [ ] **Step 5: Verify the task**

Run: `npm run typecheck && npm test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/workspaces.ts src/runtime/sessions.ts \
  test/runtime/workspaces.test.ts test/runtime/sessions.test.ts
git commit -m "feat(runtime): isolate worktrees and sessions"
```

---

### Task 14: Compile pinned APM packages for the selected harness

**Files:**

- Create: `src/harness/apm.ts`
- Create: `test/harness/apm.test.ts`

**Interfaces:**

- Consumes: a package directory from the pinned `ConfigBundle`, its committed `apm.lock.yaml`, the catalog target, and
  `AttemptSession.harnessSessionDirectory`.
- Produces:
  `compileAgentContext(agentId: string, packageDirectory: string, target: HarnessTarget, outputDirectory: string):
  Promise<CompiledAgent>`.

- [ ] **Step 1: Add a failing target compilation test**

```typescript
test("runs frozen install and target compilation in the attempt directory", async () => {
  const result = await compileAgentContext("architect", ARCHITECT_PACKAGE, "claude", OUTPUT);
  assert.match(result.instructions, /assessment/);
  assert.deepEqual(commands, [
    ["apm", "install", "--frozen", "--target", "claude"],
    ["apm", "compile", "--target", "claude"],
  ]);
});
```

Add a Codex case and failures for missing locks, compile errors, and output without the expected entry agent.

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/harness/apm.test.ts`

Expected: FAIL because `compileAgentContext` does not exist.

- [ ] **Step 3: Implement frozen target compilation**

Copy the pinned package source and lock into `<outputDirectory>/source`. Run both commands there without a shell so APM
can create target-native files without changing the pinned materialization or repository worktree. Read the generated
`AGENTS.md` or `CLAUDE.md` and the deployed entry agent from `.codex/agents/<agent-id>.toml` or
`.claude/agents/<agent-id>.md`. Return their combined instructions with the source directory as the target-native
runtime directory. Treat a missing lock, install failure, validation failure, missing entry agent, or missing output
as a non-retryable preflight error. Do not use `--chatmode`: chat modes are not APM agents.

```typescript
export interface CompiledAgent {
  agentId: string;
  target: HarnessTarget;
  instructions: string;
  runtimeDirectory: string;
}

export async function compileAgentContext(
  agentId: string,
  packageDirectory: string,
  target: HarnessTarget,
  outputDirectory: string,
): Promise<CompiledAgent>;
```

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/harness/apm.test.ts`

Expected: PASS for both targets and every non-retryable failure.

- [ ] **Step 5: Verify against one real package**

Run: `npm run typecheck && node --test test/harness/apm.test.ts && npm test`

Expected: all commands exit 0; the focused test includes one real local compile and mocked command failures.

- [ ] **Step 6: Commit**

```bash
git add src/harness/apm.ts test/harness/apm.test.ts
git commit -m "feat(harness): compile pinned APM context"
```

---

### Task 15: Run and cancel Codex and Claude processes

**Files:**

- Create: `src/harness/types.ts`
- Create: `src/harness/process.ts`
- Create: `src/harness/codex.ts`
- Create: `src/harness/claude.ts`
- Create: `test/harness/process.test.ts`

**Interfaces:**

- Consumes: `Workspace`, `AttemptSession`, compiled APM text, a stage prompt, retry timeout, and an `AbortSignal`.
- Produces:

```typescript
interface HarnessAdapter {
  readonly target: HarnessTarget;
  preflight(): Promise<void>;
  run(input: HarnessRunInput): Promise<HarnessResult>;
}

interface HarnessRunInput {
  workspace: Workspace;
  session: AttemptSession;
  compiledAgent: CompiledAgent;
  stagePrompt: string;
  timeoutSeconds: number;
  signal: AbortSignal;
}

interface HarnessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}
```

- [ ] **Step 1: Add failing command, timeout, and cancellation tests**

```typescript
test("runs Codex in the worktree with attempt paths", async () => {
  await codex.run(runInput);
  assert.deepEqual(spawned.argv, ["codex", "exec", "--cd", WORKTREE, "-"]);
  assert.equal(spawned.env.AGENT_FLOW_CONTEXT_PATH, CONTEXT_PATH);
  assert.equal(spawned.env.AGENT_FLOW_RECEIPT_PATH, RECEIPT_PATH);
});

test("terminates a cancelled Claude process", async () => {
  const pending = claude.run(runInput);
  abort.abort();
  assert.equal((await pending).signal, "SIGTERM");
});
```

Also assert timeout termination, a 10-second TERM-to-KILL grace period, log capture, and a new spawn per call.

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/harness/process.test.ts`

Expected: FAIL because the harness adapters do not exist.

- [ ] **Step 3: Implement fixed process adapters**

Spawn without a shell and set `cwd` to the ticket worktree. Send the compiled APM instructions and the bounded stage
prompt on stdin. Use `codex exec --cd <worktree> -`; Codex has no root-session `--agent` selector, so the deployed
entry agent's `developer_instructions` must be included directly in this single session's prompt. Use
`claude --agent <agent-id> -p` after copying the target-native agent from `compiledAgent.runtimeDirectory` into the
attempt's Claude config directory. Stream stdout and stderr into `harness.log` without retaining an unbounded copy in
memory. Do not ask either harness to spawn another agent.

Create a target-specific home under `harness-session/` for every run. Seed only the mounted authentication and required
CLI configuration into that writable attempt directory. Set `CODEX_HOME` for Codex and `CLAUDE_CONFIG_DIR` for Claude
so their session artifacts stay adjacent to `harness.log` instead of writing into a shared auth mount.

`preflight()` runs `codex --version` plus `codex login status`, or `claude --version` plus `claude auth status`. Missing
binaries and failed authentication are non-retryable. Timeout and cancellation send SIGTERM, wait 10 seconds, then use
SIGKILL only if the process remains alive.

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/harness/process.test.ts`

Expected: PASS for argv, cwd, environment, logs, exit decoding, timeout, and cancellation.

- [ ] **Step 5: Verify the task**

Run: `npm run typecheck && npm test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/harness/types.ts src/harness/process.ts src/harness/codex.ts \
  src/harness/claude.ts test/harness/process.test.ts
git commit -m "feat(harness): run headless agent processes"
```

---

### Task 16: Validate receipts and read provider publications back

**Files:**

- Create: `src/runtime/receipts.ts`
- Create: `test/runtime/receipts.test.ts`

**Interfaces:**

- Consumes: `AttemptSession.receiptPath`, expected flow and attempt IDs, expected result contract, ticket and pinned
  head, `ProviderAdapter`, and cancellation state.
- Produces:

```typescript
interface ReceiptExpectation {
  flowInstanceId: string;
  attemptId: string;
  resultContract: ResultContract;
  ticket: TicketRef;
  pinnedHeadSha: string | null;
}

readAndVerifyReceipt(
  path: string,
  expected: ReceiptExpectation,
  provider: ProviderAdapter,
  cancelled: boolean,
): Promise<AgentReceipt>;
```

- [ ] **Step 1: Add failing trust-boundary tests**

```typescript
test("accepts only an artifact that the provider reads back", async () => {
  const receipt = await readAndVerifyReceipt(RECEIPT, EXPECTED, provider, false);
  assert.equal(receipt.attemptId, EXPECTED.attemptId);
  assert.equal(provider.readCommentCalls, 1);
});

test("rejects a stale review head and a late cancelled result", async () => {
  await assert.rejects(verify(reviewReceipt({ headSha: OLD_HEAD })), /head SHA/);
  await assert.rejects(verify(validReceipt(), true), /cancelled/);
});
```

Add cases for malformed JSON, schema failure, mismatched IDs, wrong artifact kind, malformed marker, missing
publication, wrong repository or change request, invalid human comment ID or permission, and duplicate artifacts.

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/runtime/receipts.test.ts`

Expected: FAIL because `readAndVerifyReceipt` does not exist.

- [ ] **Step 3: Implement receipt validation and readback**

Parse once, validate with `agent-receipt.schema.json`, and then check semantic identity. Comment markers must equal:

```text
<!-- agent-flow:v1 flow=<flow-instance-id> attempt=<attempt-id> artifact=<artifact-kind> -->
```

Read every comment, change request, and review back through the adapter. Compare stable IDs, URLs, repository, change
number, state, head SHA, verdict, marker, artifact kind, and authorized human comment. Require a development receipt to
name the one linked change request and a review receipt to match the pinned head. Return a typed receipt only after all
checks pass. Classify every receipt or publication mismatch as non-retryable `INVALID_RECEIPT`.

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/runtime/receipts.test.ts`

Expected: PASS for valid publications and every rejection case.

- [ ] **Step 5: Verify the task**

Run: `npm run typecheck && npm test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/receipts.ts test/runtime/receipts.test.ts
git commit -m "feat(runtime): verify agent receipts"
```

---

### Task 17: Reconcile provider state through XState

**Files:**

- Create: `src/runtime/reconcile.ts`
- Create: `src/runtime/derive-event.ts`
- Create: `test/runtime/reconcile.test.ts`

**Interfaces:**

- Consumes: `ProviderTicketSnapshot`, the parsed control comment, pinned `ConfigBundle`, `CompiledFlow`,
  `ProviderAdapter`, and the attempt launcher interface.
- Produces:

```typescript
interface AttemptLauncher {
  start(request: AttemptRequest): Promise<void>;
  cancel(flowInstanceId: string): Promise<void>;
  isRunning(flowInstanceId: string): boolean;
}

deriveEvent(snapshot: ProviderTicketSnapshot, control: ControlState | null, flow: FlowDefinition):
  DerivedProviderEvent;
reconcileTicket(dependencies: ReconcileDependencies, ref: TicketRef): Promise<ReconcileOutcome>;
```

- [ ] **Step 1: Add failing reconciliation cases**

```typescript
test("accepts one authorized activation and owns one stage label", async () => {
  await reconcileTicket(deps, TICKET);
  assert.equal(provider.updatedControl.stateId, "assessment");
  assert.deepEqual(provider.addedLabels, ["agent-flow:managed", "agent-stage:assessment"]);
});

test("merge completion wins over ticket closure", async () => {
  provider.snapshot = awaitingMergeSnapshot({ ticketOpen: false, changeState: "merged" });
  await reconcileTicket(deps, TICKET);
  assert.equal(provider.updatedControl.stateId, "done");
});
```

Add cases for unauthorized activation, permanent managed label, activation removal, ordinary ticket closure, terminal
reactivation creating a new flow UUID while preserving old control comments, duplicate comments for one flow, two
active flow instances, one stage label, closed-unmerged change request, head change, human gate comment selection,
unclear verdict, blocked reset, invalid transition, and a result arriving after cancellation.

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/runtime/reconcile.test.ts`

Expected: FAIL because `reconcileTicket` does not exist.

- [ ] **Step 3: Implement one bounded reconciliation transaction**

Follow this order:

1. Read the ticket, labels, activation event, comments, permissions, and linked change request.
2. Find at most one control comment and load its pinned config revision.
3. Give a merged change request in `awaiting-merge` priority over ticket closure.
4. Cancel on label removal or other active-ticket closure; stop the process, remove `agent-flow:development`, preserve
   `agent-flow:managed`, write `agent-stage:cancelled`, and ignore later results.
5. For a first authorized activation, create a flow UUID, pin current config HEAD, add `agent-flow:managed`, and write
   `agent-stage:assessment`.
6. Derive one provider event, ask the compiled XState machine for the transition, and reject invalid transitions.
7. Update the control comment first, read it back, then replace every old `agent-stage:*` label with exactly one current
   stage label.
8. Start an attempt only for an agent or human-gate state that has no running attempt.

The initial `ControlState` uses sequence 0, the flow ID and pinned 40-character SHA, `assessment`, a null resume state,
the authorized activation actor and timestamp, and null attempt series, receipt, human gate, and change request. Create
one new control comment for each terminal reactivation; never overwrite a prior flow instance's terminal comment.

The first later unmarked comment from a `write`, `maintain`, or `admin` actor is the candidate human input. Human gates
launch the current-stage agent in `human-input` mode. `needs-human` uses the same interpreter. Preserve the source
comment and nonblocking approval notes in the next attempt's context. `blocked` accepts an authorized unmarked comment
directly and resets the current retry series.

A closed, unmerged change request enters `needs-human` with review as the resume state. Launch the reviewer once in
stage mode so it publishes the marked reopen-or-cancel question, then wait for the authorized unmarked answer. Never
create a replacement change request automatically.

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/runtime/reconcile.test.ts`

Expected: PASS for activation, labels, cancellation, merge precedence, human gates, blocked reset, and head changes.

- [ ] **Step 5: Verify the task**

Run: `npm run typecheck && npm test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/reconcile.ts src/runtime/derive-event.ts test/runtime/reconcile.test.ts
git commit -m "feat(runtime): reconcile provider state"
```

---

### Task 18: Run attempts with retries, cancellation, and durable consumption

**Files:**

- Create: `src/runtime/attempt-runner.ts`
- Create: `src/runtime/errors.ts`
- Create: `test/runtime/attempt-runner.test.ts`

**Interfaces:**

- Consumes: workspaces, sessions, APM compilation, harness adapters, receipt verification, catalog retry policy, and
  callbacks that edit and read back the control comment.
- Produces: `createAttemptRunner(dependencies: AttemptRunnerDependencies): AttemptLauncher`.

- [ ] **Step 1: Add failing lifecycle tests**

```typescript
test("persists a started attempt before spawning the harness", async () => {
  await runner.start(REQUEST);
  assert.deepEqual(events.slice(0, 3), ["control:update-started", "control:readback", "harness:spawn"]);
  assert.equal(control.attemptSeries?.consumed, 1);
});

test("a new head starts a fresh retry series", async () => {
  await failSeries({ inputRevision: OLD_HEAD, maxAttempts: 3 });
  await runner.start(request({ inputRevision: NEW_HEAD }));
  assert.notEqual(control.attemptSeries?.seriesId, OLD_SERIES);
  assert.equal(control.attemptSeries?.consumed, 1);
});
```

Cover a technical retry with delay, timeout, unexpected exit, transient provider failure, exhausted budget, a
successful close, non-retryable config, auth, allowlist, permission, harness, and receipt errors, authorized blocked
reset, cancellation, process replacement prevention, and a fresh session per attempt.

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/runtime/attempt-runner.test.ts`

Expected: FAIL because `createAttemptRunner` does not exist.

- [ ] **Step 3: Implement the attempt series contract**

Identify a series by agent ID, state ID, and pinned input revision. A new state or revision creates a new UUID and full
budget. Before spawning, increment `consumed`, record a `started` attempt in the control comment, and read the exact
sequence back. Then prepare the worktree, create a new attempt session, compile the pinned APM package, and spawn the
selected harness.

Timeouts, unexpected exits, and transient provider errors schedule a new process after `delaySeconds` until
`maxAttempts` is consumed. Successful verified receipts close the series. `needs-human` does not spend another
attempt. Invalid configuration, missing binary, failed auth, allowlist or permission failure, and invalid receipt set
`blocked` immediately. An authorized blocked reset preserves `seriesId`, agent, state, and input revision while setting
`consumed` to 0 and `current` to null. `cancel()` aborts the live process, writes `cancelled`, and prevents receipt
application.

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/runtime/attempt-runner.test.ts`

Expected: PASS with an injected clock and fake processes; no test performs a real delay.

- [ ] **Step 5: Verify the task**

Run: `npm run typecheck && npm test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/attempt-runner.ts src/runtime/errors.ts test/runtime/attempt-runner.test.ts
git commit -m "feat(runtime): manage agent attempts"
```

---

### Task 19: Poll, bootstrap, and bound controller concurrency

**Files:**

- Create: `src/runtime/controller.ts`
- Create: `src/runtime/scheduler.ts`
- Create: `test/runtime/controller.test.ts`
- Create: `test/runtime/scheduler.test.ts`

**Interfaces:**

- Consumes: configured providers and allowlists, `ProviderAdapter.discover` and `bootstrap`, `reconcileTicket`, polling
  interval, global concurrency, and shared rate limiters.
- Produces:
  `createController(dependencies: ControllerDependencies): Controller` with
  `bootstrap(): Promise<void>`, `run(signal: AbortSignal): Promise<void>`, and `reconcileNow(ref: TicketRef)`.

- [ ] **Step 1: Add failing scheduler tests**

```typescript
test("bootstraps managed history and unaccepted activations", async () => {
  await controller.bootstrap();
  assert.deepEqual(reconciled, unique([...managedTickets, ...activationTickets]));
});

test("serializes repository scans and excludes duplicate ticket work", async () => {
  await controller.run(oneIntervalSignal);
  assert.equal(maxConcurrentRepositoryScans, 1);
  assert.equal(maxConcurrentByTicket.get(TICKET_KEY), 1);
  assert.ok(maxConcurrentTickets <= 4);
});
```

Also assert a one-second discovery overlap, one incremental list call per repository, continuation into the next
interval when budget runs out, a five-minute default, and no comment-body, search API, or stage-label discovery.

- [ ] **Step 2: Run the tests and confirm the red state**

Run: `node --test test/runtime/controller.test.ts test/runtime/scheduler.test.ts`

Expected: FAIL because `createController` does not exist.

- [ ] **Step 3: Implement polling without durable local scheduling state**

At startup, query `agent-flow:managed` and `agent-flow:development` for each allowlisted repository and reconcile their
union. Record the sweep start in memory. For normal polling, call GitHub with `since` or GitLab with `updated_after` at
the previous cursor minus one second. Reconciliation is idempotent, so discard duplicate ticket refs.

Keep repository scans in one FIFO. If the rate budget cannot finish a sweep, retain the remaining repository names in
memory for the next interval. Use a bounded worker pool for tickets and a keyed in-memory exclusion guard for each
provider, repository, and ticket number. Process shutdown cancels scheduling and delegates active process cancellation
to the attempt runner.

- [ ] **Step 4: Run the focused tests and confirm green**

Run: `node --test test/runtime/controller.test.ts test/runtime/scheduler.test.ts`

Expected: PASS for bootstrap, overlap, serialized scans, deferred sweep work, worker bounds, and per-ticket exclusion.

- [ ] **Step 5: Verify the task**

Run: `npm run typecheck && npm test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/controller.ts src/runtime/scheduler.ts \
  test/runtime/controller.test.ts test/runtime/scheduler.test.ts
git commit -m "feat(runtime): poll and schedule reconciliations"
```

---

### Task 20: Add startup preflight, health endpoints, and the process entry point

**Files:**

- Create: `src/health.ts`
- Create: `src/preflight.ts`
- Create: `src/main.ts`
- Create: `test/health.test.ts`
- Create: `test/preflight.test.ts`

**Interfaces:**

- Consumes: controller config path, pinned config loader, provider auth, data mounts, APM, harness adapters, `gh`,
  `glab`, and `createController`.
- Produces:
  `runPreflight(dependencies: PreflightDependencies): Promise<ReadyDependencies>` and
  `createHealthServer(port: number, readiness: Readiness): http.Server`.

- [ ] **Step 1: Add failing readiness tests**

```typescript
test("reports live before preflight and ready only after every check", async () => {
  const server = createHealthServer(0, readiness);
  assert.equal((await get(server, "/health/live")).status, 200);
  assert.equal((await get(server, "/health/ready")).status, 503);
  readiness.markReady();
  assert.equal((await get(server, "/health/ready")).status, 200);
});
```

Add preflight cases for invalid config, provider REST auth, missing `gh` or `glab` auth, missing APM or harness binary,
failed Codex or Claude auth, and unwritable repository, worktree, or session paths.

- [ ] **Step 2: Run the tests and confirm the red state**

Run: `node --test test/health.test.ts test/preflight.test.ts`

Expected: FAIL because the health server and preflight do not exist.

- [ ] **Step 3: Implement startup in a fixed order**

Start the liveness server, then validate and pin configuration, create and probe all `/data` subdirectories,
authenticate each enabled REST provider, run `gh auth status` or `glab auth status` for enabled agent access, check
`git` and `apm --version`, preflight every harness named by the pinned catalog, and bootstrap the controller. Mark
readiness only after all checks succeed. On a failed preflight, keep readiness false, log one bounded error, close the
health server, and exit nonzero before polling.

Use Node's `http` module. `/health/live` returns 200 while the event loop runs. `/health/ready` returns 200 only after
preflight and bootstrap, otherwise 503. All other paths return 404. SIGINT and SIGTERM stop polling, cancel live agent
processes, wait for shutdown, and close the server.

- [ ] **Step 4: Run the focused tests and confirm green**

Run: `node --test test/health.test.ts test/preflight.test.ts`

Expected: PASS for endpoint status and each preflight gate.

- [ ] **Step 5: Verify the task**

Run: `npm run build && npm run typecheck && npm test`

Expected: `dist/main.js` exists and every command exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/health.ts src/preflight.ts src/main.ts test/health.test.ts test/preflight.test.ts
git commit -m "feat(controller): add preflight and health"
```

---

### Task 21: Package the single controller for macOS Docker Compose

**Files:**

- Create: `Dockerfile`
- Create: `compose.yaml`
- Create: `.dockerignore`
- Create: `test/docker-contract.test.ts`

**Interfaces:**

- Consumes: `npm ci`, `dist/main.js`, the production CLI versions in this plan, `/config`, `/data`, auth directories,
  environment tokens, and port 8080.
- Produces: one non-root controller image and one Compose service named `controller`.

- [ ] **Step 1: Add a failing static Docker contract test**

```typescript
test("pins the runtime CLIs and declares every required mount", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  for (const version of ["2.96.0", "1.111.0", "0.28.0", "0.150.0-alpha.8", "2.1.217"]) {
    assert.match(dockerfile, new RegExp(escapeRegExp(version)));
  }
  const compose = await readFile("compose.yaml", "utf8");
  for (const mount of ["/config", "/data", ".config/gh", ".config/glab-cli", ".codex", ".claude", ".claude.json"]) {
    assert.match(compose, new RegExp(escapeRegExp(mount)));
  }
});
```

Also reject a mutable `FROM` without a digest, root runtime users, absent port 8080, or more than one product service.

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test test/docker-contract.test.ts`

Expected: FAIL because `Dockerfile` and `compose.yaml` do not exist.

- [ ] **Step 3: Build the minimal reproducible image and Compose service**

Resolve the official multi-architecture `node:24-bookworm-slim` digest with
`docker buildx imagetools inspect node:24-bookworm-slim` and put that immutable digest in `FROM`. Install Git plus
`gh` 2.96.0, `glab` 1.111.0, APM CLI 0.28.0, `@openai/codex` 0.150.0-alpha.8, and
`@anthropic-ai/claude-code` 2.1.217. Verify every version in a build layer. Use `npm ci` and a build stage, copy only
runtime dependencies and `dist`, and run as a fixed non-root user with writable `/data`.

Compose runs only `controller`. Mount the repository read-only at `/config`, a persistent host path at `/data`, and
these auth paths explicitly:

```yaml
- ${HOME}/.config/gh:/home/agent/.config/gh:ro
- ${HOME}/.config/glab-cli:/home/agent/.config/glab-cli:ro
- ${HOME}/.codex:/home/agent/.codex:ro
- ${HOME}/.claude:/home/agent/.claude:ro
- ${HOME}/.claude.json:/home/agent/.claude.json:ro
```

Pass `GITHUB_TOKEN` and `GITLAB_TOKEN` from the environment, publish `8080:8080`, use
`config/controller.example.yaml` unless overridden, and add a healthcheck against `/health/ready`. Do not mount the
Docker socket.

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/docker-contract.test.ts && docker compose config`

Expected: the static contract passes and Compose renders one controller service.

- [ ] **Step 5: Verify the image**

Run: `docker compose build --pull controller`

Expected: the build exits 0 and its version assertions show Node 24 and every pinned CLI.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile compose.yaml .dockerignore test/docker-contract.test.ts
git commit -m "feat(deploy): add macOS Docker Compose runtime"
```

---

### Task 22: Prove both providers and recovery with end-to-end fixtures

**Files:**

- Create: `test/fixtures/provider-server.ts`
- Create: `test/fixtures/fake-harness.ts`
- Create: `test/fixtures/e2e-config/github.yaml`
- Create: `test/fixtures/e2e-config/gitlab.yaml`
- Create: `test/e2e/github-flow.test.ts`
- Create: `test/e2e/gitlab-flow.test.ts`
- Create: `test/e2e/recovery.test.ts`
- Create: `test/e2e/docker-mac.sh`
- Modify: `package.json`

**Interfaces:**

- Consumes: the built controller, real GitHub and GitLab adapters against a local REST fixture, the real XState flow,
  real control comment codec, real retry and workspace code, fake `codex` and `claude` processes, and Docker Compose.
- Produces: `npm run test:e2e` and a macOS Docker smoke script that require no live provider repository.

- [ ] **Step 1: Add failing full-flow tests**

```typescript
test("GitHub activation reaches done through both human gates", async () => {
  const run = await startFixture("github");
  await run.activateAs("maintainer");
  await run.answerAssessment("approved");
  await run.answerPlan("approved");
  await run.mergeChangeRequest();
  await run.untilState("done");
  assert.deepEqual(await run.controllerLabels(), ["agent-flow:managed", "agent-stage:done"]);
});
```

Write the same externally observable assertion for GitLab. Add recovery cases for restart after a persisted `started`
attempt, a transient failure consuming the finite budget, activation removal cancelling a process, a late receipt not
advancing, review head invalidation, a closed-unmerged change request entering `needs-human`, and reactivation after a
terminal flow creating a new flow UUID.

- [ ] **Step 2: Run the end-to-end tests and confirm the red state**

Run: `node --test test/e2e/*.test.ts`

Expected: FAIL because the fixture server and fake harness do not exist.

- [ ] **Step 3: Implement the fixture boundary**

The in-process HTTPS server implements only the REST routes used by each adapter and keeps canonical issue, comment,
label, permission, pull or merge request, review, and quota state. Generate a short-lived test certificate and key in
the test's temporary directory with SANs for `localhost`, `127.0.0.1`, and `host.docker.internal`, and trust the
certificate through `NODE_EXTRA_CA_CERTS`. Do not commit a private key. This keeps fixture `apiUrl` values valid under
the schema's HTTPS requirement.

The fake harness is a separate process for every attempt. It reads `AGENT_FLOW_CONTEXT_PATH`, publishes marked fixture
artifacts through the provider REST server, and writes `receipt.json`. Script its result by state so tests can force
success, question, timeout, exit failure, and late completion.

Run the actual controller loop with a short injected clock, not a second workflow implementation. Keep all production
configuration data-only and use only allowlisted fixture repositories.

- [ ] **Step 4: Run the Node end-to-end suite and confirm green**

Run: `npm run build && node --test test/e2e/*.test.ts`

Expected: GitHub, GitLab, restart, retry, cancellation, stale-head, closed-change-request, and reactivation cases pass.

- [ ] **Step 5: Verify the macOS container path**

`test/e2e/docker-mac.sh` starts the fixture server on the host, supplies a Compose override that points provider URLs to
`host.docker.internal` and mounts fake authenticated CLIs before the image CLIs on `PATH`, then runs:

```bash
docker compose build controller
docker compose up -d controller
curl --fail http://localhost:8080/health/live
curl --fail http://localhost:8080/health/ready
docker compose down
```

The script uses a trap so Compose stops on failure. Run:
`npm run typecheck && npm test && npm run test:e2e && test/e2e/docker-mac.sh`.

Expected: all checks exit 0, readiness becomes healthy, and the fixture ticket ends with only
`agent-flow:managed` and `agent-stage:done`.

- [ ] **Step 6: Commit**

```bash
git add package.json test/fixtures/provider-server.ts \
  test/fixtures/fake-harness.ts test/fixtures/e2e-config test/e2e
git commit -m "test(e2e): cover both provider flows"
```

---

## Final acceptance check

Run these commands from a clean checkout after Task 22:

```bash
npm ci
npm run typecheck
npm test
npm run test:e2e
for package in architect planner developer reviewer; do
  target=codex
  case "$package" in architect|planner) target=claude ;; esac
  (cd "agent-packages/$package" && apm install --frozen --target "$target" && \
    apm compile --target "$target" && apm audit --ci --no-policy)
done
docker compose config
test/e2e/docker-mac.sh
```

The prototype is complete only when provider state makes the next transition unambiguous after the controller and all
of `/data` are removed. Losing an active worktree may require a fresh attempt, but it must not change the valid next
transition. No accepted behavior may depend on local retry records, cached provider responses, or harness transcripts.
