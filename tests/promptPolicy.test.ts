import { describe, expect, it } from "vitest";
import { compileAgentPromptPolicy, outputContractContext } from "../src/workers/promptPolicy.js";

const reviewer = {
  logicalAgent: "test-reviewer",
  role: "reviewer",
  runtimeAdapter: "opencode",
  skills: ["verification-planning", "acceptance-traceability", "structured-output-delivery"]
} as never;

const auditContract = {
  version: 1,
  task: { id: "AUDIT-1", title: "Audit" },
  routing: { intent: "audit" }
} as never;

describe("deterministic prompt policy", () => {
  it("uses the audit protocol and removes inapplicable planning/delivery skills from normal audit reviews", () => {
    const policy = compileAgentPromptPolicy(reviewer, auditContract, {
      outputContract: "reviewer",
      phase: "review",
      operationKind: "audit",
      transport: "paseo"
    });
    expect(policy.skills).toContain("audit-review-protocol");
    expect(policy.skills).not.toContain("verification-planning");
    expect(policy.skills).not.toContain("acceptance-traceability");
    expect(policy.skills).not.toContain("structured-output-delivery");
    expect(policy.outputContractContext).toContain("supplied out-of-band");
    expect(policy.outputContractContext).not.toContain("properties");
  });

  it("keeps traceability when the contract has acceptance evidence", () => {
    const policy = compileAgentPromptPolicy(reviewer, { ...auditContract, requirements: [{ id: "REQ-1" }] } as never, {
      phase: "review",
      operationKind: "audit",
      transport: "paseo"
    });
    expect(policy.skills).toContain("acceptance-traceability");
  });

  it("loads structured-output-delivery only for the bounded contract repair turn", () => {
    const policy = compileAgentPromptPolicy(reviewer, auditContract, {
      outputContract: "reviewer",
      phase: "review-contract-repair",
      operationKind: "audit",
      transport: "paseo"
    });
    expect(policy.skills).toContain("structured-output-delivery");
    expect(policy.outputContractContext).toContain("serialization-repair");
  });

  it("keeps an explicit schema in prompts only for transports without native schema enforcement", () => {
    const text = outputContractContext("reviewer", false);
    expect(text).toContain("Schema:");
    expect(text).toContain("findings");
  });
});
