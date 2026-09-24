import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { explorerOutputSchema, outputJsonSchema, specAuthoringOutputSchema } from "../src/agents/outputContracts.js";
import type { WorkerSession } from "../src/core/types.js";
import { sha256Canonical } from "../src/core/digest.js";
import { compileExecutionBinding, compileResolvedOperationPolicy, compileRoleInvocationPolicy, compileSkillManifest, createExecutionBlueprintV2 } from "../src/architecture/executionIdentity.js";
import { createWorkGraph } from "../src/architecture/workGraph.js";
import { roleProfile } from "../src/participants/index.js";
import { bindOperationParticipantExecution, bindResolvedOperationPolicy, loadOperation, registerOperationAgent, saveOperation } from "../src/operations/state.js";
import { requireDurableChangeHandoff } from "../src/operations/changeHandoff.js";
import { acceptStructuredResult, activateStructuredResultTurn, bindStructuredResultChannel, createStructuredResultProvenance, provisionStructuredResultChannel } from "../src/workers/resultGateway.js";

function session(id: string): WorkerSession {
  return { id, provider: "opencode", logicalAgent: "explorer", exitCode: 0, stdout: "", stderr: "", status: "idle" };
}

afterEach(() => {
  delete process.env.AEH_OPERATION_ID;
  delete process.env.AEH_CONTROL_ROOT;
});

describe("CHANGE durable handoff", () => {
  it("requires a typed bounded product-choice draft without accepting authority fields from Spec Manager", () => {
    const blocked = {
      change: "catalog-choice",
      status: "BLOCKED",
      artifacts: { specs: [] },
      requirements: [],
      unresolvedDecisions: ["Which confirmation behavior should be required?"],
      decisionRequests: [{
        issue: "Choose a confirmation behavior.",
        whatTried: ["Reviewed current behavior."],
        whyUnresolvable: "Both options satisfy the source request.",
        choices: [{ choiceId: "confirm", label: "Require confirmation", description: "Ask explicitly.", consequences: ["Adds a confirmation step."] }],
        workThatCanContinue: []
      }],
      validationReady: false
    };
    expect(specAuthoringOutputSchema.parse(blocked)).toMatchObject({ status: "BLOCKED", decisionRequests: [{ choices: [{ choiceId: "confirm" }] }] });
    expect(specAuthoringOutputSchema.safeParse({ ...blocked, decisionRequests: [{ ...blocked.decisionRequests[0], actorId: "human:forged" }] }).success).toBe(false);
    expect(outputJsonSchema("spec-authoring")?.required).toContain("decisionRequests");
  });

  it("consumes an accepted explorer artifact even when captured stdout is empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-handoff-"));
    const operationId = "CHANGE-TEST";
    const agentId = "explorer-1";
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_CONTROL_ROOT = root;
    const provenance = await bindExplorerIdentity(root, operationId, agentId);
    const channel = await provisionStructuredResultChannel(root, { operationId, logicalAgent: "explorer", role: "Explorer", taskId: "TASK-CHANGE", contract: "explorer", operationRevision: provenance.operationRevision, provenance });
    await bindStructuredResultChannel(root, operationId, channel.channelId, agentId);
    await activateStructuredResultTurn(root, operationId, channel.channelId, "discovery");
    const payload = {
      summary: "Discovery completed",
      relevantFiles: [{ path: "src/operations/change.ts", symbols: ["runChangeOperation"], reason: "pipeline entry" }],
      findings: [{ id: "CON-001", status: "CONFIRMED", evidence: ["src/operations/change.ts:1"] }],
      moduleBoundaries: ["operations -> spec"],
      tests: ["tests/changeHandoff.test.ts"],
      dependencies: ["OpenSpec"],
      risks: [],
      openQuestions: []
    };
    const accepted = await acceptStructuredResult(root, operationId, channel.channelId, payload, "mcp");
    const handoff = await requireDurableChangeHandoff(root, "EXPLORER", session(agentId), explorerOutputSchema);
    expect(handoff.artifact).toBe(accepted.artifact);
    expect(handoff.payload.summary).toBe("Discovery completed");
  });

  it("consumes the handoff from the explicit control root when execution is isolated", async () => {
    const executionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-handoff-worktree-"));
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-handoff-control-"));
    const operationId = "CHANGE-CONTROL-ROOT";
    const agentId = "explorer-control-root";
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_CONTROL_ROOT = controlRoot;
    const provenance = await bindExplorerIdentity(controlRoot, operationId, agentId);
    const channel = await provisionStructuredResultChannel(controlRoot, { operationId, logicalAgent: "explorer", role: "Explorer", taskId: "TASK-CHANGE", contract: "explorer", operationRevision: provenance.operationRevision, provenance });
    await bindStructuredResultChannel(controlRoot, operationId, channel.channelId, agentId);
    await activateStructuredResultTurn(controlRoot, operationId, channel.channelId, "discovery");
    await acceptStructuredResult(controlRoot, operationId, channel.channelId, {
      summary: "Control-root discovery",
      relevantFiles: [],
      findings: [],
      moduleBoundaries: [],
      tests: [],
      dependencies: [],
      risks: [],
      openQuestions: []
    }, "mcp");

    const handoff = await requireDurableChangeHandoff(executionRoot, "EXPLORER", session(agentId), explorerOutputSchema, controlRoot);
    expect(handoff.payload.summary).toBe("Control-root discovery");
  });

  it("fails closed when an expected structured handoff is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-handoff-missing-"));
    await expect(requireDurableChangeHandoff(root, "EXPLORER", session("missing-agent"), explorerOutputSchema)).rejects.toThrow(/RESULT_ARTIFACT_MISSING/);
  });
});

