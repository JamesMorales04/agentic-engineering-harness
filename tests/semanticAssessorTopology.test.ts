import { describe, expect, it } from "vitest";
import { resolveAgentTopology } from "../src/agents/config.js";
import { resolveSemanticAssessor } from "../src/semantic/assessment.js";
import { canonicalRoleValues, isCanonicalRole } from "../src/participants/index.js";
import { semanticAssessorTopologySource } from "./semanticAssessmentSupport.js";

describe("Semantic Assessor topology resolution", () => {
  it("resolves model/profile selection only from AgentTopology", () => {
    // Codex-channel Luna is pending requalification, so both the base and profile-overridden
    // topologies fail closed at the capability gate (after profile model selection, which is
    // why both reach PENDING_REQUALIFICATION instead of an earlier topology error).
    const source = structuredClone(semanticAssessorTopologySource);
    source.profiles = { high: { models: { assessorModel: { variant: "max" } } } };
    expect(() => resolveSemanticAssessor(resolveAgentTopology(source))).toThrow(/PENDING_REQUALIFICATION/);
    expect(() => resolveSemanticAssessor(resolveAgentTopology(source, "high"))).toThrow(/PENDING_REQUALIFICATION/);
  });

  it("fails closed when the topology has zero or multiple enabled assessors", () => {
    const missing = structuredClone(semanticAssessorTopologySource);
    missing.agents.assessor!.disabled = true;
    expect(() => resolveSemanticAssessor(resolveAgentTopology(missing))).toThrow(/exactly one enabled Semantic Assessor/);

    const multiple = structuredClone(semanticAssessorTopologySource);
    multiple.agents.otherAssessor = structuredClone(multiple.agents.assessor!);
    expect(() => resolveSemanticAssessor(resolveAgentTopology(multiple))).toThrow(/exactly one enabled Semantic Assessor/);
  });

  it("rejects unsafe permissions and keeps the agent outside Participant roles", () => {
    const unsafe = structuredClone(semanticAssessorTopologySource);
    unsafe.agents.assessor!.permissions!.read = "allow";
    expect(() => resolveSemanticAssessor(resolveAgentTopology(unsafe))).toThrow(/must explicitly deny read/);
    expect(canonicalRoleValues).not.toContain("Semantic Assessor");
    expect(isCanonicalRole("Semantic Assessor")).toBe(false);
  });
});
