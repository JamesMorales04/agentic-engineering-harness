# SDD Operating Model

A change is incomplete until the following chain is coherent:

```text
Explore → Proposal → Spec → Design → Acceptance → Tasks → Frozen Contract → Apply → Verify → Archive
```

## Gherkin boundary

Use Gherkin for **observable business behavior**, not implementation details.

Good:

```gherkin
Rule: Staff cannot access another tenant's medical records

  Scenario: Veterinarian requests a pet from another organization
    Given Alice is a veterinarian in organization A
    And Luna belongs to organization B
    When Alice requests Luna's medical record
    Then access is denied
```

Bad:

```gherkin
Scenario: Repository calls DbContext once
```

Architecture/unit tests belong elsewhere.

## Frozen requirements and verification

For managed `FORMAL_SDD` work, the Spec Manager authors the OpenSpec proposal,
specifications, design, and tasks. Deterministic validation and compilation
produce stable AEH requirement IDs, acceptance assertions, verification
requirements, and a sealed TaskContract. The seal and compiled artifacts are
the execution contract after freeze; OpenSpec remains authoring provenance.

The controller verifies that frozen requirements and assertions remain
traceable through the compiled contract. Required validators must resolve to an
approved candidate-bound validation path and their evidence must identify the
current candidate. The AcceptanceOracle checks assertions against that exact
evidence and emits the deterministic acceptance disposition. ObjectiveCompletion
checks the remaining operation obligations and terminal identity after oracle
evaluation. A passing validator alone does not satisfy an assertion it was not
declared to verify.

OpenSpec CLI apply commands do not implement the product change. The deterministic
controller owns implementation, validation, acceptance, and delivery after the
contract is sealed.
