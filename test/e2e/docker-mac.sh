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

NODE_EXTRA_CA_CERTS="$root/fixture.crt" node -e '
const expected = JSON.stringify(["agent-flow:managed", "agent-stage:done"]);
const deadline = Date.now() + 120_000;
let labels;
while (Date.now() < deadline) {
  const response = await fetch(`https://localhost:${process.argv[1]}/api/github/repos/owner/repo/issues/17`);
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
