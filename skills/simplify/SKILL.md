---
name: simplify
description: Reduce unnecessary complexity without changing observable behavior or sealed contracts.
license: Apache-2.0
---
# Simplify

Use after correctness is established or when complexity itself causes risk.

- Preserve behavior, public contracts and acceptance criteria.
- Remove accidental abstraction, duplication and confusing control flow only when evidence supports it.
- Prefer small local simplifications over broad rewrites.
- Keep changes within task scope and rerun the focused deterministic checks.
- Do not trade explicit invariants for cleverness.

Report what became simpler and the evidence that behavior remains unchanged.
