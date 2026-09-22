import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutionSelection } from "../../src/agents/types.js";
import { compileExecutionBlueprint } from "../../src/architecture/participantPlan.js";
import { compileExecutionCatalog } from "../../src/architecture/executionCatalog.js";
import { createWorkGraph } from "../../src/architecture/workGraph.js";
import { bindOperationCandidate, bindOperationParticipantExecution, bindResolvedOperationPolicy, claimControllerEpoch, loadOperation, patchOperationMetadata, registerOperationAgent, saveOperation, transitionOperationToTerminal } from "../../src/operations/state.js";
import { createCandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import { compileExecutionBinding, compileResolvedOperationPolicy, compileRoleInvocationPolicy, compileSkillManifest, createExecutionBlueprintV2 } from "../../src/architecture/executionIdentity.js";
import { prepareExecutionAuthority, type ExecutionAuthorityV1 } from "../../src/security/executionLease.js";
import { authorizeToolAction, controllerActorId, recordToolActionReceipt, type ToolActionRequestV1 } from "../../src/security/toolActionGate.js";

const roots: string[] = [];
const previousEnv = { id: process.env.AEH_OPERATION_ID, control: process.env.AEH_CONTROL_ROOT, redirect: process.env.AEH_OPERATION_STATE_REDIRECT, epoch: process.env.AEH_CONTROLLER_EPOCH, token: process.env.AEH_CONTROLLER_TOKEN };
afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", previousEnv.id);
  restoreEnv("AEH_CONTROL_ROOT", previousEnv.control);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", previousEnv.redirect);
  restoreEnv("AEH_CONTROLLER_EPOCH", previousEnv.epoch);
  restoreEnv("AEH_CONTROLLER_TOKEN", previousEnv.token);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const NOW = "2026-01-01T00:00:00.000Z";

describe("durable controller fencing", () => {
  it("fences a zombie controller from candidate mutation after takeover", async () => {
    const context = await createContext("RUN-FENCE-CANDIDATE");
    process.env.AEH_CONTROLLER_EPOCH = "1";
    await expect(bindOperationCandidate(context.root, context.operationId, candidate(context, 2, "b"))).resolves.toBeTruthy();

    await takeOver(context);
    process.env.AEH_CONTROLLER_EPOCH = "1";
    await expect(bindOperationCandidate(context.root, context.operationId, candidate(context, 3, "c"))).rejects.toThrow("V2_CONTROLLER_FENCED");

    process.env.AEH_CONTROLLER_EPOCH = "2";
    await expect(bindOperationCandidate(context.root, context.operationId, candidate(context, 3, "c"))).resolves.toBeTruthy();
    expect((await loadOperation(context.root, context.operationId)).controller?.epoch).toBe(2);
  });

  it("fences a zombie controller from terminal transitions", async () => {
    const context = await createContext("RUN-FENCE-TERMINAL");
    process.env.AEH_CONTROLLER_EPOCH = "1";
    await takeOver(context);
    process.env.AEH_CONTROLLER_EPOCH = "1";
    await expect(transitionOperationToTerminal(context.root, context.operationId, { status: "FAILED", error: "zombie" })).rejects.toThrow("V2_CONTROLLER_FENCED");
    process.env.AEH_CONTROLLER_EPOCH = "2";
    await expect(transitionOperationToTerminal(context.root, context.operationId, { status: "FAILED", error: "current" })).resolves.toMatchObject({ transitioned: true });
  });

  it("fences execution authority compiled under a superseded controller epoch", async () => {
    const context = await createContext("RUN-FENCE-AUTHORITY", "Implementer");
    process.env.AEH_CONTROLLER_EPOCH = "1";
    const authority = await makeAuthority(context, implementerSelection);
    expect(authority.controllerEpoch).toBe(1);

    await takeOver(context);
    process.env.AEH_CONTROLLER_EPOCH = "2";
    await expect(authorizeToolAction(makeRequest(context, authority, "git.commit", "delivery:commit")))
      .rejects.toThrow("TOOL_ACTION_CONTROLLER_FENCED");
  });

  it("fences a zombie process from authorizing new tool actions", async () => {
    const context = await createContext("RUN-FENCE-ACTION", "Implementer");
    process.env.AEH_CONTROLLER_EPOCH = "1";
    const authority = await makeAuthority(context, implementerSelection);
    await takeOver(context);

    // The zombie still holds its epoch-1 environment and epoch-1 authority.
    process.env.AEH_CONTROLLER_EPOCH = "1";
    await expect(authorizeToolAction(makeRequest(context, authority, "git.commit", "delivery:commit")))
      .rejects.toThrow("V2_CONTROLLER_FENCED");

    // The current controller can still authorize with authority compiled under epoch 2.
    process.env.AEH_CONTROLLER_EPOCH = "2";
    const currentAuthority = await makeAuthority(context, implementerSelection);
    const allowed = await authorizeToolAction(makeRequest(context, currentAuthority, "git.commit", "delivery:commit"));
    expect(allowed.decision).toBe("EXECUTE_ONCE");
    expect(allowed.intent.controllerEpoch).toBe(2);
  });

  it("fences a zombie from recording a receipt after takeover", async () => {
    const context = await createContext("RUN-FENCE-RECEIPT", "Implementer");
    process.env.AEH_CONTROLLER_EPOCH = "1";
    const authority = await makeAuthority(context, implementerSelection);
    const authorized = await authorizeToolAction(makeRequest(context, authority, "git.commit", "delivery:commit"));
    expect(authorized.decision).toBe("EXECUTE_ONCE");
    if (authorized.decision !== "EXECUTE_ONCE") throw new Error("expected EXECUTE_ONCE");
    await takeOver(context);

    process.env.AEH_CONTROLLER_EPOCH = "1";
    await expect(recordToolActionReceipt(context.root, authorized.intent, "SUCCEEDED", { commit: "abc" }, new Date(NOW)))
      .rejects.toThrow("V2_CONTROLLER_FENCED");

    process.env.AEH_CONTROLLER_EPOCH = "2";
    const receipt = await recordToolActionReceipt(context.root, authorized.intent, "SUCCEEDED", { commit: "abc" }, new Date(NOW));
    expect(receipt.controllerEpoch).toBe(2);
    expect(receipt.outcome).toBe("SUCCEEDED");
  });

  it("fences a blueprint compiled under a superseded controller epoch", async () => {
    const context = await createContext("RUN-FENCE-BLUEPRINT", "Implementer");
    process.env.AEH_CONTROLLER_EPOCH = "1";
    const graph = createWorkGraph({ taskId: context.candidate.taskId ?? "T-1", objective: "fence", route: "DELEGATED", assurance: "STANDARD", requirementRefs: [], acceptanceRefs: [], units: [{ version: 1, id: "fence-unit", objective: "fence", scope: ["src/**"], dependencies: [], requirementRefs: [], acceptanceRefs: [], competencies: [], riskTags: [], changeKinds: ["source"], risk: "low", status: "PENDING" }] });
    const operation = await loadOperation(context.root, context.operationId);
    const resolvedOperationPolicy = compileResolvedOperationPolicy({ projectId: context.candidate.projectId!, operationId: context.operationId, operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: context.candidate.revision, candidateDigest: context.candidate.identityDigest, controllerEpoch: 1, intent: "fence blueprint", route: graph.route, minimumAssurance: graph.assurance, policyVersions: { resolvedOperationPolicy: "1" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: [] });
    const blueprint = compileExecutionBlueprint({
      graph,
      candidate: context.candidate,
      executionCatalog: compileExecutionCatalog({ runtimes: {}, models: {} }),
      controllerEpoch: 1,
      operationExecutionRevision: operation.operationExecutionRevision!,
      resolvedOperationPolicy
    });
    expect(blueprint.controllerEpoch).toBe(1);
    await takeOver(context);
    process.env.AEH_CONTROLLER_EPOCH = "2";

    const authority = await makeAuthority(context, implementerSelection);
    const request = { ...makeRequest(context, authority, "git.commit", "delivery:commit"), authority: { kind: "execution-blueprint" as const, blueprint } };
    await expect(authorizeToolAction(request)).rejects.toThrow("TOOL_ACTION_CONTROLLER_FENCED");
  });

  it("invalidates participant execution bindings and frozen policy on controller takeover", async () => {
    const context = await createContext("RUN-FENCE-BINDING", "Implementer");
    const operation = await loadOperation(context.root, context.operationId);
    const policy = compileResolvedOperationPolicy({ projectId: context.candidate.projectId!, operationId: context.operationId,
      operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: context.candidate.revision, candidateDigest: context.candidate.identityDigest,
      controllerEpoch: 1, intent: "fence binding", route: "DELEGATED", minimumAssurance: "STANDARD", policyVersions: { policy: "1" }, policyDigests: {},
      validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: [] });
    await bindResolvedOperationPolicy(context.root, context.operationId, policy);
    const rolePolicy = compileRoleInvocationPolicy({ operationId: context.operationId, operationPolicyDigest: policy.digest, participantId: context.participantId,
      role: "Implementer", workUnitIds: ["work"], scope: ["src/**"], competencies: [], toolPack: { version: 1, required: ["repository-read"], optional: [], forbidden: [] },
      resourceClaims: [], outputContract: "implementer", constraints: {} });
    const skillManifest = compileSkillManifest({ scope: { operationId: context.operationId, operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: context.candidate.revision, candidateDigest: context.candidate.identityDigest, controllerEpoch: 1, participantId: context.participantId, workUnitIds: ["work"], competencies: [] }, skills: [] });
    const resolution = { version: 1 as const, requirements: [], actions: [], blocked: [], digest: "a".repeat(64) };
    const blueprint = createExecutionBlueprintV2({ projectId: policy.projectId, operationId: context.operationId, operationExecutionRevision: policy.operationExecutionRevision,
      candidateRevision: context.candidate.revision, candidateDigest: context.candidate.identityDigest, controllerEpoch: 1, resolvedOperationPolicy: policy,
      workGraph: createWorkGraph({ taskId: context.candidate.taskId!, objective: "work", route: "DELEGATED", assurance: "STANDARD", requirementRefs: [], acceptanceRefs: [], units: [] }),
      participantPlan: { version: 1 }, executionCatalog: { version: 1 }, participants: [{ participantId: context.participantId, role: "Implementer", specialization: "typescript",
        roleInvocationPolicy: rolePolicy, toolPack: rolePolicy.toolPack, resourceClaims: [], validationResolution: resolution, outputContract: "implementer", skillManifestDigest: skillManifest.digest }], validationResolution: resolution });
    const binding = compileExecutionBinding({ operationId: context.operationId, operationExecutionRevision: policy.operationExecutionRevision, candidateRevision: context.candidate.revision,
      candidateDigest: context.candidate.identityDigest, controllerEpoch: 1, executionBlueprintDigest: blueprint.digest, operationPolicyDigest: policy.digest,
      participantId: context.participantId, participantGeneration: "generation:1", roleInvocationPolicyDigest: rolePolicy.digest, skillManifestDigest: skillManifest.digest,
      runtime: { runtimeId: "codex", provider: "openai", modelId: "test", model: "test", sessionId: "session:1" }, contextManifestDigest: "b".repeat(64),
      promptManifestDigest: "c".repeat(64), outputContract: "implementer", leaseIdentities: [] });
    await bindOperationParticipantExecution(context.root, context.operationId, { participantId: context.participantId, logicalAgent: "Implementer", role: "Implementer", binding });
    await takeOver(context);
    const after = await loadOperation(context.root, context.operationId);
    expect(after.controller?.epoch).toBe(2);
    expect(after.resolvedOperationPolicy).toBeUndefined();
    expect(after.participants[context.participantId]?.executionBinding).toBeUndefined();
  });

  it("fences a caller that presents the right epoch but not the controller token", async () => {
    const context = await createContext("RUN-FENCE-TOKEN", "Implementer");
    const realToken = process.env.AEH_CONTROLLER_TOKEN;
    process.env.AEH_CONTROLLER_EPOCH = "1";
    const request: ToolActionRequestV1 = {
      root: context.root,
      operationId: context.operationId,
      participantId: controllerActorId(context.operationId),
      candidate: context.candidate,
      actionKey: "delivery:commit",
      action: "git.commit",
      payload: { taskId: "T-1" },
      authority: { kind: "controller-authority", operationId: context.operationId, controllerEpoch: 1 }
    };
    process.env.AEH_CONTROLLER_TOKEN = "f".repeat(64);
    await expect(authorizeToolAction(request)).rejects.toThrow("V2_CONTROLLER_FENCED");
    process.env.AEH_CONTROLLER_TOKEN = realToken;
    await expect(authorizeToolAction(request)).resolves.toMatchObject({ decision: "EXECUTE_ONCE" });
  });

  it("rejects a candidate revision jump instead of accepting arbitrary lineage", async () => {
    const context = await createContext("RUN-FENCE-JUMP");
    process.env.AEH_CONTROLLER_EPOCH = "1";
    await expect(bindOperationCandidate(context.root, context.operationId, candidate(context, 3, "c"))).rejects.toThrow("V2_CANDIDATE_BINDING_REJECTED");
    await expect(bindOperationCandidate(context.root, context.operationId, candidate(context, 2, "b"))).resolves.toBeTruthy();
  });

  it("records monotonic epochs with the previous owner", async () => {
    const context = await createContext("RUN-FENCE-MONOTONIC");
    const first = await loadOperation(context.root, context.operationId);
    expect(first.controller).toMatchObject({ epoch: 1, ownerId: "controller:one" });
    await takeOver(context);
    const second = await loadOperation(context.root, context.operationId);
    expect(second.controller).toMatchObject({ epoch: 2, ownerId: "controller:two", previousOwnerId: "controller:one" });
  });
});

const implementerSelection: AgentExecutionSelection = {
  logicalAgent: "implementer",
  role: "Implementer",
  domains: ["typescript"],
  runtimeName: "codex",
  runtimeAdapter: "codex",
  paseoProvider: "codex",
  modelAlias: "test",
  modelId: "test",
  modelName: "test",
  transport: "direct",
  permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny" },
  skills: [], mcps: [], args: [], runtimeCapabilities: {}
};

async function createContext(operationId: string, role: ToolActionRequestV1["role"] = "Implementer"): Promise<{ root: string; operationId: string; participantId: string; candidate: ReturnType<typeof createCandidateRevisionV1> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-controller-fence-"));
  roots.push(root);
  const participantId = `participant:${operationId.toLowerCase()}`;
  await saveOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: "T-1" }, createdAt: NOW, updatedAt: NOW, operationExecutionRevision: 1 } as never);
  const initial = (await loadOperation(root, operationId)).candidateRevision!;
  await registerOperationAgent(root, operationId, { id: participantId, role, logicalAgent: role, phase: "implementation" });
  await claimControllerEpoch(root, operationId, "controller:one");
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_CONTROL_ROOT = root;
  return { root, operationId, participantId, candidate: initial };
}

