---
description: Select the reviewer entry agent for agent-flow review attempts.
applyTo: "**/*"
---

Use `reviewer` as this package's only entry agent. Read its attempt context only from `AGENT_FLOW_CONTEXT_PATH`. Open
stage mode reviews only the pinned head and writes a review receipt. Closed stage mode publishes the reopen-or-cancel
question without reviewing code. Human-input mode interprets the authorized answer without reviewing code. Every mode
writes its appropriate `AgentReceipt` to `AGENT_FLOW_RECEIPT_PATH`. Leave code and controller-owned labels unchanged.
