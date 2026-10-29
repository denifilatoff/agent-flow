# Attempt accounting implementation update

The owner decision on issue #2 (comment 6501491971) supersedes post-publication annotation in the original plan. Keep the published assessment and plan intact. Reuse the saved structured collectors, complete descendant accounting, conservative pricing, strict old-pin compatibility, and per-attempt receipt archive.

Remaining increments:

1. Opt new Stack revisions into `publication: controller-prepared-v1`. The runtime prompt asks agents to prepare substantive stage comment text locally. Existing pins continue agent publication and retain usage in receipts only. PR creation and native reviews retain their existing contracts.
2. Validate the minimal decision and prepared text after the harness and its native descendants finish. Persist completed accounting and a frozen prepared publication before delivery. Create the substantive comment with the unchanged common publication marker and compact usage line together. Read back the exact body and target before normal result verification. Never edit a published comment for accounting.
3. Resume retained prepared delivery independently of model execution. On uncertain writes, inspect provider evidence before another write; never blindly duplicate a comment. Preserve provider cancellation, ownership, provenance, and pinned configuration checks. Local prepared work remains disposable and cannot authorize a stage transition without provider evidence.
4. Replace annotation tests with creation/readback/retry tests. Exercise GitHub and GitLab end to end, including legacy pins, unsuccessful attempts, cancellation, restart, absent cost, and uncertain delivery. Document protocol and disposable retention.

References: owner-pinned ReviewCTL `bcc61d355c1c79bfbcc2df0866f67aa4fab14d69`, `usage.go` (completed session tree and complete pricing inputs), `signature.go` (target validation, exact readback, independent retry). Do not adopt its post-publication editing or add a dependency.

Verification: focused Node tests per increment, then `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`, and diff review. No protocol version or pricing guesses; unavailable cost stays absent.
