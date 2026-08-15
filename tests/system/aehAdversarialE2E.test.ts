import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenCodeRuntimeConfig, validateExecutionCapabilities } from "../../src/agents/permissions.js";
import type { AgentExecutionSelection } from "../../src/agents/types.js";
import { ContextBudgetGateway } from "../../src/context/gateway.js";
import { authorizeRetrieval } from "../../src/context/retrieval/authorization.js";
import { ContextRetrievalGateway } from "../../src/context/retrieval/gateway.js";
import type { HarnessProjectConfig, TaskContract } from "../../src/core/types.js";
import { loadOperationCompletionTarget, notifyOperationCompletion, registerOperationCompletionTarget } from "../../src/operations/completion.js";
import { loadOperation, patchOperation, saveOperation, transitionOperationToTerminal, type OperationRecord } from "../../src/operations/state.js";
import { filterStaleRecords } from "../../src/providers/engram.js";
import { verifyProvenanceManifest, verifySupplyChainGate } from "../../src/provenance/generate.js";
import { runExternalToolValidator } from "../../src/validators/external.js";

const config: HarnessProjectConfig = { version: 1, project: { name: "adversarial-system" }, telemetry: { enabled: false }, evidence: { outputDir: ".harness/evidence" } };
const contract: TaskContract = { version: 1, task: { id: "SCN-FAULT", title: "fault injection" } };

