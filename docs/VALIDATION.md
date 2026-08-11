# Validation Strategy

Validation is layered:

1. Compiler/type system.
2. Static analysis/lint.
3. Unit tests.
4. Integration tests with real dependencies where practical.
5. Gherkin/BDD acceptance tests.
6. Architecture/topology gates.
7. API/consumer contracts.
8. Security and tenant-isolation invariants.
9. Diff-scope/frozen-path/budget policies.
10. Supply-chain and dependency policy.

## Trust firewall

Workers must not be able to change frozen contracts or acceptance validators merely to make the result pass.

## Repair loop

A recommended workflow is:

```text
worker → verify → structured failure packet → same worker → verify
```

Set a finite automatic repair budget, then escalate to the lead agent.
