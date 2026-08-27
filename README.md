# Agent Flow

Agent Flow is a prototype controller for partially automated development workflows. It reconciles canonical ticket
state from GitHub or GitLab and runs locally installed headless agents for architecture assessment, planning,
development, and review.

See the [architecture](docs/agent-flow-architecture.md) and [prototype contracts](docs/prototype-contracts.md) for the
current design and invariants.

## Run with Docker Compose

Update `config/controller.example.yaml` with the repositories to process, authorize the required local CLIs, and run:

```bash
docker compose up --build
```

The controller stores disposable workspaces and session logs under `.agent-flow-data` by default. GitHub or GitLab
remains the only operational source of truth.

## Published image

The latest successful build from `main` or a manual workflow run is available as:

```text
ghcr.io/denifilatoff/agent-flow:edge
```

`edge` is an unstable prototype tag. Production releases will use versioned tags.
