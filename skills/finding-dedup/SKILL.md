---
name: finding-dedup
description: Normalize and consolidate reviewer findings before remediation.
license: Apache-2.0
---
# Finding Deduplication

Represent findings with severity, category, location, evidence, impact, recommended fix and owning agent.

Treat findings as likely duplicates when they target the same path, overlapping lines/behavior, category and remediation. Preserve the strongest evidence/severity and union useful context. Keep distinct findings separate when their root cause or fix differs.

Do not discard a finding merely because another reviewer did not mention it.
