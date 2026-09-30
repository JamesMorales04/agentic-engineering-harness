import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  generateSelfHostingEvidenceManifestV1,
  SELF_HOSTING_COMPOSITE_POLICY_V1,
  selfHostingCompositePolicyDigestV1,
  verifySelfHostingCompositeGateV1,
  type SelfHostingCompositePolicyV1,
  type SelfHostingEvidenceManifestV1
} from "../src/certification/composite.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface SyntheticFixture {
  root: string;
  policy: SelfHostingCompositePolicyV1;
  manifestPath: string;
  write(relativePath: string, value: unknown | string): Promise<void>;
  readManifest(): Promise<SelfHostingEvidenceManifestV1>;
  writeManifest(manifest: SelfHostingEvidenceManifestV1): Promise<void>;
}

async function syntheticFixture(): Promise<SyntheticFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-composite-test-"));
  const versionedPath = "docs/evidence/synthetic/versioned.json";
  const runtimePath = "docs/evidence/synthetic/runtime.json";
  const versionedBody = `${JSON.stringify({ result: "PASS", mechanism: "DETERMINISTIC" }, null, 2)}\n`;
  await fs.mkdir(path.join(root, "docs/evidence/synthetic"), { recursive: true });
  await fs.writeFile(path.join(root, versionedPath), versionedBody);
  const policy: SelfHostingCompositePolicyV1 = {
    version: 1,
    id: "aeh-self-hosting-composite-test",
    readinessAuthority: "DETERMINISTIC_COMPOSITE",
    artifacts: {
      "synthetic.versioned": {
        key: "synthetic.versioned",
        path: versionedPath,
        binding: "versioned",
        expectedSha256: sha256(versionedBody),
        assertions: [{ path: "result", op: "equals", value: "PASS" }, { path: "mechanism", op: "oneOf", value: ["DETERMINISTIC", "HYBRID"] }]
      },
      "synthetic.runtime": {
        key: "synthetic.runtime",
        path: runtimePath,
        binding: "runtime",
        assertions: [
          { path: "candidateBuildDigest", op: "equals", value: "$CANDIDATE_BUILD_DIGEST" },
          { path: "checks.length", op: "gte", value: 2 },
          { path: "checks", op: "array-contains", match: { id: "synthetic.one", ok: true } }
        ]
      }
    },
    items: [
      { id: "synthetic-evidence", title: "Synthetic evidence", target: "test", mechanism: "DETERMINISTIC", required: true, artifactKeys: ["synthetic.versioned", "synthetic.runtime"] }
    ]
  };
  const runtimeBody = `${JSON.stringify({ candidateBuildDigest: "a".repeat(64), checks: [{ id: "synthetic.one", ok: true }, { id: "synthetic.two", ok: true }] }, null, 2)}\n`;
  const write = async (relativePath: string, value: unknown | string) => {
    const body = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
    await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await fs.writeFile(path.join(root, relativePath), body);
  };
  await write(runtimePath, runtimeBody);
  const manifestPath = "docs/evidence/synthetic/manifest.json";
  const writeManifest = async (manifest: SelfHostingEvidenceManifestV1) => write(manifestPath, manifest);
  const readManifest = async () => JSON.parse(await fs.readFile(path.join(root, manifestPath), "utf8")) as SelfHostingEvidenceManifestV1;
  await writeManifest(await generateSelfHostingEvidenceManifestV1({ repoRoot: root, generatedAt: "2026-09-30T00:00:00.000Z", policy }));
  return { root, policy, manifestPath, write, readManifest, writeManifest };
}

async function evaluate(fixture: SyntheticFixture, overrides: { candidateBuildDigest?: string; manifestPath?: string; modelReadinessClaims?: { source: string; claim: unknown }[] } = {}) {
  return verifySelfHostingCompositeGateV1(
    {
      repoRoot: fixture.root,
      manifestPath: overrides.manifestPath ?? fixture.manifestPath,
      candidateBuildDigest: overrides.candidateBuildDigest ?? "a".repeat(64),
      generatedAt: "2026-09-30T00:00:00.000Z",
      modelReadinessClaims: overrides.modelReadinessClaims
    },
    fixture.policy
  );
}

