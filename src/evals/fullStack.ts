import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess, commandExists } from "../utils/process.js";
import type { AgentExecutionSelection } from "../agents/types.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { sealTask } from "../core/seal.js";
import { verifyTask } from "../core/verify.js";
import { buildRequirementEvidenceGraph } from "../evidence/graph.js";
import { buildRepositoryContextMap } from "../context/repository/map.js";
import { buildEffectivePrompt } from "../workers/agentPrompt.js";
import { HeadroomCompressionProvider } from "../context/compression/headroom.js";
import { GraphifyCodeIntelligenceProvider } from "../providers/graphify.js";
import { EngramMemoryProvider } from "../providers/engram.js";
import { runSerenaMcpContract } from "../providers/serenaMcp.js";
import { generateProvenance, verifyProvenanceManifest } from "../provenance/generate.js";

export interface FullStackCheck { id: string; stage: string; status: "PASS" | "FAIL" | "SKIP"; required: boolean; message: string; details?: Record<string, unknown>; }
export interface FullStackDogfoodReport { version: 1; profile: "full-stack"; generatedAt: string; status: "PASS" | "FAIL"; checks: FullStackCheck[]; configuredComponents: string[]; limitations: string[]; }

/** Deterministic local dogfood lane, with strict CI mode requiring installed providers. */
export async function runFullStackDogfood(root: string, config: HarnessProjectConfig): Promise<FullStackDogfoodReport> {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-full-stack-"));
  const strict = config.evals?.fullStack?.strictSupplyChain === true || process.env.AEH_STRICT_FULL_STACK === "1";
  const checks: FullStackCheck[] = [];
  const check = (id: string, stage: string, status: FullStackCheck["status"], message: string, required = false, details?: Record<string, unknown>): void => { checks.push({ id, stage, status, required, message, details }); };
  try {
    await createFixture(fixture);
    const fixtureConfig = fixtureConfiguration(config, strict);
    const contract = fixtureContract(strict);
    await sealTask(fixture, fixtureConfig, contract);
    await fs.appendFile(path.join(fixture, "src", "feature.ts"), "\nexport const accepted = true;\n");
    check("fixture.contract-seal", "specification", "PASS", "TaskContract and seal were created through the production seal path.", true);

    const graphify = new GraphifyCodeIntelligenceProvider(fixtureConfig);
    if (await commandExists("graphify", fixture)) {
      try { await graphify.refresh(fixture); check("provider.graphify", "graphify", "PASS", "Graphify generated and canonicalized the fixture graph.", fixtureConfig.codeIntelligence?.required === true, { fresh: await graphify.isFresh(fixture) }); }
      catch (error) { check("provider.graphify", "graphify", fixtureConfig.codeIntelligence?.required ? "FAIL" : "SKIP", "Graphify integration failed: " + String(error), fixtureConfig.codeIntelligence?.required === true); }
    } else check("provider.graphify", "graphify", "SKIP", "Graphify CLI is not installed in this environment.", fixtureConfig.codeIntelligence?.required === true);

    const map = await buildRepositoryContextMap(fixture, fixtureConfig, { explicitPaths: ["src/feature.ts"] });
    check("context.repository-map", "context", "PASS", "RepoMap rendered through the production context path (" + map.map.provider + ").", true, { provider: map.map.provider, selected: map.selected.length });

    if (fixtureConfig.memory?.provider === "engram" && await commandExists("engram", fixture)) {
      try {
        const memory = new EngramMemoryProvider(fixture);
        const health = await memory.doctor(fixture);
        if (!health.ok) throw new Error(health.message);
        await memory.remember({ project: fixtureConfig.project.name, type: "discovery", title: "Fixture discovery", content: "The fixture uses the production validation and evidence path.", source: ".harness/contracts/FS-1.yaml", sourceSha256: await digest(path.join(fixture, ".harness/contracts/FS-1.yaml")) });
        const recalled = await memory.recall(fixtureConfig.project.name, "fixture discovery");
        check("provider.engram", "memory", recalled.length ? "PASS" : "FAIL", "Engram store/recall completed (" + recalled.length + " record(s)).", strict, { recalled: recalled.length });
      } catch (error) { check("provider.engram", "memory", "FAIL", "Engram integration failed: " + String(error), strict); }
    } else if (fixtureConfig.memory?.provider === "engram") check("provider.engram", "memory", "SKIP", "Engram CLI is not installed in this environment.", strict);

    if (strict) {
      const headroom = await new HeadroomCompressionProvider().doctor(fixture);
      check("provider.headroom", "context", headroom.ok ? "PASS" : "FAIL", headroom.ok ? "Pinned Headroom SDK bridge is ready for the production ContextBudgetGateway." : headroom.message, true, { version: headroom.version });
      if (await commandExists("serena", fixture)) {
        try {
          const result = await runSerenaMcpContract(fixture);
          check("provider.serena", "context", result.toolNames.includes("get_symbols_overview") ? "PASS" : "FAIL", "Serena MCP initialized, exposed " + result.toolNames.length + " tools and returned a fixture symbol through " + result.semanticTool + ".", true, { semanticTool: result.semanticTool, toolCount: result.toolNames.length });
        } catch (error) { check("provider.serena", "context", "FAIL", "Serena MCP contract failed: " + String(error), true); }
      } else check("provider.serena", "context", "SKIP", "Serena CLI is not installed in this environment.", true);
    }

    const report = await verifyTask(fixture, fixtureConfig, contract);
    const failedChecks = report.checks.filter((item) => item.status === "FAIL").map((item) => item.id);
    check("validation.report", "validation", report.status === "PASS" ? "PASS" : "FAIL", report.status === "PASS" ? "Deterministic validation produced " + (report.findings?.length ?? 0) + " normalized finding(s)." : "Deterministic validation failed: " + failedChecks.join("; "), true, { findings: report.findings?.length ?? 0, failedChecks });
    const graph = await buildRequirementEvidenceGraph({ root: fixture, config: fixtureConfig, contract, report });
    check("evidence.graph", "evidence", graph.complete ? "PASS" : "FAIL", "RequirementEvidenceGraph built with " + graph.nodes.length + " nodes and sha256 " + graph.sha256 + (graph.complete ? "." : " " + graph.reasons.join("; ")), true, { complete: graph.complete, sha256: graph.sha256 });
    const runFile = path.join(fixture, ".harness", "runs", "FS-1.json");
    await fs.mkdir(path.dirname(runFile), { recursive: true });
    const operationId = "FS-1-operation";
    await fs.mkdir(path.join(fixture, ".harness", "operations"), { recursive: true });
    await fs.writeFile(runFile, JSON.stringify({ taskId: "FS-1", operationId, status: report.status, report, evidence: { complete: graph.complete, sha256: graph.sha256 } }));
    await fs.writeFile(path.join(fixture, ".harness", "operations", operationId + ".json"), JSON.stringify({ version: 2, id: operationId, kind: "run", status: "COMPLETED", payload: { taskId: "FS-1" }, updatedAt: new Date().toISOString(), result: { taskId: "FS-1", report: ".harness/reports/FS-1.json", evidence: ".harness/evidence/FS-1.json" } }));

    const selection = productionSelection();
    try {
      const rendered = await buildEffectivePrompt(fixture, fixtureConfig, contract, selection, "Validate the changed fixture and preserve the accepted operation evidence.", { phase: "validation", operationKind: "run" });
      const envelope = JSON.parse(await fs.readFile(path.join(fixture, ".harness", "context", "FS-1", "envelope.json"), "utf8")) as { fragments: Array<{ id: string; content: string; compressed?: boolean; compression?: { reversible: boolean; handle?: string } }>; retrieval: { available: boolean } };
      const ids = envelope.fragments.map((fragment) => fragment.id);
      const requiredIds = ["execution-envelope", "agent-charter", "task-assignment", "task-contract", "sealed-acceptance", "repository-map", "validation-evidence", "advisory-memory", "raw-evidence-references"];
      const missing = requiredIds.filter((id) => !ids.includes(id));
      const compressed = envelope.fragments.filter((fragment) => fragment.compressed);
      const allowedNonStrictMissing = !strict && missing.every((id) => id === "advisory-memory");
      const contextPass = rendered.includes("AEH ContextEnvelope") && (missing.length === 0 || allowedNonStrictMissing);
      check("context.production-assembly", "context", contextPass ? "PASS" : "FAIL", contextPass ? "buildEffectivePrompt assembled the production envelope with normative, RepoMap, memory, validation/evidence, retrieval and the configured Headroom gateway." : "Production context assembly is incomplete: " + missing.join(", ") + ".", true, { fragmentIds: ids, compressedFragments: compressed.length, compressionProvider: fixtureConfig.context?.compression?.provider, retrievalAvailable: envelope.retrieval.available });
      if (strict && compressed.length > 0) check("context.reversibility", "context", compressed.every((fragment) => fragment.compression?.reversible === true && Boolean(fragment.compression.handle)) ? "PASS" : "FAIL", compressed.every((fragment) => fragment.compression?.reversible === true && Boolean(fragment.compression.handle)) ? "Compressed production context carries AEH recovery handles." : "Compressed production context did not carry an AEH recovery handle.", true);
    } catch (error) { check("context.production-assembly", "context", "FAIL", "Production context assembly failed: " + String(error), true); }

    const provenance = await generateProvenance(fixture, fixtureConfig, { artifact: "src/feature.ts", taskId: "FS-1", sbom: false });
    const verified = await verifyProvenanceManifest(fixture, provenance.manifestFile);
    check("provenance.chain", "provenance", verified.ok ? "PASS" : "FAIL", verified.ok ? "Provenance generation and verification completed." : verified.failures.join("; "), true, { manifest: provenance.manifestFile });
    await fs.mkdir(path.resolve(root, config.evals?.resultsDir ?? ".harness/evals/results"), { recursive: true });
    const output: FullStackDogfoodReport = { version: 1, profile: "full-stack", generatedAt: new Date().toISOString(), status: checks.some((item) => item.required && item.status !== "PASS") ? "FAIL" : "PASS", checks, configuredComponents: configuredSurface(fixtureConfig), limitations: ["Agent/model execution is intentionally outside the deterministic contract lane.", ...(strict ? [] : ["Strict provider requirements are enabled only in the dedicated CI lane."])] };
    await fs.writeFile(path.join(path.resolve(root, config.evals?.resultsDir ?? ".harness/evals/results"), "full-stack-" + Date.now() + ".json"), JSON.stringify(output, null, 2) + "\n");
    return output;
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
}

function fixtureConfiguration(base: HarnessProjectConfig, strict: boolean): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: base.project.name + "-full-stack-fixture" },
    memory: { provider: "engram", required: strict },
    sdd: { contractsDir: ".harness/contracts", reportsDir: ".harness/reports", runsDir: ".harness/runs" },
    validation: { baseRef: "HEAD", requireSeal: true, commands: [{ id: "smoke", command: "node -e \"process.exit(0)\"", required: true }], validators: [{ id: "trivy-evidence", adapter: "trivy", required: strict }] },
    evidence: { enabled: true, outputDir: ".harness/evidence", requireComplete: true },
    codeIntelligence: { provider: "graphify", required: strict, codeOnly: true },
    context: { repositoryMap: { enabled: true, tokenBudget: 1_000 }, semanticRetrieval: { provider: strict ? "serena" : "none", required: strict }, compression: { provider: "headroom", required: strict, minTokens: 2, reversible: true }, budgets: { default: { inputTokens: 16_000 } } },
    telemetry: { enabled: false },
    provenance: { outputDir: ".harness/provenance" },
    evals: { fullStack: { strictSupplyChain: strict } }
  };
}

