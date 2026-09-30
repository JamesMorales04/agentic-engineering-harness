import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  generateSelfHostingEvidenceManifestV1,
  verifySelfHostingCompositeGateV1,
  type SelfHostingCompositePolicyV1,
  type SelfHostingEvidenceManifestV1
} from "../src/certification/composite.js";

/**
 * S14 adversarial/negative checks for the self-hosting composite gate.
 *
 *   npx tsx scripts/s14AdversarialChecks.ts [checkout]
 *
 * Proves (deterministically, with machine-readable output) that the composite fail-closed
 * behavior rejects missing/tampered/stale/replayed/unsupported evidence, that no model readiness
 * claim can set readiness, and that mutations the campaign cannot confine fail the gate. The
 * product-level workspace-confinement checks run the real candidate-identity suites.
 */

const checkout = path.resolve(process.argv[2] ?? process.cwd());
const evidenceRoot = path.join(checkout, "docs", "evidence", "s14");
const artifactPath = path.join(evidenceRoot, "adversarial-negative-checks.json");

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function buildIdentity() {
  const releaseId = (await fs.readFile(path.join(checkout, "dist", "current"), "utf8")).trim();
  return JSON.parse(await fs.readFile(path.join(checkout, "dist", "releases", releaseId, "build-identity.json"), "utf8")) as { buildDigest: string };
}

async function syntheticFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s14-adversarial-"));
  const versionedPath = "docs/evidence/synthetic/versioned.json";
  const runtimePath = "docs/evidence/synthetic/runtime.json";
  const versionedBody = `${JSON.stringify({ result: "PASS" }, null, 2)}\n`;
  const runtimeBody = `${JSON.stringify({ candidateBuildDigest: "a".repeat(64), containment: { mutationRootsDisposable: true }, checks: [{ id: "one", ok: true }, { id: "two", ok: true }] }, null, 2)}\n`;
  await fs.mkdir(path.join(root, "docs/evidence/synthetic"), { recursive: true });
  await fs.writeFile(path.join(root, versionedPath), versionedBody);
  await fs.writeFile(path.join(root, runtimePath), runtimeBody);
  const policy: SelfHostingCompositePolicyV1 = {
    version: 1,
    id: "aeh-self-hosting-adversarial-test",
    readinessAuthority: "DETERMINISTIC_COMPOSITE",
    artifacts: {
      "synthetic.versioned": { key: "synthetic.versioned", path: versionedPath, binding: "versioned", expectedSha256: sha256(versionedBody), assertions: [{ path: "result", op: "equals", value: "PASS" }] },
      "synthetic.runtime": {
        key: "synthetic.runtime",
        path: runtimePath,
        binding: "runtime",
        assertions: [
          { path: "candidateBuildDigest", op: "equals", value: "$CANDIDATE_BUILD_DIGEST" },
          { path: "containment.mutationRootsDisposable", op: "equals", value: true },
          { path: "checks.length", op: "gte", value: 2 }
        ]
      }
    },
    items: [{ id: "synthetic-item", title: "Synthetic", target: "test", mechanism: "DETERMINISTIC", required: true, artifactKeys: ["synthetic.versioned", "synthetic.runtime"] }]
  };
  const manifestBody = await generateSelfHostingEvidenceManifestV1({ repoRoot: root, generatedAt: "2026-09-30T00:00:00.000Z", policy });
  await fs.writeFile(path.join(root, "docs/evidence/synthetic/manifest.json"), `${JSON.stringify(manifestBody, null, 2)}\n`);
  const evaluate = async (overrides: { candidateBuildDigest?: string; manifestPath?: string; modelReadinessClaims?: { source: string; claim: unknown }[] } = {}) => verifySelfHostingCompositeGateV1({
    repoRoot: root,
    manifestPath: overrides.manifestPath ?? "docs/evidence/synthetic/manifest.json",
    candidateBuildDigest: overrides.candidateBuildDigest ?? "a".repeat(64),
    generatedAt: "2026-09-30T00:00:00.000Z",
    modelReadinessClaims: overrides.modelReadinessClaims
  }, policy);
  const write = async (relativePath: string, value: unknown) => fs.writeFile(path.join(root, relativePath), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  const readManifest = async () => JSON.parse(await fs.readFile(path.join(root, "docs/evidence/synthetic/manifest.json"), "utf8")) as SelfHostingEvidenceManifestV1;
  return { root, evaluate, write, readManifest };
}

const checks: { id: string; ok: boolean; detail: string }[] = [];
function record(id: string, ok: boolean, detail: string) { checks.push({ id, ok, detail }); }

const fixture = await syntheticFixture();
const identity = await buildIdentity();

record("adversarial.gate-baseline-passes", (await fixture.evaluate()).ready === true, "valid synthetic evidence passes");
record("adversarial.missing-manifest-fails-closed", (await fixture.evaluate({ manifestPath: "docs/evidence/synthetic/absent.json" })).ready === false, "absent manifest is rejected");
record("adversarial.unsafe-manifest-path-rejected", (await fixture.evaluate({ manifestPath: "../outside.json" })).ready === false, "traversal manifest path is rejected");

{
  const manifest = await fixture.readManifest();
  await fixture.write("docs/evidence/synthetic/manifest.json", { ...manifest, version: 2 });
  const report = await fixture.evaluate();
  record("adversarial.unsupported-version-rejected", report.ready === false && report.failures.some((failure) => failure.code === "COMPOSITE_UNSUPPORTED_VERSION"), "manifest version 2 is unsupported");
  await fixture.write("docs/evidence/synthetic/manifest.json", manifest);
}