function command(script: string): string { return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`; }

function operation(root: string, id: string, status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" = "RUNNING"): OperationRecord {
  const now = new Date(0).toISOString();
  return { version: 2, id, kind: "run", status, phase: status.toLowerCase(), root, payload: { taskId: `TASK-${id}` }, revision: 1, createdAt: now, updatedAt: now, lastProgressAt: now, supervision: { required: false, materialized: false, generations: [] }, stages: {}, participants: {}, progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 }, notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 } };
}

function contextConfig(): HarnessProjectConfig { return { version: 1, project: { name: "adversarial-system" }, telemetry: { enabled: false }, evidence: { outputDir: ".harness/evidence" }, context: { mode: "enforce", retrieval: { maxRequestsPerTurn: 2, maxTokensPerRequest: 100, maxTotalTokensPerTurn: 200 } } }; }

function selection(role: "implementer" | "reviewer" = "reviewer", overrides: Partial<AgentExecutionSelection> = {}): AgentExecutionSelection {
  return { logicalAgent: `${role}-adversarial`, role, domains: [], runtimeName: "opencode", runtimeAdapter: "opencode", paseoProvider: "opencode", modelAlias: "test", modelId: "test/model", modelName: "model", transport: "direct", skills: [], mcps: [], permissions: { read: "allow", write: role === "reviewer" ? "deny" : "allow", shell: "deny", network: "deny", delegate: "deny", gitWrite: "deny" }, args: [], runtimeCapabilities: { nativeAgent: true }, ...overrides };
}

describe("AEH deterministic adversarial system paths", () => {
  it("fails closed on malformed structured validator output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-malformed-"));
    try {
      const check = await runExternalToolValidator({ root, config, contract, spec: { id: "opengrep-malformed", adapter: "opengrep", command: command("process.stdout.write('noise before json')"), required: true }, baseRef: "HEAD", changedFiles: [] });
      expect(check.status).toBe("FAIL");
      expect(check.message).toContain("malformed evidence");
      expect(check.details?.rawArtifact).toBe(".harness/evidence/opengrep-malformed.raw");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("accepts an explicit empty structured result as a clean validator pass", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-empty-"));
    try {
      const check = await runExternalToolValidator({ root, config, contract, spec: { id: "opengrep-empty", adapter: "opengrep", command: command("process.stdout.write(JSON.stringify({ results: [] }))"), required: true }, baseRef: "HEAD", changedFiles: [] });
      expect(check.status).toBe("PASS");
      expect(check.details?.findingCount).toBe(0);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps non-zero provider exits as failures even when stdout looks valid", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-exit-"));
    try {
      const check = await runExternalToolValidator({ root, config, contract, spec: { id: "trivy-exit", adapter: "trivy", command: command("process.stdout.write(JSON.stringify({ SchemaVersion: 2, Trivy: { Version: '0.70.0' }, ArtifactName: '.', ArtifactType: 'filesystem', Results: [] })); process.exitCode = 7"), required: true }, baseRef: "HEAD", changedFiles: [] });
      expect(check.status).toBe("FAIL");
      expect(check.message).toContain("exit code");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps required provider failures blocking while optional failures remain explicit degradation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-provider-policy-"));
    try {
      const failingCommand = command("process.stderr.write('provider unavailable'); process.exitCode = 9");
      const required = await runExternalToolValidator({ root, config, contract, spec: { id: "required-provider", adapter: "command", command: failingCommand, required: true }, baseRef: "HEAD", changedFiles: [] });
      const optional = await runExternalToolValidator({ root, config, contract, spec: { id: "optional-provider", adapter: "command", command: failingCommand, required: false }, baseRef: "HEAD", changedFiles: [] });
      expect(required.status).toBe("FAIL");
      expect(optional.status).toBe("WARN");
      expect(optional.message).toContain("degraded");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("turns a provider timeout into a blocking result", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-timeout-"));
    try {
      const check = await runExternalToolValidator({ root, config, contract, spec: { id: "timeout", adapter: "command", command: command("setTimeout(() => {}, 500)"), timeoutSeconds: 0.01, required: true }, baseRef: "HEAD", changedFiles: [] });
      expect(check.status).toBe("FAIL");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects a Trivy report with an invalid result member", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-trivy-shape-"));
    try {
      const output = JSON.stringify({ SchemaVersion: 2, Trivy: { Version: "0.70.0" }, ArtifactName: ".", ArtifactType: "filesystem", Results: [{}] });
      const check = await runExternalToolValidator({ root, config, contract, spec: { id: "trivy-shape", adapter: "trivy", command: command(`process.stdout.write(${JSON.stringify(output)})`), required: true }, baseRef: "HEAD", changedFiles: [] });
      expect(check.status).toBe("FAIL");
      expect(check.message).toContain("malformed evidence");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects a browser validator that emits non-JSON noise", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-browser-noise-"));
    try {
      const check = await runExternalToolValidator({ root, config, contract, spec: { id: "playwright-noise", adapter: "playwright", command: command("process.stdout.write('partial report')"), required: true }, baseRef: "HEAD", changedFiles: [] });
      expect(check.status).toBe("FAIL");
      expect(check.message).toContain("malformed evidence");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps a crashing custom process from becoming a pass", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-crash-"));
    try {
      const check = await runExternalToolValidator({ root, config, contract, spec: { id: "crash", adapter: "command", command: command("process.exitCode = 134"), required: true }, baseRef: "HEAD", changedFiles: [] });
      expect(check.status).toBe("FAIL");
      expect(check.message).toContain("exit code");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects context artifacts that escape the operation root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-context-traversal-"));
    try {
      await expect(new ContextBudgetGateway(root, contextConfig(), { telemetry: false }).prepare({ operationId: "TRAVERSAL", logicalAgent: "reviewer", phase: "review", fragments: [{ id: "escape", kind: "raw-evidence", preservation: "VERBATIM", priority: 1, content: "secret", source: { artifact: "../escape.raw" } }] })).rejects.toThrow(/escapes the project root/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects absolute context artifact paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-context-absolute-"));
    try {
      await expect(new ContextBudgetGateway(root, contextConfig(), { telemetry: false }).prepare({ operationId: "ABSOLUTE", logicalAgent: "reviewer", phase: "review", fragments: [{ id: "absolute", kind: "raw-evidence", preservation: "VERBATIM", priority: 1, content: "secret", source: { artifact: path.join(os.tmpdir(), "escape.raw") } }] })).rejects.toThrow(/relative to the project root/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects symlinked context destinations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-context-symlink-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-outside-"));
    try {
      await fs.mkdir(path.join(root, ".harness"), { recursive: true });
      await fs.symlink(outside, path.join(root, ".harness", "escape"));
      await expect(new ContextBudgetGateway(root, contextConfig(), { telemetry: false }).prepare({ operationId: "SYMLINK", logicalAgent: "reviewer", phase: "review", fragments: [{ id: "symlink", kind: "raw-evidence", preservation: "VERBATIM", priority: 1, content: "secret", source: { artifact: ".harness/escape/raw" } }] })).rejects.toThrow(/symbolic link/);
    } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
  });

  it("rejects retrieval when the durable artifact hash is stale", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-retrieval-hash-"));
    try {
      await fs.mkdir(path.join(root, ".harness"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "raw.txt"), "current\n");
      const gateway = new ContextRetrievalGateway(authorizeRetrieval({ root, operationId: "HASH", logicalAgent: "reviewer", allowedFragmentIds: ["raw"], fragments: [{ id: "raw", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 1, content: "old", source: { artifact: ".harness/raw.txt", sha256: "0".repeat(64) } }] }), { maxRequestsPerTurn: 1, maxTokensPerRequest: 100, maxTotalTokensPerTurn: 100 });
      await expect(gateway.retrieve({ fragmentId: "raw" })).rejects.toThrow("CONTEXT_RETRIEVAL_HASH_MISMATCH");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects retrieval without a durable artifact", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-retrieval-missing-"));
    try {
      const gateway = new ContextRetrievalGateway(authorizeRetrieval({ root, operationId: "MISSING", logicalAgent: "reviewer", allowedFragmentIds: ["raw"], fragments: [{ id: "raw", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 1, content: "ephemeral" }] }), { maxRequestsPerTurn: 1, maxTokensPerRequest: 100, maxTotalTokensPerTurn: 100 });
      await expect(gateway.retrieve({ fragmentId: "raw" })).rejects.toThrow("CONTEXT_RETRIEVAL_NO_ARTIFACT");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects cross-operation retrieval even when the fragment id is known elsewhere", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-cross-operation-"));
    try {
      await fs.mkdir(path.join(root, ".harness"), { recursive: true }); await fs.writeFile(path.join(root, ".harness", "other.raw"), "other\n");
      const gateway = new ContextRetrievalGateway(authorizeRetrieval({ root, operationId: "A", logicalAgent: "reviewer", allowedFragmentIds: ["a"], fragments: [{ id: "a", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 1, content: "a", source: { artifact: ".harness/other.raw" } }, { id: "b", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 1, content: "b", source: { artifact: ".harness/other.raw" } }] }), { maxRequestsPerTurn: 1, maxTokensPerRequest: 100, maxTotalTokensPerTurn: 100 });
      await expect(gateway.retrieve({ fragmentId: "b" })).rejects.toThrow("CONTEXT_RETRIEVAL_UNAUTHORIZED");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("does not allow a terminal operation to re-enter active execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-terminal-reentry-"));
    try { await saveOperation(root, operation(root, "TERMINAL", "RUNNING")); await transitionOperationToTerminal(root, "TERMINAL", { status: "SUCCEEDED", phase: "finished" }); expect((await patchOperation(root, "TERMINAL", { status: "RUNNING" })).status).toBe("SUCCEEDED"); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects a direct queued-to-success patch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-queued-success-"));
    try { await saveOperation(root, operation(root, "QUEUED-SUCCESS", "QUEUED")); await expect(patchOperation(root, "QUEUED-SUCCESS", { status: "SUCCEEDED" })).rejects.toThrow("QUEUED -> SUCCEEDED"); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("makes duplicate terminalization idempotent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-duplicate-terminal-"));
    try { await saveOperation(root, operation(root, "DUPLICATE", "RUNNING")); expect((await transitionOperationToTerminal(root, "DUPLICATE", { status: "FAILED", phase: "failed" })).transitioned).toBe(true); expect((await transitionOperationToTerminal(root, "DUPLICATE", { status: "SUCCEEDED", phase: "finished" })).transitioned).toBe(false); expect((await loadOperation(root, "DUPLICATE")).status).toBe("FAILED"); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects unsafe operation identifiers before filesystem access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-operation-id-"));
    try { await expect(loadOperation(root, "../outside")).rejects.toThrow("Invalid operation id"); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("recovers a dead operation lock without accepting corrupted state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-stale-lock-"));
    try { await saveOperation(root, operation(root, "STALE-LOCK", "RUNNING")); const file = path.join(root, ".harness", "operations", "STALE-LOCK.json"); await fs.writeFile(`${file}.lock`, "999999\n"); const updated = await patchOperation(root, "STALE-LOCK", { phase: "recovered" }); expect(updated.phase).toBe("recovered"); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects an implementer whose effective write permission is denied", () => {
    const invalid = selection("implementer", { permissions: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny", gitWrite: "deny" } });
    expect(validateExecutionCapabilities(invalid, "direct").join(" ")).toContain("denies write permission");
  });

  it("rejects a reviewer projection that grants write permission", () => {
    const invalid = selection("reviewer", { permissions: { read: "allow", write: "allow", shell: "deny", network: "deny", delegate: "deny", gitWrite: "deny" } });
    expect(validateExecutionCapabilities(invalid, "direct").join(" ")).toContain("explicitly allows writes");
  });

  it("rejects a native agent that the selected runtime cannot support", () => {
    const invalid = selection("reviewer", { nativeAgent: "native-reviewer", runtimeCapabilities: { nativeAgent: false } });
    expect(validateExecutionCapabilities(invalid, "direct").join(" ")).toContain("cannot select native agent");
  });

  it("preserves deny policy in the concrete runtime projection", () => {
    const projected = buildOpenCodeRuntimeConfig(selection("reviewer"));
    expect(projected.permission).toMatchObject({ edit: "deny", webfetch: "deny", websearch: "deny", task: "deny" });
    expect(JSON.stringify(projected.permission)).toContain("deny");
  });

  it("records completion callback failure without changing terminal truth", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-completion-failure-"));
    try {
      const terminal = operation(root, "COMPLETION", "SUCCEEDED"); await saveOperation(root, terminal); await registerOperationCompletionTarget(root, terminal.id, "lead", "test", async () => undefined);
      const result = await notifyOperationCompletion(root, terminal, { dispatch: async () => ({ exitCode: 1, stdout: "", stderr: "Paseo unavailable", transport: "sdk" as const }), trace: async () => undefined, retryDelaysMs: [0], sleep: async () => undefined });
      expect(result?.status).toBe("FAILED"); expect((await loadOperation(root, terminal.id)).status).toBe("SUCCEEDED");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("fails closed on a malformed completion target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-completion-record-"));
    try { await fs.mkdir(path.join(root, ".harness", "operations"), { recursive: true }); await fs.writeFile(path.join(root, ".harness", "operations", "BAD.completion.json"), JSON.stringify({ version: 1, operationId: "BAD", status: "SENT" })); await expect(loadOperationCompletionTarget(root, "BAD")).rejects.toThrow("invalid completion target"); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("blocks strict delivery when the provenance manifest is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-supply-chain-missing-"));
    try { const result = await verifySupplyChainGate(root, { ...contextConfig(), provenance: { required: true } }); expect(result.ok).toBe(false); expect(result.failures.join(" ")).toContain("requires a provenance manifest"); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects a provenance manifest with an unsafe member path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-provenance-path-"));
    try { await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify({ version: 1, entries: [{ path: "../outside", kind: "final-artifact", sha256: "0".repeat(64) }] })); const result = await verifyProvenanceManifest(root, "manifest.json"); expect(result.ok).toBe(false); expect(result.failures.join(" ")).toContain("invalid manifest entry"); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects modified source behind an otherwise valid memory record", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-memory-stale-"));
    try { const source = path.join(root, "source.md"); await fs.writeFile(source, "normative\n"); const digest = crypto.createHash("sha256").update("normative\n").digest("hex"); await fs.writeFile(source, "changed\n"); expect(await filterStaleRecords(root, [{ project: "p", type: "decision", title: "stale", content: "advisory", source: "source.md", sourceSha256: digest }])).toEqual([]); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
