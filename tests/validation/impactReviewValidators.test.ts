import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../../src/core/config.js";
import { computeWorktreeDigest } from "../../src/core/git.js";
import type { HarnessProjectConfig, TaskContract } from "../../src/core/types.js";
import { resolveValidationRequirements, validationRequirementKindValues } from "../../src/architecture/validationRequirements.js";
import { candidateImpactValidationRequirementsV1, compileCandidateAssuranceV1 } from "../../src/architecture/candidateAssurance.js";
import { runCandidateImpactValidations } from "../../src/core/run.js";
import { sha256Canonical } from "../../src/core/digest.js";
import { requireSastEvidenceV1 } from "../../src/security/sastEvidence.js";
import { runConfiguredValidators } from "../../src/validators/registry.js";
import { runExternalToolValidator } from "../../src/validators/external.js";
import { createCandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import { providerVersions, readRulesetPins, verifyRulesetPins } from "../../scripts/security/toolPin.mjs";
import { loadProviderLaneEvidenceV1, requireProviderLaneEvidenceV1, verifyProviderLaneEvidenceV1 } from "../../src/validation/laneEvidence.js";

const REPO_ROOT = path.resolve(process.cwd());
const WRAPPERS = {
  opengrep: path.join(REPO_ROOT, "scripts", "security", "opengrep.mjs"),
  trivyVuln: path.join(REPO_ROOT, "scripts", "security", "trivy-vuln.mjs"),
  trivySecret: path.join(REPO_ROOT, "scripts", "security", "trivy-secret-misconfig.mjs")
};
const ARCHITECTURE = path.join(REPO_ROOT, "scripts", "architecture.mjs");
const PUBLIC_API_CONTRACT = path.join(REPO_ROOT, "scripts", "publicApiContract.mjs");

const realTools = process.env.AEH_RUN_REAL_PROVIDERS === "1";
const describeReal = realTools ? describe : describe.skip;

const roots: string[] = [];
const stubDirs: string[] = [];
const savedPath = process.env.PATH ?? "";
const savedPins = process.env.AEH_OPENGREP_PINS;
const savedVersions = process.env.AEH_PROVIDER_VERSIONS;
const savedBinaries = { opengrep: process.env.AEH_OPENGREP_BINARY, trivy: process.env.AEH_TRIVY_BINARY };

beforeEach(() => {
  process.env.PATH = savedPath;
  delete process.env.AEH_OPENGREP_BINARY;
  delete process.env.AEH_TRIVY_BINARY;
  delete process.env.AEH_OPENGREP_PINS;
  delete process.env.AEH_PROVIDER_VERSIONS;
});

afterEach(async () => {
  process.env.PATH = savedPath;
  if (savedPins === undefined) delete process.env.AEH_OPENGREP_PINS; else process.env.AEH_OPENGREP_PINS = savedPins;
  if (savedVersions === undefined) delete process.env.AEH_PROVIDER_VERSIONS; else process.env.AEH_PROVIDER_VERSIONS = savedVersions;
  if (savedBinaries.opengrep === undefined) delete process.env.AEH_OPENGREP_BINARY; else process.env.AEH_OPENGREP_BINARY = savedBinaries.opengrep;
  if (savedBinaries.trivy === undefined) delete process.env.AEH_TRIVY_BINARY; else process.env.AEH_TRIVY_BINARY = savedBinaries.trivy;
  stubDirs.splice(0);
  const { clearToolchainEnvCache } = await import("../../src/utils/process.js");
  clearToolchainEnvCache();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-impact-review-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "impact-review-fixture", version: "1.0.0", scripts: {} }));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  return root;
}

/** Hermetic stub tool binary: answers --version and emits canned scan JSON on stdout. */
async function stubBinary(name: string, versionLine: string, scanJson: string, scanExit = 0): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `aeh-stub-${name}-`));
  roots.push(dir);
  stubDirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, `#!/usr/bin/env node
if (process.argv.includes("--version")) { process.stdout.write(${JSON.stringify(versionLine)} + "\\n"); process.exit(0); }
process.stdout.write(${JSON.stringify(scanJson)});
process.exit(${scanExit});
`, "utf8");
  await fs.chmod(file, 0o755);
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
  return file;
}

/**
 * Hermetic migration: ambient PATH no longer reaches managed children, so
 * stub dirs created above must be pinned via toolchain state on the fixture
 * root before running validators through the Harness execution path (plus the
 * node dir: stubs and `node <wrapper>` invocations resolve on
 * `#!/usr/bin/env node`). Stale/missing state migrates the same way: run
 * `aeh setup`, then retry. Call after stubBinary, before computeWorktreeDigest
 * so the pinned state is part of the fixture digest consistently.
 */
async function pinStubs(root: string): Promise<void> {
  const { clearToolchainEnvCache } = await import("../../src/utils/process.js");
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".harness", "toolchain.state.json"),
    JSON.stringify({ version: 1, binPaths: [path.dirname(process.execPath), ...stubDirs] })
  );
  clearToolchainEnvCache();
}

const OPENGRP_ZERO = JSON.stringify({ version: "1.22.0", results: [], errors: [] });
const OPENGRP_FINDING = JSON.stringify({
  version: "1.22.0",
  results: [{
    check_id: "policies.opengrep.rules.aeh-no-eval",
    path: "src/bad.js",
    start: { line: 1, col: 1 },
    end: { line: 1, col: 10 },
    extra: { message: "AEH forbids eval().", severity: "ERROR", metadata: { category: "security", cwe: ["CWE-95"] } }
  }],
  errors: []
});
const TRIVY_ZERO = JSON.stringify({ SchemaVersion: 2, Trivy: { Version: "0.70.0" }, ArtifactName: ".", ArtifactType: "filesystem", Results: [] });
const TRIVY_VULN = JSON.stringify({
  SchemaVersion: 2,
  Trivy: { Version: "0.70.0" },
  ArtifactName: ".",
  ArtifactType: "filesystem",
  Results: [{
    Target: "package-lock.json",
    Class: "lang-pkgs",
    Type: "npm",
    Vulnerabilities: [{ VulnerabilityID: "CVE-STUB-1", PkgName: "stub-pkg", InstalledVersion: "1.0.0", FixedVersion: "1.0.1", Severity: "HIGH", Title: "stub vulnerability" }]
  }]
});

