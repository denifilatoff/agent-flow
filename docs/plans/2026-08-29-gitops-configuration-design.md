# GitOps configuration boundary

Status: Reviewed design

## Purpose

Define a configuration contract that works with the current Docker delivery and can later be deployed by Argo CD
without adding a Git reconciler to the controller.

The controller has two configuration sources:

1. A Git revision defines stack behavior.
2. One mounted runtime YAML file binds that behavior to a concrete execution environment.

Neither the dashboard nor a CLI may change either source. The dashboard reports the effective configuration and
whether an operator restart is required.

## Goals

- Keep all stack, flow, agent, and behavioral configuration in Git.
- Load Git configuration from one exact commit SHA and never follow a moving branch or tag.
- Keep deployment-specific choices outside Git in one mounted runtime YAML file.
- Use mounted files for credentials. Do not use environment variables as a configuration or secret interface.
- Support safe runtime reloads at explicit execution boundaries.
- Keep Docker as a complete deployment target.
- Allow Argo CD to manage a later Kubernetes deployment without changing the controller's configuration model.
- Preserve GitHub or GitLab as the only canonical store for operational flow state.

## Non-goals

- After startup, the controller does not watch Git, fetch another revision, or reconcile its deployment.
- The controller does not provide configuration mutation through the dashboard, an API, a CLI, or signals.
- Runtime configuration is not committed to the stack configuration repository.
- Secret values are not stored in either configuration source.
- The initial design does not support multiple active controller replicas.
- This design does not introduce a database, durable queue, lease service, or configuration service.

## Configuration ownership

### Git configuration

The pinned Git revision contains everything that defines the behavior of the stack:

| Area | Git-owned content |
| --- | --- |
| Stack | Stack manifest and references to all files that make up one valid stack |
| Flows | State machines, states, transitions, guards, gates, and agent role references |
| Agents | Logical agent IDs and their APM package paths |
| Agent behavior | `apm.yml`, prompts, skills, instructions, and other package artifacts |
| Dependencies | Every APM lockfile needed to reproduce the agent catalog |
| Contracts | Agent result, context, provider evidence, and runtime protocol contracts |
| Validation | Schemas for the stack manifest, flows, catalogs, and contracts |

The Git agent catalog is logical. It maps an agent ID to an APM package and does not select a harness, model,
reasoning level, retry policy, or timeout. This removes the need for parallel catalogs such as `agents.yaml` and
`agents-codex.yaml`.

One stack manifest is the entry point for the pinned revision. It references the flow definitions, logical agent
catalog, contracts, and schemas required to validate and load the stack. The manifest and every referenced file must
resolve inside the same repository at the same commit.

All Git-owned stack configuration lives in this one repository. This does not place the runtime YAML in that repository
or require product source code and deployment manifests to share it.

### Runtime configuration

The mounted runtime YAML binds the pinned stack to one deployment:

| Area | Runtime-owned content |
| --- | --- |
| Git selection | Repository URL, exact commit SHA, and stack manifest path |
| Provider binding | Provider type, API URL, repository allowlist, and credential file paths |
| Agent execution | Harness, model, reasoning level, retry count, retry delay, and timeout per logical agent |
| Scheduling | Poll interval, provider call limit, quota reserve, and global concurrency |
| Local runtime | Data directory, HTTP bind address, HTTP port, and other host-specific paths |
| Secrets | Paths to mounted token or authentication files, never their contents |

Harness, model, and reasoning remain runtime choices because different deployments may have different executors and
model availability. Retry and timeout settings remain beside those execution choices because they control the cost and
capacity of that deployment rather than the behavior of the state machine.

## Runtime file contract

The container always reads one file at a fixed path:

```text
/etc/agent-flow/runtime.yaml
```

The host may mount any source file at that path, but the in-container location is not configurable. The controller has
no environment variable or command-line override for ordinary configuration.

The following example shows the intended ownership and shape. Exact enum values remain part of the implementation
schema, not this design document.

```yaml
apiVersion: agent-flow/v1alpha1
kind: RuntimeConfig
configuration:
  repository: https://github.com/example/agent-stack.git
  revision: 0123456789abcdef0123456789abcdef01234567
  stack: config/stack.yaml
provider:
  type: github
  apiUrl: https://api.github.com
  repositories:
    - example-owner/example-repository
  tokenFile: /run/secrets/agent-flow/github-token
execution:
  agents:
    architect:
      harness: claude
      model: example-architect-model
      reasoning: high
      maxAttempts: 3
      delaySeconds: 30
      timeoutSeconds: 2700
    developer:
      harness: codex
      model: example-developer-model
      reasoning: high
      maxAttempts: 3
      delaySeconds: 30
      timeoutSeconds: 7200
  harnesses:
    claude:
      authFile: /run/secrets/agent-flow/claude-auth
    codex:
      authFile: /run/secrets/agent-flow/codex-auth
polling:
  intervalSeconds: 300
  maxCallsPerMinute: 20
  quotaReservePercent: 25
runtime:
  concurrency: 4
  dataDirectory: /var/lib/agent-flow
  http:
    address: 0.0.0.0
    port: 8080
```

