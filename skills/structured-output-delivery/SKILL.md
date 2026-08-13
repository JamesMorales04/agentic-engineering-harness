---
name: structured-output-delivery
description: Deliver machine-consumed AEH agent results as valid JSON that satisfies the runtime output contract.
license: Apache-2.0
---
# Structured Output Delivery

This skill governs delivery format only. It never changes the task conclusion, findings, evidence, or lifecycle authority.

When AEH supplies an output contract or JSON Schema:

1. Treat the schema as authoritative and machine-consumed.
2. Return exactly one JSON value matching that schema as the final result.
3. Use ordinary ASCII JSON syntax. String delimiters must be U+0022 (`"`); never use typographic quotes such as `“` or `”`.
4. Do not wrap the JSON in Markdown fences, headings, bullets, or explanatory prose.
5. Do not omit required fields, rename fields, or invent undeclared fields to make serialization easier.
6. Preserve the semantic result already established by the task. Formatting repair must not add findings, remove findings, rerun tools, or change conclusions.
7. If the transport cannot return native structured output and AEH explicitly requests the marker fallback, return exactly one line in this form:

`AEH_RESULT_JSON=<valid compact JSON>`

Before completing the turn, check syntactically that the payload could be parsed by a standard JSON parser and that enum values and required fields match the supplied contract.
