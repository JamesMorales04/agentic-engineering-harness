import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract, ValidationReport } from "../../src/core/types.js";
import { computeWorktreeDigest } from "../../src/core/git.js";
import { sha256Canonical } from "../../src/core/digest.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import type { CandidateImpactV1 } from "../../src/candidates/assembler.js";
import { candidateImpactValidationRequirementsV1, compileCandidateAssuranceV1 } from "../../src/architecture/candidateAssurance.js";
import { resolveValidationRequirements, validationRequirementKindValues } from "../../src/architecture/validationRequirements.js";
import { requireProviderLaneEvidenceV1 } from "../../src/validation/laneEvidence.js";
import { runCandidateImpactValidations } from "../../src/core/run.js";

const config: HarnessProjectConfig = { version: 1, project: { name: "required-lane-fixture" }, evidence: { outputDir: ".harness/evidence" } };
const contract: TaskContract = { version: 1, task: { id: "S11-REQUIRED-LANE", title: "required lane evidence" } };
const roots: string[] = [];

const PROJECT_SCRIPTS = `node -e "require('node:fs').writeFileSync('project-script-ran.txt','1');process.exit(0)"`;

async function fixture(files: Record<string, string> = {}): Promise<{ root: string; candidate: CandidateRevisionV1 }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-required-lane-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "required-lane-fixture",
    version: "1.0.0",
    scripts: { e2e: PROJECT_SCRIPTS, visual: PROJECT_SCRIPTS, contract: PROJECT_SCRIPTS, integration: PROJECT_SCRIPTS }
  }));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  const sourceDigest = await computeWorktreeDigest(root);
  const candidate = createCandidateRevisionV1({ operationId: "OP-S11-REQUIRED-LANE", candidateId: "CAND-S11-REQUIRED-LANE", revision: 1, sourceDigest });
  return { root, candidate };
}

async function installFakePinnedPlaywright(root: string): Promise<void> {
  const executable = path.join(root, "node_modules", ".bin", "playwright");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) { process.stdout.write("Version 1.62.1-fixture\\n"); process.exit(0); }
