---
name: routing-normalizer
description: Convert a plan into bounded, ownership-safe delegation tasks.
license: Apache-2.0
---
# Routing Normalizer

Every delegated task must identify: id, summary, owning agent, scope, dependencies, acceptance evidence and risk.

Reject or repair plans when:
- two parallel writers overlap the same files without an ordering dependency;
- a dependency references a missing task;
- the selected agent does not own the stated domain;
- acceptance is vague or cannot be validated;
- the task silently expands sealed scope.

Prefer the narrowest capable agent and explicit dependency edges over broad generalists.
