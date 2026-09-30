---
name: sdd
purpose: Drive a strict spec-driven change from exploration to archival.
---

# Spec-Driven Development

Phases:

1. Explore: understand current state without deciding prematurely.
2. Proposal: state problem, desired outcome, scope and non-goals.
3. Specification: define requirements/invariants without implementation detail.
4. Design: define architecture, interfaces, data/API impact and trade-offs.
5. Acceptance: encode observable business behavior in Gherkin where appropriate.
6. Tasks: decompose design into implementation work.
7. Contract: create and freeze a machine-readable TaskContract.
8. Apply: delegate implementation to constrained workers.
9. Verify: deterministic harness first, semantic review second.
10. Archive: persist final artifacts and curated learnings to memory.

Do not let a later phase silently rewrite the intent of an earlier approved phase.
