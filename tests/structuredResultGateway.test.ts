import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { outputJsonSchema } from "../src/agents/outputContracts.js";
import { sha256Canonical } from "../src/core/digest.js";
import { bindOperationCandidate, bindOperationParticipantExecution, bindResolvedOperationPolicy, claimControllerEpoch, loadOperation, registerOperationAgent, saveOperation, setOperationStage } from "../src/operations/state.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { compileExecutionBinding, compileResolvedOperationPolicy, compileRoleInvocationPolicy, compileSkillManifest, createExecutionBlueprintV2 } from "../src/architecture/executionIdentity.js";
import { createWorkGraph } from "../src/architecture/workGraph.js";
import {
  activateStructuredResultTurn,
  activateStructuredResultTurnForAgent,
  acceptedStructuredResultForAgent,
  acceptStructuredResult,
  bindStructuredResultChannel,
  createStructuredResultProvenance,
  finalizeStructuredResultChannelForAgent,
  loadStructuredResultChannel,
  provisionStructuredResultChannel,
  reconcileStructuredResult
} from "../src/workers/resultGateway.js";
import { commitStructuredResult } from "../src/workers/resultCommit.js";
import { handleResultSinkRequest } from "../src/workers/resultSinkMcp.js";

const roots: string[] = [];
const originalEnv = {
  AEH_RESULT_CONTROL_ROOT: process.env.AEH_RESULT_CONTROL_ROOT,
  AEH_RESULT_OPERATION_ID: process.env.AEH_RESULT_OPERATION_ID,
  AEH_RESULT_CHANNEL_ID: process.env.AEH_RESULT_CHANNEL_ID,
  AEH_OPERATION_ID: process.env.AEH_OPERATION_ID,
  AEH_CONTROL_ROOT: process.env.AEH_CONTROL_ROOT,
  AEH_CONTROLLER_EPOCH: process.env.AEH_CONTROLLER_EPOCH,
  AEH_CONTROLLER_TOKEN: process.env.AEH_CONTROLLER_TOKEN
};

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function reviewerPayload(verdict: "PASS" | "FAIL" = "PASS") {
  return { verdict, findings: [], finalizationSafety: verdict === "PASS" ? "SAFE" : "RISK_KNOWN", followUp: [] };
}

async function fixture(options: { supervisorGeneration?: number } = {}) {
  delete process.env.AEH_OPERATION_ID;
  delete process.env.AEH_CONTROL_ROOT;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-result-gateway-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
  const operationId = "AUDIT-RESULT";
  const now = new Date().toISOString();
  await saveOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "review", root, payload: { taskId: "TASK-RESULT" }, createdAt: now, updatedAt: now, operationExecutionRevision: 1 } as never);
  const initial = await loadOperation(root, operationId);
  const participantId = "participant:security-reviewer";
  await registerOperationAgent(root, operationId, { id: participantId, logicalAgent: "security-reviewer", role: "Reviewer", phase: "review" });
  const identity = await bindFullIdentity(root, operationId, participantId, initial.candidateRevision!, "generation-1");
  const channel = await provisionStructuredResultChannel(root, {
    operationId,
    logicalAgent: "security-reviewer",
    role: "Reviewer",
    taskId: "TASK-RESULT",
    contract: "reviewer",
    operationRevision: identity.provenance.operationRevision,
    supervisorGeneration: options.supervisorGeneration ?? 3,
    provenance: identity.provenance
  });
  await bindStructuredResultChannel(root, operationId, channel.channelId, "agent-1");
  await activateStructuredResultTurn(root, operationId, channel.channelId, "review");
  return { root, operationId, channelId: channel.channelId, participantId, candidate: initial.candidateRevision!, identity };
}