describe("self-hosting composite gate", () => {
  it("passes when every required artifact verifies against the frozen policy and manifest", async () => {
    const fixture = await syntheticFixture();
    const report = await evaluate(fixture);
    expect(report.ready).toBe(true);
    expect(report.summary.failedItems).toBe(0);
    expect(report.summary.versionedArtifacts).toBe(1);
    expect(report.summary.runtimeArtifacts).toBe(1);
    expect(report.readinessAuthority).toBe("DETERMINISTIC_COMPOSITE");
    expect(report.modelAuthority).toBe("NONE");
  });

  it("fails closed on a missing manifest", async () => {
    const fixture = await syntheticFixture();
    const report = await evaluate(fixture, { manifestPath: "docs/evidence/synthetic/absent.json" });
    expect(report.ready).toBe(false);
    expect(report.failures.some((failure) => failure.code === "COMPOSITE_MANIFEST_MISSING" || failure.code === "COMPOSITE_MANIFEST_UNSAFE_PATH")).toBe(true);
  });

  it("rejects an unsupported manifest version", async () => {
    const fixture = await syntheticFixture();
    const manifest = await fixture.readManifest();
    await fixture.writeManifest({ ...manifest, version: 2 as unknown as 1 });
    const report = await evaluate(fixture);
    expect(report.ready).toBe(false);
    expect(report.failures.some((failure) => failure.code === "COMPOSITE_UNSUPPORTED_VERSION")).toBe(true);
  });

  it("rejects a manifest whose policy digest does not match the frozen policy", async () => {
    const fixture = await syntheticFixture();
    const manifest = await fixture.readManifest();
    await fixture.writeManifest({ ...manifest, policyDigest: "b".repeat(64) });
    const report = await evaluate(fixture);
    expect(report.ready).toBe(false);
    expect(report.failures.some((failure) => failure.code === "COMPOSITE_POLICY_DIGEST_MISMATCH")).toBe(true);
  });

  it("detects tampered evidence bytes", async () => {
    const fixture = await syntheticFixture();
    await fixture.write("docs/evidence/synthetic/runtime.json", { candidateBuildDigest: "a".repeat(64), checks: [{ id: "synthetic.one", ok: true }, { id: "synthetic.two", ok: true }], injected: true });
    const report = await evaluate(fixture);
    expect(report.ready).toBe(false);
    const runtime = report.items[0].artifacts.find((artifact) => artifact.key === "synthetic.runtime");
    expect(runtime?.failures.some((failure) => failure.includes("tampered or stale"))).toBe(true);
  });

  it("rejects versioned evidence whose manifest digest is not the frozen digest", async () => {
    const fixture = await syntheticFixture();
    const manifest = await fixture.readManifest();
    await fixture.writeManifest({ ...manifest, artifacts: { ...manifest.artifacts, "synthetic.versioned": "c".repeat(64) } });
    const report = await evaluate(fixture);
    expect(report.ready).toBe(false);
    const versioned = report.items[0].artifacts.find((artifact) => artifact.key === "synthetic.versioned");
    expect(versioned?.failures.some((failure) => failure.includes("frozen versioned digest"))).toBe(true);
  });

  it("fails closed on stale runtime evidence bound to a different candidate build", async () => {
    const fixture = await syntheticFixture();
    const report = await evaluate(fixture, { candidateBuildDigest: "d".repeat(64) });
    expect(report.ready).toBe(false);
    const runtime = report.items[0].artifacts.find((artifact) => artifact.key === "synthetic.runtime");
    expect(runtime?.failures.some((failure) => failure.includes("candidateBuildDigest") || failure.includes("expected"))).toBe(true);
  });

  it("replays old runtime evidence as stale when the candidate build advances", async () => {
    const fixture = await syntheticFixture();
    const first = await evaluate(fixture);
    expect(first.ready).toBe(true);
    const second = await evaluate(fixture, { candidateBuildDigest: "e".repeat(64) });
    expect(second.ready).toBe(false);
    expect(second.candidateBuildDigest).toBe("e".repeat(64));
  });

  it("never lets a model readiness claim set readiness", async () => {
    const fixture = await syntheticFixture();
    await fixture.write("docs/evidence/synthetic/runtime.json", { candidateBuildDigest: "a".repeat(64), checks: [{ id: "synthetic.one", ok: false }, { id: "synthetic.two", ok: true }] });
    const report = await evaluate(fixture, {
      modelReadinessClaims: [{ source: "semantic-assessor", claim: { ready: true, confidence: 0.99 } }, { source: "agent-output", claim: "AEH is ready for self-hosting" }]
    });
    expect(report.ready).toBe(false);
    expect(report.modelAuthority).toBe("NONE");
    expect(report.modelReadinessClaims.received).toBe(2);
    expect(report.modelReadinessClaims.evaluated).toBe(false);
  });

  it("ignores model claims embedded in the manifest itself", async () => {
    const fixture = await syntheticFixture();
    const manifest = await fixture.readManifest();
    await fixture.writeManifest({ ...manifest, modelReadiness: { ready: true } } as unknown as SelfHostingEvidenceManifestV1);
    const report = await evaluate(fixture);
    expect(report.ready).toBe(true);
    expect(report.modelAuthority).toBe("NONE");
  });

  it("rejects manifest paths outside docs/evidence", async () => {
    const fixture = await syntheticFixture();
    const report = await evaluate(fixture, { manifestPath: "../outside.json" });
    expect(report.ready).toBe(false);
    expect(report.failures.some((failure) => failure.code === "COMPOSITE_MANIFEST_UNSAFE_PATH")).toBe(true);
  });

  it("fails closed when a required artifact is missing from the manifest", async () => {
    const fixture = await syntheticFixture();
    const manifest = await fixture.readManifest();
    const { "synthetic.runtime": removed, ...rest } = manifest.artifacts;
    void removed;
    await fixture.writeManifest({ ...manifest, artifacts: rest });
    const report = await evaluate(fixture);
    expect(report.ready).toBe(false);
    expect(report.items[0].artifacts.find((artifact) => artifact.key === "synthetic.runtime")?.status).toBe("FAIL");
  });

  it("manifest generation refuses to bless drifted versioned evidence", async () => {
    const fixture = await syntheticFixture();
    await fixture.write("docs/evidence/synthetic/versioned.json", { result: "FAIL" });
    await expect(generateSelfHostingEvidenceManifestV1({ repoRoot: fixture.root, generatedAt: "2026-09-30T00:00:00.000Z", policy: fixture.policy })).rejects.toThrow(/SELF_HOSTING_MANIFEST_GENERATION_FAILED/);
  });

  it("pins the frozen composite policy digest to its declared version", () => {
    expect(SELF_HOSTING_COMPOSITE_POLICY_V1.version).toBe(1);
    expect(selfHostingCompositePolicyDigestV1()).toMatch(/^[0-9a-f]{64}$/);
    expect(SELF_HOSTING_COMPOSITE_POLICY_V1.items.length).toBe(21);
    expect(new Set(SELF_HOSTING_COMPOSITE_POLICY_V1.items.map((item) => item.id)).size).toBe(SELF_HOSTING_COMPOSITE_POLICY_V1.items.length);
    for (const item of SELF_HOSTING_COMPOSITE_POLICY_V1.items) {
      for (const key of item.artifactKeys) expect(SELF_HOSTING_COMPOSITE_POLICY_V1.artifacts[key], `artifact ${key} is declared`).toBeDefined();
    }
    for (const artifact of Object.values(SELF_HOSTING_COMPOSITE_POLICY_V1.artifacts)) {
      if (artifact.binding === "versioned") expect(artifact.expectedSha256, `versioned artifact ${artifact.key} is pinned`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("verifies every frozen versioned artifact of the real checkout", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const manifest = await generateSelfHostingEvidenceManifestV1({ repoRoot, generatedAt: "2026-09-30T00:00:00.000Z" });
    const versionedKeys = Object.values(SELF_HOSTING_COMPOSITE_POLICY_V1.artifacts).filter((artifact) => artifact.binding === "versioned").map((artifact) => artifact.key);
    for (const key of versionedKeys) expect(manifest.artifacts[key], `versioned artifact ${key} verifies`).toMatch(/^[0-9a-f]{64}$/);
  });
});
