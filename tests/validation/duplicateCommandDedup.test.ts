import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract, ValidationReport } from "../../src/core/types.js";
import { computeWorktreeDigest } from "../../src/core/git.js";
import { sha256Canonical } from "../../src/core/digest.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import type { CandidateImpactV1 } from "../../src/candidates/assembler.js";
import { compileCandidateAssuranceV1 } from "../../src/architecture/candidateAssurance.js";
import {
  validationRequirementKindValues,
  type ResolvedValidationActionV1,
  type ValidationRequirementV1,
  type ValidationResolutionV1,
} from "../../src/architecture/validationRequirements.js";
import { runCandidateImpactValidations } from "../../src/core/run.js";

const baseConfig: HarnessProjectConfig = {
  version: 1,
  project: { name: "duplicate-command-dedup-fixture" },
  evidence: { outputDir: ".harness/evidence" },
};
const contract: TaskContract = {
  version: 1,
  task: { id: "TEST-DCMD-DEDUP", title: "duplicate command dedup" },
};
const roots: string[] = [];

async function fixture(): Promise<{ root: string; candidate: CandidateRevisionV1 }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-dcmd-dedup-"));
  roots.push(root);
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "duplicate-command-dedup-fixture", version: "1.0.0", scripts: {} }),
  );
  // Probe scripts append one marker line to a counter file via a path
  // relative to the execution cwd (the fixture root). process.execPath is an
  // absolute node binary path, so the probes are immune to hermetic-PATH
  // scrubbing in managed children. DETERMINISTIC: no providers, no network.
  await fs.writeFile(path.join(root, "probe-shared.mjs"), `import fs from "node:fs";\nfs.appendFileSync("probe-shared-counter.txt", "x\\n");\n`, "utf8");
  await fs.writeFile(path.join(root, "probe-distinct.mjs"), `import fs from "node:fs";\nfs.appendFileSync("probe-distinct-counter.txt", "y\\n");\n`, "utf8");
  const sourceDigest = await computeWorktreeDigest(root);
  const candidate = createCandidateRevisionV1({
    operationId: "OP-DCMD-DEDUP",
    candidateId: "CAND-DCMD-DEDUP",
    revision: 1,
    sourceDigest,
  });
  return { root, candidate };
}

function impactFor(candidate: CandidateRevisionV1): CandidateImpactV1 {
  const body = {
    version: 1 as const,
    candidate: {
      candidateId: candidate.candidateId,
      revision: candidate.revision,
      identityDigest: candidate.identityDigest,
    },
    baseCandidate: {
      candidateId: candidate.candidateId,
      revision: candidate.revision,
      identityDigest: candidate.identityDigest,
    },
    patchDigest: sha256Canonical("duplicate-command-dedup-patch"),
    changedFiles: ["src/app.ts"],
    changeKinds: ["source"],
    reviewDimensions: ["unit"],
    requiresIndependentReview: false,
    interpretation: "MODEL" as const,
    unknowns: [],
  };
  return { ...body, digest: sha256Canonical(body) };
}

function requirement(id: string, kind: ValidationRequirementV1["kind"], property: string): ValidationRequirementV1 {
  return {
    version: 1,
    id,
    property,
    kind,
    scope: ["src/app.ts"],
    evidenceNeeded: [`${kind} evidence.`],
    requirementRefs: [],
    acceptanceRefs: [],
  } as ValidationRequirementV1;
}

function resolutionFor(requirements: ValidationRequirementV1[], actions: ResolvedValidationActionV1[]): ValidationResolutionV1 {
  const withoutDigest = { version: 1 as const, requirements, actions, blocked: [] as Array<{ requirementId: string; reason: string }> };
  return { ...withoutDigest, digest: sha256Canonical(withoutDigest) };
}

