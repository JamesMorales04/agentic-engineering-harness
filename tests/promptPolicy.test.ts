import { describe, expect, it } from "vitest";
import { compileAgentPromptPolicy, outputContractContext } from "../src/workers/promptPolicy.js";

const reviewer = {
  logicalAgent: "test-reviewer",
  role: "reviewer",
  runtimeAdapter: "opencode",
  skills: ["finding-dedup", "simplify", "verification-planning", "acceptance-traceability", "structured-output-delivery"]
} as never;
const supervisor = {
  logicalAgent: "operation-supervisor",
  role: "coordinator",
  runtimeAdapter: "codex",
  skills: ["finding-dedup", "acceptance-traceability", "recovery-classifier", "verification-planning"]
} as never;

const auditContract = {
  version: 1,
  task: { id: "AUDIT-1", title: "Audit" },
  routing: { intent: "audit" }
} as never;

describe("deterministic prompt policy", () => {
  it("uses only audit review semantics on normal audit reviewer turns", () => {
    const policy = compileAgentPromptPolicy(reviewer, auditContract, {
      outputContract: "reviewer",
      phase: "review",
      operationKind: "audit",
      transport: "paseo"
    });
    expect(policy.skills).toEqual(["audit-review-protocol"]);
    expect(policy.outputContractContext).toContain("supplied out-of-band");
    expect(policy.outputContractContext).not.toContain("properties");
  });

  it("keeps traceability when the contract has acceptance evidence", () => {
    const policy = compileAgentPromptPolicy(reviewer, { ...auditContract, requirements: [{ id: "REQ-1" }] } as never, {
      phase: "review",
      operationKind: "audit",
      transport: "paseo"
    });
    expect(policy.skills).toEqual(["audit-review-protocol", "acceptance-traceability"]);
  });

  it("loads structured-output-delivery only for the bounded contract repair turn", () => {
    const policy = compileAgentPromptPolicy(reviewer, auditContract, {
      outputContract: "reviewer",
      phase: "review-contract-repair",
      operationKind: "audit",
      transport: "paseo"
    });
    expect(policy.skills).toEqual(["audit-review-protocol", "structured-output-delivery"]);
    expect(policy.outputContractContext).toContain("serialization-repair");
  });

  it("strips supervisor semantic skills during serialization repair", () => {
    const policy = compileAgentPromptPolicy(supervisor, auditContract, {
      outputContract: "supervisor",
      phase: "consolidating-contract-repair",
      operationKind: "audit",
      transport: "paseo"
    });
    expect(policy.skills).toEqual(["structured-output-delivery"]);
  });

  it("keeps an explicit schema in prompts only for transports without native schema enforcement", () => {
    const text = outputContractContext("reviewer", false);
    expect(text).toContain("Schema:");
    expect(text).toContain("findings");
  });
});
