#!/bin/sh
set -eu

root=$(mktemp -d "${TMPDIR:-/tmp}/agent-flow-docker-e2e.XXXXXX")
fixture_port=${AGENT_FLOW_E2E_FIXTURE_PORT:-19443}
health_port=${AGENT_FLOW_E2E_HEALTH_PORT:-18080}
project="agent-flow-e2e-$$"
fixture_pid=

cleanup() {
  docker compose -p "$project" -f compose.yaml -f "$root/compose.e2e.yaml" down --remove-orphans >/dev/null 2>&1 || true
  if [ -n "$fixture_pid" ]; then
    kill "$fixture_pid" >/dev/null 2>&1 || true
    wait "$fixture_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$root"
}
trap cleanup EXIT INT TERM

node test/fixtures/provider-server.ts --docker-server "$root" "$fixture_port" "$health_port" &
fixture_pid=$!

attempt=0
while [ ! -f "$root/ready" ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 100 ] || { echo "fixture did not become ready" >&2; exit 1; }
  sleep 0.1
done

export AGENT_FLOW_RUNTIME_PATH="$root/runtime.yaml"
export AGENT_FLOW_PROVIDER_TOKEN_PATH="$root/provider-token"
export AGENT_FLOW_CODEX_AUTH_PATH="$root/auth/.codex/auth.json"
export AGENT_FLOW_CLAUDE_AUTH_PATH="$root/auth/.claude/.credentials.json"

docker compose -p "$project" -f compose.yaml -f "$root/compose.e2e.yaml" build controller
docker compose -p "$project" -f compose.yaml -f "$root/compose.e2e.yaml" up -d controller

attempt=0
until curl --fail --silent "http://127.0.0.1:$health_port/health/live" >/dev/null \
  && curl --fail --silent "http://127.0.0.1:$health_port/health/ready" >/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 120 ] || {
    docker compose -p "$project" -f compose.yaml -f "$root/compose.e2e.yaml" logs controller
    exit 1
  }
  sleep 1
done

node -e '
const response = await fetch(`http://127.0.0.1:${process.argv[1]}/api/status`);
if (!response.ok) throw new Error(`status endpoint returned ${response.status}`);
const status = await response.json();
if (!/^[0-9a-f]{40}$/.test(status.configurationRevision)) throw new Error("status revision is invalid");
if (!/^[0-9a-f]{64}$/.test(status.runtimeDigest)) throw new Error("runtime digest is invalid");
const body = JSON.stringify(status);
if (/token|authFile|tokenFile|fixture/i.test(body)) throw new Error("status endpoint exposed credential data");
' "$health_port"

NODE_EXTRA_CA_CERTS="$root/fixture.crt" node -e '
const expected = JSON.stringify(["agent-flow:managed", "agent-stage:done"]);
const deadline = Date.now() + 120_000;
let labels;
while (Date.now() < deadline) {
  const response = await fetch(`https://localhost:${process.argv[1]}/api/github/repos/owner/repo/issues/17`, {
    headers: {
      authorization: "Bearer fixture",
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (response.ok) {
    const issue = await response.json();
    labels = issue.labels.map(({ name }) => name).sort();
    if (JSON.stringify(labels) === expected) process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
console.error(`ticket did not reach done; labels=${JSON.stringify(labels)}`);
process.exit(1);
' "$fixture_port"
