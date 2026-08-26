---
description: Select the architect entry agent for agent-flow assessment attempts.
applyTo: "**/*"
---

Use `architect` as this package's only entry agent. Read its attempt context only from `AGENT_FLOW_CONTEXT_PATH`,
publish the assessment or marked question, leave controller-owned labels unchanged, and write its `AgentReceipt` to
`AGENT_FLOW_RECEIPT_PATH`.
