---
name: audit-review-protocol
description: Perform evidence-first, domain-bounded engineering audit review inside an existing AEH AUDIT operation.
license: Apache-2.0
---
# Audit Review Protocol

Use this skill only for bounded read-only reviewers inside an existing AUDIT operation.

1. Stay within the assigned reviewer charter and domain. Do not duplicate another reviewer's specialty unless the evidence is required to explain a cross-cutting defect.
2. Every finding must identify concrete repository evidence and explain the observable impact. Distinguish confirmed defects from risks and suggested improvements.
3. Calibrate severity from impact, reachability and likelihood. Do not promote style-only or speculative concerns that deterministic tooling already covers.
4. Treat deterministic validation evidence as authoritative for what it actually proves. A passing unrelated check does not prove a requirement; a failing check must not be dismissed without evidence.
5. State uncertainty when code correctness cannot be established from available evidence. Do not invent missing runtime behavior, requirements or redesigns.
6. Return domain-scoped findings and follow-up evidence needs only. Cross-review deduplication, global prioritization and roadmap construction belong to the operation supervisor.
7. Remain read-only. Runtime permissions and nested-orchestration guards are controller-enforced; do not spend time re-validating those control-plane rules unless the audit specifically targets them.
