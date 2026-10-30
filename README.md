# Agent Flow

Agent Flow is a prototype controller for partially automated development workflows. It reconciles canonical ticket
state from GitHub or GitLab and runs locally installed headless agents for architecture assessment, planning,
development, and review.

See the [architecture](docs/agent-flow-architecture.md) and [prototype contracts](docs/prototype-contracts.md) for the
runtime contracts. [ADR 0001](docs/adr/0001-provider-commit-points-and-local-execution.md) records provider recovery
with local SQLite. The [recovery specification](docs/recovery-from-provider-draft.md) and
[data model](docs/recovery-data-model.md) define its recovery and ownership rules.

## Run with Docker Compose

For an existing pre-Stack deployment, follow the [upgrade procedure](docs/upgrading.md) first.
Update `config/runtime.example.yaml` with the repositories to process, authorize the required local CLIs, and run:

```bash
docker compose up --build
```

The default Compose configuration mounts the runtime YAML as a single file. Atomic replacement on the host does not
guarantee hot reload through this mount. After replacing the file, recreate the controller:

```bash
docker compose up -d --force-recreate controller
```

The controller stores disposable workspaces and session logs under `.agent-flow-data` by default. GitHub or GitLab
remains the only operational source of truth.

At startup, the controller creates or loads `.agent-flow-data/controller-id`, opens
`.agent-flow-data/execution.sqlite`, and reconciles tickets that carry a configured activation label, including
`agent-flow:development` or `bugfix`. A managed label or historical publication alone does not start work. Corrupt
identities and unsupported or corrupt databases
fail startup without replacing the affected file. Active legacy state requires migration and receives no automatic
writes.

Stop the controller and its agents before resetting local execution state. Preserve `controller-id`, move
`execution.sqlite` aside for diagnosis, and restart to reconstruct active work from provider evidence. To transfer an
installation, stop the old executor and agents before copying its identity and local data; preserve repository routing
and access to pinned configuration commits. Give an independent installation a fresh data directory and identity.

## Published image

The latest successful build from `main` or a manual workflow run is available as:

```text
ghcr.io/denifilatoff/agent-flow:edge
```

`edge` is an unstable prototype tag. Production releases will use versioned tags.

## Workflow migrations

Operators can explicitly migrate an active GitHub ticket or replay an earlier agent stage while retaining its
existing PR. See [the operator procedure](docs/operating-workflow-migrations.md) and [the rule-authoring
guide](docs/workflow-migrations.md). Controller-only updates do not change pinned configurations.
