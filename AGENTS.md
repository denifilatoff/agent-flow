# Repository agent instructions

## Repository language

- Use English for repository content, including source code, identifiers, comments, documentation, commit messages,
  branch names, pull request text, and review comments.

## Git workflow

- Never commit or push directly to `main`. Use a dedicated branch and merge through a ready-for-review pull request.
- After `origin/main` exists, run `git fetch origin main` at the start of each agent session and before every push. On
  `main`, require `HEAD` to equal `origin/main`; on another branch, require
  `git merge-base --is-ancestor origin/main HEAD` to succeed. Update the branch from `origin/main` before continuing if
  either check fails.
- Do not push, publish a package, or create a pull request unless the user explicitly requests that external action.

## Architecture

- Read `docs/agent-flow-architecture.md` before changing orchestration, provider state, retries, agent execution, or
  deployment behavior. GitHub or GitLab remains the only canonical operational store.
- Keep flow definitions data-only. Do not add executable code, shell commands, or inline scripts to flow YAML.
- Do not introduce a database, durable queue, distributed lease, webhook, or multi-controller behavior without an
  approved architecture change.
- Do not create ADRs unless the repository owner explicitly requests one.

## Generated agent files

- Edit APM source files under `agent-packages/*/apm.yml` and `agent-packages/*/.apm/`, not generated harness output.
- Commit every APM lockfile produced for the agent catalog. Update the applicable lockfile whenever an external APM
  dependency changes.
