import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { initializeProject } from "../src/core/init.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { sha256Canonical } from "../src/core/digest.js";
import { advanceCandidateForControllerAuthoring } from "../src/operations/change.js";
import {
  bindOperationExecutionSemantics,
  bindResolvedOperationPolicy,
  claimControllerEpoch,
  isProvisionalOperationPolicyV1,
  loadOperation,
  recordParticipantReceipt,
  registerOperationAgent,
  saveOperation
} from "../src/operations/state.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { candidateAssemblyReceiptIdV1, resolveCandidateLineageReceiptV1, type CandidateRevisionV1, type ParticipantReceiptV1 } from "../src/operations/v2Contracts.js";

const digest = (value: unknown) => sha256Canonical(value);
const specManagerLaunchId = "participant:1111111111111111";
const explorerLaunchId = "participant:2222222222222222";
const implementerLaunchId = "participant:3333333333333333";

const roots: string[] = [];
const environmentKeys = ["AEH_OPERATION_ID", "AEH_OPERATION_KIND", "AEH_OPERATION_STATE_REDIRECT", "AEH_CONTROL_ROOT", "AEH_CONTROLLER_EPOCH", "AEH_CONTROLLER_TOKEN"] as const;
const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
afterEach(async () => {
  for (const key of environmentKeys) { const value = previousEnvironment[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `aeh-${name}-`));
  roots.push(root);
  await initializeProject(root);
  await fs.writeFile(path.join(root, ".harness", "project.yaml"), `version: 1\nproject:\n  name: ${name}\nvalidation:\n  baseRef: master\n`);
  await new Promise<void>((resolve, reject) => execFile("git", ["init", "-q", "-b", "master"], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => execFile("git", ["config", "user.email", "authoring@aeh.invalid"], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => execFile("git", ["config", "user.name", "Authoring Test"], { cwd: root }, (error) => error ? reject(error) : resolve()));
  return root;
}

function settledReceipt(operationId: string, role: string, participantId: string, sessionId: string, candidate: CandidateRevisionV1, artifact: string, now: string): ParticipantReceiptV1 {
  return {
    version: 1,
    receiptId: `receipt:${participantId}:${candidate.revision}:${now}`,
    operationId,
    participantId,
    sessionId,
    attempt: 1,
    role,
    phase: role === "Spec Manager" ? "spec-authoring" : "discovery",
    startedAt: now,
    finishedAt: now,
    outcome: "SUCCEEDED",
    candidate,
    runtimeTerminal: { kind: "runtime-terminal", eventId: `runtime:${participantId}-r${candidate.revision}`, observedAt: now, terminal: true, status: "SUCCEEDED", exitCode: 0 },
    contract: { contractId: role.toLowerCase(), contractDigest: digest(`${role}-contract`), valid: true },
    artifact: { artifactId: artifact, artifactDigest: digest(`artifact-${participantId}-r${candidate.revision}`), persisted: true, persistedAt: now },
    provenance: { provenanceId: `provenance:${participantId}-r${candidate.revision}`, provenanceDigest: digest(`provenance-${participantId}-r${candidate.revision}`), source: "aeh-worker-finalization", valid: true },
    settled: true,
    createdAt: now
  };
}

describe("AEH-V2-0126 formal authoring candidate advance", () => {
  it("advances the candidate lineage for controller authoring and records the ASSEMBLING receipt", async () => {
    const root = await fixtureRoot("formal-authoring-advance");
    const operationId = "CHANGE-FORMAL-ADVANCE";
    const now = "2026-01-01T00:00:00.000Z";
    await saveOperation(root, { version: 1, id: operationId, kind: "change", status: "RUNNING", phase: "spec-compilation", root, payload: { request: "formal authoring", risk: "low" }, createdAt: now, updatedAt: now } as never);
    await claimControllerEpoch(root, operationId, `controller:test:${operationId}`);
    const r1 = (await loadOperation(root, operationId)).candidateRevision!;
    await registerOperationAgent(root, operationId, { id: specManagerLaunchId, logicalAgent: "spec-manager", role: "Spec Manager", phase: "spec-authoring" });
    await registerOperationAgent(root, operationId, { id: explorerLaunchId, logicalAgent: "explorer", role: "Explorer", phase: "discovery" });
    await registerOperationAgent(root, operationId, { id: implementerLaunchId, logicalAgent: "implementer", role: "Implementer", phase: "implementation" });
    const specArtifact = `.harness/operations/${operationId}/results/spec-authoring/r1.json`;
    await fs.mkdir(path.dirname(path.join(root, specArtifact)), { recursive: true });
    await fs.writeFile(path.join(root, specArtifact), `${JSON.stringify({ status: "READY" })}\n`);
    await recordParticipantReceipt(root, operationId, settledReceipt(operationId, "Spec Manager", specManagerLaunchId, "spec-session-r1", r1, specArtifact, now));
    await recordParticipantReceipt(root, operationId, settledReceipt(operationId, "Explorer", explorerLaunchId, "explorer-session-r1", r1, `.harness/operations/${operationId}/results/explorer/r1.json`, now));
    await recordParticipantReceipt(root, operationId, settledReceipt(operationId, "Implementer", implementerLaunchId, "implementer-session-r1", r1, `.harness/operations/${operationId}/results/implementer/r1.json`, now));
    // Controller-owned authoring persistence writes non-ignored files into the bound workspace.
    const authored = path.join(root, "openspec", "changes", "change-formal-advance", "specs", "greeting", "spec.md");
    await fs.mkdir(path.dirname(authored), { recursive: true });
    await fs.writeFile(authored, "## ADDED Requirements\n\n### Requirement: FAREWELL is exported\n\nThe module SHALL export FAREWELL.\n\n#### Scenario: import\n- **WHEN** imported\n- **THEN** FAREWELL is defined\n");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "greeting.mjs"), "export const FAREWELL = \"bye\";\n");

    const config = { project: { name: "s13-formal-authoring" }, workflow: { reviews: { leadAcceptance: true } } } as unknown as HarnessProjectConfig;
    const first = await advanceCandidateForControllerAuthoring({ root, controlRoot: root, config, operationId, taskId: "CHANGE-FORMAL-ADVANCE", changeName: "change-formal-advance", route: "FORMAL_SDD", assurance: "ELEVATED" });
    expect(first).toMatchObject({ advanced: true, revision: 2 });
    const after = await loadOperation(root, operationId);
    const r2 = after.candidateRevision!;
    expect(r2).toMatchObject({ revision: 2, parentCandidateId: r1.candidateId, sourceDigest: await computeWorktreeDigest(root) });
    // Execution bindings are invalidated consistently: the frozen policy is replaced by the
    // provisional bootstrap policy for the advanced candidate (so the first real execution-semantics
    // bind advances the revision instead of failing EXECUTION_POLICY_RECOMPILE_REQUIRED) and every
    // participant execution binding is dropped so the next launch recompiles against r2.
    expect(isProvisionalOperationPolicyV1(after.resolvedOperationPolicy)).toBe(true);
    expect(after.resolvedOperationPolicy).toMatchObject({ candidateRevision: 2, operationExecutionRevision: after.operationExecutionRevision, route: "FORMAL_SDD", minimumAssurance: "ELEVATED" });
    expect(Object.values(after.participants).every((participant) => participant.executionBinding === undefined)).toBe(true);
    const assembly = after.candidateAssemblyReceipts?.[candidateAssemblyReceiptIdV1(operationId, r2.candidateId)];
    expect(assembly).toBeDefined();
    expect(assembly).toMatchObject({
      baseCandidateId: r1.candidateId,
      baseRevision: 1,
      candidateId: r2.candidateId,
      revision: 2,
      participantId: specManagerLaunchId,
      workUnitId: "authoring:change-formal-advance",
      sourceBaseRevision: 1,
      sourceBaseIdentityDigest: r1.identityDigest
    });
    const specReceipt = Object.values(after.participantReceipts ?? {}).find((receipt) => receipt.participantId === specManagerLaunchId)!;
    expect(resolveCandidateLineageReceiptV1({ receipt: specReceipt, current: r2, assemblies: Object.values(after.candidateAssemblyReceipts ?? {}) })?.kind).toBe("ASSEMBLY");
    const explorerReceipt = Object.values(after.participantReceipts ?? {}).find((receipt) => receipt.participantId === explorerLaunchId)!;
    expect(resolveCandidateLineageReceiptV1({ receipt: explorerReceipt, current: r2, assemblies: Object.values(after.candidateAssemblyReceipts ?? {}) })?.kind).toBe("ANCESTOR");
    // A producer receipt the authoring assembly does not name stays fail-closed.
    const implementerReceipt = Object.values(after.participantReceipts ?? {}).find((receipt) => receipt.participantId === implementerLaunchId)!;
    expect(resolveCandidateLineageReceiptV1({ receipt: implementerReceipt, current: r2, assemblies: Object.values(after.candidateAssemblyReceipts ?? {}) })).toBeUndefined();
    void specArtifact;

    const second = await advanceCandidateForControllerAuthoring({ root, controlRoot: root, config, operationId, taskId: "CHANGE-FORMAL-ADVANCE", changeName: "change-formal-advance", route: "FORMAL_SDD", assurance: "ELEVATED" });
    expect(second).toMatchObject({ advanced: false, revision: 2 });
    expect((await loadOperation(root, operationId)).candidateRevision?.revision).toBe(2);

    // The first real execution-semantics bind (wave planning) must advance the operation execution
    // revision and clear the provisional bootstrap policy, so the wave-compiled policy can bind at
    // the advanced revision. Without the provisional rebind this threw
    // EXECUTION_POLICY_RECOMPILE_REQUIRED in the real formal lane (r16-formal-2 diagnostic).
    const beforeSemantics = await loadOperation(root, operationId);
    const semantics = await bindOperationExecutionSemantics(root, operationId, digest({ wave: "semantics" }));
    expect(semantics.operationExecutionRevision).toBe((beforeSemantics.operationExecutionRevision ?? 1) + 1);
    expect(semantics.resolvedOperationPolicy).toBeUndefined();
    const wavePolicy = compileResolvedOperationPolicy({
      projectId: r2.projectId ?? "s13-formal-authoring",
      operationId,
      operationExecutionRevision: semantics.operationExecutionRevision!,
      candidateRevision: r2.revision,
      candidateDigest: r2.identityDigest,
      controllerEpoch: semantics.controller?.epoch ?? 1,
      intent: "wave planning",
      route: "FORMAL_SDD",
      minimumAssurance: "ELEVATED",
      policyVersions: { resolvedOperationPolicy: "1", roleInvocationPolicy: "1", executionBlueprint: "2", executionBinding: "2", skillManifest: "1" },
      policyDigests: { validation: digest({ validation: "wave" }), delivery: digest({ delivery: "wave" }), knowledge: digest([]), context: digest(null) },
      validationPolicy: { wave: true },
      reviewPolicy: { minimumAssurance: "ELEVATED", independentReviewRequired: true, leadAcceptance: true },
      deliveryPolicy: { githubEnabled: false, paseoEnabled: false, allowedExternalEffects: [] },
      knowledgePolicy: { resolutions: [] },
      contextPolicy: { mode: "disabled" },
      allowedExternalEffects: [],
      humanDecisionRequirements: []
    });
    const rebound = await bindResolvedOperationPolicy(root, operationId, wavePolicy);
    expect(rebound.resolvedOperationPolicy?.digest).toBe(wavePolicy.digest);
    expect(rebound.resolvedOperationPolicy?.operationExecutionRevision).toBe(semantics.operationExecutionRevision);
  });
});
