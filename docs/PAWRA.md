# Pawra Integration Guidance

Pawra-specific knowledge should stay in Pawra.

The harness supplies generic mechanics; Pawra should add product-specific policies such as:

- strict tenant isolation;
- Domain/Application/Infrastructure dependency boundaries;
- public API compatibility;
- authorization invariants;
- migration rules;
- web/mobile/shared package boundaries;
- medical-record access rules;
- billing/payment invariants.

The `examples/pawra` directory demonstrates the expected shape without attempting to encode the full Pawra codebase.
