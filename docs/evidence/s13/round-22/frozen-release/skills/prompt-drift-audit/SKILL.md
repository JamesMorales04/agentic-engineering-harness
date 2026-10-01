---
name: prompt-drift-audit
description: Detect drift among source topology, prompts, skills, routing and generated runtime artifacts.
license: Apache-2.0
---
# Prompt and Configuration Drift Audit

Check source -> generated runtime consistency and all referenced prompt/skill paths. Verify agent role charters match routing ownership, skill/MCP names resolve, generated files are not hand-edited and duplicated policy text has not diverged across prompts.

Prefer `aeh agents check` and schema/reference checks for deterministic drift. Use semantic review only for role/policy contradictions that cannot be reduced to references or hashes.
