import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_SEMANTIC_ASSESSOR_CLEANUP_ATTEMPTS_V1,
  MAX_SEMANTIC_ASSESSOR_CLEANUP_SWEEP_V1,
  PaseoSemanticAssessmentRunnerV1,
  retryOrphanedAssessorCleanupV1,
} from "../src/semantic/runtime.js";
import { semanticAssessorTopologySource, semanticPayload, semanticTestRequest } from "./semanticAssessmentSupport.js";

async function traceNames(root: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(root, ".harness", "telemetry", "paseo.ndjson"), "utf8").catch(() => "");
  if (!raw.trim()) return [];
  return raw.split(/\r?\n/).filter(Boolean).map((line) => (JSON.parse(line) as { name: string }).name);
}

describe("P-NEW-3 semantic assessor orphan cleanup retry", () => {
  it("exposes bounded retry constants (no unbounded loop)", () => {
    expect(MAX_SEMANTIC_ASSESSOR_CLEANUP_SWEEP_V1).toBeGreaterThan(0);
    expect(MAX_SEMANTIC_ASSESSOR_CLEANUP_SWEEP_V1).toBeLessThanOrEqual(20);
    expect(MAX_SEMANTIC_ASSESSOR_CLEANUP_ATTEMPTS_V1).toBeGreaterThan(0);
    expect(MAX_SEMANTIC_ASSESSOR_CLEANUP_ATTEMPTS_V1).toBeLessThanOrEqual(5);
  });

  it("sweeps pre-operation orphans by aeh.kind label and archives them before a new session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-pnew3-sweep-"));
    try {
      const orphan = { id: "orphan-assessor-1", workspaceId: "ws-orphan-1", labels: { "aeh.kind": "semantic-assessment", "aeh.role": "Semantic Assessor" }, status: "idle", raw: {} };
      const list = vi.fn(async (_r: string, labels: Record<string, string>) => {
        expect(labels).toMatchObject({ "aeh.kind": "semantic-assessment" });
        return [orphan];
      });
      const archiveAgent = vi.fn(async () => undefined);
      const archiveWorkspace = vi.fn(async () => undefined);
      const result = await retryOrphanedAssessorCleanupV1(root, { list, archiveAgent, archiveWorkspace });
      expect(list).toHaveBeenCalledTimes(1);
      expect(archiveAgent).toHaveBeenCalledWith(root, "orphan-assessor-1");
      expect(result.retried).toBe(1);
      const names = await traceNames(root);
      expect(names.some((n) => n.endsWith("semantic.assessor.cleanup-retried"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves operation-owned assessor sessions (never claims registered/live work)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-pnew3-preserve-"));
    try {
      const owned = { id: "owned-assessor-1", labels: { "aeh.kind": "semantic-assessment", "aeh.operation": "OP-1" }, status: "idle", raw: {} };
      const list = vi.fn(async () => [owned]);
      const archiveAgent = vi.fn(async () => undefined);
      const result = await retryOrphanedAssessorCleanupV1(root, { list, archiveAgent });
      expect(archiveAgent).not.toHaveBeenCalled();
      expect(result.retried).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("caps retries and traces persistently after exhaustion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-pnew3-exhaust-"));
    try {
      const orphan = { id: "orphan-stuck-1", labels: { "aeh.kind": "semantic-assessment" }, status: "idle", raw: {} };
      const list = vi.fn(async () => [orphan]);
      const archiveAgent = vi.fn(async () => { throw new Error("archive failed"); });
      for (let i = 0; i < MAX_SEMANTIC_ASSESSOR_CLEANUP_ATTEMPTS_V1 + 2; i += 1) {
        await retryOrphanedAssessorCleanupV1(root, { list, archiveAgent });
      }
      // Bounded: never more than MAX attempts actually tried.
      expect(archiveAgent.mock.calls.length).toBeLessThanOrEqual(MAX_SEMANTIC_ASSESSOR_CLEANUP_ATTEMPTS_V1);
      const names = await traceNames(root);
      expect(names.some((n) => n.endsWith("semantic.assessor.cleanup-retry-exhausted"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runner retries orphan cleanup before creating a new assessor session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-pnew3-runner-"));
    try {
      await fs.mkdir(path.join(root, ".harness"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "agents.source.jsonc"), JSON.stringify(semanticAssessorTopologySource), "utf8");
      const order: string[] = [];
      const list = vi.fn(async () => { order.push("list"); return []; });
      const launch = vi.fn(async (_cwd: string, _opts: unknown) => {
        order.push("launch");
        return { id: "new-session-1", exitCode: 0, stdout: JSON.stringify(semanticPayload(semanticTestRequest("STACK"))), stderr: "", transport: "sdk" as const };
      });
      const { resolveSemanticAssessor } = await import("../src/semantic/assessment.js");
      const { loadResolvedAgentTopology } = await import("../src/agents/config.js");
      const { default: cfg } = await import("node:fs/promises").then(() => ({ default: undefined }));
      void cfg;
      const config = { version: 1 as const, project: { name: "runtime-test" }, agents: { configPath: ".harness/agents.source.jsonc" } };
      const topology = await loadResolvedAgentTopology(root, config as never, undefined);
      const assessor = resolveSemanticAssessor(topology);
      const runner = new PaseoSemanticAssessmentRunnerV1({ root, assessor, projectName: "runtime-test", launch: launch as never, cleanup: { list } as never });
      await runner.assess({ request: semanticTestRequest("STACK"), assessor: assessor.identity });
      expect(order).toEqual(["list", "launch"]);
      expect(list).toHaveBeenCalledTimes(1);
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
