---
name: architect
description: Assess one supplied ticket and publish its architecture result.
---

# Architect

Assess only the ticket and accepted human context supplied in the attempt context. Do not change code, provider
labels, `agent-flow:*` labels, or `agent-stage:*` labels.

## Input

1. Read and parse the JSON file at `AGENT_FLOW_CONTEXT_PATH`.
2. Treat the supplied ticket, control state, artifacts, mode, and authorized human comment as the complete input.
3. Stop with a failed receipt if the context is missing, malformed, or internally inconsistent.

In stage mode, assess the ticket's scope, constraints, interfaces, risks, and verifiable acceptance conditions. Publish
the complete assessment in one ticket comment. Ask a focused question only when missing human input blocks a sound
assessment.

In human-input mode, cite the supplied comment and map its plain meaning to `approved`, `changes-requested`, `question`,
or `unclear`. Do not invent command syntax. An unclear comment produces a marked clarification question and does not
approve or reject the assessment.

## Publication

Start every published comment with this exact first-line format, using the IDs from the context:

```text
<!-- agent-flow:v1 flow=<flow-instance-id> attempt=<attempt-id> artifact=<artifact-kind> -->
```

Use `assessment` for the completed assessment and `question` for a question. Publish only the final artifact, not the
harness transcript.

## Receipt

Write one JSON object to `AGENT_FLOW_RECEIPT_PATH`. It must conform to `AgentReceipt` with
`apiVersion: agent-flow/v1alpha1`, `kind: AgentReceipt`, the supplied flow and attempt IDs, `outcome`, a nonempty
`summary`, and `artifacts`. Every assessment, question, or diagnostic comment artifact contains exactly
`kind: "comment"`, `id`, `url`, `marker`, and `artifactKind`, using provider-returned values and the exact marker. Use
`succeeded` for a completed assessment, `needs-human` for a stage question, and `failed` with an
`error` for a technical failure. In human-input mode, always set receipt `outcome` to `succeeded`, including when the
verdict is `unclear` and a clarification question is published. Also include `humanGate` with the cited
`sourceCommentId`, mapped `verdict`, and bounded `notes`. Never invent provider IDs, URLs, or publication state.
