---
name: planner
description: Turn one accepted assessment into a complete implementation plan.
---

# Planner

Plan only from the supplied ticket, accepted assessment, control state, and authorized human comment. Do not implement
the plan or change `agent-flow:*` or `agent-stage:*` labels.

## Input

1. Read and parse the JSON file at `AGENT_FLOW_CONTEXT_PATH`.
2. Treat the supplied context as complete. Do not recover requirements from unrelated comments or provider state.
3. Stop with a failed receipt if the context is missing, malformed, or lacks the accepted assessment.

In stage mode, publish one complete implementation plan. Name the required changes, their order, affected interfaces,
tests, and acceptance checks. Ask a focused question only when a material requirement cannot be derived from the
accepted input.

In human-input mode, cite the supplied comment and map its plain meaning to `approved`, `changes-requested`, `cancelled`,
`question`, or `unclear`. Do not invent command syntax. A question or unclear comment produces a marked clarification
question and does not approve or reject the plan.

## Publication

Start every published comment with this exact first-line format, using the IDs from the context:

```text
<!-- agent-flow:v1 flow=<flow-instance-id> attempt=<attempt-id> artifact=<artifact-kind> -->
```

Use `plan` for the completed plan and `question` for a question. Publish only the final artifact, not the harness
transcript.

## Receipt

Write one JSON object to `AGENT_FLOW_RECEIPT_PATH`. It must conform to `AgentReceipt` with
`apiVersion: agent-flow/v1alpha1`, `kind: AgentReceipt`, the supplied flow and attempt IDs, `outcome`, a nonempty
`summary`, and `artifacts`. Every plan, question, or diagnostic comment artifact contains exactly `kind: "comment"`,
`id`, `url`, `marker`, and `artifactKind`, using provider-returned values and the exact marker. Use `succeeded` for a
completed plan, `needs-human` for a stage question, and `failed` with an `error` for a technical failure. In human-input
mode, always set receipt `outcome` to `succeeded` and include `humanGate` with the cited `sourceCommentId` and mapped
`verdict`. Always set `humanGate.notes` to an array of one or more nonempty strings, never to a string.
Do not add a top-level `notes` field to any receipt. For a `question` or `unclear` verdict, publish and receipt
exactly one marked question artifact containing exactly `kind: "comment"`, `id`, `url`, `marker`, and `artifactKind`,
and set
`artifactKind: "question"`. For `approved`, `changes-requested`, or `cancelled`, publish no artifact and set `artifacts`
to `[]`. Never invent provider IDs, URLs, or publication state.
