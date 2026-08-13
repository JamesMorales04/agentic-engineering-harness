---
name: structured-output-delivery
description: Deliver machine-consumed AEH agent results through the controller-owned structured result channel.
license: Apache-2.0
---
# Structured Output Delivery

This skill governs delivery only. It never changes the task conclusion, findings, evidence, or lifecycle authority.

When AEH supplies an output contract or JSON Schema:

1. Treat the schema as authoritative and machine-consumed.
2. Preserve the semantic result already established by the task. Delivery repair must not add findings, remove findings, rerun tools, or change conclusions.
3. If the capability-scoped `aeh_submit_result` tool is available, call it exactly with the final contract object. Do not supply operation ids, agent ids, contract names, paths, or lifecycle state; those are controller-bound.
4. A successful `aeh_submit_result` call is the authoritative delivery. Do not call it again with a different payload. If the provider requires a native structured final response, it may repeat the same object only for transport compatibility.
5. If the tool rejects the payload, correct only the reported schema/serialization defect and resubmit the same semantic result.
6. If no result-sink tool is available, return exactly one JSON value matching the schema. Use ordinary ASCII JSON syntax; string delimiters must be U+0022 (`"`), never typographic quotes.
7. Do not wrap JSON in Markdown fences, headings, bullets, or explanatory prose.
8. Only when AEH explicitly requests the legacy marker fallback and no result-sink tool is available, return exactly one line:

`AEH_RESULT_JSON=<valid compact JSON>`

Before completing a fallback delivery, check syntactically that a standard JSON parser can parse the payload and that enum values and required fields match the supplied contract.