A revision must be a full commit SHA, not a branch, tag, abbreviated SHA, or symbolic reference.

## Container filesystem contract

| Path | Access | Purpose |
| --- | --- | --- |
| `/etc/agent-flow/runtime.yaml` | Read-only file | The only runtime configuration source |
| `/run/secrets/agent-flow/` | Read-only files | Provider tokens and harness authentication |
| `/var/lib/agent-flow/` | Read-write persistent volume | Git cache, materialized revisions, worktrees, and sessions |
| `/tmp/agent-flow/` | Read-write ephemeral storage | Temporary files |

The Docker deployment mounts only the files and directories it needs. It does not mount complete host configuration
directories such as `.codex`, `.claude`, `gh`, or `glab` when a specific authentication file is sufficient.

## Startup and Git revision resolution

Startup follows one deterministic sequence:

1. Read and validate `/etc/agent-flow/runtime.yaml`.
2. Read the referenced credential files without copying their contents into logs or configuration snapshots.
3. Read provider-visible control metadata and collect the pinned Git SHA of every unfinished flow instance.
4. Fetch the configured Git repository when it is reachable.
5. Build the required revision set from the runtime SHA and the pinned SHA of every unfinished flow instance.
6. Materialize every required revision under `/var/lib/agent-flow/`.
7. Verify each materialized revision against the retained Git objects for its commit.
8. Load the stack manifest and validate every referenced Git configuration file for each required revision.
9. Start reconciliation only after the complete Git and runtime configuration is valid.

If the remote repository is unavailable, startup may use cached copies only when every required SHA is present and all
materialized files can be verified against their Git objects. The controller must never fall back to another SHA, the
latest branch head, or an unchecked working tree. Startup fails when any required revision cannot be verified.

The runtime SHA is used for new flow instances. Existing unfinished flow instances keep and load their pinned SHA until
an explicit migration, as defined by the current controller architecture.

## Safe runtime reload

A logical attempt series is one agent role working in one flow state on one pinned provider input, including all
retries covered by the same retry budget.

The controller rereads the runtime file:

- before each polling cycle;
- before starting a new logical attempt series.

It does not use filesystem watchers, signals, a reload endpoint, or a CLI command. A changed file is accepted only as a
complete valid generation. The controller never applies a partial configuration.

### Reloadable fields

| Field | Application boundary |
| --- | --- |
| Poll interval | Next polling cycle |
| Provider call limit | Next provider request |
| Quota reserve | Next provider request |
| Global concurrency | New jobs only |
| Agent harness | Next logical attempt series |
| Agent model | Next logical attempt series |
| Agent reasoning | Next logical attempt series |
| Retry count | Next logical attempt series |
| Retry delay | Next logical attempt series |
| Attempt timeout | Next logical attempt series |

Reducing concurrency does not cancel running jobs. An active attempt series retains its execution settings for all
retries in that series. Entering another state or observing another pinned input revision starts a new series and may
use a newer runtime generation.

### Restart-only fields

The following changes require an operator restart:

- configuration repository, revision, or stack manifest path;
- provider type or API URL;
- repository allowlist;
- secret file paths;
- data directory;
- HTTP bind address or port.

Secret files are read only at startup. If authentication stops working, the controller reports the failure and does not
attempt live credential rotation. A secret path change is visible in the runtime YAML and produces
`restartRequired`. A change to the contents of an existing secret file also requires an operator restart, but the
controller does not reread or compare those contents and therefore cannot detect that change as a new runtime
generation. It may observe only the resulting authentication failure.

### Invalid or restart-only replacement

If a replacement runtime file is invalid or changes a restart-only field, the controller:

1. keeps the last valid effective generation;
2. stops starting polling work and new attempts;
3. allows active attempts to finish;
4. reports `restartRequired` and the reason;
5. reports readiness as false while keeping liveness true;
6. waits for the operator instead of exiting automatically.

