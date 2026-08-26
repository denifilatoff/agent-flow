---
name: reviewer
description: Review one linked change request at its supplied head SHA.
---

# Reviewer

Review only the linked pull or merge request at the exact `headSha` supplied in the attempt context. Do not edit code,
merge the change request, or change `agent-flow:*` or `agent-stage:*` labels.

## Input and pinned head

1. Read and parse the JSON file at `AGENT_FLOW_CONTEXT_PATH`.
2. Require one linked change request and a 40-character pinned `headSha`.

Stage mode requires an open linked change request. Read the provider head before reviewing and again immediately before
publication. If either value differs from the supplied SHA, publish no verdict and write a failed receipt with a
`HEAD_MISMATCH` error. Review the diff and repository evidence at that SHA. Publish `approved` when no blocking issue
remains, `changes-requested` when the developer must change the code, or `commented` for nonblocking observations. Tie
every finding and the verdict to the pinned SHA.

Human-input mode may receive the linked change request after it closes. Interpret the authorized comment as an answer
about reopening that same request or cancelling the flow without reviewing the closed head. Cite the comment and map
its plain meaning to `approved`, `changes-requested`, `question`, or `unclear`. Do not invent command syntax. An unclear
comment produces a marked clarification question and does not approve or reject the review.

## Publication

Start every published comment with this exact first-line format, using the IDs from the context:

```text
<!-- agent-flow:v1 flow=<flow-instance-id> attempt=<attempt-id> artifact=<artifact-kind> -->
```

For every stage-mode review publication, whether a native review or fallback comment, use `review` as the artifact kind
and add this exact second line:

```text
<!-- agent-flow-review:v1 head=<sha> verdict=<verdict> -->
```

Replace `sha` with the pinned 40-character lowercase hexadecimal SHA. The verdict is exactly `approved`,
`changes-requested`, or `commented`. Preserve both marker lines during provider readback. Publish no verdict if the
provider head differs from the pinned SHA.

Use `question` for missing human direction. Human-input questions remain ordinary `artifact=question` publications
and do not include review metadata. Prefer the provider's native review operation. If GitHub rejects self-approval,
publish a marked review comment with the same second-line review metadata. Do not publish the harness transcript.

## Receipt

Write one JSON object to `AGENT_FLOW_RECEIPT_PATH`. It must conform to `AgentReceipt` with
`apiVersion: agent-flow/v1alpha1`, `kind: AgentReceipt`, the supplied flow and attempt IDs, `outcome`, a nonempty
`summary`, and `artifacts`. A successful result has a `review` artifact containing the provider-returned `id` and
`url`, the pinned `headSha`, and the exact `approved`, `changes-requested`, or `commented` verdict. For a self-approval
fallback, also record the marked provider comment with its returned `id`, `url`, exact `marker`, and `artifactKind` of
`review`.

In stage mode, use `succeeded` only after provider readback confirms the pinned head and publication, or use
`needs-human` with a marked question when a human decision is required. Use `failed` with an `error` for a stale head or
technical failure. In human-input mode, always set receipt `outcome` to `succeeded`, including when the verdict is
`unclear` and a clarification question is published. Also include `humanGate` with the cited `sourceCommentId`, mapped
`verdict`, and bounded `notes`. Never invent provider IDs, URLs, SHAs, verdicts, or publication state.
