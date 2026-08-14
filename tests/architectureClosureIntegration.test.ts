import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveContextTransportCapabilities } from "../src/context/transport.js";
import { buildRequirementEvidenceGraph } from "../src/evidence/graph.js";
import { runFullStackDogfood } from "../src/evals/fullStack.js";
import { recordEvent } from "../src/telemetry/events.js";
import { buildAcceptedOperationCandidates } from "../src/memory/candidates.js";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import type { HarnessProjectConfig, TaskContract, ValidationReport } from "../src/core/types.js";

const selection = (runtimeAdapter: string, transport: AgentExecutionSelection["transport"]): AgentExecutionSelection => ({ logicalAgent: "worker", role: "implementer", domains: [], runtimeName: runtimeAdapter, runtimeAdapter, paseoProvider: "none", modelAlias: "test", modelId: "test", modelName: "test", transport, skills: [], mcps: [], permissions: { read: "allow", write: "allow" }, args: [], runtimeCapabilities: {} });

describe("architecture closure integration", () => {
  it("resolves Serena and raw retrieval by effective transport", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-transport-"));
    try {
      const config: HarnessProjectConfig = { version: 1, project: { name: "transport" }, context: { semanticRetrieval: { provider: "serena", required: false }, compression: { provider: "none", required: false } } };
      await expect(resolveContextTransportCapabilities(root, config, selection("codex", "direct"))).resolves.toMatchObject({ semanticRetrieval: false, authorizedRetrieval: false });
      await expect(resolveContextTransportCapabilities(root, config, selection("opencode", "direct"))).resolves.toMatchObject({ semanticRetrieval: true, authorizedRetrieval: true });
      await expect(resolveContextTransportCapabilities(root, { ...config, context: { ...config.context, semanticRetrieval: { provider: "serena", required: true } } }, selection("codex", "direct"))).rejects.toThrow("UNSUPPORTED_CAPABILITY");
      await expect(resolveContextTransportCapabilities(root, { ...config, security: { sandbox: { image: "missing-image" } } }, selection("opencode", "podman"))).resolves.toMatchObject({ semanticRetrieval: false, authorizedRetrieval: false });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("carries normalized validator findings into the requirement evidence graph", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-evidence-flow-"));
    try {
      const config: HarnessProjectConfig = { version: 1, project: { name: "evidence" }, evidence: { enabled: true, outputDir: ".harness/evidence" } };
      const contract: TaskContract = { version: 1, task: { id: "E-1", title: "evidence" }, scope: { allowed: ["src/**"] }, requirements: [{ id: "R-1", description: "source is checked", validators: ["trivy"] }] };
      const report: ValidationReport = { version: 1, taskId: "E-1", status: "PASS", startedAt: "", finishedAt: "", changedFiles: ["src/a.ts"], checks: [{ id: "trivy", category: "security", status: "PASS", message: "structured output", details: { findings: [{ fingerprint: "f".repeat(64), tool: "trivy", kind: "vulnerability", rule: "CVE-1", severity: "HIGH", file: "src/a.ts", message: "bounded finding" }] } }], findings: [{ fingerprint: "f".repeat(64), tool: "trivy", kind: "vulnerability", rule: "CVE-1", severity: "HIGH", file: "src/a.ts", message: "bounded finding" }], metadata: { project: "evidence", baseRef: "HEAD" } };
      const graph = await buildRequirementEvidenceGraph({ root, config, contract, report });
      expect(graph.nodes.some((node) => node.type === "finding" && node.data?.tool === "trivy")).toBe(true);
      expect(graph.nodes.find((node) => node.type === "finding")?.data).not.toHaveProperty("stdout");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("runs the deterministic full-stack production-path fixture", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-full-stack-report-"));
    try { const report = await runFullStackDogfood(root, { version: 1, project: { name: "dogfood" }, evals: { resultsDir: ".harness/evals/results" } }); expect(report.status).toBe("PASS"); expect(report.checks.map((item) => item.id)).toEqual(expect.arrayContaining(["context.budget-gateway", "validation.report", "evidence.graph", "provenance.chain"])); } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 120_000);

  it("builds source-hash-verified accepted-operation memory candidates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-memory-candidates-"));
    try {
      await fs.mkdir(path.join(root, ".harness", "reports"), { recursive: true }); await fs.writeFile(path.join(root, "run.json"), "run artifact\n"); await fs.writeFile(path.join(root, ".harness", "reports", "M-1.json"), "report artifact\n");
      const contract: TaskContract = { version: 1, task: { id: "M-1", title: "memory" } }; const report: ValidationReport = { version: 1, taskId: "M-1", status: "PASS", startedAt: "", finishedAt: "", changedFiles: [], checks: [{ id: "test", category: "test", status: "PASS", message: "pass" }], metadata: { project: "memory", baseRef: "HEAD" } };
      const candidates = await buildAcceptedOperationCandidates({ root, project: "memory", contract, result: { taskId: "M-1", status: "PASS", attempts: 0, report }, runFile: path.join(root, "run.json"), reportFile: path.join(root, ".harness", "reports", "M-1.json") });
      expect(candidates).toHaveLength(1); expect(candidates[0].sourceSha256).toMatch(/^[a-f0-9]{64}$/); expect(candidates[0].content).not.toContain("chain of thought");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps local telemetry durable without a collector and records phase siblings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-otel-local-"));
    try {
      const config: HarnessProjectConfig = { version: 1, project: { name: "otel" }, telemetry: { enabled: true, exporter: "none" } };
      await recordEvent(root, config, "harness.run.start", { operationId: "OTEL-1", status: "RUNNING" }); await recordEvent(root, config, "harness.plan.ready", { operationId: "OTEL-1", status: "PASS" }); await recordEvent(root, config, "harness.verify.finish", { operationId: "OTEL-1", status: "PASS" });
      await recordEvent(root, config, "harness.validation.error", { operationId: "OTEL-ERR", status: "FAIL", error: "bounded failure" }); await recordEvent(root, config, "harness.run.finish", { operationId: "OTEL-ERR", status: "FAIL" });
      const lines = (await fs.readFile(path.join(root, ".harness/telemetry/events.ndjson"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { name: string; traceId: string; spanId: string; parentSpanId?: string; status?: string; attributes?: Record<string, unknown> });
      const events = lines.filter((line) => line.attributes?.["aeh.recorded"] === true);
      expect(events).toHaveLength(5); expect(new Set(lines.filter((line) => line.attributes?.["operationId"] === "OTEL-1").map((line) => line.traceId)).size).toBe(1); expect(events[1].parentSpanId).not.toBe(events[0].spanId); expect(lines.find((line) => line.name === "harness.validation.error" && line.attributes?.["aeh.recorded"] !== true)?.status).toBe("ERROR");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
