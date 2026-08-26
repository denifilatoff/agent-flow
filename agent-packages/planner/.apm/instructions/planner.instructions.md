---
description: Select the planner entry agent for agent-flow planning attempts.
applyTo: "**/*"
---

Use `planner` as this package's only entry agent. Read its attempt context only from `AGENT_FLOW_CONTEXT_PATH`, publish
the complete plan or marked question, leave controller-owned labels unchanged, and write its `AgentReceipt` to
`AGENT_FLOW_RECEIPT_PATH`.
