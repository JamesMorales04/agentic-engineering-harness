import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract, ValidationCheck, ValidationReport } from "../../src/core/types.js";
import { computeWorktreeDigest } from "../../src/core/git.js";
import { sha256Canonical } from "../../src/core/digest.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import type { CandidateImpactV1 } from "../../src/candidates/assembler.js";
import { compileCandidateAssuranceV1 } from "../../src/architecture/candidateAssurance.js";
import { attributedReporterFailuresV1, evaluateTestAttributionV1, extractReporterTestsFromExecutionV1 } from "../../src/validation/testAttribution.js";
import { resolveValidationRequirements, validationRequirementKindValues } from "../../src/architecture/validationRequirements.js";
import { runCandidateImpactValidations } from "../../src/core/run.js";

const baseConfig: HarnessProjectConfig = {
  version: 1,
  project: { name: "test-attribution-fixture" },
  evidence: { outputDir: ".harness/evidence" },
};
const contract: TaskContract = {
  version: 1,
  task: { id: "TEST-ATTRIBUTION", title: "requirement test attribution" },
};
const roots: string[] = [];

async function fixture(): Promise<{ root: string; candidate: CandidateRevisionV1 }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-test-attribution-"));
  roots.push(root);
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "test-attribution-fixture", version: "1.0.0", scripts: {} }),
  );
  const sourceDigest = await computeWorktreeDigest(root);
  const candidate = createCandidateRevisionV1({
    operationId: "OP-TEST-ATTRIBUTION",
    candidateId: "CAND-TEST-ATTRIBUTION",
    revision: 1,
    sourceDigest,
  });
  return { root, candidate };
}

// Shared browser bundle: 2 passing specs + 1 failing spec, exits 1.
// Titles are generic (no product strings): alpha/beta pass, gamma fails.
async function installSharedBundlePlaywright(root: string): Promise<void> {
  const executable = path.join(root, "node_modules", ".bin", "playwright");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) { process.stdout.write("Version 1.62.1-fixture\\n"); process.exit(0); }
