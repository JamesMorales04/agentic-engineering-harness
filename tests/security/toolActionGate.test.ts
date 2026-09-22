import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutionSelection } from "../../src/agents/types.js";
import { createCandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import { bindOperationCandidate, loadOperation, patchOperationMetadata, registerOperationAgent, saveOperation } from "../../src/operations/state.js";
import { prepareExecutionAuthority, type ExecutionAuthorityV1 } from "../../src/security/executionLease.js";
import { authorizeToolAction, classifyToolActionImpact, recordToolActionReceipt, type ToolActionRequestV1 } from "../../src/security/toolActionGate.js";
import { sha256Utf8 } from "../../src/core/digest.js";

const roots: string[] = [];
const previousEnv = {
  id: process.env.AEH_OPERATION_ID,
  control: process.env.AEH_CONTROL_ROOT,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT
};

afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", previousEnv.id);
  restoreEnv("AEH_CONTROL_ROOT", previousEnv.control);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", previousEnv.redirect);
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
    await expect(authorizeToolAction(request)).rejects.toThrow("TOOL_ACTION_RECONCILIATION_REQUIRED");
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

  it("limits external side effects to the bound Lead/Director", async () => {
    const implementer = await createContext("RUN-ACTION-EXTERNAL-DENY", "Implementer");
    const implementerAuthority = await makeAuthority(implementer, implementerSelection);
    await expect(authorizeToolAction(makeRequest(implementer, implementerAuthority, "github.issue.create", "delivery:issue")))
      .rejects.toThrow("TOOL_ACTION_APPROVAL_REQUIRED");

    const lead = await createContext("RUN-ACTION-EXTERNAL-ALLOW", "Lead/Director", true);
    const leadAuthority = await makeAuthority(lead, leadSelection);
    const allowed = await authorizeToolAction(makeRequest(lead, leadAuthority, "github.issue.create", "delivery:issue"));
    expect(allowed.decision).toBe("EXECUTE_ONCE");
    expect(allowed.intent.impact).toBe("EXTERNAL_NON_IDEMPOTENT");
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
      .rejects.toThrow("TOOL_ACTION_AUTHORITY_MISMATCH");
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

async function createContext(operationId: string, role: ToolActionRequestV1["role"], bindLead = false): Promise<{ root: string; operationId: string; participantId: string; role: ToolActionRequestV1["role"]; candidate: ReturnType<typeof createCandidateRevisionV1> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-tool-action-gate-")); roots.push(root);
  const participantId = `participant:${operationId.toLowerCase()}`;
  await saveOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: "T-1" }, createdAt: NOW, updatedAt: NOW });
  const candidate = (await loadOperation(root, operationId)).candidateRevision!;
  await registerOperationAgent(root, operationId, { id: participantId, role, logicalAgent: role, phase: "implementation" });
  if (bindLead) await patchOperationMetadata(root, operationId, { lead: { agentId: participantId, generation: 1, boundAt: NOW, acknowledgedRevision: 1, acknowledgedAt: NOW } });
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_CONTROL_ROOT = root;
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

function restoreEnv(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
