import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract, ValidationReport } from "../src/core/types.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { sha256Canonical } from "../src/core/digest.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { candidateImpactValidationRequirementsV1 } from "../src/architecture/candidateAssurance.js";
import { compileCandidateAssuranceV1 } from "../src/architecture/candidateAssurance.js";
import { resolveValidationRequirements } from "../src/architecture/validationRequirements.js";
import { runCandidateImpactValidations } from "../src/core/run.js";

const roots: string[] = [];
const contract: TaskContract = {
  version: 1,
  task: { id: "FAILURE-EVIDENCE", title: "failure evidence threading" },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/**
 * RED: a failing `unit-test` project-script must thread its bounded raw output
 * (assertion/selector/timeout snippet) into the candidate-impact lane evidence.
 * Before the fix the lane check only carries `failed with exit code 1` and drops
 * stdout/stderr, hiding the root cause behind a bare exit code.
 */
describe("candidate-impact lane preserves bounded failure output", () => {
  it("threads failing assertion output into lane details", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-failure-evidence-"));
    roots.push(root);
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "failure-evidence-fixture",
        version: "1.0.0",
        scripts: {
          test: `node -e "console.log('AssertionError: selector section.decision-request not found'); console.error('Timeout 30000ms exceeded waiting for #pair'); process.exit(1)"`,
        },
      }),
    );
    const sourceDigest = await computeWorktreeDigest(root);
    const candidate = createCandidateRevisionV1({
      operationId: "OP-FAILURE-EVIDENCE",
      candidateId: "CAND-FAILURE-EVIDENCE",
      revision: 1,
      sourceDigest,
    });
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
      patchDigest: sha256Canonical("failure-evidence-patch"),
      changedFiles: ["src/app.ts"],
      changeKinds: ["source"],
      reviewDimensions: ["behavior.correctness"],
      requiresIndependentReview: false,
      interpretation: "MODEL" as const,
      unknowns: [] as string[],
    };
    const impact = { ...body, digest: sha256Canonical(body) };
    const config: HarnessProjectConfig = {
      version: 1,
      project: { name: "failure-evidence-fixture" },
      evidence: { outputDir: ".harness/evidence" },
    };
    const requirements = candidateImpactValidationRequirementsV1(impact);
    expect(requirements.map((r) => r.kind)).toContain("unit-test");
    const resolution = await resolveValidationRequirements({ root, requirements, config, contract });
    const compilation = compileCandidateAssuranceV1({
      candidate,
      impact: impact as never,
      policy: {
        version: 1,
        digest: sha256Canonical("failure-evidence-policy"),
        minimumAssurance: "STANDARD",
        independentReviewRequired: false,
        minimumIndependentReviewers: 0,
        providerDiversity: false,
        allowedValidationKinds: ["unit-test"],
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
      metadata: { project: "failure-evidence-fixture", baseRef: "HEAD" },
    };
    const checks = await runCandidateImpactValidations({
      root,
      config,
      contract,
      report,
      impact: impact as never,
      compilation,
      resolution,
    });
    const check = checks.find((c) => c.id === "candidate.assurance.validation.impact-review-behavior-correctness");
    expect(check, JSON.stringify(checks)).toBeDefined();
    expect(check!.status).toBe("FAIL");
    const details = (check!.details ?? {}) as Record<string, unknown>;
    // Bounded raw output must be present — not just "exit code 1".
    const stdout = typeof details.underlyingStdout === "string" ? details.underlyingStdout : "";
    const stderr = typeof details.underlyingStderr === "string" ? details.underlyingStderr : "";
    expect(`${stdout}\n${stderr}`).toContain("section.decision-request");
    expect(details.underlyingExitCode).toBe(1);
    // Configured validator commands may embed inline credentials/secrets:
    // lane evidence must never copy the raw command.
    expect(details).not.toHaveProperty("underlyingCommand");
    expect(details).not.toHaveProperty("command");
  });
});
