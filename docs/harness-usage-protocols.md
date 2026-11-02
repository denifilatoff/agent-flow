# Harness attempt accounting protocols

Protocol evidence was captured with Codex `0.150.0-alpha.8` and Claude Code `2.1.217` using an isolated localhost
API simulator with dummy credentials. No model requests were sent to a remote provider. The fixtures retain accounting
records only; prompts, system instructions and tool output were removed. Fixture counters are simulator-supplied values,
not measurements of a paid model call. Real installed harnesses produced the protocol envelopes and aggregation.

## Codex

`codex exec --json` reports the primary thread only. The captured root reports 700 input and 70 output tokens;
its child independently reports 300 input and 30 output tokens. The attempt therefore has 1,100 tokens, not 770.
The JSONL completion value is cumulative, not a delta.

The session rollouts under the attempt's temporary `CODEX_HOME/sessions` contain cumulative `token_count` events.
The first `session_meta` identifies the file's thread. `parent_thread_id` establishes ancestry. Full-history forks
also embed ancestor metadata; it must not replace the first metadata. In the paginated fork fixture,
`subagent_history_start_ordinal` separates inherited history from the child's own records. Child counters start at zero
and exclude inherited usage. Use the latest valid own-thread cumulative snapshot once, never add snapshots together.
Only linked descendants of the stdout `thread.started` ID belong to the attempt. Read records before deleting the home.

Exact-version source: [exec notification filtering](https://github.com/openai/codex/blob/rust-v0.150.0-alpha.8/codex-rs/exec/src/lib.rs),
[JSONL mapping](https://github.com/openai/codex/blob/rust-v0.150.0-alpha.8/codex-rs/exec/src/event_processor_with_jsonl_output.rs),
[fork history filtering](https://github.com/openai/codex/blob/rust-v0.150.0-alpha.8/codex-rs/core/src/agent/control/spawn.rs).

Cached input and cache writes are subsets of input; reasoning output is a subset of output. They must not be added
to total tokens again. The public completion envelope has no actual model identity. The controller uses actual
session logs, rather than the configured model name, for pricing.

After a successful Codex execution, the controller runs `ccusage codex session --json --no-offline` with a separate
30-second deadline. It snapshots only the completed root session and its native descendants into a temporary
calculator home. Authentication files and provider credentials are excluded; only the root `service_tier` setting is
preserved. The snapshot is removed after calculation. Missing descendants, unfinished sessions, warnings, fallback or
unpriced models, unsupported tool versions, and inconsistent reports leave the amount unavailable without rerunning
the model. Observed categories remain available when calculation fails, without claiming a complete attempt total.
The deadline starts before any accounting log read and also applies to fallback collection.

The runtime image pins ccusage `20.0.47` in `docker/tools/package-lock.json`. Prices are refreshed through ccusage's
online catalog; the controller has no Codex price table. The validated report supplies whole-attempt tokens, cache
accounting, actual models, and the API-equivalent USD estimate. Receipts retain `costCalculator`; failures retain the
safe `CCUSAGE_UNAVAILABLE` code and prepared comments display `cost unavailable`. Positive estimates below one cent
display `<$0.01`; receipts retain the full amount. The image's Python 3.11 TOML parser preserves equivalent quoted
service-tier keys without copying other Codex settings.

`ccusage-codex.json` records ccusage `20.0.47` output for the public delegation fixture. It was captured on
2026-11-02 with online pricing and no model requests. Its prices are a frozen test response, not a maintained rate
table. A separate real CLI smoke also verified the same protocol counters attributed to `gpt-6.1-sol`.
See [Codex session reports](https://ccusage.com/guide/codex/) and
[unpriced-model JSON fields](https://ccusage.com/guide/json-output#unpriced-models).

## Claude

`claude -p --output-format stream-json --verbose` emits cumulative `modelUsage` and `total_cost_usd` on result records.
The captured mixed-model fixture has 800 Sonnet input + 80 Sonnet output + 200 Haiku input + 20 Haiku output = 1,100 tokens.
Its earlier result is superseded by the final cumulative result. Summing both results would double count.
`result.usage` excludes the child and must not be treated as an attempt aggregate. `modelUsage` includes delegated work.
Cache creation/read tokens are separate from uncached input and must be included in Claude totals.

[Official cost semantics](https://code.claude.com/docs/en/agent-sdk/cost-tracking) describe these scopes and warn that
assistant-message output counts can be placeholders. Native cost is a harness estimate, not invoice billing.
Without a complete result, retain assistant-message input/cache counters once per session and message ID. Bound the
observation set, ignore invalid counters, and let a later complete aggregate replace these partial observations.
Preserve only reliable categories; do not infer complete output, total tokens or total cost.
[The upstream changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) records a later fix in 2.1.307
for placeholder usage in subagent transcripts, so those transcripts are not a reliable complete fallback on the pin.
