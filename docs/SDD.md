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

## Phase gates

A future version of the harness should validate requirement IDs across phases so later artifacts cannot silently add/remove requirements without an explicit decision.
