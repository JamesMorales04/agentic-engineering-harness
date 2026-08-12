---
name: recovery-classifier
description: Classify agent/validation failures and select the smallest deterministic recovery path.
license: Apache-2.0
---
# Recovery Classifier

Classify evidence into the Harness failure taxonomy before retrying:
PATCH_CONTEXT_MISMATCH, TOOL_FAILURE, MISSING_CONTEXT, WRONG_AGENT, VALIDATION_FAILURE, REVIEW_FAILURE, AMBIGUOUS_OUTPUT, CONFLICTING_RESULTS.

Use exact stderr/stdout, validator failures and routing evidence. Do not label a product/spec contradiction as an implementation failure.

Recovery preference: same agent with better context -> narrow reroute/quality remediation -> senior/oracle -> lead/human only for true exceptions. Preserve the failure packet and retry history.
