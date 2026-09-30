---
name: verification-planning
description: Design deterministic evidence and validation gates before implementation.
license: Apache-2.0
---
# Verification Planning

Use before non-trivial implementation.

1. Map each requirement to observable evidence.
2. Prefer an existing deterministic validator over LLM review.
3. Separate fast focused checks from final integration checks.
4. Identify environment, fixture and external-service prerequisites.
5. Define failure signals that are unambiguous and machine-readable.
6. Do not weaken acceptance criteria to fit the implementation.

Return: requirement -> validator -> command/evidence -> expected pass condition -> fallback if the validator cannot run.
