import { z } from "zod";
import { extractMarkedJson } from "./structuredOutput.js";
import { continueManagedPaseoAgent, inspectManagedPaseoAgent } from "../paseo/runtime.js";
import { currentObjectiveIdentityV1, leadAcceptanceRequiredV1, type ManagedLeadAcceptanceEvidenceV1 } from "../architecture/acceptanceOracle.js";
import type { CandidateAssuranceCompilationV1 } from "../architecture/candidateAssurance.js";
import { sha256Canonical } from "../core/digest.js";
import type { ValidationReport } from "../core/types.js";
import { loadOperation, resolveOperationStateRoot } from "../operations/state.js";

const leadOutputSchema = z.object({
  assertions: z.array(z.object({ assertionId: z.string().trim().min(1), verdict: z.enum(["PASS", "FAIL"]), rationale: z.string().trim().min(1) }).strict()),
  summary: z.string().trim().min(1),
  unresolved: z.array(z.string().trim().min(1))
}).strict();

const leadOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assertions", "summary", "unresolved"],
  properties: {
    assertions: { type: "array", items: { type: "object", additionalProperties: false, required: ["assertionId", "verdict", "rationale"], properties: { assertionId: { type: "string" }, verdict: { enum: ["PASS", "FAIL"] }, rationale: { type: "string" } } } },
    summary: { type: "string" },
    unresolved: { type: "array", items: { type: "string" } }
  }
};

export async function requestManagedLeadAcceptance(input: {
  root: string;
  operationId: string;
  compilation: CandidateAssuranceCompilationV1;
  report: ValidationReport;
  implementationIdentity: string;
}): Promise<ManagedLeadAcceptanceEvidenceV1 | undefined> {
  const stateRoot = resolveOperationStateRoot(input.root);
  const operation = await loadOperation(stateRoot, input.operationId);
  const policy = operation.resolvedOperationPolicy;
  if (!policy || !leadAcceptanceRequiredV1(policy)) return undefined;
  const identity = currentObjectiveIdentityV1(operation);
  const binding = operation.lead;
  if (!binding?.agentId || !Number.isSafeInteger(binding.generation) || binding.generation < 1) {
    throw new Error("ACCEPTANCE_LEAD_REQUIRED: managed operation has no current bound Lead generation.");
  }
  if (binding.agentId === input.implementationIdentity || operation.participants[binding.agentId]?.logicalAgent === input.implementationIdentity) {
    throw new Error("ACCEPTANCE_LEAD_NOT_INDEPENDENT: bound managed Lead is the implementation actor.");
  }
  if (!input.report.candidate || input.report.candidate.identityDigest !== identity.candidate.identityDigest
    || input.compilation.policyDigest !== identity.policyDigest || input.compilation.candidate.identityDigest !== identity.candidate.identityDigest) {
    throw new Error("ACCEPTANCE_LEAD_INPUT_STALE: Lead acceptance requires current candidate-bound assertions and validation report.");
  }

  const prompt = [
    "[AEH_MANAGED_LEAD_ACCEPTANCE]",
    `You are the currently bound Lead for managed operation ${identity.operationId}, generation ${binding.generation}.`,
    "Assess the candidate's AcceptanceAssertions against the current candidate and sealed task requirements. This is semantic evidence only: do not claim authority, change operation state, accept on behalf of the controller, or initiate delivery effects.",
    `Current identity: ${JSON.stringify({ operationId: identity.operationId, candidate: { candidateId: identity.candidate.candidateId, revision: identity.candidate.revision, identityDigest: identity.candidate.identityDigest }, policyDigest: identity.policyDigest, operationExecutionRevision: identity.operationExecutionRevision, controllerEpoch: identity.controllerEpoch })}`,
    `Task: ${input.report.taskId}`,
    `Validation summary: ${input.report.status}; checks=${input.report.checks.map((check) => `${check.id}:${check.status}`).join(", ")}`,
    `Assertions: ${JSON.stringify(input.compilation.acceptanceAssertions.map(({ id, statement, requirementRefs, dimensions, evidenceStrength }) => ({ assertionId: id, statement, requirementRefs, dimensions, evidenceStrength })))}`,
    "Return one JSON object with exactly: assertions[{assertionId,verdict:'PASS'|'FAIL',rationale}], summary, unresolved[]. Include every supplied assertion exactly once and use its exact assertionId. Verdict PASS only when current candidate evidence supports the statement; otherwise use FAIL and explain the gap. Final line must be AEH_RESULT_JSON=<json>."
  ].join("\n");
  const promptDigest = sha256Canonical(prompt);
  const paseoLead = await inspectManagedPaseoAgent(input.root, binding.agentId);
  const provider = paseoLead?.labels?.["aeh.provider"];
  if (!provider) throw new Error("ACCEPTANCE_LEAD_PROVIDER_IDENTITY_REQUIRED: the bound Paseo Lead session has no persisted provider label.");
  const response = await continueManagedPaseoAgent(input.root, binding.agentId, prompt, 600, undefined, leadOutputJsonSchema, {
    "aeh.operation": operation.id,
    "aeh.lead.agentId": binding.agentId,
    "aeh.lead.generation": String(binding.generation),
    "aeh.provider": provider,
    ...(paseoLead.workspaceId ? { "aeh.workspace.id": paseoLead.workspaceId } : {})
  });
  const latest = await loadOperation(stateRoot, input.operationId);
  const latestIdentity = currentObjectiveIdentityV1(latest);
  if (latest.lead?.agentId !== binding.agentId || latest.lead.generation !== binding.generation
    || sha256Canonical(latestIdentity) !== sha256Canonical(identity)) {
    throw new Error("ACCEPTANCE_LEAD_BINDING_STALE: operation identity or bound Lead generation changed during semantic assessment.");
  }
  let parsed: z.infer<typeof leadOutputSchema> | undefined;
  if (response.exitCode === 0) {
    try { parsed = leadOutputSchema.parse(extractMarkedJson(response.stdout, response.stderr)); }
    catch { parsed = undefined; }
  }
  const expected = input.compilation.acceptanceAssertions.map((assertion) => assertion.id).sort();
  const observed = parsed?.assertions.map((assertion) => assertion.assertionId).sort() ?? [];
  const exactCoverage = expected.length === observed.length && expected.every((id, index) => id === observed[index]);
  const passed = Boolean(parsed && exactCoverage && parsed.assertions.every((assertion) => assertion.verdict === "PASS") && parsed.unresolved.length === 0);
  return {
    version: 1,
    status: passed ? "PASS" : "FAIL",
    operationId: identity.operationId,
    candidate: identity.candidate,
    policyDigest: identity.policyDigest,
    operationExecutionRevision: identity.operationExecutionRevision,
    controllerEpoch: identity.controllerEpoch,
    leadAgentId: binding.agentId,
    leadGeneration: binding.generation,
    assertions: parsed?.assertions ?? [],
    summary: parsed?.summary ?? `Bound Lead response did not satisfy the structured acceptance contract (exitCode=${response.exitCode}).`,
    unresolved: parsed?.unresolved ?? ["Lead response missing or invalid."],
    promptDigest,
    responseDigest: sha256Canonical({ exitCode: response.exitCode, stdout: response.stdout, stderr: response.stderr })
  };
}