function productionSelection(): AgentExecutionSelection {
  return { logicalAgent: "full-stack-contract", role: "implementer", description: "Deterministic full-stack contract worker.", domains: ["validation"], runtimeName: "opencode", runtimeAdapter: "opencode", paseoProvider: "opencode", modelAlias: "contract", modelId: "contract", modelName: "contract", transport: "direct", skills: [], mcps: [], permissions: { read: "allow", write: "allow", shell: "allow", network: "deny" }, args: [], runtimeCapabilities: {} };
}

function fixtureContract(strict: boolean): TaskContract { return { version: 1, mode: "spec", task: { id: "FS-1", title: "deterministic full-stack fixture" }, source: { spec: "specs/FS-1.md" }, scope: { allowed: ["src/**", "specs/**", ".harness/**", ".serena/**", "graphify-out/**"] }, requirements: [{ id: "REQ-1", description: "changed fixture is validated", validators: ["command.smoke", ...(strict ? ["trivy-evidence"] : [])] }] }; }
async function createFixture(root: string): Promise<void> { await fs.mkdir(path.join(root, "src"), { recursive: true }); await fs.mkdir(path.join(root, "specs"), { recursive: true }); await fs.mkdir(path.join(root, ".harness", "contracts"), { recursive: true }); await fs.writeFile(path.join(root, "src", "feature.ts"), "export const accepted = false;\n"); await fs.writeFile(path.join(root, "src", "serena-fixture.ts"), "export function SerenaFixtureSymbol(): boolean { return true; }\n"); await fs.writeFile(path.join(root, "specs", "FS-1.md"), "# FS-1\n\nThe fixture must validate a changed source file.\n"); await fs.writeFile(path.join(root, ".harness", "contracts", "FS-1.yaml"), "version: 1\nmode: spec\ntask:\n  id: FS-1\n  title: deterministic full-stack fixture\n"); const init = await runProcess("git init -q && git config user.email aeh@example.invalid && git config user.name AEH && git add . && git commit -qm base", { cwd: root, timeoutMs: 30_000 }); if (init.exitCode !== 0) throw new Error("Fixture git setup failed: " + init.stderr); }
async function digest(file: string): Promise<string> { const crypto = await import("node:crypto"); return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"); }
function configuredSurface(config: HarnessProjectConfig): string[] { const result = ["git", "node", "ContextBudgetGateway", "buildEffectivePrompt", "EvidenceGraph", "provenance"]; if (config.memory?.provider && config.memory.provider !== "none") result.push("memory:" + config.memory.provider); if (config.codeIntelligence?.provider && config.codeIntelligence.provider !== "none") result.push("code-intelligence:" + config.codeIntelligence.provider); return result; }