const file = path.join(process.cwd(), ".harness", "evidence", "fake-playwright", "screenshot.png");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const report = { suites: [{ title: "shared bundle", specs: [
  { title: "alpha passing journey", tests: [{ results: [{ status: "passed", attachments: [{ name: "screenshot", contentType: "image/png", path: file }] }] }] },
  { title: "beta passing journey", tests: [{ results: [{ status: "passed", attachments: [{ name: "screenshot", contentType: "image/png", path: file }] }] }] },
  { title: "gamma failing visual", tests: [{ results: [{ status: "failed", error: { message: "width drift 716 vs 769" }, attachments: [] }] }] }
]}] };
process.stdout.write(JSON.stringify(report));
process.exit(1);
`,
    "utf8",
  );
  await fs.chmod(executable, 0o755);
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
    patchDigest: sha256Canonical("test-attribution-patch"),
    changedFiles: ["src/app.ts"],
    changeKinds: ["source"],
    reviewDimensions: ["UI/browser"],
    requiresIndependentReview: false,
    interpretation: "MODEL" as const,
    unknowns: [],
  };
  return { ...body, digest: sha256Canonical(body) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("requirement test attribution for shared bundles (fail-closed)", () => {
  it("RED: shared 2/3-green bundle currently fails every requirement (signal fan-out)", async () => {
    const { root, candidate } = await fixture();
    await installSharedBundlePlaywright(root);
    const configured: HarnessProjectConfig = {
      ...baseConfig,
      validation: {
        providers: [{ id: "shared-browser", capability: "browser-test", provider: "playwright" }],
      },
    };
    const requirements = [
      {
        version: 1 as const,
        id: "REQ-PASS",
        property: "Passing journeys demonstrate behavior.",
        kind: "browser-test" as const,
        scope: ["src/app.ts"],
        evidenceNeeded: ["browser evidence for passing journeys."],
        requirementRefs: [],
        acceptanceRefs: [],
      },
      {
        version: 1 as const,
        id: "REQ-FAIL",
        property: "Failing visual demonstrates regression.",
        kind: "browser-test" as const,
        scope: ["src/app.ts"],
        evidenceNeeded: ["browser evidence for failing visual."],
        requirementRefs: [],
        acceptanceRefs: [],
      },
    ];
    const resolution = await resolveValidationRequirements({
      root,
      requirements,
      config: configured,
      contract,
      allowedKinds: validationRequirementKindValues,
    });
    // Both requirements resolve to the same approved provider (shared bundle).
    expect(resolution.actions.map((a) => a.selector)).toEqual(["shared-browser", "shared-browser"]);
    const impact = impactFor(candidate);
    const compilation = compileCandidateAssuranceV1({
      candidate,
      impact,
      policy: {
        version: 1,
        digest: sha256Canonical("test-attribution-policy"),
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
      metadata: { project: "test-attribution-fixture", baseRef: "HEAD" },
    };
    const checks = await runCandidateImpactValidations({
      root,
      config: configured,
      contract,
      report,
      impact,
      compilation,
      resolution,
      requirements,
    });
    const byId = new Map(checks.map((c) => [c.id, c]));
    // Current defective behavior: whole-bundle exit 1 fails every requirement,
    // even though alpha/beta tests passed in the reporter JSON.
    expect(byId.get("candidate.assurance.validation.REQ-PASS")?.status).toBe("FAIL");
    expect(byId.get("candidate.assurance.validation.REQ-FAIL")?.status).toBe("FAIL");
    expect(byId.get("candidate.assurance.validation.REQ-PASS")?.details?.underlyingStatus).toBe("FAIL");
  });

  it("GREEN: mapped-passing requirement PASSes its own evidence while mapped-failing and unmapped keep FAIL", async () => {
    const { root, candidate } = await fixture();
    await installSharedBundlePlaywright(root);
    const configured: HarnessProjectConfig = {
      ...baseConfig,
      validation: {
        providers: [{ id: "shared-browser", capability: "browser-test", provider: "playwright" }],
        testAttribution: {
          "REQ-PASS": ["alpha passing", "beta passing"],
          "REQ-FAIL": ["gamma failing"],
        },
      },
    };
    const requirements = [
      {
        version: 1 as const,
        id: "REQ-PASS",
        property: "Passing journeys demonstrate behavior.",
        kind: "browser-test" as const,
        scope: ["src/app.ts"],
        evidenceNeeded: ["browser evidence for passing journeys."],
        requirementRefs: [],
        acceptanceRefs: [],
      },
      {
        version: 1 as const,
        id: "REQ-FAIL",
        property: "Failing visual demonstrates regression.",
        kind: "browser-test" as const,
        scope: ["src/app.ts"],
        evidenceNeeded: ["browser evidence for failing visual."],
        requirementRefs: [],
        acceptanceRefs: [],
      },
      {
        version: 1 as const,
        id: "REQ-UNMAPPED",
        property: "Unmapped requirement keeps bundle verdict.",
        kind: "browser-test" as const,
        scope: ["src/app.ts"],
        evidenceNeeded: ["browser evidence."],
        requirementRefs: [],
        acceptanceRefs: [],
      },
    ];
    const resolution = await resolveValidationRequirements({
      root,
      requirements,
      config: configured,
      contract,
      allowedKinds: validationRequirementKindValues,
    });
    const impact = impactFor(candidate);
    const compilation = compileCandidateAssuranceV1({
      candidate,
      impact,
      policy: {
        version: 1,
        digest: sha256Canonical("test-attribution-policy"),
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
      metadata: { project: "test-attribution-fixture", baseRef: "HEAD" },
    };
    const checks = await runCandidateImpactValidations({
      root,
      config: configured,
      contract,
      report,
      impact,
      compilation,
      resolution,
      requirements,
    });
    const byId = new Map(checks.map((c) => [c.id, c]));
    // Refined partial-green rule: attributed alpha/beta tests pass per the
    // single authentic reporter and every reporter failure (gamma) is outside
    // the attributed set, so the mapped-passing requirement PASSes even
    // though the shared bundle exits nonzero. The bundle failure stays on the
    // honest record as underlying failure evidence.
    expect(byId.get("candidate.assurance.validation.REQ-PASS")?.status).toBe("PASS");
    expect(byId.get("candidate.assurance.validation.REQ-FAIL")?.status).toBe("FAIL");
    expect(byId.get("candidate.assurance.validation.REQ-UNMAPPED")?.status).toBe("FAIL");
    // Attribution evidence is recorded deterministically; nothing newly PASSes without evidence.
    const passDetails = byId.get("candidate.assurance.validation.REQ-PASS")?.details as Record<string, unknown>;
    expect(passDetails?.underlyingCheckId).toBeDefined();
    expect(passDetails?.underlyingStatus).toBe("FAIL");
    expect(passDetails?.testAttribution).toMatchObject({ verdict: "PASS" });
    expect(passDetails?.underlyingExitCode).toBe(1);
    expect(passDetails?.underlyingStdout).toBeDefined();
  });

  it("fail-closed: unknown titles, missing reporter, and parse errors FAIL (never SKIP/PASS)", async () => {
    const { root, candidate } = await fixture();
    await installSharedBundlePlaywright(root);
    const configured: HarnessProjectConfig = {
      ...baseConfig,
      validation: {
        providers: [{ id: "shared-browser", capability: "browser-test", provider: "playwright" }],
        testAttribution: {
          "REQ-UNKNOWN": ["no-such-test-title-xyz"],
        },
      },
    };
    const requirements = [
      {
        version: 1 as const,
        id: "REQ-UNKNOWN",
        property: "Unknown mapping must fail closed.",
        kind: "browser-test" as const,
        scope: ["src/app.ts"],
        evidenceNeeded: ["browser evidence."],
        requirementRefs: [],
        acceptanceRefs: [],
      },
    ];
    const resolution = await resolveValidationRequirements({
      root,
      requirements,
      config: configured,
      contract,
      allowedKinds: validationRequirementKindValues,
    });
    const impact = impactFor(candidate);
    const compilation = compileCandidateAssuranceV1({
      candidate,
      impact,
      policy: {
        version: 1,
        digest: sha256Canonical("test-attribution-policy"),
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
      metadata: { project: "test-attribution-fixture", baseRef: "HEAD" },
    };
    const checks = await runCandidateImpactValidations({
      root,
      config: configured,
      contract,
      report,
      impact,
      compilation,
      resolution,
      requirements,
    });
    expect(checks[0]?.status).toBe("FAIL");
    expect(String(checks[0]?.message ?? "")).toMatch(/TEST_ATTRIBUTION|unknown|no match/i);
  });

  it("supports requirement-declared testSelectors without config (planner surface)", async () => {
    const { root, candidate } = await fixture();
    await installSharedBundlePlaywright(root);
    const configured: HarnessProjectConfig = {
      ...baseConfig,
      validation: {
        providers: [{ id: "shared-browser", capability: "browser-test", provider: "playwright" }],
      },
    };
    const requirements = [
      {
        version: 1 as const,
        id: "REQ-DECLARED-PASS",
        property: "Declared passing selectors demonstrate behavior.",
        kind: "browser-test" as const,
        scope: ["src/app.ts"],
        evidenceNeeded: ["browser evidence."],
        requirementRefs: [],
        acceptanceRefs: [],
        testSelectors: ["alpha passing", "beta passing"],
      },
      {
        version: 1 as const,
        id: "REQ-DECLARED-FAIL",
        property: "Declared failing selectors fail closed.",
        kind: "browser-test" as const,
        scope: ["src/app.ts"],
        evidenceNeeded: ["browser evidence."],
        requirementRefs: [],
        acceptanceRefs: [],
        testSelectors: ["gamma failing"],
      },
    ];
    const resolution = await resolveValidationRequirements({
      root,
      requirements,
      config: configured,
      contract,
      allowedKinds: validationRequirementKindValues,
    });
    expect(resolution.actions).toHaveLength(2);
    const impact = impactFor(candidate);
    const compilation = compileCandidateAssuranceV1({
      candidate,
      impact,
      policy: {
        version: 1,
        digest: sha256Canonical("test-attribution-policy"),
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
      metadata: { project: "test-attribution-fixture", baseRef: "HEAD" },
    };
    const checks = await runCandidateImpactValidations({
      root,
      config: configured,
      contract,
      report,
      impact,
      compilation,
      resolution,
      requirements,
    });
    const byId = new Map(checks.map((c) => [c.id, c]));
    expect(byId.get("candidate.assurance.validation.REQ-DECLARED-PASS")?.status).toBe("PASS");
    expect(byId.get("candidate.assurance.validation.REQ-DECLARED-FAIL")?.status).toBe("FAIL");
  });

  it("unions requirement-declared and config-declared selectors (fail-closed, no narrowing)", async () => {
    const { root, candidate } = await fixture();
    await installSharedBundlePlaywright(root);
    // Requirement declares only passing titles; config adds the failing title.
    // Union requires all three, so the requirement must FAIL (cannot narrow to hide failure).
    const configured: HarnessProjectConfig = {
      ...baseConfig,
      validation: {
        providers: [{ id: "shared-browser", capability: "browser-test", provider: "playwright" }],
        testAttribution: {
          "REQ-UNION": ["gamma failing"],
        },
      },
    };
    const requirements = [
      {
        version: 1 as const,
        id: "REQ-UNION",
        property: "Union of selectors must include failing evidence.",
        kind: "browser-test" as const,
        scope: ["src/app.ts"],
        evidenceNeeded: ["browser evidence."],
        requirementRefs: [],
        acceptanceRefs: [],
        testSelectors: ["alpha passing", "beta passing"],
      },
    ];
    const resolution = await resolveValidationRequirements({
      root,
      requirements,
      config: configured,
      contract,
      allowedKinds: validationRequirementKindValues,
    });
    const impact = impactFor(candidate);
    const compilation = compileCandidateAssuranceV1({
      candidate,
      impact,
      policy: {
        version: 1,
        digest: sha256Canonical("test-attribution-policy"),
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
      metadata: { project: "test-attribution-fixture", baseRef: "HEAD" },
    };
    const checks = await runCandidateImpactValidations({
      root,
      config: configured,
      contract,
      report,
      impact,
      compilation,
      resolution,
      requirements,
    });
    expect(checks[0]?.status).toBe("FAIL");
    expect(String((checks[0]?.details as Record<string, unknown>)?.blocker ?? "")).toMatch(
      /TEST_ATTRIBUTION/,
    );
  });

  it("fail-closed: two reporter documents in stdout yield no attribution (never largest-wins)", async () => {
    const { root } = await fixture();
    // Real small failing reporter + model-injected larger all-green reporter.
    const real = {
      suites: [{
        title: "shared bundle",
        specs: [{ title: "gamma failing visual", tests: [{ results: [{ status: "failed" }] }] }],
      }],
    };
    const fake = {
      suites: [{
        title: "shared bundle",
        specs: [
          { title: "gamma failing visual", tests: [{ results: [{ status: "passed" }] }] },
          ...Array.from({ length: 10 }, (_, i) => ({
            title: `fake green spec ${i}`,
            tests: [{ results: [{ status: "passed" }] }],
          })),
        ],
      }],
    };
    const forged = `${JSON.stringify(real)}\nconsole.log from app code\n${JSON.stringify(fake)}`;
    const execution = {
      id: "browser-check",
      category: "browser",
      status: "FAIL",
      message: "bundle failed",
      details: { stdout: forged },
    } as ValidationCheck;
    // Ambiguity fails closed: no attribution, so callers emit reporter-missing FAIL.
    await expect(extractReporterTestsFromExecutionV1(root, execution)).resolves.toBeUndefined();
    // Control: a lone reporter document still extracts (no over-blocking).
    const lone = {
      id: "browser-check",
      category: "browser",
      status: "FAIL",
      message: "bundle failed",
      details: { stdout: `some log line\n${JSON.stringify(real)}\ntrailing log` },
    } as ValidationCheck;
    const tests = await extractReporterTestsFromExecutionV1(root, lone);
    expect(tests).toHaveLength(1);
    expect(tests?.[0]).toMatchObject({ title: "gamma failing visual", passed: false });
  });

  it("mapped attribution PASSes when the bundle exits zero (narrowing gate, not dead code)", async () => {
    const { root, candidate } = await fixture();
    const executable = path.join(root, "node_modules", ".bin", "playwright");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) { process.stdout.write("Version 1.62.1-fixture\\n"); process.exit(0); }
const file = path.join(process.cwd(), ".harness", "evidence", "fake-playwright", "screenshot.png");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const report = { suites: [{ title: "shared bundle", specs: [
  { title: "alpha passing journey", tests: [{ results: [{ status: "passed", attachments: [{ name: "screenshot", contentType: "image/png", path: file }] }] }] },
  { title: "beta passing journey", tests: [{ results: [{ status: "passed", attachments: [{ name: "screenshot", contentType: "image/png", path: file }] }] }] }
]}] };
process.stdout.write(JSON.stringify(report));
process.exit(0);
`,
      "utf8",
    );
    await fs.chmod(executable, 0o755);
    const configured: HarnessProjectConfig = {
      ...baseConfig,
      validation: {
        providers: [{ id: "shared-browser", capability: "browser-test", provider: "playwright" }],
        testAttribution: {
          "REQ-PASS": ["alpha passing"],
          "REQ-UNKNOWN": ["no-such-test-title-xyz"],
        },
      },
    };
    const requirements = [
      {
        version: 1 as const,
        id: "REQ-PASS",
        property: "Passing journey.",
        kind: "browser-test" as const,
        scope: ["src/app.ts"],
        evidenceNeeded: ["browser evidence."],
        requirementRefs: [],
        acceptanceRefs: [],
      },
      {
        version: 1 as const,
        id: "REQ-UNKNOWN",
        property: "Unknown mapping still fails closed on a green bundle.",
        kind: "browser-test" as const,
        scope: ["src/app.ts"],
        evidenceNeeded: ["browser evidence."],
        requirementRefs: [],
        acceptanceRefs: [],
      },
    ];
    const resolution = await resolveValidationRequirements({
      root,
      requirements,
      config: configured,
      contract,
      allowedKinds: validationRequirementKindValues,
    });
    const impact = impactFor(candidate);
    const compilation = compileCandidateAssuranceV1({
      candidate,
      impact,
      policy: {
        version: 1,
        digest: sha256Canonical("test-attribution-policy"),
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
      metadata: { project: "test-attribution-fixture", baseRef: "HEAD" },
    };
    const checks = await runCandidateImpactValidations({
      root,
      config: configured,
      contract,
      report,
      impact,
      compilation,
      resolution,
      requirements,
    });
    const byId = new Map(checks.map((c) => [c.id, c]));
    expect(byId.get("candidate.assurance.validation.REQ-PASS")?.status).toBe("PASS");
    expect(
      (byId.get("candidate.assurance.validation.REQ-PASS")?.details as Record<string, unknown>)?.underlyingStatus,
    ).toBe("PASS");
    expect(
      (byId.get("candidate.assurance.validation.REQ-PASS")?.details as Record<string, unknown>)?.testAttribution,
    ).toMatchObject({ verdict: "PASS" });
    expect(byId.get("candidate.assurance.validation.REQ-UNKNOWN")?.status).toBe("FAIL");
  });

  it("partial-green gate reads the reporter's own failure list, never bundle stderr text", () => {
    const tests = [
      { title: "alpha passing journey", fullTitle: "shared bundle > alpha passing journey", status: "passed", passed: true },
      { title: "gamma failing visual", fullTitle: "shared bundle > gamma failing visual", status: "failed", passed: false },
    ];
    // Unrelated gamma failure is outside the alpha/beta attribution: empty.
    expect(attributedReporterFailuresV1({ selectors: ["alpha passing", "beta passing"], tests })).toEqual([]);
    // The same failure is inside a gamma attribution: returned as-is.
    expect(
      attributedReporterFailuresV1({ selectors: ["gamma failing"], tests }).map((t) => t.title),
    ).toEqual(["gamma failing visual"]);
  });

  it("boundary-safe matching: S1 does not match S11, S11 matches, S9-journey matches space variant", () => {
    const tests = [
      { title: "S11-title", fullTitle: "suite > S11-title", status: "passed", passed: true },
      { title: "S9 journey title", fullTitle: "suite > S9 journey title", status: "passed", passed: true },
    ];
    const s1 = evaluateTestAttributionV1({ requirementId: "REQ-S1", selectors: ["S1"], tests });
    expect(s1.matched).toBe(0);
    expect(s1.verdict).toBe("FAIL");
    const s11 = evaluateTestAttributionV1({ requirementId: "REQ-S11", selectors: ["S11"], tests });
    expect(s11.matched).toBe(1);
    expect(s11.verdict).toBe("PASS");
    const s9 = evaluateTestAttributionV1({ requirementId: "REQ-S9", selectors: ["S9-journey"], tests });
    expect(s9.matched).toBe(1);
    expect(s9.verdict).toBe("PASS");
  });
});
