import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig } from "../../src/core/types.js";
import { computeWorktreeDigest } from "../../src/core/git.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import {
  PROVIDER_LANE_EVIDENCE_COMMAND_MISMATCH,
  PROVIDER_LANE_EVIDENCE_REQUIRED,
  PROVIDER_LANE_EVIDENCE_STALE,
  PROVIDER_LANE_EVIDENCE_TAMPERED,
  PROVIDER_LANE_REFERENCE_REQUIRED,
  loadProviderLaneEvidenceV1,
  persistProviderLaneEvidenceV1,
  providerLaneEvidenceArtifactPath,
  requireProviderLaneEvidenceForActionV1,
  requireProviderLaneEvidenceV1,
  verifyProviderLaneEvidenceV1
} from "../../src/validation/laneEvidence.js";
import { sha256Utf8 } from "../../src/core/digest.js";

const config: HarnessProjectConfig = { version: 1, project: { name: "lane-fixtures" }, evidence: { outputDir: ".harness/evidence" } };
const roots: string[] = [];

async function fixture(): Promise<{ root: string; candidate: CandidateRevisionV1 }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-lane-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  const sourceDigest = await computeWorktreeDigest(root);
  const candidate = createCandidateRevisionV1({ operationId: "OP-LANE", candidateId: "CAND-LANE", revision: 1, sourceDigest });
  return { root, candidate };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("candidate-bound provider lane evidence", () => {
  it("persists, loads, and verifies contract/integration/browser/visual evidence bound to the exact candidate revision", async () => {
    for (const lane of ["CONTRACT", "INTEGRATION", "BROWSER", "VISUAL"] as const) {
      const { root, candidate } = await fixture();
      const screenshot = path.join(root, ".harness", "inputs", "shot.png");
      await fs.mkdir(path.dirname(screenshot), { recursive: true });
      await fs.writeFile(screenshot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const baseline = path.join(root, ".harness", "inputs", "baseline.png");
      await fs.writeFile(baseline, "baseline-bytes");
      const evidence = await persistProviderLaneEvidenceV1({
        root, config, lane, checkId: `${lane.toLowerCase()}-check`, candidate,
        provider: { name: "playwright", version: "1.62.1", runtime: "chromium" },
        command: `playwright test --grep ${lane}`,
        status: "PASS",
        summary: `${lane} passed.`,
        findings: [],
        rawArtifactText: JSON.stringify({ lane, status: "passed" }),
        artifacts: lane === "VISUAL"
          ? [{ kind: "screenshot", path: screenshot }, { kind: "baseline", path: baseline }]
          : [{ kind: "screenshot", path: screenshot }],
        ...(lane === "VISUAL" ? { comparison: { tool: "playwright-toHaveScreenshot", name: "shot.png", options: { maxDiffPixelRatio: 0.05 } } } : {}),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString()
      });
      expect(evidence.lane).toBe(lane);
      expect(evidence.candidate).toEqual({ candidateId: "CAND-LANE", revision: 1, identityDigest: candidate.identityDigest });
      expect(evidence.artifact).toContain(path.join(lane.toLowerCase(), `CAND-LANE-r1-${candidate.identityDigest.slice(0, 12)}`));
      expect(evidence.workspace.observedSourceDigest).toBe(candidate.sourceDigest);
      expect(evidence.artifacts.some((artifact) => artifact.kind === "screenshot")).toBe(true);
      const loaded = await loadProviderLaneEvidenceV1(root, config, lane, candidate, `${lane.toLowerCase()}-check`);
      expect(loaded?.digest).toBe(evidence.digest);
      expect((await verifyProviderLaneEvidenceV1(root, config, loaded!, candidate, sha256Utf8(`playwright test --grep ${lane}`))).ok).toBe(true);
      expect((await requireProviderLaneEvidenceV1(root, config, lane, candidate, `${lane.toLowerCase()}-check`, sha256Utf8(`playwright test --grep ${lane}`))).digest).toBe(evidence.digest);
    }
  });

  it("requires VISUAL evidence to bind its reference baseline identity and comparison configuration", async () => {
    const { root, candidate } = await fixture();
    const screenshot = path.join(root, ".harness", "inputs", "shot.png");
    await fs.mkdir(path.dirname(screenshot), { recursive: true });
    await fs.writeFile(screenshot, "png");
    const bare = await persistProviderLaneEvidenceV1({
      root, config, lane: "VISUAL", checkId: "visual-bare", candidate,
      provider: { name: "playwright-visual", version: "1.62.1" }, command: "visual", status: "PASS",
      summary: "visual passed", findings: [], rawArtifactText: "{}",
      artifacts: [{ kind: "screenshot", path: screenshot }],
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
    });
    const bareVerification = await verifyProviderLaneEvidenceV1(root, config, bare, candidate, sha256Utf8("visual"));
    expect(bareVerification.ok).toBe(false);
    expect(bareVerification.blockers.every((blocker) => blocker.includes(PROVIDER_LANE_REFERENCE_REQUIRED))).toBe(true);
    await expect(requireProviderLaneEvidenceV1(root, config, "VISUAL", candidate, "visual-bare", sha256Utf8("visual"))).rejects.toThrow(PROVIDER_LANE_REFERENCE_REQUIRED);
    const baseline = path.join(root, ".harness", "inputs", "baseline.png");
    await fs.writeFile(baseline, "baseline");
    const bound = await persistProviderLaneEvidenceV1({
      root, config, lane: "VISUAL", checkId: "visual-bound", candidate,
      provider: { name: "playwright-visual", version: "1.62.1" }, command: "visual", status: "PASS",
      summary: "visual passed", findings: [], rawArtifactText: "{}",
      artifacts: [{ kind: "screenshot", path: screenshot }, { kind: "baseline", path: baseline }],
      comparison: { tool: "playwright-toHaveScreenshot", name: "shot.png", options: { maxDiffPixelRatio: 0.05 } },
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
    });
    expect((await verifyProviderLaneEvidenceV1(root, config, bound, candidate, sha256Utf8("visual"))).ok).toBe(true);
    await fs.writeFile(baseline, "baseline-tampered");
    const tampered = await verifyProviderLaneEvidenceV1(root, config, bound, candidate, sha256Utf8("visual"));
    expect(tampered.ok).toBe(false);
    expect(tampered.blockers.some((blocker) => blocker.includes(PROVIDER_LANE_EVIDENCE_TAMPERED))).toBe(true);
  });

  it("requires specialized lane checks to have provider-produced evidence instead of synthesizing it from a raw check", async () => {
    const { root, candidate } = await fixture();
    await expect(requireProviderLaneEvidenceForActionV1({
      root, config, lane: "BROWSER", candidate, checkId: "command.candidate-impact-browser",
      kind: "browser-test", actionSource: "project-script", actionSelector: "e2e",
      expectedCommandDigest: sha256Utf8("playwright test")
    })).rejects.toThrow(PROVIDER_LANE_EVIDENCE_REQUIRED);
    const screenshot = path.join(root, ".harness", "inputs", "shot.png");
    await fs.mkdir(path.dirname(screenshot), { recursive: true });
    await fs.writeFile(screenshot, "png");
    await persistProviderLaneEvidenceV1({
      root, config, lane: "BROWSER", checkId: "command.candidate-impact-browser", candidate,
      provider: { name: "playwright", version: "1.62.1" }, command: "playwright test", status: "PASS",
      summary: "browser passed", findings: [], rawArtifactText: "{}",
      artifacts: [{ kind: "screenshot", path: screenshot }],
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
    });
    await expect(requireProviderLaneEvidenceForActionV1({
      root, config, lane: "BROWSER", candidate, checkId: "command.candidate-impact-browser",
      kind: "browser-test", actionSource: "project-script", actionSelector: "e2e",
      expectedCommandDigest: sha256Utf8("playwright test")
    })).resolves.toMatchObject({ lane: "BROWSER", status: "PASS" });
  });

  it("keeps lanes separate: evidence written for one lane cannot satisfy another lane", async () => {
    const { root, candidate } = await fixture();
    await persistProviderLaneEvidenceV1({
      root, config, lane: "BROWSER", checkId: "journey", candidate,
      provider: { name: "playwright", version: "1.62.1" }, command: "playwright test", status: "PASS",
      summary: "browser passed", findings: [], rawArtifactText: "{}",
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
    });
    expect(await loadProviderLaneEvidenceV1(root, config, "VISUAL", candidate, "journey")).toBeUndefined();
    await expect(requireProviderLaneEvidenceV1(root, config, "VISUAL", candidate, "journey", sha256Utf8("playwright test"))).rejects.toThrow(PROVIDER_LANE_EVIDENCE_REQUIRED);
    await expect(requireProviderLaneEvidenceV1(root, config, "BROWSER", candidate, "missing-check", sha256Utf8("playwright test"))).rejects.toThrow(PROVIDER_LANE_EVIDENCE_REQUIRED);
  });

  it("blocks evidence for a different candidate as stale", async () => {
    const { root, candidate } = await fixture();
    const evidence = await persistProviderLaneEvidenceV1({
      root, config, lane: "CONTRACT", checkId: "openapi", candidate,
      provider: { name: "openapi", version: "1" }, command: "compare", status: "PASS",
      summary: "contract passed", findings: [], rawArtifactText: "{}",
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
    });
    const other = createCandidateRevisionV1({ operationId: "OP-LANE", candidateId: "CAND-LANE", revision: 2, sourceDigest: candidate.sourceDigest });
    const verified = await verifyProviderLaneEvidenceV1(root, config, evidence, other, sha256Utf8("compare"));
    expect(verified.ok).toBe(false);
    expect(verified.blockers.some((blocker) => blocker.includes(PROVIDER_LANE_EVIDENCE_STALE))).toBe(true);
  });

  it("detects tampered evidence JSON, tampered raw output, and missing screenshot artifacts", async () => {
    const { root, candidate } = await fixture();
    const screenshot = path.join(root, ".harness", "inputs", "shot.png");
    await fs.mkdir(path.dirname(screenshot), { recursive: true });
    await fs.writeFile(screenshot, "png-bytes");
    const baseline = path.join(root, ".harness", "inputs", "baseline.png");
    await fs.writeFile(baseline, "baseline-bytes");
    const evidence = await persistProviderLaneEvidenceV1({
      root, config, lane: "VISUAL", checkId: "visual", candidate,
      provider: { name: "playwright-visual", version: "1.62.1" }, command: "visual", status: "PASS",
      summary: "visual passed", findings: [], rawArtifactText: "{\"ok\":true}",
      artifacts: [{ kind: "screenshot", path: screenshot }, { kind: "baseline", path: baseline }],
      comparison: { tool: "playwright-toHaveScreenshot", name: "shot.png", options: {} },
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
    });
    const artifactPath = providerLaneEvidenceArtifactPath(root, config, "VISUAL", candidate, "visual");
    const tampered = { ...evidence, status: "FAIL" } as Record<string, unknown>;
    await fs.writeFile(artifactPath, JSON.stringify(tampered));
    const loaded = await loadProviderLaneEvidenceV1(root, config, "VISUAL", candidate, "visual");
    expect((await verifyProviderLaneEvidenceV1(root, config, loaded!, candidate, sha256Utf8("visual"))).blockers.some((blocker) => blocker.includes(PROVIDER_LANE_EVIDENCE_TAMPERED))).toBe(true);
    await fs.writeFile(artifactPath, JSON.stringify(evidence));
    await fs.appendFile(path.join(root, evidence.rawArtifact), "tampered");
    expect((await verifyProviderLaneEvidenceV1(root, config, evidence, candidate, sha256Utf8("visual"))).blockers.some((blocker) => blocker.includes(PROVIDER_LANE_EVIDENCE_TAMPERED))).toBe(true);
    await fs.writeFile(path.join(root, evidence.rawArtifact), "{\"ok\":true}");
    await fs.rm(screenshot);
    expect((await verifyProviderLaneEvidenceV1(root, config, evidence, candidate, sha256Utf8("visual"))).blockers.some((blocker) => blocker.includes(PROVIDER_LANE_EVIDENCE_TAMPERED))).toBe(true);
  });

  it("verify stays integrity-only: non-PASS evidence status still verifies when binding is valid", async () => {
    // Partial-green support: a FAIL bundle's lane evidence honestly records
    // its FAIL outcome; verify must not turn that record into an integrity
    // blocker. Per-requirement verdicts are decided by test attribution in
    // run.ts, with the bundle failure kept as underlying failure evidence.
    for (const status of ["FAIL", "WARN"] as const) {
      const { root, candidate } = await fixture();
      const evidence = await persistProviderLaneEvidenceV1({
        root, config, lane: "BROWSER", checkId: "status-check", candidate,
        provider: { name: "playwright", version: "1.62.1" }, command: "playwright test",
        status, summary: `browser ${status.toLowerCase()}`, findings: [], rawArtifactText: "{}",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
      });
      const verification = await verifyProviderLaneEvidenceV1(root, config, evidence, candidate, sha256Utf8("playwright test"));
      expect(verification.blockers).toEqual([]);
      expect(verification.ok).toBe(true);
      await expect(requireProviderLaneEvidenceV1(root, config, "BROWSER", candidate, "status-check", sha256Utf8("playwright test"))).resolves.toMatchObject({
        status,
      });
      await expect(requireProviderLaneEvidenceForActionV1({
        root, config, lane: "BROWSER", candidate, checkId: "status-check",
        kind: "browser-test", actionSource: "approved-provider", actionSelector: "shared-browser",
        expectedCommandDigest: sha256Utf8("playwright test")
      })).resolves.toMatchObject({ status });
    }
  });

  it("binds evidence to the executed command: substitution, tampered digest, and missing digest fail closed", async () => {
    // Happy path: matching digest passes.
    {
      const { root, candidate } = await fixture();
      const evidence = await persistProviderLaneEvidenceV1({
        root, config, lane: "BROWSER", checkId: "binding-happy", candidate,
        provider: { name: "playwright", version: "1.62.1" }, command: "playwright test --grep real", status: "PASS",
        summary: "browser passed", findings: [], rawArtifactText: "{}",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
      });
      expect((await verifyProviderLaneEvidenceV1(root, config, evidence, candidate, sha256Utf8("playwright test --grep real"))).ok).toBe(true);
      await expect(requireProviderLaneEvidenceForActionV1({
        root, config, lane: "BROWSER", candidate, checkId: "binding-happy",
        kind: "browser-test", actionSource: "approved-provider", actionSelector: "real-provider",
        expectedCommandDigest: sha256Utf8("playwright test --grep real")
      })).resolves.toMatchObject({ lane: "BROWSER" });
    }
    // Substitution: evidence minted for trivial command A consumed for action B fails.
    {
      const { root, candidate } = await fixture();
      await persistProviderLaneEvidenceV1({
        root, config, lane: "BROWSER", checkId: "binding-sub", candidate,
        provider: { name: "playwright", version: "1.62.1" }, command: "echo trivial", status: "PASS",
        summary: "trivial passed", findings: [], rawArtifactText: "{}",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
      });
      const loaded = await loadProviderLaneEvidenceV1(root, config, "BROWSER", candidate, "binding-sub");
      const verification = await verifyProviderLaneEvidenceV1(root, config, loaded!, candidate, sha256Utf8("playwright test --grep real-action"));
      expect(verification.ok).toBe(false);
      expect(verification.blockers.some((blocker) => blocker.includes(PROVIDER_LANE_EVIDENCE_COMMAND_MISMATCH))).toBe(true);
      await expect(requireProviderLaneEvidenceForActionV1({
        root, config, lane: "BROWSER", candidate, checkId: "binding-sub",
        kind: "browser-test", actionSource: "approved-provider", actionSelector: "real-provider",
        expectedCommandDigest: sha256Utf8("playwright test --grep real-action")
      })).rejects.toThrow(PROVIDER_LANE_EVIDENCE_COMMAND_MISMATCH);
    }
    // Tampered commandDigest file fails closed.
    {
      const { root, candidate } = await fixture();
      const evidence = await persistProviderLaneEvidenceV1({
        root, config, lane: "BROWSER", checkId: "binding-tamper", candidate,
        provider: { name: "playwright", version: "1.62.1" }, command: "playwright test", status: "PASS",
        summary: "browser passed", findings: [], rawArtifactText: "{}",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
      });
      const artifactPath = providerLaneEvidenceArtifactPath(root, config, "BROWSER", candidate, "binding-tamper");
      const tampered = { ...evidence, commandDigest: sha256Utf8("echo forged") };
      await fs.writeFile(artifactPath, JSON.stringify({ ...tampered, digest: evidence.digest }));
      const loaded = await loadProviderLaneEvidenceV1(root, config, "BROWSER", candidate, "binding-tamper");
      // Digest mismatch is reported first (tamper), but a forged digest that
      // collides would still fail the command binding below; assert at least
      // one fail-closed blocker is present.
      const verification = await verifyProviderLaneEvidenceV1(root, config, loaded!, candidate, sha256Utf8("playwright test"));
      expect(verification.ok).toBe(false);
      expect(verification.blockers.length).toBeGreaterThan(0);
    }
    // Missing expected digest at call site fails closed (no undefined default).
    {
      const { root, candidate } = await fixture();
      const evidence = await persistProviderLaneEvidenceV1({
        root, config, lane: "BROWSER", checkId: "binding-missing", candidate,
        provider: { name: "playwright", version: "1.62.1" }, command: "playwright test", status: "PASS",
        summary: "browser passed", findings: [], rawArtifactText: "{}",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
      });
      const verification = await verifyProviderLaneEvidenceV1(root, config, evidence, candidate, undefined as unknown as string);
      expect(verification.ok).toBe(false);
      expect(verification.blockers.some((blocker) => blocker.includes(PROVIDER_LANE_EVIDENCE_COMMAND_MISMATCH))).toBe(true);
      await expect(requireProviderLaneEvidenceForActionV1({
        root, config, lane: "BROWSER", candidate, checkId: "binding-missing",
        kind: "browser-test", actionSource: "approved-provider", actionSelector: "real-provider",
        expectedCommandDigest: undefined as unknown as string
      })).rejects.toThrow(PROVIDER_LANE_EVIDENCE_COMMAND_MISMATCH);
    }
  });

  it("refuses to persist evidence for a workspace that does not match the candidate", async () => {
    const { root, candidate } = await fixture();
    await fs.writeFile(path.join(root, "drift.txt"), "drift");
    await expect(persistProviderLaneEvidenceV1({
      root, config, lane: "CONTRACT", checkId: "drift", candidate,
      provider: { name: "openapi", version: "1" }, command: "compare", status: "PASS",
      summary: "drift", findings: [], rawArtifactText: "{}",
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
    })).rejects.toThrow(PROVIDER_LANE_EVIDENCE_STALE);
  });
});
