import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { sha256Canonical } from "../src/core/digest.js";
import { initializeProject } from "../src/core/init.js";
import { rebindEscalatedChangePolicy } from "../src/operations/change.js";
import { bindOperationExecutionSemantics, bindResolvedOperationPolicy, isProvisionalOperationPolicyV1, loadOperation } from "../src/operations/state.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";

const roots: string[] = [];
const environmentKeys = ["AEH_OPERATION_ID", "AEH_OPERATION_STATE_REDIRECT", "AEH_CONTROL_ROOT", "AEH_CONTROLLER_EPOCH", "AEH_CONTROLLER_TOKEN"] as const;
const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
afterEach(async () => {
  for (const key of environmentKeys) { const value = previousEnvironment[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-spec-escalation-"));
  roots.push(root);
  await initializeProject(root);
  await fs.writeFile(path.join(root, ".harness", "project.yaml"), "version: 1\nproject:\n  name: spec-escalation\nvalidation:\n  baseRef: master\n");
  return root;
}

describe("AEH-V2-0107 FORMAL_SDD escalation policy rebind", () => {
  it("advances execution semantics and rebinds the escalated route/assurance for the current candidate", async () => {
    const root = await fixtureRoot();
    const operationId = "CHANGE-SPEC-ESCALATION";
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "change", status: "RUNNING", phase: "planning", root, payload: { request: "escalating change", taskId: "TASK-ESCALATE", risk: "low" }, createdAt: now, updatedAt: now } as never);
    let operation = await loadOperation(root, operationId);
    const candidate = operation.candidateRevision!;
    const epoch = operation.operationExecutionRevision!;
    const policy = compileResolvedOperationPolicy({
      projectId: candidate.projectId!,
      operationId,
      operationExecutionRevision: epoch,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      controllerEpoch: 1,
      intent: "escalating change",
      route: "DELEGATED",
      minimumAssurance: "NONE",
      policyVersions: { resolvedOperationPolicy: "2" },
      policyDigests: {},
      validationPolicy: {},
      reviewPolicy: { leadAcceptance: false, leadAcceptanceDirect: false },
      deliveryPolicy: {},
      knowledgePolicy: {},
      contextPolicy: {},
      allowedExternalEffects: [],
      humanDecisionRequirements: []
    });
    await bindResolvedOperationPolicy(root, operationId, policy);
    const before = await loadOperation(root, operationId);
    expect(before.resolvedOperationPolicy?.route).toBe("DELEGATED");

    const escalationEvidence = { explorerArtifact: ".harness/handoffs/explorer.json", plannerArtifact: ".harness/handoffs/planner.json" };
    const rebound = await rebindEscalatedChangePolicy({ controlRoot: root, operationId, route: "FORMAL_SDD", assurance: "ELEVATED", escalationEvidence });
    expect(rebound.operationExecutionRevision).toBe(before.operationExecutionRevision! + 1);
    expect(rebound.executionSemanticsDigest).toBe(sha256Canonical({ kind: "SPEC_ESCALATION", operationId, route: "FORMAL_SDD", assurance: "ELEVATED", candidateId: candidate.candidateId, candidateDigest: candidate.identityDigest, ...escalationEvidence }));
    expect(rebound.resolvedOperationPolicy).toMatchObject({
      operationId,
      route: "FORMAL_SDD",
      minimumAssurance: "ELEVATED",
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      operationExecutionRevision: rebound.operationExecutionRevision,
      controllerEpoch: rebound.resolvedOperationPolicy?.controllerEpoch
    });
    expect(rebound.resolvedOperationPolicy!.digest).not.toBe(policy.digest);

    const again = await rebindEscalatedChangePolicy({ controlRoot: root, operationId, route: "FORMAL_SDD", assurance: "ELEVATED", escalationEvidence });
    expect(again.operationExecutionRevision).toBe(rebound.operationExecutionRevision);
    expect(again.resolvedOperationPolicy!.digest).toBe(rebound.resolvedOperationPolicy!.digest);
  });

  it("advances exactly one execution revision when the semantics baseline already exists", async () => {
    const root = await fixtureRoot();
    const operationId = "CHANGE-SPEC-ESCALATION-BASELINE";
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "change", status: "RUNNING", phase: "planning", root, payload: { request: "escalating change", taskId: "TASK-ESCALATE-B", risk: "low" }, createdAt: now, updatedAt: now } as never);
    const operation = await loadOperation(root, operationId);
    const candidate = operation.candidateRevision!;
    await bindResolvedOperationPolicy(root, operationId, compileResolvedOperationPolicy({
      projectId: candidate.projectId!,
      operationId,
      operationExecutionRevision: operation.operationExecutionRevision!,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      controllerEpoch: 1,
      intent: "escalating change",
      route: "DELEGATED",
      minimumAssurance: "NONE",
      policyVersions: { resolvedOperationPolicy: "2" },
      policyDigests: {},
      validationPolicy: {},
      reviewPolicy: { leadAcceptance: false, leadAcceptanceDirect: false },
      deliveryPolicy: {},
      knowledgePolicy: {},
      contextPolicy: {},
      allowedExternalEffects: [],
      humanDecisionRequirements: []
    }));
    const baseline = await bindOperationExecutionSemantics(root, operationId, sha256Canonical({ semantics: "pre-escalation" }));
    const rebound = await rebindEscalatedChangePolicy({ controlRoot: root, operationId, route: "FORMAL_SDD", assurance: "ELEVATED", escalationEvidence: {} });
    expect(rebound.operationExecutionRevision).toBe(baseline.operationExecutionRevision! + 1);
    expect(rebound.resolvedOperationPolicy).toMatchObject({ route: "FORMAL_SDD", minimumAssurance: "ELEVATED", operationExecutionRevision: rebound.operationExecutionRevision });
    expect((rebound.resolvedOperationPolicy!.reviewPolicy as { minimumAssurance?: string }).minimumAssurance).toBe("ELEVATED");
  });

  it("supersedes a provisional bootstrap policy on the first execution-semantics bind (AEH-V2-0110)", async () => {
    const root = await fixtureRoot();
    const operationId = "CHANGE-PROVISIONAL-POLICY";
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "change", status: "RUNNING", phase: "planning", root, payload: { request: "provisional semantics", taskId: "TASK-PROVISIONAL", risk: "low" }, createdAt: now, updatedAt: now } as never);
    const operation = await loadOperation(root, operationId);
    const candidate = operation.candidateRevision!;
    const base = {
      projectId: candidate.projectId!,
      operationId,
      operationExecutionRevision: operation.operationExecutionRevision!,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      controllerEpoch: 1,
      intent: "provisional semantics",
      route: "DELEGATED" as const,
      minimumAssurance: "NONE" as const,
      policyVersions: { resolvedOperationPolicy: "2" },
      policyDigests: {},
      validationPolicy: {},
      reviewPolicy: { leadAcceptance: false, leadAcceptanceDirect: false },
      deliveryPolicy: {},
      contextPolicy: {},
      allowedExternalEffects: [],
      humanDecisionRequirements: []
    };
    const provisional = await bindResolvedOperationPolicy(root, operationId, compileResolvedOperationPolicy({ ...base, knowledgePolicy: { bootstrap: true } }));
    expect(isProvisionalOperationPolicyV1(provisional.resolvedOperationPolicy!)).toBe(true);

    const semantics = sha256Canonical({ kind: "PLANNING_SEMANTICS", operationId });
    const advanced = await bindOperationExecutionSemantics(root, operationId, semantics);
    expect(advanced.operationExecutionRevision).toBe(provisional.operationExecutionRevision! + 1);
    expect(advanced.resolvedOperationPolicy).toBeUndefined();
    expect(advanced.executionSemanticsDigest).toBe(semantics);

    const compiled = await bindResolvedOperationPolicy(root, operationId, compileResolvedOperationPolicy({ ...base, operationExecutionRevision: advanced.operationExecutionRevision!, knowledgePolicy: { resolutions: [] } }));
    expect(compiled.resolvedOperationPolicy!.digest).not.toBe(provisional.resolvedOperationPolicy!.digest);
    const repeated = await bindOperationExecutionSemantics(root, operationId, semantics);
    expect(repeated.operationExecutionRevision).toBe(advanced.operationExecutionRevision!);
    expect(repeated.resolvedOperationPolicy?.digest).toBe(compiled.resolvedOperationPolicy!.digest);
  });

  it("fails closed when the escalation has no current frozen policy to rebind", async () => {
    const root = await fixtureRoot();
    const operationId = "CHANGE-SPEC-ESCALATION-NO-POLICY";
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "change", status: "RUNNING", phase: "planning", root, payload: { request: "escalating change", taskId: "TASK-ESCALATE-2", risk: "low" }, createdAt: now, updatedAt: now } as never);
    await expect(rebindEscalatedChangePolicy({ controlRoot: root, operationId, route: "FORMAL_SDD", assurance: "ELEVATED", escalationEvidence: {} }))
      .rejects.toThrow("EXECUTION_POLICY_INPUT_MISSING: spec escalation requires the current frozen policy and candidate to rebind.");
  });
});
