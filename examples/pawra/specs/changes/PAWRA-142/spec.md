# Specification: Location-scoped membership permissions

## PAWRA-142-R1

A membership may define permissions scoped to a location within its organization. When a location-specific permission exists, the defined precedence rule must be applied consistently.

## PAWRA-142-R2

No location-scoped permission may permit access to data owned by another organization.

## Invariants

- Organization remains the tenant boundary.
- A location belongs to exactly one organization for authorization evaluation.
- Existing organization-level permissions remain compatible unless explicitly superseded by the approved design.
