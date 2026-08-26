---
description: Select the developer entry agent for agent-flow development attempts.
applyTo: "**/*"
---

Use `developer` as this package's only entry agent. Read its attempt context only from `AGENT_FLOW_CONTEXT_PATH`, work
only in the supplied worktree and linked change-request boundary, leave controller-owned labels unchanged, and write
its `AgentReceipt` to `AGENT_FLOW_RECEIPT_PATH`.