async function runAll(root: string, candidate: CandidateRevisionV1, requirements: ValidationRequirementV1[], resolution: ValidationResolutionV1) {
  const impact = impactFor(candidate);
  const compilation = compileCandidateAssuranceV1({
    candidate,
    impact,
    policy: {
      version: 1,
      digest: sha256Canonical("duplicate-command-dedup-policy"),
      minimumAssurance: "STANDARD",
      independentReviewRequired: false,
      minimumIndependentReviewers: 0,
      providerDiversity: false,
      allowedValidationKinds: [...validationRequirementKindValues],
      evidenceStrength: "STANDARD",
    },
    implementationIdentity: "implementer-1",
    risk: "low",
    reviewerCandidates: [],
    baseValidationRequirements: [],
    validationResolution: resolution,
    acceptanceAssertions: [],
  });
  const report: ValidationReport = {
    version: 1,
    taskId: contract.task.id,
    status: "PASS",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    checks: [],
    changedFiles: ["src/app.ts"],
    candidate,
    metadata: { project: "duplicate-command-dedup-fixture", baseRef: "HEAD" },
  };
  return runCandidateImpactValidations({
    root,
    config: baseConfig,
    contract,
    report,
    impact,
    compilation,
    resolution,
    requirements,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/**
 * D27 duplicate-command dedup (Mechanism=DETERMINISTIC): a contract-derived
 * `command` requirement (configured-command) and a planner-authored
 * `unit-test` requirement (project-script) resolving to the byte-identical
 * command string must execute ONCE, emitting one per-requirement check each.
 * Before the fix the execution loop keyed only by
 * (source, selector, command, provider), so the suite ran twice.
 */
describe("duplicate command-string dedup in runCandidateImpactValidations", () => {
  it("executes a byte-identical command ONCE and emits per-requirement checks with correct bindings", async () => {
    const { root, candidate } = await fixture();
    const sharedCommand = `${process.execPath} probe-shared.mjs`;
    const requirements = [
      requirement("REQ-CONTRACT", "command", "Contract test script passes."),
      requirement("REQ-UNIT", "unit-test", "Unit tests pass."),
    ];
    const resolution = resolutionFor(requirements, [
      { version: 1, requirementId: "REQ-CONTRACT", kind: "command", source: "configured-command", selector: "test", command: sharedCommand, scope: ["src/app.ts"], evidenceNeeded: ["command evidence."] },
      { version: 1, requirementId: "REQ-UNIT", kind: "unit-test", source: "project-script", selector: "test", command: sharedCommand, scope: ["src/app.ts"], evidenceNeeded: ["unit-test evidence."] },
    ]);
    const checks = await runAll(root, candidate, requirements, resolution);

    // The shared probe ran exactly once (pre-fix: twice -> "x\nx\n").
    expect(await fs.readFile(path.join(root, "probe-shared-counter.txt"), "utf8")).toBe("x\n");

    const byId = new Map(checks.map((c) => [c.id, c]));
    const contractCheck = byId.get("candidate.assurance.validation.REQ-CONTRACT");
    const unitCheck = byId.get("candidate.assurance.validation.REQ-UNIT");
    expect(contractCheck?.status).toBe("PASS");
    expect(unitCheck?.status).toBe("PASS");
    // Per-requirement binding: each check carries its own requirement id,
    // kind, selector and source — never copied from the first requirement.
    expect(contractCheck?.details).toMatchObject({
      requirementId: "REQ-CONTRACT",
      kind: "command",
      selector: "test",
      source: "configured-command",
    });
    expect(unitCheck?.details).toMatchObject({
      requirementId: "REQ-UNIT",
      kind: "unit-test",
      selector: "test",
      source: "project-script",
    });
    // Shared execution: one underlying check, one duration.
    const contractDetails = contractCheck?.details as Record<string, unknown>;
    const unitDetails = unitCheck?.details as Record<string, unknown>;
    expect(contractDetails.underlyingCheckId).toBe("command.candidate-impact-REQ-CONTRACT");
    expect(unitDetails.underlyingCheckId).toBe(contractDetails.underlyingCheckId);
    expect(unitCheck?.durationMs).toBe(contractCheck?.durationMs);
  });

  it("still executes different command strings independently", async () => {
    const { root, candidate } = await fixture();
    const sharedCommand = `${process.execPath} probe-shared.mjs`;
    const distinctCommand = `${process.execPath} probe-distinct.mjs`;
    const requirements = [
      requirement("REQ-CONTRACT", "command", "Contract test script passes."),
      requirement("REQ-UNIT", "unit-test", "Unit tests pass."),
      requirement("REQ-OTHER", "unit-test", "Other unit tests pass."),
    ];
    const resolution = resolutionFor(requirements, [
      { version: 1, requirementId: "REQ-CONTRACT", kind: "command", source: "configured-command", selector: "test", command: sharedCommand, scope: ["src/app.ts"], evidenceNeeded: ["command evidence."] },
      { version: 1, requirementId: "REQ-UNIT", kind: "unit-test", source: "project-script", selector: "test", command: sharedCommand, scope: ["src/app.ts"], evidenceNeeded: ["unit-test evidence."] },
      { version: 1, requirementId: "REQ-OTHER", kind: "unit-test", source: "configured-command", selector: "other", command: distinctCommand, scope: ["src/app.ts"], evidenceNeeded: ["unit-test evidence."] },
    ]);
    const checks = await runAll(root, candidate, requirements, resolution);

    expect(await fs.readFile(path.join(root, "probe-shared-counter.txt"), "utf8")).toBe("x\n");
    expect(await fs.readFile(path.join(root, "probe-distinct-counter.txt"), "utf8")).toBe("y\n");

    const byId = new Map(checks.map((c) => [c.id, c]));
    expect(byId.get("candidate.assurance.validation.REQ-CONTRACT")?.status).toBe("PASS");
    expect(byId.get("candidate.assurance.validation.REQ-UNIT")?.status).toBe("PASS");
    const otherCheck = byId.get("candidate.assurance.validation.REQ-OTHER");
    expect(otherCheck?.status).toBe("PASS");
    expect(otherCheck?.details).toMatchObject({
      requirementId: "REQ-OTHER",
      kind: "unit-test",
      selector: "other",
      source: "configured-command",
    });
    // Independent execution: distinct underlying check id.
    const sharedUnderlying = (byId.get("candidate.assurance.validation.REQ-CONTRACT")?.details as Record<string, unknown>).underlyingCheckId;
    const otherUnderlying = (otherCheck?.details as Record<string, unknown>).underlyingCheckId;
    expect(otherUnderlying).toBe("command.candidate-impact-REQ-OTHER");
    expect(otherUnderlying).not.toBe(sharedUnderlying);
  });
});