{
  const manifest = await fixture.readManifest();
  await fixture.write("docs/evidence/synthetic/manifest.json", { ...manifest, policyDigest: "f".repeat(64) });
  const report = await fixture.evaluate();
  record("adversarial.policy-digest-mismatch-rejected", report.ready === false && report.failures.some((failure) => failure.code === "COMPOSITE_POLICY_DIGEST_MISMATCH"), "policy digest mismatch is rejected");
  await fixture.write("docs/evidence/synthetic/manifest.json", manifest);
}

{
  const manifest = await fixture.readManifest();
  await fixture.write("docs/evidence/synthetic/manifest.json", { ...manifest, artifacts: { ...manifest.artifacts, "synthetic.versioned": "0".repeat(64) } });
  const report = await fixture.evaluate();
  record("adversarial.frozen-pin-drift-rejected", report.ready === false, "manifest digest deviating from the frozen pin is rejected");
  await fixture.write("docs/evidence/synthetic/manifest.json", manifest);
}

{
  const tampered = `${JSON.stringify({ candidateBuildDigest: "a".repeat(64), containment: { mutationRootsDisposable: true }, checks: [{ id: "one", ok: true }, { id: "two", ok: true }], injected: "tamper" }, null, 2)}\n`;
  await fixture.write("docs/evidence/synthetic/runtime.json", tampered);
  const report = await fixture.evaluate();
  record("adversarial.tampered-evidence-rejected", report.ready === false, "post-manifest tampering is rejected by digest");
  await fixture.write("docs/evidence/synthetic/runtime.json", `${JSON.stringify({ candidateBuildDigest: "a".repeat(64), containment: { mutationRootsDisposable: true }, checks: [{ id: "one", ok: true }, { id: "two", ok: true }] }, null, 2)}\n`);
}

{
  const report = await fixture.evaluate({ candidateBuildDigest: "b".repeat(64) });
  record("adversarial.stale-candidate-binding-rejected", report.ready === false, "runtime evidence bound to another candidate build is stale");
}

{
  const report = await fixture.evaluate({
    candidateBuildDigest: "b".repeat(64),
    modelReadinessClaims: [{ source: "semantic-assessor", claim: { ready: true, confidence: 0.99 } }, { source: "agent-output", claim: "ready for self-hosting" }]
  });
  record("adversarial.model-claim-cannot-declare-readiness", report.ready === false && report.modelAuthority === "NONE" && report.modelReadinessClaims.evaluated === false && report.modelReadinessClaims.received === 2, "model readiness claims are recorded and never evaluated");
}

{
  const body = `${JSON.stringify({ candidateBuildDigest: "a".repeat(64), containment: { mutationRootsDisposable: false }, checks: [{ id: "one", ok: true }, { id: "two", ok: true }] }, null, 2)}\n`;
  await fixture.write("docs/evidence/synthetic/runtime.json", body);
  const manifest = await fixture.readManifest();
  await fixture.write("docs/evidence/synthetic/manifest.json", { ...manifest, artifacts: { ...manifest.artifacts, "synthetic.runtime": sha256(body) } });
  const report = await fixture.evaluate();
  record("adversarial.out-of-fixture-mutation-rejected", report.ready === false && report.items[0].artifacts.some((artifact) => artifact.key === "synthetic.runtime" && artifact.failures.some((failure) => failure.includes("mutationRootsDisposable"))), "a mutation outside the disposable fixture fails the gate");
}

{
  const missing = `docs/evidence/synthetic/manifest-${Date.now()}.json`;
  record("adversarial.missing-manifest-code", (await fixture.evaluate({ manifestPath: missing })).failures.some((failure) => failure.code === "COMPOSITE_MANIFEST_MISSING"), "missing manifest has a typed failure");
}

const productLevelCommand = [
  "npx", "vitest", "run",
  "tests/candidateIdentity.test.ts",
  "tests/directCandidateLifecycle.test.ts",
  "tests/candidateAssembler.test.ts",
  "--reporter=json",
  `--outputFile=${path.join(os.tmpdir(), "aeh-s14-adversarial-product.json")}`
];
const productRun = spawnSync(productLevelCommand[0], productLevelCommand.slice(1), { cwd: checkout, encoding: "utf8", timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
let productLevel: Record<string, unknown> = { command: productLevelCommand.join(" "), exitCode: productRun.status, parseError: null };
try {
  const parsed = JSON.parse(await fs.readFile(path.join(os.tmpdir(), "aeh-s14-adversarial-product.json"), "utf8"));
  productLevel = { ...productLevel, numTotalTestSuites: parsed.numTotalTestSuites, numPassedTestSuites: parsed.numPassedTestSuites, numTotalTests: parsed.numTotalTests, numPassedTests: parsed.numPassedTests, numFailedTests: parsed.numFailedTests, success: parsed.success };
} catch (error) {
  productLevel = { ...productLevel, parseError: String(error) };
}

const failedChecks = checks.filter((check) => !check.ok);
const artifact = {
  version: 1,
  slice: "S14",
  campaign: "adversarial-negative-checks",
  generatedAt: new Date().toISOString(),
  checkout,
  candidateBuildDigest: identity.buildDigest,
  modelAuthority: "NONE",
  checks,
  failedChecks: failedChecks.map((check) => check.id),
  productLevelChecks: productLevel,
  result: failedChecks.length === 0 && productRun.status === 0 ? "PASS" : "FAIL"
};
await fs.mkdir(evidenceRoot, { recursive: true });
await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
const artifactSha256 = sha256(await fs.readFile(artifactPath));
console.log(JSON.stringify({ result: artifact.result, candidateBuildDigest: artifact.candidateBuildDigest, failedChecks: artifact.failedChecks, productLevel, artifact: path.relative(checkout, artifactPath), artifactSha256 }, null, 2));
if (artifact.result !== "PASS") process.exitCode = 1;
