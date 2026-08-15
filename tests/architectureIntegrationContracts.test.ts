import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProvenanceManifest, verifyProvenanceManifest } from "../src/provenance/generate.js";
import { buildOpaInput } from "../src/validators/opa.js";
import { exportEventSpan, type TraceContext } from "../src/telemetry/otlp.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";

describe("end-to-end architecture boundaries", () => {
  it("detects tampering in the provenance manifest chain", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-provenance-chain-"));
    try {
      await fs.mkdir(path.join(root, ".harness", "contracts"), { recursive: true });
      await fs.writeFile(path.join(root, "artifact.txt"), "before\n");
      const config: HarnessProjectConfig = { version: 1, project: { name: "p" }, sdd: { contractsDir: ".harness/contracts" } };
      const manifest = await buildProvenanceManifest(root, config, "T-1", path.join(root, "artifact.txt"));
      const manifestFile = path.join(root, "manifest.json"); await fs.writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
      expect((await verifyProvenanceManifest(root, "manifest.json")).ok).toBe(true);
      await fs.writeFile(path.join(root, "artifact.txt"), "tampered\n");
      const result = await verifyProvenanceManifest(root, "manifest.json"); expect(result.ok).toBe(false); expect(result.failures[0]).toContain("artifact.txt");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("builds OPA input from the effective execution identity", () => {
    const contract: TaskContract = { version: 1, task: { id: "T", title: "t" }, routing: { risk: "high" } };
    const input = buildOpaInput(contract, ["src/a.ts"], [".harness/contracts/T.yaml"], { newDependencies: [], schemaChanged: false, schemaFiles: [] }, { operationId: "OP", operationKind: "change", logicalAgent: "reviewer-2", role: "reviewer", profile: "strict", domains: ["security"], runtime: "opencode", modelAlias: "brain", permissions: { write: "deny", network: "deny" } });
    expect(input.identity).toMatchObject({ logicalAgent: "reviewer-2", role: "reviewer", profile: "strict", risk: "high", runtime: "opencode", modelAlias: "brain" });
    expect(input).not.toHaveProperty("workerRole");
  });

  it("uses one trace id with parent span linkage for operation events", async () => {
    const payloads: any[] = [];
    const server = http.createServer((request, response) => { let body = ""; request.on("data", (chunk) => { body += chunk.toString(); }); request.on("end", () => { payloads.push(JSON.parse(body)); response.writeHead(200); response.end(); }); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("trace test server did not bind");
    try {
      const config: HarnessProjectConfig = { version: 1, project: { name: "trace", telemetry: undefined } };
      const rootContext: TraceContext = { traceId: "0123456789abcdef0123456789abcdef", spanId: "1111111111111111" };
      const childContext: TraceContext = { traceId: rootContext.traceId, parentSpanId: rootContext.spanId, spanId: "2222222222222222" };
      const otelConfig = { ...config, telemetry: { exporter: "otlp-http-json" as const, endpoint: `http://127.0.0.1:${address.port}` } };
      await exportEventSpan(otelConfig, "operation.root", { operationId: "OP" }, new Date(), rootContext);
      await exportEventSpan(otelConfig, "operation.child", { operationId: "OP" }, new Date(), childContext);
      expect(payloads[0].resourceSpans[0].scopeSpans[0].spans[0].traceId).toBe(rootContext.traceId);
      expect(payloads[1].resourceSpans[0].scopeSpans[0].spans[0].traceId).toBe(rootContext.traceId);
      expect(payloads[1].resourceSpans[0].scopeSpans[0].spans[0].parentSpanId).toBe(rootContext.spanId);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
