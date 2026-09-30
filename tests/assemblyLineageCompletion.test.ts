import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertWorkspaceMatchesCandidate } from "../src/candidates/identity.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { initializeProject } from "../src/core/init.js";
import {
  bindOperationCandidate,
  claimControllerEpoch,
  loadOperation,
  recordCandidateAssemblyReceipt,
  recordParticipantReceipt,
  registerOperationAgent,
  saveOperation,
  transitionOperationToTerminal
} from "../src/operations/state.js";
import { candidateAssemblyReceiptIdV1, createCandidateRevisionV1, evaluateTerminalGate, resolveCandidateLineageReceiptV1, type CandidateRevisionV1, type ParticipantReceiptV1 } from "../src/operations/v2Contracts.js";
import { sha256Canonical } from "../src/core/digest.js";

const digest = (value: unknown) => sha256Canonical(value);
const authorityId = "participant:abcabcabcabcabca";

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
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => execFile("git", ["init", "-q", "-b", "master"], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => execFile("git", ["config", "user.email", "assembly@aeh.invalid"], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => execFile("git", ["config", "user.name", "Assembly Test"], { cwd: root }, (error) => error ? reject(error) : resolve()));
  return root;
}

function settledReceipt(operationId: string, current: CandidateRevisionV1, artifact: string, now: string): ParticipantReceiptV1 {
  return {
    version: 1,
    receiptId: `receipt:${authorityId}:${current.revision}:${now}`,
    operationId,
    participantId: authorityId,
    sessionId: `implementer-session-r${current.revision}`,
    attempt: 1,
    role: "Implementer",
    phase: "implementation",
    startedAt: now,
    finishedAt: now,
    outcome: "SUCCEEDED",
    candidate: current,
    runtimeTerminal: { kind: "runtime-terminal", eventId: `runtime:implementer-r${current.revision}`, observedAt: now, terminal: true, status: "SUCCEEDED", exitCode: 0 },
    contract: { contractId: "implementer", contractDigest: digest("implementer-contract"), valid: true },
    artifact: { artifactId: artifact, artifactDigest: digest(`artifact-r${current.revision}`), persisted: true, persistedAt: now },
    provenance: { provenanceId: `provenance:implementer-r${current.revision}`, provenanceDigest: digest(`provenance-r${current.revision}`), source: "aeh-worker-finalization", valid: true },
    settled: true,
    createdAt: now
  };
}

async function prepareOperation(root: string, operationId: string): Promise<{ r1: CandidateRevisionV1; artifact: string; receipt: ParticipantReceiptV1 }> {
  const now = "2026-01-01T00:00:00.000Z";
  await saveOperation(root, { version: 1, id: operationId, kind: "audit", status: "RUNNING", phase: "implementation", root, payload: { request: "assembly lineage", risk: "low" }, createdAt: now, updatedAt: now } as never);
  await claimControllerEpoch(root, operationId, `controller:test:${operationId}`);
  const r1 = (await loadOperation(root, operationId)).candidateRevision!;
  await registerOperationAgent(root, operationId, { id: authorityId, logicalAgent: "implementer", role: "Implementer", phase: "implementation" });
  const artifact = `.harness/operations/${operationId}/results/implementer/${r1.revision}.json`;
  await fs.mkdir(path.dirname(path.join(root, artifact)), { recursive: true });
  await fs.writeFile(path.join(root, artifact), `${JSON.stringify({ status: "PASS", changes: ["src/feature.mjs"] })}\n`);
  const receipt = settledReceipt(operationId, r1, artifact, now);
  await recordParticipantReceipt(root, operationId, receipt);
  return { r1, artifact, receipt };
}

async function advanceCandidate(root: string, operationId: string, base: CandidateRevisionV1): Promise<CandidateRevisionV1> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "feature.mjs"), "export const FEATURE = true;\n");
  const candidate = createCandidateRevisionV1({
    operationId,
    candidateId: `candidate:${operationId}:r${base.revision + 1}`,
    projectId: base.projectId,
    taskId: base.taskId,
    revision: base.revision + 1,
    parentCandidateId: base.candidateId,
    sourceDigest: await computeWorktreeDigest(root),
    worktree: root,
    createdAt: "2026-01-01T00:00:01.000Z"
  });
  await bindOperationCandidate(root, operationId, candidate);
  return candidate;
}

function assemblyInput(base: CandidateRevisionV1, candidate: CandidateRevisionV1, patchDigest = digest("patch-r2")) {
  return {
    baseCandidate: base,
    candidate,
    changeSet: {
      operationId: base.operationId,
      taskId: base.taskId!,
      workUnitId: "direct:implement",
      participantId: authorityId,
      baseCandidateRevision: base.revision,
      baseCandidateDigest: base.identityDigest,
      patchDigest
    }
  };
}

