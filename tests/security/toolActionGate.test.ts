import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutionSelection } from "../../src/agents/types.js";
import { createCandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import { bindOperationCandidate, bindResolvedOperationPolicy, claimControllerEpoch, currentControllerEpoch, loadOperation, patchOperationMetadata, registerOperationAgent, saveOperation } from "../../src/operations/state.js";
import { prepareExecutionAuthority, type ExecutionAuthorityV1 } from "../../src/security/executionLease.js";
import { authorizeToolAction, classifyToolActionImpact, controllerActorId, loadActionIntent, recordToolActionReceipt, type ToolActionRequestV1 } from "../../src/security/toolActionGate.js";
import { sha256Utf8 } from "../../src/core/digest.js";
import { compileResolvedOperationPolicy } from "../../src/architecture/executionIdentity.js";
import { sha256Canonical } from "../../src/core/digest.js";
import { HumanDecisionLedgerV2 } from "../../src/security/humanDecision.js";

const roots: string[] = [];
const previousEnv = {
  id: process.env.AEH_OPERATION_ID,
  control: process.env.AEH_CONTROL_ROOT,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
  epoch: process.env.AEH_CONTROLLER_EPOCH,
  token: process.env.AEH_CONTROLLER_TOKEN
};

afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", previousEnv.id);
  restoreEnv("AEH_CONTROL_ROOT", previousEnv.control);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", previousEnv.redirect);
  restoreEnv("AEH_CONTROLLER_EPOCH", previousEnv.epoch);
  restoreEnv("AEH_CONTROLLER_TOKEN", previousEnv.token);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("deterministic tool action gate", () => {
  it("classifies external and local actions without accepting caller supplied impact", () => {
    expect(classifyToolActionImpact("git.commit")).toBe("LOCAL_REPOSITORY_MUTATION");
    expect(classifyToolActionImpact("github.issue.create")).toBe("EXTERNAL_NON_IDEMPOTENT");
    expect(classifyToolActionImpact("git.push")).toBe("EXTERNAL_PUBLICATION");
    expect(classifyToolActionImpact("paseo.workspace.create")).toBe("EXTERNAL_RECONCILABLE");
  });

  it("persists one stable intent and returns its stable receipt on retry", async () => {
    const context = await createContext("RUN-ACTION-1", "Implementer");
    const authority = await makeAuthority(context, implementerSelection);
    const request = makeRequest(context, authority, "git.commit", "delivery:commit");

    const first = await authorizeToolAction(request);
    expect(first.decision).toBe("EXECUTE_ONCE");
    expect(first.intent.impact).toBe("LOCAL_REPOSITORY_MUTATION");

    const receipt = await recordToolActionReceipt(context.root, first.intent, "SUCCEEDED", { commit: "abc123" }, new Date(NOW));
    expect(receipt.receiptId).toMatch(/^action-receipt:[a-f0-9]{64}$/);
    const retry = await authorizeToolAction(request);
    expect(retry.decision).toBe("ALREADY_COMPLETED");
    if (retry.decision !== "ALREADY_COMPLETED") throw new Error("expected completed action replay");
    expect(retry.intent.intentId).toBe(first.intent.intentId);
    expect(retry.receipt.receiptId).toBe(receipt.receiptId);
  });

  it("blocks a retry whose prior intent has no receipt until reconciliation", async () => {
    const context = await createContext("RUN-ACTION-PENDING", "Implementer");
    const authority = await makeAuthority(context, implementerSelection);
    const request = makeRequest(context, authority, "git.commit", "delivery:commit");
    const first = await authorizeToolAction(request);
    expect(first.decision).toBe("EXECUTE_ONCE");
    await expect(authorizeToolAction(request)).rejects.toThrow("TOOL_ACTION_RECONCILIATION_AUTHORITY_REQUIRED");
    await expect(authorizeToolAction(makeControllerRequest(context, "git.commit", "delivery:commit", request.payload))).rejects.toThrow("TOOL_ACTION_RECONCILIATION_REQUIRED");
  });

  it("rejects action-key reuse with a changed payload or candidate", async () => {
    const context = await createContext("RUN-ACTION-CONFLICT", "Implementer");
    const authority = await makeAuthority(context, implementerSelection);
    const request = makeRequest(context, authority, "git.commit", "delivery:commit");
    await authorizeToolAction(request);
    await expect(authorizeToolAction({ ...request, payload: { commitMessage: "changed" } })).rejects.toThrow("TOOL_ACTION_INTENT_CONFLICT");
    const newer = createCandidateRevisionV1({ operationId: context.operationId, candidateId: "candidate-newer", projectId: "project-test", taskId: "T-1", revision: 2, sourceDigest: "b".repeat(64) });
    await expect(authorizeToolAction({ ...request, candidate: newer })).rejects.toThrow("TOOL_ACTION_INTENT_CONFLICT");
  });

  it("requires the registered role's write ceiling and candidate-bound lease", async () => {
    const context = await createContext("RUN-ACTION-ROLE", "Reviewer");
    const reviewerAuthority = await makeAuthority(context, reviewerSelection);
    const request = makeRequest(context, reviewerAuthority, "git.commit", "delivery:commit");
    await expect(authorizeToolAction(request)).rejects.toThrow("TOOL_ACTION_CAPABILITY_DENIED");
  });

  it("rejects participant external authority and requires controller authority for policy-listed effects", async () => {
    const implementer = await createContext("RUN-ACTION-EXTERNAL-DENY", "Implementer");
    const implementerAuthority = await makeAuthority(implementer, implementerSelection);
    await expect(authorizeToolAction(makeRequest(implementer, implementerAuthority, "github.branch.create", "delivery:branch")))
      .rejects.toThrow("TOOL_ACTION_CONTROLLER_AUTHORITY_REQUIRED");

    const lead = await createContext("RUN-ACTION-EXTERNAL-ALLOW", "Lead/Director", true);
    const allowed = await authorizeToolAction(makeControllerRequest(lead, "github.branch.create", "delivery:branch"));
    expect(allowed.decision).toBe("EXECUTE_ONCE");
    expect(allowed.intent.impact).toBe("EXTERNAL_RECONCILABLE");
    expect(allowed.intent.policyDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("consumes only an exact human approval for an action effect; rejection and product choice cannot authorize it", async () => {
    const approved = await createContext("RUN-ACTION-HUMAN-APPROVE", "Lead/Director", false, {
      allowedExternalEffects: ["github.issue.create"],
      humanDecisionActions: ["github.issue.create"]
    });
    const request = makeControllerRequest(approved, "github.issue.create", "issue:create");
    const operation = await loadOperation(approved.root, approved.operationId);
    const ledger = new HumanDecisionLedgerV2(path.resolve(approved.root, ".harness", "security", "human-decisions.json"));
    await ledger.record({
      operationId: operation.id,
      candidate: operation.candidateRevision!,
      operationExecutionRevision: operation.operationExecutionRevision!,
      policyDigest: operation.resolvedOperationPolicy!.digest,
      controllerEpoch: currentControllerEpoch(operation),
      purpose: { kind: "ACTION_AUTHORIZATION", action: "github.issue.create", effectDigest: sha256Canonical(request.payload) },
      kind: "APPROVE",
      actorId: "human:control-center:approval-test",
      reason: "approved the exact issue effect",
      createdAt: NOW
    });
    const authorized = await authorizeToolAction(request);
    expect(authorized.decision).toBe("EXECUTE_ONCE");
    if (authorized.decision !== "EXECUTE_ONCE") throw new Error("expected EXECUTE_ONCE");
    await recordToolActionReceipt(approved.root, authorized.intent, "SUCCEEDED", { issue: "#123" }, new Date(NOW));
    await expect(authorizeToolAction(request)).resolves.toMatchObject({ decision: "ALREADY_COMPLETED" });

    const rejected = await createContext("RUN-ACTION-HUMAN-REJECT", "Lead/Director", false, {
      allowedExternalEffects: ["github.issue.create"],
      humanDecisionActions: ["github.issue.create"]
    });
    const rejectedRequest = makeControllerRequest(rejected, "github.issue.create", "issue:create");
    const rejectedOperation = await loadOperation(rejected.root, rejected.operationId);
    const rejectedLedger = new HumanDecisionLedgerV2(path.resolve(rejected.root, ".harness", "security", "human-decisions.json"));
    await rejectedLedger.record({
      operationId: rejectedOperation.id,
      candidate: rejectedOperation.candidateRevision!,
      operationExecutionRevision: rejectedOperation.operationExecutionRevision!,
      policyDigest: rejectedOperation.resolvedOperationPolicy!.digest,
      controllerEpoch: currentControllerEpoch(rejectedOperation),
      purpose: { kind: "ACTION_AUTHORIZATION", action: "github.issue.create", effectDigest: sha256Canonical(rejectedRequest.payload) },
      kind: "REJECT",
      actorId: "human:control-center:rejection-test",
      reason: "rejected the exact issue effect",
      createdAt: NOW
    });
    await expect(authorizeToolAction(rejectedRequest)).rejects.toThrow("HumanDecision rejects this exact action and effect");
    await expect(loadActionIntent(rejected.root, rejected.operationId, "issue:create")).resolves.toBeUndefined();

    const choice = await createContext("RUN-ACTION-HUMAN-CHOICE", "Lead/Director", false, {
      allowedExternalEffects: ["github.issue.create"],
      humanDecisionActions: ["github.issue.create"]
    });
    const choiceRequest = makeControllerRequest(choice, "github.issue.create", "issue:create");
    const choiceOperation = await loadOperation(choice.root, choice.operationId);
    const choiceLedger = new HumanDecisionLedgerV2(path.resolve(choice.root, ".harness", "security", "human-decisions.json"));
    await choiceLedger.record({
      operationId: choiceOperation.id,
      candidate: choiceOperation.candidateRevision!,
      operationExecutionRevision: choiceOperation.operationExecutionRevision!,
      policyDigest: choiceOperation.resolvedOperationPolicy!.digest,
      controllerEpoch: currentControllerEpoch(choiceOperation),
      purpose: { kind: "PRODUCT_CHOICE", requestId: "choice-request-1", choiceId: "option-a" },
      kind: "CHOOSE",
      actorId: "human:control-center:choice-test",
      reason: "selected a product option",
      createdAt: NOW
    });
    await expect(authorizeToolAction(choiceRequest)).rejects.toThrow("TOOL_ACTION_HUMAN_DECISION_REQUIRED");
    await expect(loadActionIntent(choice.root, choice.operationId, "issue:create")).resolves.toBeUndefined();
  });

  it("rejects a completed action receipt after its candidate or frozen policy becomes stale", async () => {
    const context = await createContext("RUN-ACTION-STALE-RECEIPT", "Implementer");
    const authority = await makeAuthority(context, implementerSelection);
    const request = makeRequest(context, authority, "git.commit", "delivery:commit");
    const authorized = await authorizeToolAction(request);
    if (authorized.decision !== "EXECUTE_ONCE") throw new Error("expected EXECUTE_ONCE");
    await recordToolActionReceipt(context.root, authorized.intent, "SUCCEEDED", { commit: "abc" }, new Date(NOW));
    const operation = await loadOperation(context.root, context.operationId);
    const candidate = operation.candidateRevision!;
    await bindOperationCandidate(context.root, context.operationId, createCandidateRevisionV1({ operationId: context.operationId, candidateId: "candidate-newer", projectId: candidate.projectId, taskId: candidate.taskId, revision: candidate.revision + 1, parentCandidateId: candidate.candidateId, sourceDigest: candidate.sourceDigest, worktree: candidate.worktree }));
    await expect(authorizeToolAction(request)).rejects.toThrow("TOOL_ACTION_POLICY_REQUIRED");
  });

  it("fails closed when a receipt exists without its ActionIntent", async () => {
    const context = await createContext("RUN-ACTION-ORPHAN", "Implementer");
    const authority = await makeAuthority(context, implementerSelection);
    const request = makeRequest(context, authority, "git.commit", "delivery:commit");
    const first = await authorizeToolAction(request);
    expect(first.decision).toBe("EXECUTE_ONCE");
    await recordToolActionReceipt(context.root, first.intent, "SUCCEEDED", { commit: "abc" }, new Date(NOW));
    const directory = path.resolve(context.root, ".harness", "security", "tool-actions", sha256Utf8(context.operationId).slice(0, 32));
    for (const file of await fs.readdir(directory)) if (file.endsWith(".intent.json")) await fs.rm(path.join(directory, file));
    await expect(authorizeToolAction(request)).rejects.toThrow("TOOL_ACTION_RECEIPT_ORPHANED");
  });

  it("fails closed when managed operation identity is absent or candidate is stale", async () => {
    const context = await createContext("RUN-ACTION-CONTEXT", "Implementer");
    const authority = await makeAuthority(context, implementerSelection);
    const request = makeRequest(context, authority, "git.commit", "delivery:commit");
    delete process.env.AEH_OPERATION_ID;
    await expect(authorizeToolAction(request)).rejects.toThrow("TOOL_ACTION_OPERATION_MISMATCH");
    process.env.AEH_OPERATION_ID = context.operationId;
    const newer = createCandidateRevisionV1({ operationId: context.operationId, candidateId: "candidate-stale-authority", projectId: context.candidate.projectId, taskId: "T-1", revision: 2, parentCandidateId: context.candidate.candidateId, sourceDigest: context.candidate.sourceDigest, createdAt: NOW });
    await bindOperationCandidate(context.root, context.operationId, newer);
    await expect(authorizeToolAction({ ...request, actionKey: "delivery:stale", candidate: newer, authority: { kind: "execution-authority", authority } }))
      .rejects.toThrow("TOOL_ACTION_POLICY_REQUIRED");
  });
});

const NOW = "2026-01-01T00:00:00.000Z";
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
const reviewerSelection: AgentExecutionSelection = { ...implementerSelection, logicalAgent: "reviewer", role: "Reviewer", permissions: { ...implementerSelection.permissions, write: "deny", shell: "deny" } };
const leadSelection: AgentExecutionSelection = { ...implementerSelection, logicalAgent: "lead", role: "Lead/Director", permissions: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "allow" } };

async function createContext(operationId: string, role: ToolActionRequestV1["role"], bindLead = false, policyOptions: { allowedExternalEffects?: ToolActionRequestV1["action"][]; humanDecisionActions?: ToolActionRequestV1["action"][] } = {}): Promise<{ root: string; operationId: string; participantId: string; role: ToolActionRequestV1["role"]; candidate: ReturnType<typeof createCandidateRevisionV1> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-tool-action-gate-")); roots.push(root);
  const participantId = `participant:${operationId.toLowerCase()}`;
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_CONTROL_ROOT = root;
  process.env.AEH_OPERATION_STATE_REDIRECT = "1";
  await saveOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: "T-1" }, createdAt: NOW, updatedAt: NOW });
  const candidate = (await loadOperation(root, operationId)).candidateRevision!;
  const owned = await claimControllerEpoch(root, operationId, `controller:${operationId}`, { pid: process.pid });
  await registerOperationAgent(root, operationId, { id: participantId, role, logicalAgent: role, phase: "implementation" });
  if (bindLead) await patchOperationMetadata(root, operationId, { lead: { agentId: participantId, generation: 1, boundAt: NOW, acknowledgedRevision: 1, acknowledgedAt: NOW } });
  const policy = compileResolvedOperationPolicy({ projectId: candidate.projectId!, operationId, operationExecutionRevision: owned.operationExecutionRevision!, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: currentControllerEpoch(owned), intent: "tool action test", route: "DIRECT", minimumAssurance: "STANDARD", policyVersions: {}, policyDigests: {}, validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: policyOptions.allowedExternalEffects ?? ["github.branch.create"], humanDecisionRequirements: (policyOptions.humanDecisionActions ?? []).map((action) => ({ kind: "ACTION_AUTHORIZATION" as const, action })) });
  await bindResolvedOperationPolicy(root, operationId, policy);
  return { root, operationId, participantId, role, candidate };
}

