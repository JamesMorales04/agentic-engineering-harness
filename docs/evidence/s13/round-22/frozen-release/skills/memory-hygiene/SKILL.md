---
name: memory-hygiene
purpose: Prevent stale agent memory from becoming an authority source.
---

# Memory Hygiene

Memory is advisory historical context.

Store:
- decisions and their rationale;
- bugs and discoveries;
- conventions;
- useful implementation summaries.

Do not treat memory as authoritative for:
- current requirements;
- current API/schema state;
- current acceptance criteria;
- current architecture when Git contradicts it.

When a decision changes, supersede or explicitly invalidate the old memory instead of storing contradictory facts without provenance.
