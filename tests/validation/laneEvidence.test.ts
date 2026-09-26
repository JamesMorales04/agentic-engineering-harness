import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig } from "../../src/core/types.js";
import { computeWorktreeDigest } from "../../src/core/git.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import {
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
      expect((await verifyProviderLaneEvidenceV1(root, config, loaded!, candidate)).ok).toBe(true);
      expect((await requireProviderLaneEvidenceV1(root, config, lane, candidate, `${lane.toLowerCase()}-check`)).digest).toBe(evidence.digest);
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
    const bareVerification = await verifyProviderLaneEvidenceV1(root, config, bare, candidate);
    expect(bareVerification.ok).toBe(false);
    expect(bareVerification.blockers.every((blocker) => blocker.includes(PROVIDER_LANE_REFERENCE_REQUIRED))).toBe(true);
    await expect(requireProviderLaneEvidenceV1(root, config, "VISUAL", candidate, "visual-bare")).rejects.toThrow(PROVIDER_LANE_REFERENCE_REQUIRED);
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
    expect((await verifyProviderLaneEvidenceV1(root, config, bound, candidate)).ok).toBe(true);
    await fs.writeFile(baseline, "baseline-tampered");
    const tampered = await verifyProviderLaneEvidenceV1(root, config, bound, candidate);
    expect(tampered.ok).toBe(false);
    expect(tampered.blockers.some((blocker) => blocker.includes(PROVIDER_LANE_EVIDENCE_TAMPERED))).toBe(true);
  });

  it("requires specialized lane checks to have provider-produced evidence instead of synthesizing it from a raw check", async () => {
    const { root, candidate } = await fixture();
    await expect(requireProviderLaneEvidenceForActionV1({
      root, config, lane: "BROWSER", candidate, checkId: "command.candidate-impact-browser",
      kind: "browser-test", actionSource: "project-script", actionSelector: "e2e"
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
      kind: "browser-test", actionSource: "project-script", actionSelector: "e2e"
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
    await expect(requireProviderLaneEvidenceV1(root, config, "VISUAL", candidate, "journey")).rejects.toThrow(PROVIDER_LANE_EVIDENCE_REQUIRED);
    await expect(requireProviderLaneEvidenceV1(root, config, "BROWSER", candidate, "missing-check")).rejects.toThrow(PROVIDER_LANE_EVIDENCE_REQUIRED);
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
    const verified = await verifyProviderLaneEvidenceV1(root, config, evidence, other);
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
    expect((await verifyProviderLaneEvidenceV1(root, config, loaded!, candidate)).blockers.some((blocker) => blocker.includes(PROVIDER_LANE_EVIDENCE_TAMPERED))).toBe(true);
    await fs.writeFile(artifactPath, JSON.stringify(evidence));
    await fs.appendFile(path.join(root, evidence.rawArtifact), "tampered");
    expect((await verifyProviderLaneEvidenceV1(root, config, evidence, candidate)).blockers.some((blocker) => blocker.includes(PROVIDER_LANE_EVIDENCE_TAMPERED))).toBe(true);
    await fs.writeFile(path.join(root, evidence.rawArtifact), "{\"ok\":true}");
    await fs.rm(screenshot);
    expect((await verifyProviderLaneEvidenceV1(root, config, evidence, candidate)).blockers.some((blocker) => blocker.includes(PROVIDER_LANE_EVIDENCE_TAMPERED))).toBe(true);
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
