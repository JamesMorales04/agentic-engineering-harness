# Memory Model

## Rule

Memory informs; it does not authorize.

The provider abstraction starts with Engram but must remain replaceable.

The Engram adapter now implements bounded `remember`/`recall` through the
upstream CLI contract (`store` and `recall`) and keeps a small project-scoped
AEH ledger for deterministic deduplication and provenance. Records are tagged
with their source artifact where available; superseded or stale records are
excluded from recall. If Engram is configured as optional and its health check
fails, the Harness omits advisory memory. A required provider fails closed.
The provider is activated only by `memory:engram`; `memory: none` creates no
memory provider.

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