async function bindExplorerIdentity(root: string, operationId: string, participantId: string) {
  const now = new Date().toISOString();
  await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "discovery", root,
    payload: { taskId: "TASK-CHANGE" }, createdAt: now, updatedAt: now });
  let operation = await loadOperation(root, operationId);
  const candidate = operation.candidateRevision!;
  await registerOperationAgent(root, operationId, { id: participantId, logicalAgent: "explorer", role: "Explorer", phase: "discovery" });
  const policy = compileResolvedOperationPolicy({ projectId: candidate.projectId!, operationId, operationExecutionRevision: operation.operationExecutionRevision!,
    candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: operation.controller?.epoch ?? 0, intent: "discover the requested change",
    route: "DELEGATED", minimumAssurance: "STANDARD", policyVersions: { resolvedOperationPolicy: "1" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {},
    deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: [] });
  operation = await bindResolvedOperationPolicy(root, operationId, policy);
  const toolPack = roleProfile("Explorer").toolPack;
  const roleInvocationPolicy = compileRoleInvocationPolicy({ operationId, operationPolicyDigest: policy.digest, participantId, role: "Explorer", workUnitIds: ["discovery"],
    scope: ["src/**"], competencies: [], toolPack, resourceClaims: [], outputContract: "explorer", constraints: { readOnly: true } });
  const skillManifest = compileSkillManifest({ scope: { operationId, operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: operation.controller?.epoch ?? 0, participantId, workUnitIds: ["discovery"], competencies: [] }, skills: [] });
  const validationResolution = { version: 1 as const, requirements: [], actions: [], blocked: [], digest: sha256Canonical({ version: 1, requirements: [], actions: [], blocked: [] }) };
  const blueprint = createExecutionBlueprintV2({ projectId: candidate.projectId!, operationId, operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest, controllerEpoch: operation.controller?.epoch ?? 0, resolvedOperationPolicy: policy,
    workGraph: createWorkGraph({ taskId: "TASK-CHANGE", objective: "discover change impact", route: "DELEGATED", assurance: "STANDARD", requirementRefs: [], acceptanceRefs: [], units: [] }),
    participantPlan: { version: 1, taskId: "TASK-CHANGE", assignments: [participantId] }, executionCatalog: { version: 1 },
    participants: [{ participantId, role: "Explorer", specialization: "cross-cutting", roleInvocationPolicy, toolPack, resourceClaims: [], validationResolution,
      outputContract: "explorer", skillManifestDigest: skillManifest.digest }], validationResolution });
  const contextManifestDigest = sha256Canonical({ context: participantId });
  const promptManifestDigest = sha256Canonical({ prompt: "discover change" });
  const binding = compileExecutionBinding({ operationId, operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest, controllerEpoch: operation.controller?.epoch ?? 0, executionBlueprintDigest: blueprint.digest, operationPolicyDigest: policy.digest,
    participantId, participantGeneration: `generation:${participantId}`, roleInvocationPolicyDigest: roleInvocationPolicy.digest, skillManifestDigest: skillManifest.digest,
    runtime: { runtimeId: "opencode", provider: "openai", modelId: "test-model", model: "test-model", sessionId: `session:${participantId}` },
    contextManifestDigest, promptManifestDigest, outputContract: "explorer", leaseIdentities: [] });
  await bindOperationParticipantExecution(root, operationId, { participantId, logicalAgent: "explorer", role: "Explorer", binding });
  operation = await loadOperation(root, operationId);
  return createStructuredResultProvenance({ projectId: candidate.projectId!, operationId, operationRevision: operation.revision,
    operationExecutionRevision: binding.operationExecutionRevision, participantId, participantGeneration: binding.participantGeneration, logicalAgent: "explorer", role: "Explorer",
    taskId: "TASK-CHANGE", candidate, controllerEpoch: binding.controllerEpoch, runtime: { provider: binding.runtime.provider, model: binding.runtime.modelId, runtimeId: binding.runtime.runtimeId, sessionId: binding.runtime.sessionId },
    outputContract: "explorer", outputSchemaDigest: sha256Canonical(outputJsonSchema("explorer")), executionBlueprintDigest: blueprint.digest,
    resolvedOperationPolicyDigest: policy.digest, executionBinding: binding, skillManifestDigest: skillManifest.digest, contextManifestDigest, promptManifestDigest, unsupported: [] });
}
