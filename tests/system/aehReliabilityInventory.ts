export const ADVERSARIAL_SCENARIO_IDS = [
  "ADV-01-malformed-structured-output", "ADV-02-provider-nonzero", "ADV-03-required-optional-policy", "ADV-04-timeout", "ADV-05-trivy-invalid-member", "ADV-06-browser-noise", "ADV-07-process-crash", "ADV-08-context-traversal", "ADV-09-context-absolute", "ADV-10-context-symlink", "ADV-11-retrieval-hash", "ADV-12-retrieval-no-artifact", "ADV-13-cross-operation-retrieval", "ADV-14-terminal-reentry", "ADV-15-queued-success-patch", "ADV-16-duplicate-terminal", "ADV-17-unsafe-operation-id", "ADV-18-stale-lock", "ADV-19-implementer-write-deny", "ADV-20-reviewer-write-allow", "ADV-21-native-agent-unsupported", "ADV-22-runtime-deny-projection", "ADV-23-completion-failure", "ADV-24-malformed-completion", "ADV-25-missing-provenance", "ADV-26-unsafe-provenance-path", "ADV-27-stale-memory-source"
] as const;

export const CONCURRENCY_SCENARIO_IDS = [
  "CON-01-terminal-race", "CON-02-participant-registration", "CON-03-completion-race", "CON-04-context-persistence", "CON-05-unauthorized-retrieval", "CON-06-supervisor-replacement", "CON-07-terminal-completion", "CON-08-lead-acknowledgement", "CON-09-duplicate-delivery"
] as const;

export const HUMAN_JOURNEY_IDS = [
  "HJ-01-audit", "HJ-02-security", "HJ-03-architecture", "HJ-04-provider", "HJ-05-context", "HJ-06-recovery", "HJ-07-delivery", "HJ-08-lifecycle", "HJ-09-lineage", "HJ-10-permissions", "HJ-11-concurrency", "HJ-12-packaged"
] as const;

export const MULTI_TURN_JOURNEY_IDS = ["HJ-MT-01", "HJ-MT-02", "HJ-MT-03", "HJ-MT-04", "HJ-MT-05"] as const;
export const PROVIDER_CONTRACT_IDS = ["headroom", "graphify", "serena", "engram", "trivy", "opengrep", "playwright", "pact"] as const;
export const REQUIRED_COVERAGE_FLOORS = { scenarios: 100, adversarial: 20, human: 12, multiTurn: 5, concurrency: 8 } as const;

export const FIXED_FINDINGS = [
  { scenario: "SCN-LIFECYCLE-TERMINAL-LATE-CUSTOM-MUTATION", classification: "lifecycle", status: "FIXED", productionFix: "terminal records now return unchanged from custom lifecycle mutators", regressionTest: "tests/operations.test.ts" },
  { scenario: "SCN-CONTEXT-SOURCE-HASH-MISSING-ARTIFACT", classification: "context", status: "FIXED", productionFix: "new artifacts verify supplied content against the declared SHA-256 before writing", regressionTest: "tests/contextEfficiency.test.ts" },
  { scenario: "SCN-CONTEXT-SYMLINK-ESCAPE", classification: "security", status: "FIXED", productionFix: "context persistence and retrieval reject symlink traversal", regressionTest: "tests/contextEfficiency.test.ts" },
  { scenario: "SCN-COMPLETION-CONCURRENT-DISPATCH", classification: "concurrency", status: "FIXED", productionFix: "completion notification dispatch is serialized by an operation-scoped lock", regressionTest: "tests/operationCompletion.test.ts" },
  { scenario: "SCN-VALIDATOR-MALFORMED-STRUCTURED-OUTPUT", classification: "validation", status: "FIXED", productionFix: "known structured validator adapters validate evidence shape before PASS", regressionTest: "tests/system/aehAdversarialE2E.test.ts" },
  { scenario: "SCN-TRIVY-VALID-ZERO-FINDINGS", classification: "validation", status: "FIXED", productionFix: "pinned Trivy v2 reports without Results or with null Results are valid zero-findings evidence", regressionTest: "tests/contextArchitectureClose.test.ts" },
  { scenario: "SCN-HARNESS-SEED-OVERRIDE-REPRODUCTION", classification: "test-infrastructure", status: "FIXED", productionFix: "scenario assertions accept the documented AEH_SCENARIO_SEED override", regressionTest: "tests/system/aehScenarioMatrix.test.ts" }
] as const;