If the mounted file is corrected to the previous configuration or to a valid reloadable change, the controller may
clear the condition and resume. If the restart-only change is intentional, the operator restarts the container when the
dashboard reports no active attempts and `safeToRestart: true`.

Restarting a container is a deployment lifecycle action. It is not a configuration mutation performed by the
controller. A planned restart stops the old process and starts a new process that rereads the runtime YAML, secret
files, and configured Git revision. Persistent data under `/var/lib/agent-flow/` survives the restart. An unplanned
restart during an active attempt follows the existing provider-backed recovery rules.

## Runtime generation audit

Two related records describe the effective runtime:

### Runtime digest

`runtimeDigest` is a SHA-256 digest of the normalized effective runtime configuration. Normalization must be stable and
must exclude secret contents. Secret file paths remain part of the digest because changing a path changes the runtime
binding.

The digest identifies the complete runtime generation. A polling-only change therefore produces a new digest even when
agent execution settings remain unchanged.

### Execution snapshot

`executionSnapshot` records the settings that affect one logical attempt series:

- harness;
- model;
- reasoning level;
- maximum attempts;
- retry delay;
- attempt timeout.

Before launching the first process in a series, the controller persists both `runtimeDigest` and
`executionSnapshot` in the provider-visible attempt metadata. Every retry in that series uses the same snapshot. The
snapshot does not contain credentials or unrelated runtime fields.

The full runtime YAML is not stored in GitHub or GitLab. A sanitized copy may be retained in the local session directory
for diagnostics, but it is not canonical operational state.

## Dashboard and health behavior

The dashboard remains read-only. It reports:

- loaded Git repository and commit SHA;
- active runtime digest;
- configuration validation errors;
- whether a restart is required;
- restart reason and changed restart-only fields;
- active attempt count;
- `safeToRestart` status.

It must not return secret values or offer configuration controls. Liveness answers whether the process is running.
Readiness answers whether it may start or reconcile work.

## Docker deployment

Docker remains a complete deployment target. A deployment needs only the image, the runtime YAML mount, credential file
mounts, persistent storage at `/var/lib/agent-flow/`, and the HTTP port when the dashboard is required.

Changing Git behavior means changing the pinned revision in the external runtime YAML and restarting the container.
Changing a reloadable runtime field means replacing the mounted YAML atomically; the controller adopts it at the
documented boundary.

## Future Argo CD deployment

Argo CD owns Kubernetes resource reconciliation and pod replacement. The controller keeps the same container contract:

- one runtime YAML file at `/etc/agent-flow/runtime.yaml`;
- credential files under `/run/secrets/agent-flow/`;
- persistent storage at `/var/lib/agent-flow/`;
- one replica with the `Recreate` strategy.

Moving from Docker to Argo CD therefore requires Kubernetes workload manifests, a mechanism that mounts the runtime
YAML and credentials, persistent storage, health probes, and restart orchestration. The transition is limited to this
Kubernetes packaging and lifecycle integration. It does not require a controller Git watcher, a second configuration
API, or changes to flow semantics.

Runtime configuration remains outside the stack configuration repository. How a deployment supplies that file to Argo
CD is an operational decision and is intentionally outside this design.

## Migration from the current prototype

1. Add the Git stack manifest and make the logical agent catalog contain package references only.
2. Replace the current mixed controller configuration with the runtime schema and fixed mount path.
3. Move harness selection and retry settings from Git agent catalogs into runtime agent bindings.
4. Remove environment-variable configuration and environment-based token lookup.
5. Replace broad host configuration mounts with explicit credential files.
6. Add exact-revision cache verification and fail-closed startup behavior.
7. Add runtime generation validation, safe reload boundaries, draining status, digest, and execution snapshots.
8. Expose the read-only configuration and restart state in the existing dashboard and health server.

## Acceptance criteria

- The container starts from one mounted runtime YAML file without configuration environment variables.
- The controller loads and verifies every commit in the required revision set, including cached offline content.
- Every behavioral stack file is reachable from the stack manifest of its corresponding required revision.
- The Git agent catalog contains no harness, model, reasoning, retry, delay, or timeout settings.
- The dashboard, API, and CLI cannot mutate configuration.
- Secret values exist only in mounted files and process memory and never appear in logs, digests, snapshots, or the
  dashboard.
- A reloadable change affects only work started after its documented boundary.
- An active attempt series keeps one execution snapshot across its retries.
- An invalid or restart-only replacement drains active work and prevents new work without killing the process.
- The dashboard tells the operator when a restart is required and when it is safe.
- The Docker deployment works without Kubernetes components.
- A Kubernetes deployment can use the same image and filesystem contract with one `Recreate` replica.