async function makeAuthority(context: Awaited<ReturnType<typeof createContext>>, selection: AgentExecutionSelection): Promise<ExecutionAuthorityV1> {
  const authority = await prepareExecutionAuthority(context.root, selection, { participantId: context.participantId, phase: "implementation", required: true, now: new Date(NOW) });
  if (!authority) throw new Error("expected execution authority");
  return authority;
}

function makeRequest(context: Awaited<ReturnType<typeof createContext>>, authority: ExecutionAuthorityV1, action: ToolActionRequestV1["action"], actionKey: string): ToolActionRequestV1 {
  return { root: context.root, operationId: context.operationId, participantId: context.participantId, role: context.role, candidate: context.candidate, actionKey, action, payload: { taskId: "T-1", action }, authority: { kind: "execution-authority", authority }, now: new Date(NOW) };
}

function makeControllerRequest(context: Awaited<ReturnType<typeof createContext>>, action: ToolActionRequestV1["action"], actionKey: string, payload: unknown = { taskId: "T-1", action }): ToolActionRequestV1 {
  const operationEpoch = Number(process.env.AEH_CONTROLLER_EPOCH);
  return { root: context.root, operationId: context.operationId, participantId: controllerActorId(context.operationId), candidate: context.candidate, actionKey, action, payload, authority: { kind: "controller-authority", operationId: context.operationId, controllerEpoch: operationEpoch }, now: new Date(NOW) };
}

function restoreEnv(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
