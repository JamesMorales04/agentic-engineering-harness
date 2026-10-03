import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const routeService = {
  assess: vi.fn(async (request: { evidenceRefs: string[]; binding: unknown }) => ({
    judgment: {
      type: "ROUTE", recommendedRoute: "DIRECT", scopeClarity: "HIGH", decompositionNeed: false,
      coordinationNeed: false, architectureUncertainty: false, productUncertainty: false,
      formalizationNeed: "NONE", semanticRiskSignals: [], evidenceRefs: request.evidenceRefs, unknowns: []
    },
    unknowns: [], assessmentDigest: "a".repeat(64)
  }))
};

vi.mock("../src/semantic/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/semantic/runtime.js")>();
  return {
    ...actual,
    createSemanticAssessmentRuntimeV1: vi.fn(async () => ({ service: routeService, policyRevision: "recovery-floor-test" }))
  };
});

import { normalizeTriageEvidence, triageChangeWithSemanticAssessment } from "../src/core/triage.js";
import { loadProjectConfig } from "../src/core/config.js";
import { initializeProject } from "../src/core/init.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { sha256Canonical } from "../src/core/digest.js";
import { createIntentDecision } from "../src/audit/intentDecision.js";
import { bindBootstrapOperationPolicy, startDetachedOperation } from "../src/operations/controller.js";
import { prepareChangeOperation } from "../src/operations/change.js";
import { claimControllerEpoch, loadOperation, operationFile, patchOperation, saveOperation, transitionOperationToTerminal } from "../src/operations/state.js";
import { bindResolvedOperationPolicy } from "../src/operations/state.js";
import { compileOperationOriginV1 } from "../src/operations/operationProvenance.js";
import { createSemanticRepositoryBindingV1 } from "../src/semantic/runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-recovery-assurance-floor-"));
  roots.push(root);
  await initializeProject(root);
  const config = await loadProjectConfig(root);
  const now = new Date().toISOString();
  await saveOperation(root, { version: 1, id: "PARENT-ELEVATED", kind: "audit", status: "RUNNING", phase: "review", root, payload: { request: "review" }, createdAt: now, updatedAt: now } as never);
  const claimed = await claimControllerEpoch(root, "PARENT-ELEVATED", "controller:test:parent", { pid: process.pid });
  const candidate = claimed.candidateRevision!;
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId!, operationId: claimed.id, operationExecutionRevision: claimed.operationExecutionRevision!,
    candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: claimed.controller!.epoch,
    intent: "elevated parent review", route: "DIRECT", minimumAssurance: "ELEVATED",
    policyVersions: { resolvedOperationPolicy: "2" }, policyDigests: {}, validationPolicy: {},
    reviewPolicy: { minimumAssurance: "ELEVATED", independentReviewRequired: true }, deliveryPolicy: {},
    knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: []
  });
  await bindResolvedOperationPolicy(root, claimed.id, policy);
  const parentOrigin = compileOperationOriginV1({
    kind: "USER_REQUEST", leadAgentId: "lead-parent", controllerOwnerId: "controller:test:parent", userTurnId: "owner-turn-recovery",
    authorizationDigest: sha256Canonical("owner-turn-recovery"), triggerEventId: "user.turn:owner-turn-recovery",
    requestDigest: sha256Canonical({ request: "review" }), recoveryDepth: 0,
    rootHardDeadlineAt: new Date(Date.parse(now) + policy.executionLiveness.hardDeadlineMs).toISOString(),
    reason: "elevated parent review", createdAt: now
  });
  await patchOperation(root, claimed.id, { origin: parentOrigin });
  const terminal = await transitionOperationToTerminal(root, claimed.id, { status: "FAILED", phase: "failed", error: "fixture failure" });
  const payload = { request: "Adjust a button label", files: ["src/Button.tsx"], domains: ["frontend"], risk: "low" as const };
  const normalized = normalizeTriageEvidence(payload);
  const binding = await createSemanticRepositoryBindingV1(root, config);
  const intentDigest = sha256Canonical({ request: payload.request, files: normalized.files, domains: normalized.domains, risk: normalized.risk, flags: normalized.flags });
  const semanticBinding = { ...binding, intentDigest };
  const triage = await triageChangeWithSemanticAssessment(config, payload, { service: routeService as never, binding: semanticBinding, policyRevision: "recovery-floor-test" });
  const child = await startDetachedOperation(root, "change", { ...payload, intentDecision: createIntentDecision("change", "Retry the failed work safely.", "lead-semantic", { userTurnId: "owner-turn-recovery", continuation: { operationId: claimed.id } }) }, {
    nodeExecutable: "/usr/bin/node", entryFile: "/pkg/dist/main.js", initiator: { kind: "LEAD", agentId: "lead-recovery", userTurnId: "owner-turn-recovery", requestEventId: "jsonrpc:recovery" },
    resolveChangePreflight: vi.fn(async () => ({ version: 1 as const, triage, binding: semanticBinding })),
    spawnProcess: vi.fn(() => ({ pid: 8123, unref: vi.fn() })) as never
  });
  return { root, config, payload, parentId: claimed.id, terminalRevision: terminal.record.revision, child };
}

describe("linked recovery assurance floor", () => {
  it("persists the inherited ELEVATED floor through preparation and bootstrap policy", async () => {
    const { root, config, payload, child } = await fixture();
    expect(child.changePreflight?.triage.assurance).toBe("NONE");

    const prepared = await prepareChangeOperation(root, config, child, payload);
    expect(prepared.triage.assurance).toBe("ELEVATED");
    expect(prepared.triage.reasons).toContain("linked failed-operation recovery inherits the parent minimum assurance ELEVATED");

    const updated = await patchOperation(root, child.id, { intent: { ...child.intent, route: prepared.triage.route, assurance: prepared.triage.assurance } });
    const bound = await bindBootstrapOperationPolicy(root, config, updated, prepared.triage.route, prepared.triage.assurance);
    expect(bound.intent).toMatchObject({ route: "DIRECT", assurance: "ELEVATED" });
    expect(bound.resolvedOperationPolicy).toMatchObject({ minimumAssurance: "ELEVATED", reviewPolicy: { minimumAssurance: "ELEVATED", independentReviewRequired: true } });
    expect((await loadOperation(root, child.id)).resolvedOperationPolicy?.minimumAssurance).toBe("ELEVATED");
  });

  it("fails closed when the linked parent revision changed after child authorization", async () => {
    const { root, config, payload, parentId, terminalRevision, child } = await fixture();
    const parentPath = operationFile(root, parentId);
    const persisted = JSON.parse(await fs.readFile(parentPath, "utf8")) as { revision: number };
    persisted.revision = terminalRevision + 1;
    await fs.writeFile(parentPath, `${JSON.stringify(persisted)}\n`);

    await expect(prepareChangeOperation(root, config, child, payload)).rejects.toThrow("OPERATION_RECOVERY_PARENT_STALE");
  });
});