async function bindFullIdentity(root: string, operationId: string, participantId: string, candidate: NonNullable<Awaited<ReturnType<typeof loadOperation>>["candidateRevision"]>, participantGeneration: string) {
  let operation = await loadOperation(root, operationId);
  const policy = operation.resolvedOperationPolicy ?? compileResolvedOperationPolicy({
    projectId: candidate.projectId!, operationId, operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: operation.controller?.epoch ?? 0,
    intent: "review current candidate", route: "DIRECT", minimumAssurance: "STANDARD", policyVersions: { resolvedOperationPolicy: "1", roleInvocationPolicy: "1", executionBlueprint: "2", executionBinding: "2", skillManifest: "1" },
    policyDigests: { validation: sha256Canonical({}), review: sha256Canonical({}), delivery: sha256Canonical({}), knowledge: sha256Canonical({}), context: sha256Canonical({}) },
    validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: []
  });
  if (!operation.resolvedOperationPolicy) operation = await bindResolvedOperationPolicy(root, operationId, policy);
  const roleInvocationPolicy = compileRoleInvocationPolicy({ operationId, operationPolicyDigest: policy.digest, participantId, role: "Reviewer", workUnitIds: ["review"], scope: ["src/**"], competencies: ["review"], toolPack: { version: 1, required: ["repository-read"], optional: [], forbidden: ["repository-write"] }, resourceClaims: [], outputContract: "reviewer", constraints: { readOnly: true } });
  const skillManifest = compileSkillManifest({ scope: { operationId, operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: operation.controller?.epoch ?? 0, participantId, workUnitIds: ["review"], competencies: ["review"] }, skills: [] });
  const workGraph = createWorkGraph({ taskId: candidate.taskId!, objective: "Review current candidate", route: "DIRECT", assurance: "STANDARD", requirementRefs: [], acceptanceRefs: [], units: [] });
  const validationResolution = { version: 1 as const, requirements: [], actions: [], blocked: [], digest: sha256Canonical({ version: 1, requirements: [], actions: [], blocked: [] }) };
  const blueprint = createExecutionBlueprintV2({ projectId: candidate.projectId!, operationId, operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: operation.controller?.epoch ?? 0, resolvedOperationPolicy: policy, workGraph, participantPlan: { version: 1, taskId: candidate.taskId, assignments: [participantId] }, executionCatalog: { version: 1 }, participants: [{ participantId, role: "Reviewer", specialization: "review", roleInvocationPolicy, toolPack: roleInvocationPolicy.toolPack, resourceClaims: [], validationResolution, outputContract: "reviewer", skillManifestDigest: skillManifest.digest }], validationResolution });
  const binding = compileExecutionBinding({ operationId, operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: operation.controller?.epoch ?? 0, executionBlueprintDigest: blueprint.digest, operationPolicyDigest: policy.digest, participantId, participantGeneration, roleInvocationPolicyDigest: roleInvocationPolicy.digest, skillManifestDigest: skillManifest.digest, runtime: { runtimeId: "codex", provider: "openai", modelId: "test-model", model: "test-model", sessionId: `session-${participantGeneration}` }, contextManifestDigest: sha256Canonical({ context: participantId }), promptManifestDigest: sha256Canonical({ prompt: "review current candidate" }), outputContract: "reviewer", leaseIdentities: [] });
  await bindOperationParticipantExecution(root, operationId, { participantId, logicalAgent: "security-reviewer", role: "Reviewer", binding });
  operation = await loadOperation(root, operationId);
  const provenance = createStructuredResultProvenance({ projectId: candidate.projectId!, operationId, operationRevision: operation.revision, operationExecutionRevision: binding.operationExecutionRevision, participantId, participantGeneration, logicalAgent: "security-reviewer", role: "Reviewer", taskId: candidate.taskId, candidate, controllerEpoch: binding.controllerEpoch, runtime: { provider: binding.runtime.provider, model: binding.runtime.modelId, runtimeId: binding.runtime.runtimeId, sessionId: binding.runtime.sessionId }, outputContract: "reviewer", outputSchemaDigest: sha256Canonical(outputJsonSchema("reviewer")), executionBlueprintDigest: binding.executionBlueprintDigest, resolvedOperationPolicyDigest: binding.operationPolicyDigest, executionBinding: binding, skillManifestDigest: binding.skillManifestDigest, contextManifestDigest: binding.contextManifestDigest, promptManifestDigest: binding.promptManifestDigest, unsupported: [] });
  return { policy, roleInvocationPolicy, skillManifest, blueprint, binding, provenance };
}

