import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess, commandExists } from "../utils/process.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { sealTask } from "../core/seal.js";
import { verifyTask } from "../core/verify.js";
import { buildRequirementEvidenceGraph } from "../evidence/graph.js";
import { buildRepositoryContextMap } from "../context/repository/map.js";
import { ContextBudgetGateway } from "../context/gateway.js";
import { GraphifyCodeIntelligenceProvider } from "../providers/graphify.js";
import { EngramMemoryProvider } from "../providers/engram.js";
import { SerenaSemanticProvider } from "../context/repository/serena.js";
import { generateProvenance, verifyProvenanceManifest } from "../provenance/generate.js";

export interface FullStackCheck { id: string; stage: string; status: "PASS" | "FAIL" | "SKIP"; required: boolean; message: string; details?: Record<string, unknown>; }
export interface FullStackDogfoodReport { version: 1; profile: "full-stack"; generatedAt: string; status: "PASS" | "FAIL"; checks: FullStackCheck[]; configuredComponents: string[]; limitations: string[]; }

/** Deterministic local dogfood lane. It performs work through production paths; it does not claim that doctor is dogfood. */
export async function runFullStackDogfood(root: string, config: HarnessProjectConfig): Promise<FullStackDogfoodReport> {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-full-stack-"));
  const checks: FullStackCheck[] = [];
  const check = (id: string, stage: string, status: FullStackCheck["status"], message: string, required = false, details?: Record<string, unknown>): void => { checks.push({ id, stage, status, required, message, details }); };
  try {
    await createFixture(fixture);
    const fixtureConfig = fixtureConfiguration(config);
    const contract = fixtureContract();
    await sealTask(fixture, fixtureConfig, contract);
    await fs.appendFile(path.join(fixture, "src", "feature.ts"), "\nexport const accepted = true;\n");
    check("fixture.contract-seal", "specification", "PASS", "TaskContract and seal were created through the production seal path.", true);

    const graphify = new GraphifyCodeIntelligenceProvider(fixtureConfig);
    if (await commandExists("graphify", fixture)) {
      try { await graphify.refresh(fixture); check("provider.graphify", "graphify", "PASS", "Graphify generated and canonicalized the fixture graph.", fixtureConfig.codeIntelligence?.required === true, { fresh: await graphify.isFresh(fixture) }); }
      catch (error) { check("provider.graphify", "graphify", fixtureConfig.codeIntelligence?.required ? "FAIL" : "SKIP", `Graphify integration failed: ${String(error)}`, fixtureConfig.codeIntelligence?.required === true); }
    } else check("provider.graphify", "graphify", "SKIP", "Graphify CLI is not installed in this environment.", fixtureConfig.codeIntelligence?.required === true);

    const map = await buildRepositoryContextMap(fixture, fixtureConfig, { explicitPaths: ["src/feature.ts"] });
    check("context.repository-map", "context", "PASS", `RepoMap rendered through the production context path (${map.map.provider}).`, true, { provider: map.map.provider, selected: map.selected.length });

    let memory: EngramMemoryProvider | undefined;
    if (await commandExists("engram", fixture)) {
      try { memory = new EngramMemoryProvider(fixture); const health = await memory.doctor(fixture); if (!health.ok) throw new Error(health.message); await memory.remember({ project: fixtureConfig.project.name, type: "discovery", title: "Fixture discovery", content: "The fixture uses the production validation and evidence path.", source: ".harness/contracts/FS-1.yaml", sourceSha256: await digest(path.join(fixture, ".harness/contracts/FS-1.yaml")) }); const recalled = await memory.recall(fixtureConfig.project.name, "fixture discovery"); check("provider.engram", "memory", recalled.length ? "PASS" : "FAIL", `Engram store/recall completed (${recalled.length} record(s)).`, true, { recalled: recalled.length }); }
      catch (error) { check("provider.engram", "memory", "FAIL", `Engram integration failed: ${String(error)}`, true); }
    } else check("provider.engram", "memory", "SKIP", "Engram CLI is not installed in this environment.", false);

    const context = new ContextBudgetGateway(fixture, fixtureConfig);
    const prepared = await context.prepare({ operationId: "FS-1", logicalAgent: "full-stack-contract", role: "implementer", phase: "validation", fragments: [{ id: "assignment", kind: "instruction", preservation: "VERBATIM", priority: 100, content: "Validate the deterministic fixture." }, { id: "repo-map", kind: "repository-map", preservation: "PROJECTABLE", priority: 80, content: map.content }, { id: "raw-evidence", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 10, content: "fixture evidence" }, { id: "tool-output", kind: "tool-output", preservation: "COMPRESSIBLE", priority: 20, content: "The deterministic fixture emits bounded tool output that is eligible for controller-side local compression. ".repeat(80) }], capabilities: { authorizedRetrieval: true, semanticRetrieval: false } });
    check("context.budget-gateway", "context", "PASS", `Typed ContextFragments were projected into a bounded envelope (${prepared.metrics.estimatedDeliveredTokens} tokens).`, true, { envelopeSha256: prepared.envelope.provenance.sha256, retrieval: prepared.envelope.retrieval.available });

    if (await commandExists("headroom", fixture)) check("provider.headroom", "context", prepared.metrics.compressedFragments > 0 ? "PASS" : "FAIL", prepared.metrics.compressedFragments > 0 ? "Headroom SDK bridge compressed an eligible fragment through ContextBudgetGateway." : "Headroom was installed but did not compress the eligible fixture fragment.", true, { compressedFragments: prepared.metrics.compressedFragments });
    else check("provider.headroom", "context", "SKIP", "Headroom CLI is not installed in this environment.", false);
    const serena = new SerenaSemanticProvider();
    check("provider.serena", "context", (await commandExists("serena", fixture)) ? "PASS" : "SKIP", (await commandExists("serena", fixture)) ? "Serena executable is available for a transport-specific lane." : "Serena is not installed in this environment.", false);

    const report = await verifyTask(fixture, fixtureConfig, contract);
    check("validation.report", "validation", report.status === "PASS" ? "PASS" : "FAIL", report.status === "PASS" ? `Deterministic validation produced ${report.findings?.length ?? 0} normalized finding(s).` : `Deterministic validation failed: ${report.checks.filter((item) => item.status === "FAIL").map((item) => `${item.id}: ${item.message}`).join("; ")}`, true, { findings: report.findings?.length ?? 0, failedChecks: report.checks.filter((item) => item.status === "FAIL").map((item) => item.id) });
    const graph = await buildRequirementEvidenceGraph({ root: fixture, config: fixtureConfig, contract, report });
    check("evidence.graph", "evidence", graph.complete ? "PASS" : "FAIL", `RequirementEvidenceGraph built with ${graph.nodes.length} nodes and sha256 ${graph.sha256}.${graph.complete ? "" : ` ${graph.reasons.join("; ")}`}`, true, { complete: graph.complete, sha256: graph.sha256 });
    const runFile = path.join(fixture, ".harness", "runs", "FS-1.json"); await fs.mkdir(path.dirname(runFile), { recursive: true }); await fs.writeFile(runFile, JSON.stringify({ taskId: "FS-1", status: report.status, report, evidence: { complete: graph.complete, sha256: graph.sha256 } }));
    const provenance = await generateProvenance(fixture, fixtureConfig, { artifact: "src/feature.ts", taskId: "FS-1", sbom: false });
    const verified = await verifyProvenanceManifest(fixture, provenance.manifestFile);
    check("provenance.chain", "provenance", verified.ok ? "PASS" : "FAIL", verified.ok ? "Provenance generation and verification completed." : verified.failures.join("; "), true, { manifest: provenance.manifestFile });
    await fs.mkdir(path.resolve(root, config.evals?.resultsDir ?? ".harness/evals/results"), { recursive: true });
    const output: FullStackDogfoodReport = { version: 1, profile: "full-stack", generatedAt: new Date().toISOString(), status: checks.some((item) => item.required && item.status === "FAIL") ? "FAIL" : "PASS", checks, configuredComponents: configuredSurface(config), limitations: ["Provider checks marked SKIP were unavailable locally; they are not counted as passes.", "Agent/model execution is intentionally outside the deterministic contract lane."] };
    await fs.writeFile(path.join(path.resolve(root, config.evals?.resultsDir ?? ".harness/evals/results"), `full-stack-${Date.now()}.json`), `${JSON.stringify(output, null, 2)}\n`);
    return output;
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
}

function fixtureConfiguration(base: HarnessProjectConfig): HarnessProjectConfig { return { version: 1, project: { name: `${base.project.name}-full-stack-fixture` }, sdd: { contractsDir: ".harness/contracts", reportsDir: ".harness/reports", runsDir: ".harness/runs" }, validation: { baseRef: "HEAD", requireSeal: true, commands: [{ id: "smoke", command: "node -e \"process.exit(0)\"", required: true }], validators: [{ id: "trivy-evidence", adapter: "trivy", command: "printf '%s' '{\"Results\":[]}'", required: true }] }, evidence: { enabled: true, outputDir: ".harness/evidence", requireComplete: true }, codeIntelligence: { provider: "graphify", required: false, codeOnly: true }, context: { repositoryMap: { enabled: true, tokenBudget: 1_000 }, semanticRetrieval: { provider: "none", required: false }, compression: { provider: "headroom", required: false, minTokens: 2 }, budgets: { default: { inputTokens: 16_000 } } }, telemetry: { enabled: false }, provenance: { outputDir: ".harness/provenance" } }; }
function fixtureContract(): TaskContract { return { version: 1, mode: "spec", task: { id: "FS-1", title: "deterministic full-stack fixture" }, source: { spec: "specs/FS-1.md" }, scope: { allowed: ["src/**", "specs/**", ".harness/**", "graphify-out/**"] }, requirements: [{ id: "REQ-1", description: "changed fixture is validated", validators: ["command.smoke", "trivy-evidence"] }] }; }
async function createFixture(root: string): Promise<void> { await fs.mkdir(path.join(root, "src"), { recursive: true }); await fs.mkdir(path.join(root, "specs"), { recursive: true }); await fs.mkdir(path.join(root, ".harness", "contracts"), { recursive: true }); await fs.writeFile(path.join(root, "src", "feature.ts"), "export const accepted = false;\n"); await fs.writeFile(path.join(root, "specs", "FS-1.md"), "# FS-1\n\nThe fixture must validate a changed source file.\n"); await fs.writeFile(path.join(root, ".harness", "contracts", "FS-1.yaml"), "version: 1\nmode: spec\ntask:\n  id: FS-1\n  title: deterministic full-stack fixture\n"); const init = await runProcess("git init -q && git config user.email aeh@example.invalid && git config user.name AEH && git add . && git commit -qm base", { cwd: root, timeoutMs: 30_000 }); if (init.exitCode !== 0) throw new Error(`Fixture git setup failed: ${init.stderr}`); }
async function digest(file: string): Promise<string> { const crypto = await import("node:crypto"); return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"); }
function configuredSurface(config: HarnessProjectConfig): string[] { const result = ["git", "node", "ContextBudgetGateway", "EvidenceGraph", "provenance"]; if (config.memory?.provider && config.memory.provider !== "none") result.push(`memory:${config.memory.provider}`); if (config.codeIntelligence?.provider && config.codeIntelligence.provider !== "none") result.push(`code-intelligence:${config.codeIntelligence.provider}`); return result; }
