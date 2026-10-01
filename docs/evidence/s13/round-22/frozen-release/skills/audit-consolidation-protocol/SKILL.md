---
name: audit-consolidation-protocol
description: Consolidate audit reviewer evidence into one provenance-complete prioritized result.
license: Apache-2.0
---
# Audit Consolidation Protocol

Use only for semantic consolidation after bounded audit reviewers finish.

1. Account for every source finding ID exactly once at set level; semantic duplicates may be merged.
2. Preserve the strongest concrete evidence, impact, and severity when merging duplicates.
3. Keep findings separate when root cause or remediation differs.
4. Treat deterministic validation outcomes as authoritative evidence and never rewrite them.
5. Surface conflicting reviewer conclusions and missing evidence explicitly.
6. Prioritize remediation by severity, blast radius, lifecycle risk, and dependency order.
7. Produce a compact phased roadmap from the consolidated findings; do not invent work unsupported by evidence.
