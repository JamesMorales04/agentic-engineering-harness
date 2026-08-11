# Design: Location-scoped membership permissions

This example intentionally leaves implementation details incomplete. In the real Pawra repository, Codex should inspect the current code and Graphify graph before writing this artifact.

## Design constraints

- Domain code must not depend on Infrastructure.
- Tenant filtering must be enforced at authoritative data-access boundaries.
- Public API changes require explicit contract authorization.