function runWrapper(wrapper: string, cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [wrapper], { cwd, encoding: "utf8", timeout: 120_000 });
  return { status: result.status ?? 2, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function validatorContext(root: string, spec: { id: string; adapter: string; command: string }) {
  const config: HarnessProjectConfig = { version: 1, project: { name: "impact-review-fixture" }, evidence: { outputDir: ".harness/evidence" } };
  const contract: TaskContract = { version: 1, task: { id: "IMPACT-REVIEW-1", title: "impact review fixture" } };
  return { root, config, contract, spec: { ...spec, required: true }, baseRef: "HEAD", changedFiles: [] as string[] };
}

describe("impact-review validator wrappers (hermetic tool stubs)", () => {
  it("runs the pinned opengrep wrapper and forwards exact tool JSON", async () => {
    const root = await fixture({ "src/clean.js": "const a = 1;\n" });
    await stubBinary("opengrep", "1.22.0", OPENGRP_ZERO);
    const run = runWrapper(WRAPPERS.opengrep, root);
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("ruleset aeh-opengrep-ruleset v1.0.0");
    const parsed = JSON.parse(run.stdout);
    expect(parsed.version).toBe("1.22.0");
    expect(parsed.results).toEqual([]);
  }, 120_000);

  it("fails closed when the opengrep binary version drifts from the pin", async () => {
    const root = await fixture({ "src/clean.js": "const a = 1;\n" });
    await stubBinary("opengrep", "1.10.0", OPENGRP_ZERO);
    const run = runWrapper(WRAPPERS.opengrep, root);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("TOOL_VERSION_MISMATCH");
    expect(run.stderr).toContain("1.22.0");
  });

  it("fails closed when no opengrep binary is resolvable", async () => {
    const root = await fixture({ "src/clean.js": "const a = 1;\n" });
    process.env.PATH = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-empty-path-")).then((dir) => (roots.push(dir), dir));
    const run = runWrapper(WRAPPERS.opengrep, root);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("TOOL_UNAVAILABLE");
  });

  it("fails closed when the ruleset digest does not match pins", async () => {
    const root = await fixture({ "src/clean.js": "const a = 1;\n" });
    await stubBinary("opengrep", "1.22.0", OPENGRP_ZERO);
    const pinsDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-tampered-pins-"));
    roots.push(pinsDir);
    await fs.cp(path.join(REPO_ROOT, "policies", "opengrep"), pinsDir, { recursive: true });
    await fs.appendFile(path.join(pinsDir, "rules", "aeh-v1.yml"), "\n# tampered\n");
    process.env.AEH_OPENGREP_PINS = path.join(pinsDir, "pins.json");
    const run = runWrapper(WRAPPERS.opengrep, root);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("RULESET_DIGEST_MISMATCH");
  });

  it("fails closed when the candidate tree has no scannable source scope", async () => {
    const root = await fixture();
    await stubBinary("opengrep", "1.22.0", OPENGRP_ZERO);
    const run = runWrapper(WRAPPERS.opengrep, root);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("SCAN_SCOPE_EMPTY");
  });

  it("keeps the committed ruleset pins self-consistent with the authoritative tool pin", () => {
    const versions = providerVersions(REPO_ROOT);
    const { pins, pinsDir } = readRulesetPins(REPO_ROOT);
    expect(pins.tool).toBe(versions.opengrep);
    expect(() => verifyRulesetPins(pinsDir, pins)).not.toThrow();
  });

  it("runs the pinned trivy vulnerability wrapper and forwards exact tool JSON", async () => {
    const root = await fixture();
    await stubBinary("trivy", "Version: 0.70.0", TRIVY_ZERO);
    const run = runWrapper(WRAPPERS.trivyVuln, root);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.Trivy.Version).toBe("0.70.0");
    expect(parsed.Results).toEqual([]);
  });

  it("fails closed when the trivy binary version drifts from the pin", async () => {
    const root = await fixture();
    await stubBinary("trivy", "Version: 0.60.0", TRIVY_ZERO);
    for (const wrapper of [WRAPPERS.trivyVuln, WRAPPERS.trivySecret]) {
      const run = runWrapper(wrapper, root);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("TOOL_VERSION_MISMATCH");
    }
  });

  it("fails closed when the reported version merely extends the pin (substring bypass)", async () => {
    const root = await fixture({ "src/clean.js": "const a = 1;\n" });
    await stubBinary("opengrep", "1.22.0-unpinned", OPENGRP_ZERO);
    const opengrepRun = runWrapper(WRAPPERS.opengrep, root);
    expect(opengrepRun.status).not.toBe(0);
    expect(opengrepRun.stderr).toContain("TOOL_VERSION_MISMATCH");
    await stubBinary("trivy", "Version: 0.70.0-unpinned", TRIVY_ZERO);
    for (const wrapper of [WRAPPERS.trivyVuln, WRAPPERS.trivySecret]) {
      const run = runWrapper(wrapper, root);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("TOOL_VERSION_MISMATCH");
    }
  });

  it("fails closed when no trivy binary is resolvable", async () => {
    const root = await fixture();
    process.env.PATH = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-empty-path-")).then((dir) => (roots.push(dir), dir));
    const run = runWrapper(WRAPPERS.trivyVuln, root);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("TOOL_UNAVAILABLE");
  });
});

