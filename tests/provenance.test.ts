import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProvenanceManifest, buildSlsaPredicate, sha256File, verifyProvenanceManifest } from "../src/provenance/generate.js";

describe("provenance", () => {
  it("hashes artifacts deterministically", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-prov-"));
    const file = path.join(dir, "artifact.txt");
    await fs.writeFile(file, "hello");
    expect(await sha256File(file)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("creates SLSA v1 build/run details", () => {
    const predicate = buildSlsaPredicate({ project: "x", artifact: "a.tgz", taskId: "T-1", commit: "abc", remote: "https://example/repo.git", buildType: "https://example/build", invocationId: "i", startedOn: "s", finishedOn: "f" }) as any;
    expect(predicate.buildDefinition.buildType).toBe("https://example/build");
    expect(predicate.runDetails.metadata.invocationId).toBe("i");
  });

  it("limits task manifests to explicit lineage and detects normative artifact tampering", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-lineage-"));
    try {
      const config = { version: 1 as const, project: { name: "lineage" }, sdd: { contractsDir: ".harness/contracts", reportsDir: ".harness/reports", runsDir: ".harness/runs" }, evidence: { outputDir: ".harness/evidence" } };
      for (const directory of [".harness/contracts", ".harness/reports", ".harness/runs", ".harness/evidence", ".harness/operations", ".harness/operations/OP-1"]) await fs.mkdir(path.join(root, directory), { recursive: true });
      await fs.writeFile(path.join(root, "artifact.txt"), "artifact\n"); await fs.writeFile(path.join(root, "spec.md"), "spec\n"); await fs.writeFile(path.join(root, ".harness/contracts", "T-1.yaml"), "contract\n"); await fs.writeFile(path.join(root, ".harness/reports", "T-1.json"), "{}\n"); await fs.writeFile(path.join(root, ".harness/runs", "T-1.json"), "{}\n"); await fs.writeFile(path.join(root, ".harness/evidence", "T-1.json"), "{}\n"); await fs.writeFile(path.join(root, ".harness/operations", "OP-1.json"), JSON.stringify({ version: 2, id: "OP-1", kind: "run", payload: { taskId: "T-1" }, updatedAt: new Date().toISOString(), result: { report: ".harness/reports/T-1.json" } })); await fs.writeFile(path.join(root, ".harness/operations", "UNRELATED.json"), JSON.stringify({ version: 2, id: "UNRELATED", kind: "run", payload: { taskId: "OTHER" }, updatedAt: new Date().toISOString() })); await fs.writeFile(path.join(root, ".harness/operations/OP-1", "events.ndjson"), "event\n");
      const manifest = await buildProvenanceManifest(root, config, "T-1", path.join(root, "artifact.txt")); const file = path.join(root, "manifest.json"); await fs.writeFile(file, `${JSON.stringify(manifest)}\n`);
      expect(manifest.entries.some((entry) => entry.path.includes("UNRELATED"))).toBe(false); expect(manifest.lineage?.operationId).toBe("OP-1"); expect((await verifyProvenanceManifest(root, "manifest.json")).ok).toBe(true);
      await fs.writeFile(path.join(root, ".harness/contracts", "T-1.yaml"), "tampered\n"); expect((await verifyProvenanceManifest(root, "manifest.json")).ok).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
