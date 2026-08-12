import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createControlPlaneSnapshot, detectControlPlaneDrift, loadFrozenSkillContext } from "../src/core/controlPlane.js";
import { validatePlannerWavePlan } from "../src/agents/waveExecutor.js";
import { buildRequirementEvidenceGraph, evidenceValidationCheck } from "../src/evidence/graph.js";
import { enforceSandboxPolicy, hardenedPodmanArgs } from "../src/security/sandbox.js";
import type { AgentExecutionSelection, ResolvedAgentTopology } from "../src/agents/types.js";
import type { HarnessProjectConfig, TaskContract, ValidationReport } from "../src/core/types.js";

const selection: AgentExecutionSelection = {
  logicalAgent: "worker", role: "implementer", domains: ["*"], runtimeName: "opencode", runtimeAdapter: "opencode", paseoProvider: "opencode", modelAlias: "workhorse", modelId: "test/model", modelName: "model", modelProvider: "test", transport: "direct", skills: [], mcps: [], permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny", gitWrite: "deny" }, args: [], runtimeCapabilities: { modelSelection: true }
};
const topology: ResolvedAgentTopology = { version: 1, skillRoots: [], runtimes: {}, models: {}, agents: { worker: { name: "worker", role: "implementer", execution: { model: "@workhorse" }, runtime: { name: "opencode", adapter: "opencode" }, model: { alias: "workhorse", runtime: "opencode", model: "model", id: "test/model" } } }, routing: [], recovery: {}, councils: {} };

describe("architecture close", () => {
  it("materializes a frozen controller and detects live drift without mutating the snapshot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-control-"));
    try {
      await fs.mkdir(path.join(root, ".harness", "skills", "demo"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "project.yaml"), "version: 1\nproject:\n  name: test\n");
      await fs.writeFile(path.join(root, ".harness", "skills", "demo", "SKILL.md"), "frozen-v1\n");
      const config: HarnessProjectConfig = { version: 1, project: { name: "test" }, controlPlane: { snapshotDir: ".harness/controller" } };
      const snapshot = await createControlPlaneSnapshot(root, config, "T-1");
      expect(snapshot.files.some((file) => file.path === ".harness/skills/demo/SKILL.md")).toBe(true);
      await fs.writeFile(path.join(root, ".harness", "skills", "demo", "SKILL.md"), "mutated-v2\n");
      const drift = await detectControlPlaneDrift(root, snapshot);
      expect(drift.drifted).toBe(true);
      expect(drift.changed).toContain(".harness/skills/demo/SKILL.md");
      const frozen = await loadFrozenSkillContext(root, config, "T-1", ["demo"]);
      expect(frozen).toContain("frozen-v1");
      expect(frozen).not.toContain("mutated-v2");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects a planner wave plan that leaves a requirement unassigned", () => {
    const contract: TaskContract = { version: 1, task: { id: "T", title: "test" }, scope: { allowed: ["src/**"] }, requirements: [{ id: "REQ-1" }, { id: "REQ-2" }] };
    const issues = validatePlannerWavePlan(contract, topology, { tasks: [{ id: "A", summary: "a", agent: "worker", scope: ["src/a.ts"], dependencies: [], acceptance: ["REQ-1"], risk: "low" }], affectedAreas: [], requiredReviewers: [], validationGates: [], fallbackRouting: [], outOfScopeImprovements: [] });
    expect(issues).toContain("requirement REQ-2 is not assigned to any implementation task");
  });

  it("requires both changed implementation files and PASS validators for strict evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-evidence-"));
    try {
      const config: HarnessProjectConfig = { version: 1, project: { name: "test" }, evidence: { enabled: true, requireComplete: true, outputDir: ".harness/evidence" } };
      const contract: TaskContract = { version: 1, task: { id: "E-1", title: "Evidence" }, scope: { allowed: ["src/**"] }, requirements: [{ id: "REQ-1", validator: "test.req1" }] };
      const report: ValidationReport = { version: 1, taskId: "E-1", status: "PASS", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), checks: [{ id: "test.req1", category: "test", status: "PASS", message: "ok" }], changedFiles: [], metadata: { project: "test", baseRef: "main" } };
      const incomplete = await buildRequirementEvidenceGraph({ root, config, contract, report });
      expect(incomplete.complete).toBe(false);
      expect(evidenceValidationCheck(incomplete, config).status).toBe("FAIL");
      const complete = await buildRequirementEvidenceGraph({ root, config, contract, report: { ...report, changedFiles: ["src/a.ts"] } });
      expect(complete.complete).toBe(true);
      expect(complete.requirements[0].files).toEqual(["src/a.ts"]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("forces high-risk work into a hardened Podman sandbox when configured", () => {
    const config: HarnessProjectConfig = { version: 1, project: { name: "test" }, security: { sandbox: { provider: "podman", image: "example/aeh-worker:1", forceForRisks: ["high"], network: false } } };
    const decision = enforceSandboxPolicy(selection, config, "high");
    expect(decision.required).toBe(true);
    expect(decision.selection.transport).toBe("podman");
    const args = hardenedPodmanArgs(config, decision.selection, true);
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).toContain("--network=none");
  });
});
