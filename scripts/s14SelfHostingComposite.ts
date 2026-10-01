import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  generateSelfHostingEvidenceManifestV1,
  SELF_HOSTING_COMPOSITE_POLICY_V1,
  selfHostingCompositePolicyDigestV1,
  verifySelfHostingCompositeGateV1
} from "../src/certification/composite.js";

/**
 * S14 self-hosting composite run (TARGET section 16).
 *
 * Generates the versioned evidence manifest from the current tree, evaluates the deterministic
 * composite gate bound to the current build identity, and writes machine-readable evidence:
 *
 *   npx tsx scripts/s14SelfHostingComposite.ts [checkout]
 *
 * Outputs (under docs/evidence/closure/):
 *   certification-evidence-manifest.json  -- versioned evidence index + policy digest
 *   self-hosting-composite-report.json    -- deterministic gate report (readiness authority)
 */

const checkout = path.resolve(process.argv[2] ?? process.cwd());
const evidenceRoot = path.join(checkout, "docs", "evidence", "closure");
const manifestPath = "docs/evidence/closure/certification-evidence-manifest.json";
const reportPath = "docs/evidence/closure/self-hosting-composite-report.json";

async function buildIdentity() {
  const releaseId = (await fs.readFile(path.join(checkout, "dist", "current"), "utf8")).trim();
  return JSON.parse(await fs.readFile(path.join(checkout, "dist", "releases", releaseId, "build-identity.json"), "utf8"));
}

const generatedAt = process.env.S14_COMPOSITE_GENERATED_AT ?? new Date().toISOString();
const identity = await buildIdentity();
const policy = SELF_HOSTING_COMPOSITE_POLICY_V1;
const policyDigest = selfHostingCompositePolicyDigestV1(policy);

const runtimeArtifactDigests: { artifact: string; digest: string }[] = [];
for (const [artifact, key] of [
  ["docs/evidence/closure/disposable-self-modification-campaign.json", "candidateBuildDigest"],
  ["docs/evidence/closure/resource-stability-product.json", "candidateBuildDigest"],
  ["docs/evidence/closure/adversarial-negative-checks.json", "candidateBuildDigest"]
] as const) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(checkout, artifact), "utf8")) as Record<string, unknown>;
    if (typeof parsed[key] === "string") runtimeArtifactDigests.push({ artifact, digest: parsed[key] as string });
  } catch { /* runtime artifact not generated yet */ }
}
const stale = runtimeArtifactDigests.filter((entry) => entry.digest !== identity.buildDigest);
if (stale.length) {
  console.error(JSON.stringify({
    error: "S14_COMPOSITE_CANDIDATE_BUILD_POINTER_STALE",
    currentBuildDigest: identity.buildDigest,
    note: "dist/current is not the candidate build the S14 runtime evidence was produced on (a suite build may have moved the pointer). Re-cut the candidate release with `npm run build` before running the composite gate.",
    runtimeArtifactDigests
  }, null, 2));
  process.exit(2);
}

await fs.mkdir(evidenceRoot, { recursive: true });
const manifest = await generateSelfHostingEvidenceManifestV1({ repoRoot: checkout, generatedAt, policy });
await fs.writeFile(path.join(evidenceRoot, "certification-evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const manifestSha256 = createHash("sha256").update(await fs.readFile(path.join(evidenceRoot, "certification-evidence-manifest.json"))).digest("hex");

const report = await verifySelfHostingCompositeGateV1(
  {
    repoRoot: checkout,
    manifestPath,
    candidateBuildDigest: identity.buildDigest,
    generatedAt,
    modelReadinessClaims: []
  },
  policy
);
await fs.writeFile(path.join(checkout, reportPath), `${JSON.stringify(report, null, 2)}\n`);
const reportSha256 = createHash("sha256").update(await fs.readFile(path.join(checkout, reportPath))).digest("hex");

console.log(JSON.stringify({
  ready: report.ready,
  candidateBuildDigest: report.candidateBuildDigest,
  policyDigest,
  manifestPath,
  manifestSha256,
  reportPath,
  reportSha256,
  summary: report.summary,
  failedItems: report.items.filter((item) => item.status === "FAIL").map((item) => ({ id: item.id, artifacts: item.artifacts.filter((artifact) => artifact.status === "FAIL").map((artifact) => ({ key: artifact.key, failures: artifact.failures })) }))
}, null, 2));
if (!report.ready) process.exitCode = 1;
