---
name: deterministic-validation
purpose: Treat executable gates as authoritative over LLM self-assessment.
---

# Deterministic Validation

Run `engineering-harness verify <TASK-ID>` after implementation.

Interpretation:

- Any `FAIL` blocks acceptance.
- `WARN` requires lead-agent consideration but does not automatically block.
- A worker's claim that tests pass is not evidence; the generated validation report is evidence.
- Never weaken frozen validation artifacts to turn a failing result into PASS.