describe("impact-review validators through the Harness execution path", () => {
  it("passes a clean tree through the opengrep validator with zero normalized findings", async () => {
    const root = await fixture({ "src/clean.js": "const a = 1;\n" });
    await stubBinary("opengrep", "1.22.0", OPENGRP_ZERO);
    await pinStubs(root);
    const check = await runExternalToolValidator(validatorContext(root, { id: "static-security", adapter: "opengrep", command: `node ${WRAPPERS.opengrep}` }));
    expect(check.status).toBe("PASS");
    expect(check.details?.findingCount).toBe(0);
  });

  it("does not weaken: an opengrep finding still fails the validator", async () => {
    const root = await fixture({ "src/bad.js": "eval('x');\n" });
    await stubBinary("opengrep", "1.22.0", OPENGRP_FINDING);
    await pinStubs(root);
    const check = await runExternalToolValidator(validatorContext(root, { id: "static-security", adapter: "opengrep", command: `node ${WRAPPERS.opengrep}` }));
    expect(check.status).toBe("FAIL");
    expect(check.details?.findingCount).toBe(1);
    const findings = check.details?.findings as Array<{ tool: string; rule?: string }>;
    expect(findings[0]?.tool).toBe("opengrep");
    expect(findings[0]?.rule).toContain("aeh-no-eval");
  });

  it("does not weaken: a trivy vulnerability finding still fails the validator", async () => {
    const root = await fixture();
    await stubBinary("trivy", "Version: 0.70.0", TRIVY_VULN, 1);
    await pinStubs(root);
    const check = await runExternalToolValidator(validatorContext(root, { id: "dependency-security", adapter: "trivy", command: `node ${WRAPPERS.trivyVuln}` }));
    expect(check.status).toBe("FAIL");
    expect(check.details?.findingCount).toBe(1);
  });

  it("persists candidate-bound SAST evidence with exact tool versions", async () => {
    const root = await fixture({ "src/clean.js": "const a = 1;\n" });
    await stubBinary("opengrep", "1.22.0", OPENGRP_ZERO);
    await pinStubs(root);
    const sourceDigest = await computeWorktreeDigest(root);
    const candidate = createCandidateRevisionV1({ operationId: "OP-IMPACT-REVIEW", candidateId: "CAND-IMPACT-REVIEW", revision: 1, sourceDigest });
    const config: HarnessProjectConfig = {
      version: 1,
      project: { name: "impact-review-fixture" },
      evidence: { outputDir: ".harness/evidence" },
      validation: { validators: [{ id: "static-security", adapter: "opengrep", command: `node ${WRAPPERS.opengrep}`, required: true }] }
    };
    const contract: TaskContract = { version: 1, task: { id: "IMPACT-REVIEW-SAST", title: "sast evidence" } };
    const checks = await runConfiguredValidators(root, config, contract, "HEAD", [], { candidate });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("PASS");
    const evidence = await requireSastEvidenceV1(root, config, candidate, "static-security");
    expect(evidence.tool).toMatchObject({ name: "opengrep", version: "1.22.0" });
    expect(evidence.findingCount).toBe(0);
    expect(evidence.candidate).toMatchObject({ candidateId: candidate.candidateId, revision: candidate.revision });
  });

  it("persists candidate-bound trivy evidence with the exact pinned version", async () => {
    const root = await fixture();
    await stubBinary("trivy", "Version: 0.70.0", TRIVY_ZERO);
    await pinStubs(root);
    const sourceDigest = await computeWorktreeDigest(root);
    const candidate = createCandidateRevisionV1({ operationId: "OP-IMPACT-TRIVY", candidateId: "CAND-IMPACT-TRIVY", revision: 1, sourceDigest });
    const config: HarnessProjectConfig = {
      version: 1,
      project: { name: "impact-review-fixture" },
      evidence: { outputDir: ".harness/evidence" },
      validation: { validators: [{ id: "trivy-vuln", adapter: "trivy", command: `node ${WRAPPERS.trivyVuln}`, required: true }] }
    };
    const contract: TaskContract = { version: 1, task: { id: "IMPACT-REVIEW-TRIVY", title: "trivy evidence" } };
    const checks = await runConfiguredValidators(root, config, contract, "HEAD", [], { candidate });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("PASS");
    const evidence = await requireSastEvidenceV1(root, config, candidate, "trivy-vuln");
    expect(evidence.tool).toMatchObject({ name: "trivy", version: "0.70.0" });
  });

  it("executes the generic dependency dimension through the approved trivy provider with SAST evidence", async () => {
    const root = await fixture();
    await stubBinary("trivy", "Version: 0.70.0", TRIVY_ZERO);
    await pinStubs(root);
    const sourceDigest = await computeWorktreeDigest(root);
    const candidate = createCandidateRevisionV1({ operationId: "OP-IMPACT-PROVIDER", candidateId: "CAND-IMPACT-PROVIDER", revision: 1, sourceDigest });
    const config: HarnessProjectConfig = {
      version: 1,
      project: { name: "impact-review-fixture" },
      evidence: { outputDir: ".harness/evidence" },
      validation: {
        validators: [
          { id: "static-security", adapter: "opengrep", command: `node ${WRAPPERS.opengrep}`, required: true },
          { id: "trivy-vuln", adapter: "trivy", command: `node ${WRAPPERS.trivyVuln}`, required: true },
          { id: "trivy-secret-misconfig", adapter: "trivy", command: `node ${WRAPPERS.trivySecret}`, required: true }
        ],
        providers: [{ id: "trivy-dependency-security", capability: "dependency-security", provider: "trivy", command: `node ${WRAPPERS.trivyVuln}` }]
      }
    };
    const contract: TaskContract = { version: 1, task: { id: "IMPACT-REVIEW-PROVIDER", title: "provider path" } };
    const impactBody = {
      version: 1 as const,
      candidate: { candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest },
      baseCandidate: { candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest },
      patchDigest: sha256Canonical("impact-provider-patch"),
      changedFiles: ["package-lock.json"],
      changeKinds: ["dependency"],
      reviewDimensions: ["dependency/supply chain"],
      requiresIndependentReview: false,
      interpretation: "MODEL" as const,
      unknowns: [] as string[]
    };
    const impact = { ...impactBody, digest: sha256Canonical(impactBody) };
    const requirements = candidateImpactValidationRequirementsV1(impact);
    expect(requirements).toMatchObject([{ id: "impact-review-dependency-supply-chain", kind: "dependency-security" }]);
    const resolution = await resolveValidationRequirements({ root, requirements, config, contract, allowedKinds: validationRequirementKindValues });
    expect(resolution.actions).toMatchObject([{ requirementId: "impact-review-dependency-supply-chain", source: "approved-provider", selector: "trivy-dependency-security" }]);
    const compilation = compileCandidateAssuranceV1({
      candidate,
      impact,
      policy: {
        version: 1,
        digest: sha256Canonical("impact-provider-policy"),
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
    expect(compilation.status).toBe("READY");
    const report = {
      version: 1,
      taskId: contract.task.id,
      status: "PASS",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      checks: [],
      changedFiles: ["package-lock.json"],
      candidate,
      metadata: { project: "impact-review-fixture", baseRef: "HEAD" }
    } as Parameters<typeof runCandidateImpactValidations>[0]["report"];
    const checks = await runCandidateImpactValidations({ root, config, contract, report, impact, compilation, resolution });
    expect(checks).toMatchObject([{ id: "candidate.assurance.validation.impact-review-dependency-supply-chain", status: "PASS" }]);
    const evidence = await requireSastEvidenceV1(root, config, candidate, "candidate-impact-impact-review-dependency-supply-chain");
    expect(evidence.tool).toMatchObject({ name: "trivy", version: "0.70.0" });
  });
});

describe("impact-review validation resolution order", () => {
  const overlayLikeConfig = {
    version: 1,
    project: { name: "impact-review-resolution" },
    validation: {
      commands: [{ id: "architecture", command: "node scripts/architecture.mjs", required: true }],
      validators: [
        { id: "static-security", adapter: "opengrep", command: "node scripts/security/opengrep.mjs", required: true },
        { id: "contract-test", adapter: "contract-test", command: "node scripts/publicApiContract.mjs", required: true },
        { id: "trivy-vuln", adapter: "trivy", command: "node scripts/security/trivy-vuln.mjs", required: true },
        { id: "trivy-secret-misconfig", adapter: "trivy", command: "node scripts/security/trivy-secret-misconfig.mjs", required: true }
      ],
      providers: [
        { id: "trivy-dependency-security", capability: "dependency-security", provider: "trivy", command: "node scripts/security/trivy-vuln.mjs" }
      ]
    }
  } as HarnessProjectConfig;

  function requirement(id: string, kind: (typeof validationRequirementKindValues)[number]) {
    return { version: 1 as const, id, property: `${id} must be validated.`, kind, scope: ["**"], evidenceNeeded: [`${kind} evidence.`], requirementRefs: [], acceptanceRefs: [] };
  }

  it("resolves architecture through the configured command before any fallback", async () => {
    const root = await fixture();
    const resolution = await resolveValidationRequirements({ root, requirements: [requirement("impact-review-architecture", "architecture")], config: overlayLikeConfig });
    expect(resolution.blocked).toEqual([]);
    expect(resolution.actions).toMatchObject([{ requirementId: "impact-review-architecture", source: "configured-command", selector: "architecture", kind: "architecture" }]);
  });

  it("resolves static-security through its configured validator and dependency-security through the approved trivy provider", async () => {
    const root = await fixture();
    const resolution = await resolveValidationRequirements({
      root,
      requirements: [requirement("impact-review-security", "static-security"), requirement("impact-review-dependency-supply-chain", "dependency-security")],
      config: overlayLikeConfig
    });
    expect(resolution.blocked).toEqual([]);
    expect(resolution.actions).toMatchObject([
      { requirementId: "impact-review-security", source: "configured-validator", selector: "static-security", kind: "static-security" },
      { requirementId: "impact-review-dependency-supply-chain", source: "approved-provider", selector: "trivy-dependency-security", kind: "dependency-security", provider: "trivy" }
    ]);
  });

  it("resolves explicit trivy dimensions to their own configured validators", async () => {
    const root = await fixture();
    const resolution = await resolveValidationRequirements({
      root,
      requirements: [requirement("trivy-vuln", "dependency-security"), requirement("trivy-secret-misconfig", "dependency-security")],
      config: overlayLikeConfig
    });
    expect(resolution.blocked).toEqual([]);
    expect(resolution.actions).toMatchObject([
      { requirementId: "trivy-vuln", source: "configured-validator", selector: "trivy-vuln", kind: "dependency-security" },
      { requirementId: "trivy-secret-misconfig", source: "configured-validator", selector: "trivy-secret-misconfig", kind: "dependency-security" }
    ]);
  });

  it("resolves the public-api contract-test dimension through its configured validator instead of BLOCKED", async () => {
    const root = await fixture();
    const resolution = await resolveValidationRequirements({
      root,
      requirements: [requirement("impact-review-public-api", "contract-test")],
      config: overlayLikeConfig
    });
    expect(resolution.blocked).toEqual([]);
    expect(resolution.actions).toMatchObject([
      { requirementId: "impact-review-public-api", source: "configured-validator", selector: "contract-test", kind: "contract-test" }
    ]);
  });

  it("resolves the UI/browser dimension through the configured s9 browser provider instead of BLOCKED", async () => {
    const config = await loadProjectConfig(REPO_ROOT);
    const declared = config.validation?.providers?.find((provider) => provider.id === "s9-browser-playwright");
    expect(declared).toMatchObject({ capability: "browser-test", provider: "playwright", timeoutSeconds: 900 });
    expect(String(declared?.command)).toContain("--grep");
    expect(String(declared?.command)).toContain("S9 browser");
    expect(String(declared?.command)).toContain("--reporter=json");
    // Build output must stay out of stdout so the Playwright JSON report stays pure.
    expect(String(declared?.command)).toContain("1>&2");
    const root = await fixture();
    const resolution = await resolveValidationRequirements({
      root,
      requirements: [requirement("impact-review-ui-browser", "browser-test")],
      config
    });
    expect(resolution.blocked).toEqual([]);
    expect(resolution.actions).toMatchObject([
      { requirementId: "impact-review-ui-browser", source: "approved-provider", selector: "s9-browser-playwright", kind: "browser-test" }
    ]);
  });

  it("keeps the UI/browser dimension blocked when the browser provider is missing", async () => {
    const root = await fixture();
    const resolution = await resolveValidationRequirements({
      root,
      requirements: [requirement("impact-review-ui-browser", "browser-test")],
      config: { version: 1, project: { name: "empty" } }
    });
    expect(resolution.actions).toEqual([]);
    expect(resolution.blocked).toContainEqual(expect.objectContaining({ requirementId: "impact-review-ui-browser" }));
  });

  it("ignores Planner-named commands and keeps unresolvable kinds blocked", async () => {
    const root = await fixture();
    const resolution = await resolveValidationRequirements({
      root,
      requirements: [requirement("planner-named-check", "policy")],
      config: { version: 1, project: { name: "empty" } }
    });
    expect(resolution.actions).toEqual([]);
    expect(resolution.blocked).toContainEqual(expect.objectContaining({ requirementId: "planner-named-check" }));
  });

  it("provisions the overlay inventory for this checkout without weakening gates", async () => {
    const config = await loadProjectConfig(REPO_ROOT);
    const commands = config.validation?.commands ?? [];
    const validators = config.validation?.validators ?? [];
    expect(commands).toContainEqual(expect.objectContaining({ id: "architecture", command: "node scripts/architecture.mjs", required: true }));
    expect(commands).toContainEqual(expect.objectContaining({ id: "npm-check", required: true }));
    expect(validators).toContainEqual(expect.objectContaining({ id: "static-security", adapter: "opengrep", command: "node scripts/security/opengrep.mjs", required: true }));
    expect(validators).toContainEqual(expect.objectContaining({ id: "contract-test", adapter: "contract-test", command: "node scripts/publicApiContract.mjs", required: true }));
    expect(validators).toContainEqual(expect.objectContaining({ id: "trivy-vuln", adapter: "trivy", command: "node scripts/security/trivy-vuln.mjs", required: true }));
    expect(validators).toContainEqual(expect.objectContaining({ id: "trivy-secret-misconfig", adapter: "trivy", command: "node scripts/security/trivy-secret-misconfig.mjs", required: true }));
    const providers = config.validation?.providers ?? [];
    expect(providers).toContainEqual(expect.objectContaining({ id: "trivy-dependency-security", capability: "dependency-security", provider: "trivy", command: "node scripts/security/trivy-vuln.mjs" }));
    expect(providers).toContainEqual(expect.objectContaining({ id: "s11-visual-playwright", capability: "visual-test", provider: "playwright" }));
    expect(providers).toContainEqual(expect.objectContaining({ id: "s9-browser-playwright", capability: "browser-test", provider: "playwright" }));
    expect(config.security?.tools).toEqual(expect.arrayContaining(["opengrep", "trivy"]));
  });
});

describe("project architecture validator", () => {
  it("passes on the current checkout", () => {
    const run = spawnSync(process.execPath, [ARCHITECTURE, REPO_ROOT], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^ARCHITECTURE_PASS \d+ checks \(tool=node .* ruleset=aeh-architecture-v1\)\./);
  });

  it("fails closed on an incomplete tree", async () => {
    const root = await fixture();
    const run = spawnSync(process.execPath, [ARCHITECTURE, root], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("ARCHITECTURE_FAILED");
  });

  async function skeleton(): Promise<string> {
    const root = await fixture();
    await fs.mkdir(path.join(root, "src", "architecture"), { recursive: true });
    await fs.mkdir(path.join(root, "src", "projects"), { recursive: true });
    await fs.mkdir(path.join(root, "src", "control-center"), { recursive: true });
    await fs.mkdir(path.join(root, "templates"), { recursive: true });
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.mkdir(path.join(root, "policies", "opengrep"), { recursive: true });
    for (const file of ["src/architecture/candidateAssurance.ts", "src/architecture/validationRequirements.ts", "src/entry.ts", "src/projects/registry.ts", "src/control-center/server.ts", "package.json", "templates/provider-versions.json", "templates/toolchain.yaml", ".harness/toolchain.yaml", "policies/opengrep/pins.json"]) {
      await fs.writeFile(path.join(root, file), await fs.readFile(path.join(REPO_ROOT, file), "utf8"), "utf8");
    }
    return root;
  }

  it("does not weaken: a removed review dimension still fails", async () => {
    const root = await skeleton();
    const file = path.join(root, "src", "architecture", "candidateAssurance.ts");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace('\n  "architecture",', "\n"), "utf8");
    const run = spawnSync(process.execPath, [ARCHITECTURE, root], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("ARCH-DIMENSION-VOCABULARY");
  });

  it("does not weaken: a forbidden deterministic-core import still fails", async () => {
    const root = await skeleton();
    const file = path.join(root, "src", "architecture", "validationRequirements.ts");
    await fs.writeFile(file, `${await fs.readFile(file, "utf8")}\nimport type { AgentExecutionSelection } from "../agents/types.js";\n`, "utf8");
    const run = spawnSync(process.execPath, [ARCHITECTURE, root], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("ARCH-DETERMINISTIC-CORE-INDEPENDENCE");
  });

  it("does not weaken: a removed fallback script still fails", async () => {
    const root = await skeleton();
    const file = path.join(root, "package.json");
    const pkg = JSON.parse(await fs.readFile(file, "utf8")) as { scripts: Record<string, string> };
    delete pkg.scripts["check:architecture"];
    await fs.writeFile(file, JSON.stringify(pkg, null, 2), "utf8");
    const run = spawnSync(process.execPath, [ARCHITECTURE, root], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("ARCH-RESOLVER-FALLBACK-COVERAGE");
  });
});

describe("project public-api contract validator", () => {
  it("passes on the current checkout with versioned output", () => {
    const run = spawnSync(process.execPath, [PUBLIC_API_CONTRACT, REPO_ROOT], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^PUBLIC_API_CONTRACT_PASS \d+ checks \(tool=node .* ruleset=aeh-public-api-contract-v1\)\./);
  });

  it("fails closed on an incomplete tree", async () => {
    const root = await fixture();
    const run = spawnSync(process.execPath, [PUBLIC_API_CONTRACT, root], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("PUBLIC_API_CONTRACT_FAILED");
  });

  async function skeleton(): Promise<string> {
    const root = await fixture();
    await fs.mkdir(path.join(root, "src", "architecture"), { recursive: true });
    await fs.mkdir(path.join(root, "src", "control-center"), { recursive: true });
    await fs.mkdir(path.join(root, "ui", "control-center", "src"), { recursive: true });
    for (const file of ["src/architecture/candidateAssurance.ts", "src/control-center/contracts.ts", "src/control-center/server.ts", "src/control-center/operationProjection.ts", "ui/control-center/src/api.ts", "package.json"]) {
      await fs.writeFile(path.join(root, file), await fs.readFile(path.join(REPO_ROOT, file), "utf8"), "utf8");
    }
    return root;
  }

  it("does not weaken: a removed server route still fails", async () => {
    const root = await skeleton();
    const file = path.join(root, "src", "control-center", "server.ts");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("/api/v1/overview", "/api/v1/removed-overview"), "utf8");
    const run = spawnSync(process.execPath, [PUBLIC_API_CONTRACT, root], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("PUBLIC-API-SERVER-ROUTES");
  });

  it("does not weaken: a removed UI contract enforcement still fails", async () => {
    const root = await skeleton();
    const file = path.join(root, "ui", "control-center", "src", "api.ts");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace('resumeTarget !== "SPEC_AUTHORING"', 'resumeTarget !== "REMOVED"'), "utf8");
    const run = spawnSync(process.execPath, [PUBLIC_API_CONTRACT, root], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("PUBLIC-API-UI-CONTRACT");
  });

  it("does not weaken: a changed public-api dimension mapping still fails", async () => {
    const root = await skeleton();
    const file = path.join(root, "src", "architecture", "candidateAssurance.ts");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace('"public API": { kind: "contract-test", floor: "ELEVATED" }', '"public API": { kind: "unit-test", floor: "STANDARD" }'), "utf8");
    const run = spawnSync(process.execPath, [PUBLIC_API_CONTRACT, root], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("PUBLIC-API-DIMENSION-MAPPING");
  });

  it("does not weaken: a removed contract fallback script still fails", async () => {
    const root = await skeleton();
    const file = path.join(root, "package.json");
    const pkg = JSON.parse(await fs.readFile(file, "utf8")) as { scripts: Record<string, string> };
    delete pkg.scripts["test:contract"];
    await fs.writeFile(file, JSON.stringify(pkg, null, 2), "utf8");
    const run = spawnSync(process.execPath, [PUBLIC_API_CONTRACT, root], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("PUBLIC-API-FALLBACK-COVERAGE");
  });

  it("does not weaken: a field removed from both overview and snapshot interfaces still fails", async () => {
    const root = await skeleton();
    const file = path.join(root, "src", "control-center", "contracts.ts");
    const source = await fs.readFile(file, "utf8");
    expect(source).toContain("evidence: ControlCenterEvidenceProjectionV1[];");
    await fs.writeFile(file, source.replace("  evidence: ControlCenterEvidenceProjectionV1[];\n", ""), "utf8");
    const run = spawnSync(process.execPath, [PUBLIC_API_CONTRACT, root], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("PUBLIC-API-OVERVIEW-SHAPE");
  });

  it("does not weaken: an extra resource kind still fails", async () => {
    const root = await skeleton();
    const file = path.join(root, "src", "control-center", "contracts.ts");
    const source = await fs.readFile(file, "utf8");
    await fs.writeFile(file, source.replace('| "event";', '| "event"\n  | "extra";'), "utf8");
    const run = spawnSync(process.execPath, [PUBLIC_API_CONTRACT, root], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("PUBLIC-API-RESOURCE-KINDS");
  });

  it("does not weaken: UI/server resource vocabulary drift still fails", async () => {
    const uiRoot = await skeleton();
    const uiFile = path.join(uiRoot, "ui", "control-center", "src", "api.ts");
    await fs.writeFile(uiFile, (await fs.readFile(uiFile, "utf8")).replace("/api/v1/evidence", "/api/v1/removed-evidence"), "utf8");
    const uiRun = spawnSync(process.execPath, [PUBLIC_API_CONTRACT, uiRoot], { encoding: "utf8", timeout: 60_000 });
    expect(uiRun.status).not.toBe(0);
    expect(uiRun.stderr).toContain("PUBLIC-API-RESOURCE-KINDS");
    const serverRoot = await skeleton();
    const serverFile = path.join(serverRoot, "src", "control-center", "server.ts");
    await fs.writeFile(serverFile, (await fs.readFile(serverFile, "utf8")).replace('this.collection("evidence"', 'this.collection("extra"'), "utf8");
    const serverRun = spawnSync(process.execPath, [PUBLIC_API_CONTRACT, serverRoot], { encoding: "utf8", timeout: 60_000 });
    expect(serverRun.status).not.toBe(0);
    expect(serverRun.stderr).toContain("PUBLIC-API-RESOURCE-KINDS");
  });

  it("does not weaken: an extra UI route still fails", async () => {
    const root = await skeleton();
    const file = path.join(root, "ui", "control-center", "src", "api.ts");
    await fs.writeFile(file, `${await fs.readFile(file, "utf8")}\nconst __extraRouteProbe = "/api/v1/extra-route";\n`, "utf8");
    const run = spawnSync(process.execPath, [PUBLIC_API_CONTRACT, root], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("PUBLIC-API-RESOURCE-KINDS");
  });

  it("rejects a text-only contract-test command with EMPTY_TEST_EVIDENCE instead of a silent zero-interaction PASS", async () => {
    const root = await skeleton();
    const sourceDigest = await computeWorktreeDigest(root);
    const candidate = createCandidateRevisionV1({ operationId: "OP-PUBLIC-API", candidateId: "CAND-PUBLIC-API", revision: 1, sourceDigest });
    const config: HarnessProjectConfig = {
      version: 1,
      project: { name: "public-api-fixture" },
      evidence: { outputDir: ".harness/evidence" },
      validation: {
        validators: [{ id: "contract-test", adapter: "contract-test", command: `node ${PUBLIC_API_CONTRACT} ${root}`, required: true }]
      }
    };
    const contract: TaskContract = { version: 1, task: { id: "PUBLIC-API-PROVIDER", title: "provider path" } };
    const impactBody = {
      version: 1 as const,
      candidate: { candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest },
      baseCandidate: { candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest },
      patchDigest: sha256Canonical("public-api-patch"),
      changedFiles: ["src/control-center/server.ts"],
      changeKinds: ["source"],
      reviewDimensions: ["public API"],
      requiresIndependentReview: false,
      interpretation: "MODEL" as const,
      unknowns: [] as string[]
    };
    const impact = { ...impactBody, digest: sha256Canonical(impactBody) };
    const requirements = candidateImpactValidationRequirementsV1(impact);
    expect(requirements).toMatchObject([{ id: "impact-review-public-api", kind: "contract-test" }]);
    const resolution = await resolveValidationRequirements({ root, requirements, config, contract, allowedKinds: validationRequirementKindValues });
    expect(resolution.blocked).toEqual([]);
    expect(resolution.actions).toMatchObject([{ requirementId: "impact-review-public-api", source: "configured-validator", selector: "contract-test" }]);
    const compilation = compileCandidateAssuranceV1({
      candidate,
      impact,
      policy: {
        version: 1,
        digest: sha256Canonical("public-api-policy"),
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
    expect(compilation.status).toBe("READY");
    const report = {
      version: 1,
      taskId: contract.task.id,
      status: "PASS",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      checks: [],
      changedFiles: ["src/control-center/server.ts"],
      candidate,
      metadata: { project: "public-api-fixture", baseRef: "HEAD" }
    } as Parameters<typeof runCandidateImpactValidations>[0]["report"];
    const checks = await runCandidateImpactValidations({ root, config, contract, report, impact, compilation, resolution });
    // Fail-closed (I-NEW-1): the fixture script prints a human-readable PASS
    // line but no pact interaction evidence, so the contract-test normalizer
    // must FAIL with EMPTY_TEST_EVIDENCE instead of a total:0 PASS.
    expect(checks).toMatchObject([{ id: "candidate.assurance.validation.impact-review-public-api", status: "FAIL" }]);
    expect(checks[0].message).toContain("returned FAIL");
    // The underlying configured-validator check carries the machine-readable blocker.
    const underlying = await runConfiguredValidators(root, config, contract, "HEAD", [], { candidate });
    const contractCheck = underlying.find((item) => item.id === "contract-test");
    expect(contractCheck?.status).toBe("FAIL");
    const normalized = (contractCheck?.details as { result?: { failures?: Array<{ message?: string }> } }).result;
    expect(JSON.stringify(normalized?.failures)).toContain("EMPTY_TEST_EVIDENCE");
    const laneEvidence = (contractCheck?.details as { laneEvidence?: { artifact: string; digest: string } }).laneEvidence;
    expect(laneEvidence?.artifact).toMatch(/\.json$/);
    expect(laneEvidence?.digest).toMatch(/^[a-f0-9]{64}$/);
    const evidence = await loadProviderLaneEvidenceV1(root, config, "CONTRACT", candidate, "contract-test");
    expect(evidence).toBeDefined();
    expect(evidence!.lane).toBe("CONTRACT");
    expect(evidence!.checkId).toBe("contract-test");
    expect(evidence!.candidate).toMatchObject({ candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest });
    expect(typeof evidence!.provider.name).toBe("string");
    expect(evidence!.provider.name.length).toBeGreaterThan(0);
    expect(typeof evidence!.provider.version).toBe("string");
    expect(evidence!.provider.version.length).toBeGreaterThan(0);
    expect(evidence!.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence!.digest).toBe(laneEvidence?.digest);
    expect(evidence!.artifact).toBe(laneEvidence?.artifact);
    expect(evidence!.commandDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence!.rawArtifactDigest).toMatch(/^[a-f0-9]{64}$/);
    const verification = await verifyProviderLaneEvidenceV1(root, config, evidence!, candidate);
    expect(verification.ok).toBe(true);
  });
});

describe("project s9 browser provider", () => {
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

  const S9_PROVIDER_SCRIPT = `import fs from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst candidate = JSON.parse(process.env.AEH_VALIDATION_CANDIDATE_JSON);\nfs.mkdirSync('.harness/evidence', { recursive: true });\nfs.writeFileSync('.harness/evidence/provider-candidate.json', JSON.stringify(candidate));\nconst result = spawnSync('./node_modules/.bin/playwright', ['test'], { encoding: 'utf8' });\nprocess.stdout.write(result.stdout);\nprocess.stderr.write(result.stderr);\nprocess.exitCode = result.status ?? 1;\n`;

  async function s9Fixture(): Promise<{ root: string; candidate: ReturnType<typeof createCandidateRevisionV1> }> {
    const root = await fixture({ "s9-provider.mjs": S9_PROVIDER_SCRIPT });
    await installFakePinnedPlaywright(root);
    const sourceDigest = await computeWorktreeDigest(root);
    const candidate = createCandidateRevisionV1({ operationId: "OP-S9-BROWSER", candidateId: "CAND-S9-BROWSER", revision: 1, sourceDigest });
    return { root, candidate };
  }

  function s9Config(): HarnessProjectConfig {
    return {
      version: 1,
      project: { name: "s9-browser-fixture" },
      evidence: { outputDir: ".harness/evidence" },
      validation: {
        providers: [{ id: "s9-browser-playwright", capability: "browser-test", provider: "playwright", command: "node s9-provider.mjs", timeoutSeconds: 900 }]
      }
    };
  }

  async function dispatchUiBrowser(root: string, candidate: ReturnType<typeof createCandidateRevisionV1>, config: HarnessProjectConfig) {
    const contract: TaskContract = { version: 1, task: { id: "S9-BROWSER-PROVIDER", title: "s9 provider path" } };
    const impactBody = {
      version: 1 as const,
      candidate: { candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest },
      baseCandidate: { candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest },
      patchDigest: sha256Canonical("s9-browser-patch"),
      changedFiles: ["src/control-center/server.ts"],
      changeKinds: ["source"],
      reviewDimensions: ["UI/browser"],
      requiresIndependentReview: false,
      interpretation: "MODEL" as const,
      unknowns: [] as string[]
    };
    const impact = { ...impactBody, digest: sha256Canonical(impactBody) };
    const requirements = candidateImpactValidationRequirementsV1(impact);
    expect(requirements).toMatchObject([{ id: "impact-review-ui-browser", kind: "browser-test" }]);
    const resolution = await resolveValidationRequirements({ root, requirements, config, contract, allowedKinds: validationRequirementKindValues });
    return { contract, impact, requirements, resolution };
  }

  it("persists candidate-bound BROWSER evidence through the s9 provider path", async () => {
    const { root, candidate } = await s9Fixture();
    const config = s9Config();
    const { contract, impact, resolution } = await dispatchUiBrowser(root, candidate, config);
    expect(resolution.blocked).toEqual([]);
    expect(resolution.actions).toMatchObject([{ requirementId: "impact-review-ui-browser", source: "approved-provider", selector: "s9-browser-playwright", kind: "browser-test" }]);
    const compilation = compileCandidateAssuranceV1({
      candidate,
      impact,
      policy: {
        version: 1, digest: sha256Canonical("s9-browser-policy"), minimumAssurance: "STANDARD",
        independentReviewRequired: false, minimumIndependentReviewers: 0, providerDiversity: false,
        allowedValidationKinds: [...validationRequirementKindValues], evidenceStrength: "STANDARD"
      },
      implementationIdentity: "implementer-1", risk: "low",
      reviewerCandidates: [{ identity: "reviewer-a", role: "Reviewer", provider: "provider-a", readOnly: true }],
      baseValidationRequirements: [], validationResolution: resolution, acceptanceAssertions: []
    });
    expect(compilation.status).toBe("READY");
    const report = {
      version: 1, taskId: contract.task.id, status: "PASS",
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      checks: [], changedFiles: ["src/control-center/server.ts"], candidate,
      metadata: { project: "s9-browser-fixture", baseRef: "HEAD" }
    } as Parameters<typeof runCandidateImpactValidations>[0]["report"];
    const checks = await runCandidateImpactValidations({ root, config, contract, report, impact, compilation, resolution });
    expect(checks).toMatchObject([{ id: "candidate.assurance.validation.impact-review-ui-browser", status: "PASS" }]);
    const evidence = await requireProviderLaneEvidenceV1(root, config, "BROWSER", candidate, "candidate-impact-impact-review-ui-browser");
    expect(evidence.provider.name).toBe("playwright");
    expect(evidence.artifacts.some((artifact) => artifact.kind === "screenshot")).toBe(true);
    expect(evidence.candidate).toMatchObject({ candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest });
    expect(JSON.parse(await fs.readFile(path.join(root, ".harness/evidence/provider-candidate.json"), "utf8"))).toMatchObject(candidate);
    const otherCandidate = createCandidateRevisionV1({ operationId: candidate.operationId, candidateId: "CAND-S9-OTHER", revision: candidate.revision, sourceDigest: candidate.sourceDigest });
    await expect(requireProviderLaneEvidenceV1(root, config, "BROWSER", otherCandidate, "candidate-impact-impact-review-ui-browser")).rejects.toThrow("PROVIDER_LANE_EVIDENCE_REQUIRED");
  });

  it("does not weaken: a failing s9 provider still fails without BROWSER evidence", async () => {
    const { root, candidate } = await s9Fixture();
    const config: HarnessProjectConfig = {
      version: 1, project: { name: "s9-browser-fixture" }, evidence: { outputDir: ".harness/evidence" },
      validation: { providers: [{ id: "s9-browser-playwright", capability: "browser-test", provider: "playwright", command: `node -e "process.exit(1)"`, timeoutSeconds: 900 }] }
    };
    const { contract, impact, resolution } = await dispatchUiBrowser(root, candidate, config);
    expect(resolution.blocked).toEqual([]);
    const compilation = compileCandidateAssuranceV1({
      candidate, impact,
      policy: {
        version: 1, digest: sha256Canonical("s9-browser-fail-policy"), minimumAssurance: "STANDARD",
        independentReviewRequired: false, minimumIndependentReviewers: 0, providerDiversity: false,
        allowedValidationKinds: [...validationRequirementKindValues], evidenceStrength: "STANDARD"
      },
      implementationIdentity: "implementer-1", risk: "low", reviewerCandidates: [],
      baseValidationRequirements: [], validationResolution: resolution, acceptanceAssertions: []
    });
    const report = {
      version: 1, taskId: contract.task.id, status: "PASS",
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      checks: [], changedFiles: ["src/control-center/server.ts"], candidate,
      metadata: { project: "s9-browser-fixture", baseRef: "HEAD" }
    } as Parameters<typeof runCandidateImpactValidations>[0]["report"];
    const checks = await runCandidateImpactValidations({ root, config, contract, report, impact, compilation, resolution });
    expect(checks).toMatchObject([{ id: "candidate.assurance.validation.impact-review-ui-browser", status: "FAIL" }]);
  });
});

describeReal("impact-review validators against the real pinned tools", () => {
  it("passes a clean tree through the real opengrep ruleset with the exact version", async () => {
    const root = await fixture({ "src/clean.js": "const a = 1;\n" });
    const run = runWrapper(WRAPPERS.opengrep, root);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.version).toBe("1.22.0");
    expect(parsed.results).toEqual([]);
  }, 120_000);

  it("does not weaken: real opengrep flags the AEH eval rule on a violating fixture", async () => {
    const root = await fixture({ "src/bad.js": "eval('x');\n" });
    const run = runWrapper(WRAPPERS.opengrep, root);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.results).toHaveLength(1);
    expect(String(parsed.results[0].check_id)).toContain("aeh-no-eval");
    const check = await runExternalToolValidator(validatorContext(root, { id: "static-security", adapter: "opengrep", command: `node ${WRAPPERS.opengrep}` }));
    expect(check.status).toBe("FAIL");
    expect(check.details?.findingCount).toBe(1);
  }, 120_000);

  it("does not weaken: real trivy flags a fixture secret", async () => {
    const root = await fixture({ "creds.env": 'aws_access_key_id = "AKIAZZZZQWERTYUIOPAS"\n' });
    const run = runWrapper(WRAPPERS.trivySecret, root);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.Trivy.Version).toBe("0.70.0");
    const secrets = (parsed.Results ?? []).flatMap((result: { Secrets?: unknown[] }) => result.Secrets ?? []);
    expect(secrets.length).toBeGreaterThan(0);
    const check = await runExternalToolValidator(validatorContext(root, { id: "trivy-secret-misconfig", adapter: "trivy", command: `node ${WRAPPERS.trivySecret}` }));
    expect(check.status).toBe("FAIL");
  }, 180_000);

  it("passes an empty tree through the real trivy scanners with zero findings", async () => {
    const root = await fixture();
    for (const wrapper of [WRAPPERS.trivyVuln, WRAPPERS.trivySecret]) {
      const run = runWrapper(wrapper, root);
      const parsed = JSON.parse(run.stdout);
      expect(parsed.Trivy.Version).toBe("0.70.0");
    }
    const vuln = await runExternalToolValidator(validatorContext(root, { id: "dependency-security", adapter: "trivy", command: `node ${WRAPPERS.trivyVuln}` }));
    expect(vuln.status).toBe("PASS");
    const secret = await runExternalToolValidator(validatorContext(root, { id: "trivy-secret-misconfig", adapter: "trivy", command: `node ${WRAPPERS.trivySecret}` }));
    expect(secret.status).toBe("PASS");
  }, 180_000);
});

describe("impact-review validator digests", () => {
  it("records stable digests for the wrapper and ruleset sources", async () => {
    const files = [
      "scripts/security/opengrep.mjs",
      "scripts/security/trivy-vuln.mjs",
      "scripts/security/trivy-secret-misconfig.mjs",
      "scripts/security/toolPin.mjs",
      "scripts/architecture.mjs",
      "scripts/publicApiContract.mjs",
      "policies/opengrep/VERSION",
      "policies/opengrep/rules/aeh-v1.yml",
      "policies/opengrep/pins.json"
    ];
    for (const file of files) {
      const digest = crypto.createHash("sha256").update(await fs.readFile(path.join(REPO_ROOT, file))).digest("hex");
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    }
    const { pins, pinsDir } = readRulesetPins(REPO_ROOT);
    expect(verifyRulesetPins(pinsDir, pins).digest).toBe(pins.ruleset.digest);
  });
});
