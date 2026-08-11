# Memory Model

## Rule

Memory informs; it does not authorize.

The provider abstraction starts with Engram but must remain replaceable.

## Store

- architectural decisions and rationale;
- important discoveries/gotchas;
- bugs and root causes;
- conventions;
- post-change implementation summaries;
- links back to authoritative Git artifacts.

## Do not use memory as source of truth for

- current requirements;
- current API/schema;
- current acceptance criteria;
- current migration state;
- anything contradicted by the checked-out repository.

## Future backend evaluation

Compare Engram, Cognee and Graphiti using the engineering eval corpus. Measure retrieval precision, stale-memory rate, latency, operational complexity and effect on first-pass validation success.