async function takeOver(context: { root: string; operationId: string }): Promise<void> {
  const zombieEpoch = process.env.AEH_CONTROLLER_EPOCH;
  delete process.env.AEH_CONTROLLER_EPOCH;
  await claimControllerEpoch(context.root, context.operationId, "controller:two");
  restoreEnv("AEH_CONTROLLER_EPOCH", zombieEpoch);
}

function candidate(context: { operationId: string; candidate: ReturnType<typeof createCandidateRevisionV1> }, revision: number, _digestSeed: string) {
  return createCandidateRevisionV1({ operationId: context.operationId, candidateId: `candidate:${context.operationId}:r${revision}`, projectId: context.candidate.projectId, taskId: context.candidate.taskId, revision, parentCandidateId: `candidate:${context.operationId}:r${revision - 1}`, sourceDigest: context.candidate.sourceDigest, worktree: context.candidate.worktree, createdAt: NOW });
}

async function makeAuthority(context: { root: string; operationId: string; participantId: string }, selection: AgentExecutionSelection): Promise<ExecutionAuthorityV1> {
  const authority = await prepareExecutionAuthority(context.root, selection, { participantId: context.participantId, phase: "implementation", required: true, now: new Date(NOW) });
  if (!authority) throw new Error("expected execution authority");
  return authority;
}

function makeRequest(context: { root: string; operationId: string; participantId: string; candidate: ReturnType<typeof createCandidateRevisionV1> }, authority: ExecutionAuthorityV1, action: ToolActionRequestV1["action"], actionKey: string): ToolActionRequestV1 {
  return { root: context.root, operationId: context.operationId, participantId: context.participantId, role: "Implementer", candidate: context.candidate, actionKey, action, payload: { taskId: "T-1", action }, authority: { kind: "execution-authority", authority }, now: new Date(NOW) };
}

function restoreEnv(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