const file = path.join(process.cwd(), ".harness", "evidence", "fake-playwright", "screenshot.png");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const report = { suites: [{ title: "fixture suite", specs: [{ title: "fixture spec", tests: [{ results: [{ status: "passed", attachments: [{ name: "screenshot", contentType: "image/png", path: file }] }] }] }] }] };
process.stdout.write(JSON.stringify(report));
`, "utf8");
  await fs.chmod(executable, 0o755);
}

function impactFor(candidate: CandidateRevisionV1, dimension: string): CandidateImpactV1 {
  const body = {
    version: 1 as const,
    candidate: { candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest },
    baseCandidate: { candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest },
    patchDigest: sha256Canonical("required-lane-patch"),
    changedFiles: ["src/app.ts"],
    changeKinds: ["source"],
    reviewDimensions: [dimension],
    requiresIndependentReview: true,
    interpretation: "MODEL" as const,
    unknowns: []
  };
  return { ...body, digest: sha256Canonical(body) };
}

async function dispatch(input: {
  root: string;
  candidate: CandidateRevisionV1;
  config: HarnessProjectConfig;
  dimension: string;
}): Promise<{ checks: Awaited<ReturnType<typeof runCandidateImpactValidations>>; impact: CandidateImpactV1 }> {
  const impact = impactFor(input.candidate, input.dimension);
  const requirements = candidateImpactValidationRequirementsV1(impact);
  const resolution = await resolveValidationRequirements({ root: input.root, requirements, config: input.config, contract, allowedKinds: validationRequirementKindValues });
  const compilation = compileCandidateAssuranceV1({
    candidate: input.candidate,
    impact,
    policy: {
      version: 1,
      digest: sha256Canonical("required-lane-policy"),
      minimumAssurance: "STANDARD",
      independentReviewRequired: false,
      minimumIndependentReviewers: 0,
      providerDiversity: false,
      allowedValidationKinds: [...validationRequirementKindValues],
      evidenceStrength: "STANDARD"
    },
    implementationIdentity: "implementer-1",
    risk: "low",
    reviewerCandidates: [{ identity: "reviewer-a", role: "Reviewer", provider: "provider-a", readOnly: true }],
    baseValidationRequirements: [],
    validationResolution: resolution,
    acceptanceAssertions: []
  });
  const report: ValidationReport = {
    version: 1,
    taskId: contract.task.id,
    status: "PASS",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    checks: [],
    changedFiles: ["src/app.ts"],
    candidate: input.candidate,
    metadata: { project: "required-lane-fixture", baseRef: "HEAD" }
  };
  const checks = await runCandidateImpactValidations({ root: input.root, config: input.config, contract, report, impact, compilation, resolution });
  return { checks, impact };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("required specialized lanes are satisfied only by matching provider execution", () => {
  for (const [dimension, slug, label] of [
    ["UI/browser", "ui-browser", "browser"],
    ["UI/visual", "ui-visual", "visual"],
    ["public API", "public-api", "contract"],
    ["operations", "operations", "integration"]
  ] as const) {
    it(`fails closed when a required ${label} requirement is executed by a project script that merely exits zero`, async () => {
      const { root, candidate } = await fixture();
      const { checks } = await dispatch({ root, candidate, config, dimension });
      const check = checks.find((item) => item.id === `candidate.assurance.validation.impact-review-${slug}`);
      expect(check, JSON.stringify(checks)).toBeDefined();
      expect(check!.status).toBe("FAIL");
      expect(check!.details?.blocker).toBe("PROVIDER_LANE_EVIDENCE_REQUIRED");
      expect(check!.message).toContain("PROVIDER_LANE_EVIDENCE_REQUIRED");
      await expect(fs.access(path.join(root, "project-script-ran.txt"))).resolves.toBeUndefined();
      const lane = label === "browser" ? "BROWSER" : label === "visual" ? "VISUAL" : label === "contract" ? "CONTRACT" : "INTEGRATION";
      await expect(requireProviderLaneEvidenceV1(root, config, lane, candidate, `command.candidate-impact-impact-review-${slug}`)).rejects.toThrow("PROVIDER_LANE_EVIDENCE_REQUIRED");
    });
  }

  it("passes the browser requirement when the approved Playwright provider executes and persists BROWSER evidence", async () => {
    const { root, candidate } = await fixture();
    await installFakePinnedPlaywright(root);
    const configured: HarnessProjectConfig = { ...config, validation: { providers: [{ id: "browser-provider", capability: "browser-test", provider: "playwright" }] } };
    const { checks } = await dispatch({ root, candidate, config: configured, dimension: "UI/browser" });
    const check = checks.find((item) => item.id === "candidate.assurance.validation.impact-review-ui-browser");
    expect(check, JSON.stringify(checks)).toBeDefined();
    expect(check!.status, JSON.stringify(check)).toBe("PASS");
    const evidence = await requireProviderLaneEvidenceV1(root, configured, "BROWSER", candidate, `candidate-impact-impact-review-ui-browser`);
    expect(evidence.provider.name).toBe("playwright");
    expect(evidence.artifacts.some((artifact) => artifact.kind === "screenshot")).toBe(true);
  });

  it("passes the visual requirement only with a bound baseline and comparison through the visual provider", async () => {
    const { root, candidate } = await fixture({
      "baseline.png": "committed-baseline-bytes",
      "visual-provider.mjs": `import fs from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst candidate = JSON.parse(process.env.AEH_VALIDATION_CANDIDATE_JSON);\nfs.mkdirSync('.harness/evidence', { recursive: true });\nfs.writeFileSync('.harness/evidence/provider-candidate.json', JSON.stringify(candidate));\nconst result = spawnSync('./node_modules/.bin/playwright', ['test'], { encoding: 'utf8' });\nprocess.stdout.write(result.stdout);\nprocess.stderr.write(result.stderr);\nprocess.exitCode = result.status ?? 1;\n`
    });
    await installFakePinnedPlaywright(root);
    const baseline = path.join(root, "baseline.png");
    const comparison = { tool: "playwright-toHaveScreenshot", name: "shot.png", options: { maxDiffPixelRatio: 0.05 } };
    const configured: HarnessProjectConfig = { ...config, validation: { providers: [{ id: "visual-provider", capability: "visual-test", provider: "playwright", command: "node visual-provider.mjs", options: { referenceBaseline: baseline, comparison } }] } };
    const { checks } = await dispatch({ root, candidate, config: configured, dimension: "UI/visual" });
    const check = checks.find((item) => item.id === "candidate.assurance.validation.impact-review-ui-visual");
    expect(check, JSON.stringify(checks)).toBeDefined();
    expect(check!.status, JSON.stringify(check)).toBe("PASS");
    const evidence = await requireProviderLaneEvidenceV1(root, configured, "VISUAL", candidate, "candidate-impact-impact-review-ui-visual");
    expect(evidence.comparison?.tool).toBe("playwright-toHaveScreenshot");
    expect(evidence.artifacts.some((artifact) => artifact.kind === "baseline")).toBe(true);
    expect(evidence.candidate).toMatchObject({ candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest });
    expect(JSON.parse(await fs.readFile(path.join(root, ".harness/evidence/provider-candidate.json"), "utf8"))).toMatchObject(candidate);
    const otherCandidate = createCandidateRevisionV1({ operationId: candidate.operationId, candidateId: "CAND-S11-OTHER", revision: candidate.revision, sourceDigest: candidate.sourceDigest });
    await expect(requireProviderLaneEvidenceV1(root, configured, "VISUAL", otherCandidate, "candidate-impact-impact-review-ui-visual")).rejects.toThrow("PROVIDER_LANE_EVIDENCE_REQUIRED");
  });

  it("passes the contract requirement through the real OpenAPI provider instead of a project script", async () => {
    const { root, candidate } = await fixture({
      "contracts/before.yaml": "openapi: 3.0.0\ninfo: { title: pets, version: \"1.0.0\" }\npaths:\n  /pets:\n    get:\n      responses:\n        \"200\": { description: ok }\n",
      "contracts/after.yaml": "openapi: 3.0.0\ninfo: { title: pets, version: \"1.1.0\" }\npaths:\n  /pets:\n    get:\n      responses:\n        \"200\": { description: ok }\n  /owners:\n    get:\n      responses:\n        \"200\": { description: ok }\n"
    });
    const configured: HarnessProjectConfig = { ...config, validation: { validators: [{ id: "openapi-compat", adapter: "openapi", required: true, options: { baseline: "contracts/before.yaml", current: "contracts/after.yaml" } }] } };
    const { checks } = await dispatch({ root, candidate, config: configured, dimension: "public API" });
    const check = checks.find((item) => item.id === "candidate.assurance.validation.impact-review-public-api");
    expect(check, JSON.stringify(checks)).toBeDefined();
    expect(check!.status, JSON.stringify(check)).toBe("PASS");
    const evidence = await requireProviderLaneEvidenceV1(root, configured, "CONTRACT", candidate, "openapi-compat");
    expect(evidence.provider.name).toBe("openapi");
  });

  it("passes the integration requirement through the real isolated-service lifecycle provider", async () => {
    const { root, candidate } = await fixture({ "lifecycle.mjs": "process.exit(0);\n" });
    const script = path.join(root, "lifecycle.mjs");
    const configured: HarnessProjectConfig = {
      ...config,
      validation: {
        validators: [{
          id: "integration-lifecycle",
          adapter: "integration-environment",
          required: true,
          options: {
            provider: "project-lifecycle",
            provisionCommand: `node ${script}`,
            readinessCommand: `node ${script}`,
            testCommand: `node ${script}`,
            cleanupCommand: `node ${script}`,
            network: "isolated",
            ephemeral: true
          }
        }]
      }
    };
    const { checks } = await dispatch({ root, candidate, config: configured, dimension: "operations" });
    const check = checks.find((item) => item.id === "candidate.assurance.validation.impact-review-operations");
    expect(check, JSON.stringify(checks)).toBeDefined();
    expect(check!.status, JSON.stringify(check)).toBe("PASS");
    const evidence = await requireProviderLaneEvidenceV1(root, configured, "INTEGRATION", candidate, "integration-lifecycle");
    expect(evidence.status).toBe("PASS");
  });
});