describe("StructuredResultGateway", () => {
  it("finalizes an inert pending Paseo channel only for its actual bound session", async () => {
    const { root, operationId, identity } = await fixture();
    const pending = await provisionStructuredResultChannel(root, {
      operationId,
      logicalAgent: "security-reviewer",
      role: "Reviewer",
      taskId: "TASK-RESULT",
      contract: "reviewer",
      operationRevision: identity.provenance.operationRevision
    });
    const sessionId = identity.binding.runtime.sessionId;
    await bindStructuredResultChannel(root, operationId, pending.channelId, sessionId);
    await expect(bindStructuredResultChannel(root, operationId, pending.channelId, "different-provider-session"))
      .rejects.toThrow("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH");

    await expect(acceptStructuredResult(root, operationId, pending.channelId, reviewerPayload(), "mcp"))
      .rejects.toThrow("AEH_RESULT_PROVENANCE_INCOMPLETE");
    const { version: _bindingVersion, digest: _bindingDigest, ...bindingBody } = identity.binding;
    const wrongBinding = compileExecutionBinding({ ...bindingBody, runtime: { ...identity.binding.runtime, sessionId: "different-provider-session" } });
    const { version: _provenanceVersion, status: _provenanceStatus, unsupported: _unsupported, provenanceDigest: _provenanceDigest, ...provenanceBody } = identity.provenance;
    const wrongSession = createStructuredResultProvenance({ ...provenanceBody, runtime: { ...identity.provenance.runtime!, sessionId: "different-provider-session" }, executionBinding: wrongBinding });
    await expect(finalizeStructuredResultChannelForAgent(root, sessionId, wrongSession))
      .rejects.toThrow("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH");

    const finalized = await finalizeStructuredResultChannelForAgent(root, sessionId, identity.provenance);
    expect(finalized.provenance).toEqual(identity.provenance);
    const replayPromptDigest = sha256Canonical({ changed: true });
    const replayBinding = compileExecutionBinding({ ...bindingBody, promptManifestDigest: replayPromptDigest });
    const replayProvenance = createStructuredResultProvenance({ ...provenanceBody, promptManifestDigest: replayPromptDigest, executionBinding: replayBinding });
    await expect(finalizeStructuredResultChannelForAgent(root, sessionId, replayProvenance))
      .rejects.toThrow("AEH_RESULT_CHANNEL_REPLAYED");
  });

  it("persists one schema-valid immutable result and accepts identical retries idempotently", async () => {
    const { root, operationId, channelId } = await fixture();
    const first = await commitStructuredResult(root, operationId, channelId, reviewerPayload(), "mcp");
    const second = await commitStructuredResult(root, operationId, channelId, reviewerPayload(), "mcp");

    expect(second.artifact).toBe(first.artifact);
    expect(second.sha256).toBe(first.sha256);
    const envelope = JSON.parse(await fs.readFile(path.join(root, first.artifact), "utf8")) as Record<string, unknown>;
    expect(envelope).toEqual(expect.objectContaining({ kind: "agent-result", contract: "reviewer", source: "mcp", payloadSha256: first.sha256 }));
    expect(envelope.payload).toEqual(reviewerPayload());
  });

  it("keeps the first accepted result authoritative when a later valid payload differs", async () => {
    const { root, operationId, channelId } = await fixture();
    const first = await commitStructuredResult(root, operationId, channelId, reviewerPayload("PASS"), "mcp");
    await expect(commitStructuredResult(root, operationId, channelId, reviewerPayload("FAIL"), "mcp")).rejects.toThrow("CONFLICTING_RESULT");
    const channel = await loadStructuredResultChannel(root, operationId, channelId);
    expect(channel.activeTurn).toEqual(expect.objectContaining({ status: "ACCEPTED", artifact: first.artifact, sha256: first.sha256 }));
  });

  it("rejects an accepted artifact whose payload or identity was tampered with", async () => {
    const { root, operationId, channelId } = await fixture();
    const accepted = await commitStructuredResult(root, operationId, channelId, reviewerPayload(), "mcp");
    const artifactPath = path.join(root, accepted.artifact);
    const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8")) as Record<string, unknown>;
    artifact.payload = reviewerPayload("FAIL");
    await fs.writeFile(artifactPath, `${JSON.stringify(artifact)}\n`);
    await expect(acceptedStructuredResultForAgent(root, "agent-1")).rejects.toThrow(/AEH_RESULT_INTEGRITY/);
  });

  it("rejects a valid result from a different operation revision or supervisor generation", async () => {
    const bound = await fixture({ supervisorGeneration: 3 });
    await commitStructuredResult(bound.root, bound.operationId, bound.channelId, reviewerPayload(), "mcp");
    const channel = await loadStructuredResultChannel(bound.root, bound.operationId, bound.channelId);
    await expect(acceptedStructuredResultForAgent(bound.root, "agent-1", { operationRevision: channel.operationRevision! + 1 })).rejects.toThrow(/operation revision/);
    await expect(acceptedStructuredResultForAgent(bound.root, "agent-1", { supervisorGeneration: 4 })).rejects.toThrow(/supervisor generation/);
    await expect(acceptedStructuredResultForAgent(bound.root, "agent-1", { operationRevision: channel.operationRevision, supervisorGeneration: 3 })).resolves.toBeTruthy();
  });

  it("rejects result expectations with altered blueprint, policy, skills, context, prompt, output, runtime, epoch, or generation", async () => {
    const bound = await fixture();
    await commitStructuredResult(bound.root, bound.operationId, bound.channelId, reviewerPayload(), "mcp");
    const provenance = bound.identity.provenance;
    const cases = [
      { executionBlueprintDigest: "a".repeat(64) },
      { resolvedOperationPolicyDigest: "b".repeat(64) },
      { skillManifestDigest: "c".repeat(64) },
      { contextManifestDigest: "d".repeat(64) },
      { promptManifestDigest: "e".repeat(64) },
      { outputContract: "implementer" },
      { runtime: { provider: "other-provider", model: "test-model", runtimeId: "codex" } },
      { controllerEpoch: provenance.controllerEpoch! + 1 },
      { participantGeneration: "generation:replay" },
      { operationExecutionRevision: provenance.operationExecutionRevision! + 1 },
      { executionBinding: { ...provenance.executionBinding!, digest: "f".repeat(64) } }
    ];
    for (const mismatch of cases) {
      await expect(acceptedStructuredResultForAgent(bound.root, "agent-1", { provenance: mismatch, requireBoundProvenance: true }))
        .rejects.toThrow(/different candidate, participant generation, or execution parent/);
    }
  });

  it("keeps record event revisions separate from execution semantics revisions", async () => {
    const bound = await fixture();
    await commitStructuredResult(bound.root, bound.operationId, bound.channelId, reviewerPayload(), "mcp");
    const before = await loadOperation(bound.root, bound.operationId);
    const after = await setOperationStage(bound.root, bound.operationId, "quality", "RUNNING");
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.operationExecutionRevision).toBe(before.operationExecutionRevision);
    await expect(acceptedStructuredResultForAgent(bound.root, "agent-1", { verifyCurrentCandidate: true })).resolves.toBeTruthy();
  });

  it("rejects an accepted old-epoch result after controller takeover", async () => {
    const bound = await fixture();
    await commitStructuredResult(bound.root, bound.operationId, bound.channelId, reviewerPayload(), "mcp");
    await claimControllerEpoch(bound.root, bound.operationId, "controller:takeover");
    const current = await loadOperation(bound.root, bound.operationId);
    expect(current.controller?.epoch).toBe(bound.identity.binding.controllerEpoch + 1);
    expect(current.participants[bound.participantId]?.executionBinding).toBeUndefined();
    expect(current.resolvedOperationPolicy).toBeUndefined();
    await expect(acceptedStructuredResultForAgent(bound.root, "agent-1", { verifyCurrentCandidate: true })).rejects.toThrow(/AEH_RESULT_STALE_EXECUTION/);
  });

  it("rejects schema-valid results bound to a prior candidate or participant generation", async () => {
    const bound = await fixture();
    const { root, operationId, channelId, candidate, participantId, identity } = bound;
    await commitStructuredResult(root, operationId, channelId, reviewerPayload(), "mcp");
    const provenance = identity.provenance;
    await expect(acceptedStructuredResultForAgent(root, "agent-1", {
      provenance: { participantGeneration: "generation-2" },
      requireBoundProvenance: true
    })).rejects.toThrow(/different candidate, participant generation, or execution parent/);
    await expect(acceptedStructuredResultForAgent(root, "agent-1", { operationRevision: provenance.operationRevision! + 1 }))
      .rejects.toThrow(/operation revision/);
    await expect(acceptedStructuredResultForAgent(root, "agent-1", { provenance: { executionBlueprintDigest: "e".repeat(64) } }))
      .rejects.toThrow(/different candidate, participant generation, or execution parent/);

    await fs.writeFile(path.join(root, "source.ts"), "export const value = 2;\n");
    await expect(acceptedStructuredResultForAgent(root, "agent-1", { verifyCurrentCandidate: true }))
      .rejects.toThrow("CANDIDATE_WORKSPACE_MISMATCH");
    await fs.writeFile(path.join(root, "source.ts"), "export const value = 1;\n");

    await bindFullIdentity(root, operationId, participantId, candidate, "generation-2");
    await expect(acceptedStructuredResultForAgent(root, "agent-1", { verifyCurrentCandidate: true }))
      .rejects.toThrow(/AEH_RESULT_STALE_EXECUTION/);

    const advanced = createCandidateRevisionV1({
      operationId,
      candidateId: `candidate:${operationId}:r2`,
      projectId: candidate.projectId,
      taskId: candidate.taskId,
      revision: candidate.revision + 1,
      parentCandidateId: candidate.candidateId,
      sourceDigest: candidate.sourceDigest,
      worktree: root
    });
    await bindOperationCandidate(root, operationId, advanced);
    const invalidated = await loadOperation(root, operationId);
    expect(invalidated.resolvedOperationPolicy).toBeUndefined();
    expect(invalidated.participants[participantId]?.executionBinding).toBeUndefined();
    await expect(acceptedStructuredResultForAgent(root, "agent-1", { verifyCurrentCandidate: true }))
      .rejects.toThrow(/AEH_RESULT_STALE_CANDIDATE/);
  });

  it("fails closed when a resumed turn has no bound result channel", async () => {
    const { root } = await fixture();
    await expect(activateStructuredResultTurnForAgent(root, "unbound-agent")).rejects.toThrow(/no structured result channel is bound/);
  });

  it("rejects schema-invalid submissions without losing the active turn", async () => {
    const { root, operationId, channelId } = await fixture();
    await expect(commitStructuredResult(root, operationId, channelId, { verdict: "MAYBE" }, "mcp")).rejects.toThrow("SCHEMA_VALIDATION_FAILED");
    expect((await loadStructuredResultChannel(root, operationId, channelId)).activeTurn?.status).toBe("REJECTED");
    const accepted = await commitStructuredResult(root, operationId, channelId, reviewerPayload(), "mcp");
    expect(accepted.payload).toEqual(reviewerPayload());
  });

  it("persists a captured native/text result through the same gateway", async () => {
    const { root, operationId } = await fixture();
    const resolved = await reconcileStructuredResult(root, {
      operationId,
      agentId: "agent-1",
      logicalAgent: "security-reviewer",
      role: "Reviewer",
      contract: "reviewer",
      phase: "review",
      stdout: JSON.stringify(reviewerPayload()),
      stderr: ""
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.accepted?.source).toBe("captured");
    expect(resolved.accepted?.artifact).toContain("/results/security-reviewer/");
  });

  it("does not reuse an accepted result from a prior captured turn", async () => {
    const { root, operationId } = await fixture();
    const first = await reconcileStructuredResult(root, {
      operationId,
      agentId: "agent-1",
      logicalAgent: "security-reviewer",
      role: "Reviewer",
      contract: "reviewer",
      phase: "review",
      stdout: JSON.stringify(reviewerPayload("PASS")),
      stderr: ""
    });
    const second = await reconcileStructuredResult(root, {
      operationId,
      agentId: "agent-1",
      logicalAgent: "security-reviewer",
      role: "Reviewer",
      contract: "reviewer",
      phase: "review",
      stdout: JSON.stringify(reviewerPayload("FAIL")),
      stderr: ""
    });

    expect(first.accepted?.payload).toEqual(reviewerPayload("PASS"));
    expect(second.accepted?.payload).toEqual(reviewerPayload("FAIL"));
    expect(second.accepted?.turnId).not.toBe(first.accepted?.turnId);
  });

  it("exposes exactly one capability-scoped MCP tool with the active contract schema", async () => {
    const { root, operationId, channelId } = await fixture();
    process.env.AEH_RESULT_CONTROL_ROOT = root;
    process.env.AEH_RESULT_OPERATION_ID = operationId;
    process.env.AEH_RESULT_CHANNEL_ID = channelId;

    const listed = await handleResultSinkRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = listed.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("aeh_submit_result");
    expect(tools[0]?.inputSchema).toEqual(expect.objectContaining({ type: "object" }));

    const called = await handleResultSinkRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "aeh_submit_result", arguments: reviewerPayload() } });
    expect(called.structuredContent).toEqual(expect.objectContaining({ status: "ACCEPTED", contract: "reviewer" }));
  });
});
