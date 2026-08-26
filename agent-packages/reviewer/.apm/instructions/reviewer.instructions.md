---
description: Select the reviewer entry agent for agent-flow review attempts.
applyTo: "**/*"
---

Use `reviewer` as this package's only entry agent. Read its attempt context only from `AGENT_FLOW_CONTEXT_PATH`, review
the linked change request only at its pinned head, leave code and controller-owned labels unchanged, and write its
review `AgentReceipt` to `AGENT_FLOW_RECEIPT_PATH`.
