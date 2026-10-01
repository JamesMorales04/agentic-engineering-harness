import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../../src/core/types.js";
import { computeWorktreeDigest } from "../../src/core/git.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import {
  SAST_EVIDENCE_REQUIRED,
  SAST_EVIDENCE_STALE,
  SAST_EVIDENCE_TAMPERED,
  loadSastEvidenceV1,
  persistSastEvidenceV1,
  requireSastEvidenceV1,
  sastEvidenceArtifactPath,
  verifySastEvidenceV1
} from "../../src/security/sastEvidence.js";
import { runExternalToolValidator } from "../../src/validators/external.js";

const config: HarnessProjectConfig = { version: 1, project: { name: "sast-fixtures" }, evidence: { outputDir: ".harness/evidence" } };
const contract: TaskContract = { version: 1, task: { id: "SAST-1", title: "sast fixture" } };
const rawReport = JSON.stringify({ SchemaVersion: 2, Trivy: { Version: "0.70.0" }, ArtifactName: ".", ArtifactType: "filesystem", Results: [] });
const roots: string[] = [];

async function fixture(): Promise<{ root: string; candidate: CandidateRevisionV1 }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-sast-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  const sourceDigest = await computeWorktreeDigest(root);
  const candidate = createCandidateRevisionV1({ operationId: "OP-SAST", candidateId: "CAND-SAST", revision: 1, sourceDigest });
  return { root, candidate };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("candidate-bound SAST evidence", () => {
  it("persists, loads, and verifies evidence bound to the exact candidate revision", async () => {
    const { root, candidate } = await fixture();
    const evidence = await persistSastEvidenceV1({
      root, config, checkId: "sast-scan", adapter: "trivy", candidate,
      command: "trivy fs --format json .", tool: { name: "trivy", version: "0.70.0" },
      status: "PASS", findings: [], rawArtifactText: rawReport,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
    });
    expect(evidence.candidate).toEqual({ candidateId: "CAND-SAST", revision: 1, identityDigest: candidate.identityDigest });
    expect(evidence.artifact).toContain(path.join("sast", `CAND-SAST-r1-${candidate.identityDigest.slice(0, 12)}`));
    expect(evidence.workspace.observedSourceDigest).toBe(candidate.sourceDigest);
    const loaded = await loadSastEvidenceV1(root, config, candidate, "sast-scan");
    expect(loaded?.digest).toBe(evidence.digest);
    const verified = await verifySastEvidenceV1(root, config, loaded!, candidate);
    expect(verified.ok).toBe(true);
    expect((await requireSastEvidenceV1(root, config, candidate, "sast-scan")).digest).toBe(evidence.digest);
  });

  it("blocks with SAST_EVIDENCE_REQUIRED when required evidence is absent", async () => {
    const { root, candidate } = await fixture();
    await expect(requireSastEvidenceV1(root, config, candidate, "missing-scan")).rejects.toThrow(SAST_EVIDENCE_REQUIRED);
    expect(await loadSastEvidenceV1(root, config, candidate, "missing-scan")).toBeUndefined();
  });

  it("blocks evidence for a different candidate as stale", async () => {
    const { root, candidate } = await fixture();
    const evidence = await persistSastEvidenceV1({
      root, config, checkId: "sast-scan", adapter: "opengrep", candidate,
      command: "opengrep scan", tool: { name: "opengrep", version: "1.30.0" },
      status: "PASS", findings: [], rawArtifactText: JSON.stringify({ results: [] }),
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
    });
    const other = createCandidateRevisionV1({ operationId: "OP-SAST", candidateId: "CAND-SAST", revision: 2, sourceDigest: candidate.sourceDigest });
    const verified = await verifySastEvidenceV1(root, config, evidence, other);
    expect(verified.ok).toBe(false);
    expect(verified.blockers.some((blocker) => blocker.includes(SAST_EVIDENCE_STALE))).toBe(true);
  });

  it("detects tampered JSON and tampered raw artifacts", async () => {
    const { root, candidate } = await fixture();
    const evidence = await persistSastEvidenceV1({
      root, config, checkId: "sast-scan", adapter: "trivy", candidate,
      command: "trivy fs", tool: { name: "trivy", version: "0.70.0" },
      status: "PASS", findings: [], rawArtifactText: rawReport,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
    });
    const artifactPath = sastEvidenceArtifactPath(root, config, candidate, "sast-scan");
    const parsed = JSON.parse(await fs.readFile(artifactPath, "utf8")) as Record<string, unknown>;
    parsed.status = "FAIL";
    await fs.writeFile(artifactPath, JSON.stringify(parsed), "utf8");
    const loaded = await loadSastEvidenceV1(root, config, candidate, "sast-scan");
    const verified = await verifySastEvidenceV1(root, config, loaded!, candidate);
    expect(verified.blockers.some((blocker) => blocker.includes(SAST_EVIDENCE_TAMPERED))).toBe(true);
    await fs.writeFile(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await fs.writeFile(path.resolve(root, evidence.rawArtifact), "{\"tampered\":true}", "utf8");
    const reloaded = await loadSastEvidenceV1(root, config, candidate, "sast-scan");
    const reverified = await verifySastEvidenceV1(root, config, reloaded!, candidate);
    expect(reverified.blockers.some((blocker) => blocker.includes(SAST_EVIDENCE_TAMPERED))).toBe(true);
  });

  it("refuses to persist evidence when the workspace no longer matches the candidate", async () => {
    const { root, candidate } = await fixture();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "drifted", version: "2.0.0" }));
    await expect(persistSastEvidenceV1({
      root, config, checkId: "sast-scan", adapter: "trivy", candidate,
      command: "trivy fs", tool: { name: "trivy", version: "0.70.0" },
      status: "PASS", findings: [], rawArtifactText: rawReport,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
    })).rejects.toThrow(SAST_EVIDENCE_STALE);
  });

  it("fails closed with an explicit blocker when a required SAST tool is missing", async () => {
    const { root } = await fixture();
    const originalPath = process.env.PATH;
    process.env.PATH = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-empty-path-"));
    try {
      const check = await runExternalToolValidator({ root, config, contract, spec: { id: "sast-missing", adapter: "opengrep", required: true }, baseRef: "HEAD", changedFiles: [] });
      expect(check.status).toBe("FAIL");
      expect(check.message).toContain("opengrep is not installed");
      const optional = await runExternalToolValidator({ root, config, contract, spec: { id: "sast-optional", adapter: "trivy", required: false }, baseRef: "HEAD", changedFiles: [] });
      expect(optional.status).toBe("WARN");
      expect(optional.message).toContain("trivy is not installed");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("persists candidate-bound evidence when a security validator runs with a candidate binding", async () => {
    const { root, candidate } = await fixture();
    const check = await runExternalToolValidator({
      root, config, contract,
      spec: { id: "sast-bound", adapter: "opengrep", required: true, command: `node -e "process.stdout.write(JSON.stringify({results: []}))"` },
      baseRef: "HEAD", changedFiles: [], candidate
    });
    expect(check.status).toBe("PASS");
    const reference = check.details?.sastEvidence as { artifact?: string; digest?: string } | undefined;
    expect(reference?.artifact).toBeTruthy();
    expect(reference?.digest).toMatch(/^[a-f0-9]{64}$/);
    const evidence = await requireSastEvidenceV1(root, config, candidate, "sast-bound");
    expect(evidence.tool.name).toBe("opengrep");
    expect(evidence.findingCount).toBe(0);
  });

  it("requires an explicit candidate binding when policy demands candidate-bound evidence", async () => {
    const { root } = await fixture();
    const check = await runExternalToolValidator({
      root, config, contract,
      spec: { id: "sast-unbound", adapter: "trivy", required: true, command: `node -e "process.stdout.write(JSON.stringify({SchemaVersion:2,Trivy:{Version:'0.70.0'},ArtifactName:'.',ArtifactType:'filesystem',Results:[]}))"`, options: { requireCandidateBoundEvidence: true } },
      baseRef: "HEAD", changedFiles: []
    });
    expect(check.status).toBe("FAIL");
    expect(check.message).toContain("SAST_CANDIDATE_BINDING_REQUIRED");
  });
});