describe("AEH-V2-0106 assembly-lineage completion", () => {
  it("records the ASSEMBLING receipt and lets the successful-terminal gate accept the implementer lineage", async () => {
    const root = await fixtureRoot("assembly-lineage");
    const operationId = "AUDIT-ASSEMBLY-LINEAGE";
    const { r1, artifact, receipt } = await prepareOperation(root, operationId);
    const r2 = await advanceCandidate(root, operationId, r1);
    await recordCandidateAssemblyReceipt(root, operationId, assemblyInput(r1, r2));
    const after = await loadOperation(root, operationId);
    const assembly = after.candidateAssemblyReceipts?.[candidateAssemblyReceiptIdV1(operationId, r2.candidateId)];
    expect(assembly).toBeDefined();
    expect(assembly).toMatchObject({ baseCandidateId: r1.candidateId, baseRevision: r1.revision, candidateId: r2.candidateId, revision: r2.revision, participantId: authorityId, sourceReceiptId: receipt.receiptId, sourceReceiptDigest: digest(receipt), sourceBaseRevision: r1.revision, sourceBaseIdentityDigest: r1.identityDigest });
    expect(after.participants[authorityId]).toMatchObject({ status: "REGISTERED", resultArtifact: artifact });
    expect(resolveCandidateLineageReceiptV1({ receipt: after.participantReceipts![receipt.receiptId]!, current: r2, assemblies: Object.values(after.candidateAssemblyReceipts ?? {}) })).toEqual({ kind: "ASSEMBLY", assembly });
    const bound = after.participantReceipts![receipt.receiptId]!;
    expect(evaluateTerminalGate(bound, { operationId, candidate: r1 }).allowed).toBe(true);
    expect(evaluateTerminalGate(bound, { operationId, candidate: r2 }).reasons.map((item) => item.code)).toContain("CANDIDATE_MISMATCH");

    const terminal = await transitionOperationToTerminal(root, operationId, { status: "SUCCEEDED", phase: "finished", finishedAt: "2026-01-01T00:00:02.000Z" });
    expect(terminal.transitioned).toBe(true);
    expect(terminal.record.status).toBe("SUCCEEDED");
    await assertWorkspaceMatchesCandidate(root, r2);
  });

  it("still rejects a pre-assembly receipt when no assembly lineage proves the transition", async () => {
    const root = await fixtureRoot("assembly-no-lineage");
    const operationId = "AUDIT-ASSEMBLY-NO-LINEAGE";
    const { r1 } = await prepareOperation(root, operationId);
    await advanceCandidate(root, operationId, r1);
    await expect(transitionOperationToTerminal(root, operationId, { status: "SUCCEEDED", phase: "finished", finishedAt: "2026-01-01T00:00:02.000Z" }))
      .rejects.toThrow(/V2_TERMINAL_GATE_REJECTED: participant .*CANDIDATE_MISMATCH/);
  });

  it("preserves the resumable controller-issued identity across the assembly and a resumed turn", async () => {
    const root = await fixtureRoot("assembly-resume");
    const operationId = "AUDIT-ASSEMBLY-RESUME";
    const { r1, artifact, receipt } = await prepareOperation(root, operationId);
    const r2 = await advanceCandidate(root, operationId, r1);
    await recordCandidateAssemblyReceipt(root, operationId, assemblyInput(r1, r2));
    const resumedArtifact = `.harness/operations/${operationId}/results/implementer/resumed.json`;
    await fs.writeFile(path.join(root, resumedArtifact), `${JSON.stringify({ status: "PASS", resumed: true })}\n`);
    const resumed = settledReceipt(operationId, r2, resumedArtifact, "2026-01-01T00:00:03.000Z");
    await recordParticipantReceipt(root, operationId, resumed);
    const after = await loadOperation(root, operationId);
    expect(after.participants[authorityId]).toMatchObject({ status: "REGISTERED", resultArtifact: resumedArtifact });
    expect(Object.keys(after.participantReceipts ?? {}).sort()).toEqual([receipt.receiptId, resumed.receiptId].sort());
    expect(resolveCandidateLineageReceiptV1({ receipt: after.participantReceipts![receipt.receiptId]!, current: r2, assemblies: Object.values(after.candidateAssemblyReceipts ?? {}) })?.kind).toBe("ASSEMBLY");
    expect(resolveCandidateLineageReceiptV1({ receipt: after.participantReceipts![resumed.receiptId]!, current: r2, assemblies: [] })?.kind).toBe("DIRECT");
    const terminal = await transitionOperationToTerminal(root, operationId, { status: "SUCCEEDED", phase: "finished", finishedAt: "2026-01-01T00:00:04.000Z" });
    expect(terminal.record.status).toBe("SUCCEEDED");
    expect(terminal.record.participants[authorityId]?.status).toBe("COMPLETED");
    void artifact;
  });
});
