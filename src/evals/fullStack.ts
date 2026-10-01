import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { runShell, commandExists } from "../utils/process.js";
import type { AgentExecutionSelection } from "../agents/types.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { sealTask } from "../core/seal.js";
import { verifyTask } from "../core/verify.js";
import { sha256Canonical } from "../core/digest.js";
import { buildRequirementEvidenceGraph } from "../evidence/graph.js";
import { buildRepositoryContextMap } from "../context/repository/map.js";
import { buildEffectivePromptIdentity, executeAgentPrompt, materializeAgentPrompt, prepareAgentExecutionBinding, prepareAgentExecutionIdentity } from "../workers/agentPrompt.js";
import { HeadroomCompressionProvider } from "../context/compression/headroom.js";
import { GraphifyCodeIntelligenceProvider } from "../providers/graphify.js";
import { EngramMemoryProvider } from "../providers/engram.js";
import { runSerenaMcpContract } from "../providers/serenaMcp.js";
import { generateProvenance, verifyProvenanceManifest } from "../provenance/generate.js";
import { executeOperation, startDetachedOperation } from "../operations/controller.js";
import { loadOperation } from "../operations/state.js";
import { prepareExecutionAuthority } from "../security/executionLease.js";
import { retrieveAuthorizedContext } from "../context/authorizationV2.js";
import { contextEnvelopePath } from "../context/gateway.js";
import { resolveContextTransportCapabilities } from "../context/transport.js";
import { DETERMINISTIC_RUNTIME_ENV } from "../paseo/deterministicRuntime.js";
import type { AuditReport } from "../audit/run.js";

export interface FullStackCheck { id: string; stage: string; status: "PASS" | "FAIL" | "SKIP"; required: boolean; message: string; details?: Record<string, unknown>; }
export interface FullStackDogfoodReport { version: 1; profile: "full-stack"; generatedAt: string; status: "PASS" | "FAIL"; checks: FullStackCheck[]; configuredComponents: string[]; limitations: string[]; }

/** Deterministic local dogfood lane, with strict CI mode requiring installed providers. */
export async function runFullStackDogfood(root: string, config: HarnessProjectConfig): Promise<FullStackDogfoodReport> {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-full-stack-"));
  const strict = config.evals?.fullStack?.strictSupplyChain === true || process.env.AEH_STRICT_FULL_STACK === "1";
  const checks: FullStackCheck[] = [];
  const check = (id: string, stage: string, status: FullStackCheck["status"], message: string, required = false, details?: Record<string, unknown>): void => { checks.push({ id, stage, status, required, message, details }); };
  try {
    await createFixture(fixture, strict);
    const fixtureConfig = fixtureConfiguration(config, strict);
    const contract = fixtureContract(strict);
    await fs.writeFile(path.join(fixture, ".harness", "project.yaml"), YAML.stringify(fixtureConfig), "utf8");
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
    if (strict) {
      const reportFile = path.resolve(fixture, fixtureConfig.sdd?.reportsDir ?? ".harness/reports", contract.task.id + ".json");
      const persistedReport = JSON.parse(await fs.readFile(reportFile, "utf8")) as typeof report;
      if (sha256Canonical(persistedReport) !== sha256Canonical(report)) throw new Error("FULL_STACK_REPORT_IDENTITY_MISMATCH: compact context fixture must preserve the exact verified ValidationReport value.");
      // The real ValidationReport is deliberately stored compactly in this fixture. That keeps
      // the gateway's line sampler from shortening the raw artifact before Headroom can exercise
      // the required reversible compression and authorized-recovery path.
      await fs.writeFile(reportFile, JSON.stringify(persistedReport) + "\n", "utf8");
    }
    const failedChecks = report.checks.filter((item) => item.status === "FAIL").map((item) => item.id);
    check("validation.report", "validation", report.status === "PASS" ? "PASS" : "FAIL", report.status === "PASS" ? "Deterministic validation produced " + (report.findings?.length ?? 0) + " normalized finding(s)." : "Deterministic validation failed: " + failedChecks.join("; "), true, { findings: report.findings?.length ?? 0, failedChecks, failedMessages: report.checks.filter((item) => item.status === "FAIL").map((item) => ({ id: item.id, message: item.message, details: item.details })) });
    const graph = await buildRequirementEvidenceGraph({ root: fixture, config: fixtureConfig, contract, report });
    check("evidence.graph", "evidence", graph.complete ? "PASS" : "FAIL", "RequirementEvidenceGraph built with " + graph.nodes.length + " nodes and sha256 " + graph.sha256 + (graph.complete ? "." : " " + graph.reasons.join("; ")), true, { complete: graph.complete, sha256: graph.sha256 });
    await exerciseGovernedContextPath(fixture, fixtureConfig, contract, strict, check);

    const provenance = await generateProvenance(fixture, fixtureConfig, { artifact: "src/feature.ts", taskId: "FS-1", sbom: false });
    const verified = await verifyProvenanceManifest(fixture, provenance.manifestFile);
    check("provenance.chain", "provenance", verified.ok ? "PASS" : "FAIL", verified.ok ? "Provenance generation and verification completed." : verified.failures.join("; "), true, { manifest: provenance.manifestFile });
    await fs.mkdir(path.resolve(root, config.evals?.resultsDir ?? ".harness/evals/results"), { recursive: true });
    const output: FullStackDogfoodReport = { version: 1, profile: "full-stack", generatedAt: new Date().toISOString(), status: checks.some((item) => item.required && item.status !== "PASS") ? "FAIL" : "PASS", checks, configuredComponents: configuredSurface(fixtureConfig), limitations: ["Agent/model execution is intentionally outside the deterministic contract lane.", ...(strict ? [] : ["Strict provider requirements are enabled only in the dedicated CI lane."])] };
    await fs.writeFile(path.join(path.resolve(root, config.evals?.resultsDir ?? ".harness/evals/results"), "full-stack-" + Date.now() + ".json"), JSON.stringify(output, null, 2) + "\n");
    return output;
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
}

async function exerciseGovernedContextPath(
  fixture: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  strict: boolean,
  check: (id: string, stage: string, status: FullStackCheck["status"], message: string, required?: boolean, details?: Record<string, unknown>) => void
): Promise<void> {
  const scriptFile = path.join(fixture, ".harness", "fixtures", "deterministic-paseo-runtime.json");
  await fs.mkdir(path.dirname(scriptFile), { recursive: true });
  await fs.writeFile(scriptFile, `${JSON.stringify({ version: 1, responses: { reviewer: [{ verdict: "PASS", findings: [], finalizationSafety: "SAFE", followUp: [] }] } }, null, 2)}\n`, "utf8");
  const previousDeterministicRuntime = process.env[DETERMINISTIC_RUNTIME_ENV];
  process.env[DETERMINISTIC_RUNTIME_ENV] = "1";
  let operationId: string | undefined;
  let fixtureAuditReport: AuditReport | undefined;
  try {
    const queued = await startDetachedOperation(fixture, "audit", { request: "Exercise governed context delivery and recovery for the full-stack contract fixture.", files: ["src/feature.ts"], risk: "low" }, {
      nodeExecutable: process.execPath,
      entryFile: path.join(fixture, "unused-controller-entry.js"),
      spawnProcess: (() => ({ pid: process.pid, unref: () => undefined }) as never) as never
    });
    operationId = queued.id;
    const operation = await executeOperation(fixture, queued.id, {
      startWatchdog: () => () => undefined,
      runAudit: async (root, operationConfig, input) => {
        const operationContract: TaskContract = {
          ...contract,
          task: { id: queued.id, title: "governed full-stack context fixture" },
          routing: { intent: "audit", route: "DELEGATED", assurance: "STANDARD", routeEvidence: [{ route: "DELEGATED", source: "full-stack-controller-fixture", statement: "The deterministic audit operation owns this read-only context execution." }] }
        };
        await fs.writeFile(path.join(root, ".harness", "contracts", `${queued.id}.yaml`), YAML.stringify(operationContract), "utf8");
        await fs.copyFile(path.join(root, ".harness", "reports", `${contract.task.id}.json`), path.join(root, ".harness", "reports", `${queued.id}.json`));
        await sealTask(root, operationConfig, operationContract);
        const selection = productionSelection();
        const options = { phase: "review", operationKind: "audit", outputContract: "reviewer", requireExecutionAuthority: true };
        const authority = await prepareExecutionAuthority(root, selection, { phase: options.phase, required: true });
        if (!authority) throw new Error("V2_AUTHORITY_REQUIRED: managed full-stack participant has no controller-issued authority.");
        const contextCapabilities = await resolveContextTransportCapabilities(root, operationConfig, selection, { mode: "live" });
        const projected = await buildEffectivePromptIdentity(root, operationConfig, operationContract, selection, "Validate the changed fixture and recall the fixture discovery while preserving the accepted operation evidence.", {
          ...options, participantId: authority.participantId, capabilityAuthority: authority, contextCapabilities
        });
        const identity = await prepareAgentExecutionIdentity(root, operationConfig, operationContract, selection, projected.prompt, {
          ...options,
          participantId: authority.participantId,
          capabilityAuthority: authority,
          contextCapabilities,
          preparedPrompt: projected.prompt,
          contextManifest: projected.contextManifest,
          contextManifestDigest: projected.contextManifestDigest,
          promptManifestDigest: projected.promptManifestDigest
        });
        const preparedOptions = {
          ...options,
          participantId: authority.participantId,
          capabilityAuthority: identity.authority,
          contextCapabilities,
          preparedPrompt: projected.prompt,
          contextManifest: identity.contextManifest,
          contextManifestDigest: identity.contextManifestDigest,
          promptManifestDigest: identity.promptManifestDigest,
          executionBlueprint: identity.executionBlueprint,
          executionBlueprintDigest: identity.executionBlueprint.digest,
          roleInvocationPolicy: identity.roleInvocationPolicy,
          skillManifest: identity.skillManifest
        };
        const materialized = await materializeAgentPrompt(root, operationConfig, operationContract, selection, preparedOptions);
        if (!materialized?.id) throw new Error("PASEO_EXECUTION_SESSION_PREPARATION_REQUIRED: deterministic fixture did not materialize a durable runtime session.");
        const bound = await prepareAgentExecutionBinding(root, operationConfig, operationContract, selection, projected.prompt, {
          ...preparedOptions,
          executionSessionId: materialized.id
        });
        const envelope = JSON.parse(await fs.readFile(contextEnvelopePath(root, queued.id, selection.logicalAgent, options.phase), "utf8")) as {
          fragments: Array<{ id: string; content: string; estimatedTokens: number; originalTokens?: number; compressed?: boolean; source?: { artifact?: string }; compression?: { reversible: boolean; handle?: string } }>;
          retrieval: { available: boolean };
        };
        const fragments = envelope.fragments.map((fragment) => fragment.id);
        const requiredIds = ["execution-envelope", "agent-charter", "task-assignment", "task-contract", "sealed-acceptance", "repository-map", "validation-evidence", "advisory-memory", "raw-evidence-references"];
        const missing = requiredIds.filter((id) => !fragments.includes(id));
        const allowedNonStrictMissing = !strict && missing.every((id) => id === "advisory-memory");
        if (!projected.prompt.includes("AEH ContextEnvelope") || (missing.length > 0 && !allowedNonStrictMissing)) throw new Error(`Production context assembly is incomplete: ${missing.join(", ") || "rendered envelope missing"}.`);
        if (!bound.authority.leases.some((lease) => lease.capability === "read")) throw new Error("CONTEXT_RUNTIME_V2_AUTHORITY_REJECTED: participant binding has no controller-issued read lease.");
        if (!envelope.retrieval.available || !Array.isArray(bound.contextManifest.addressableRefs)) throw new Error("CONTEXT_RUNTIME_V2_AUTHORITY_REJECTED: bound execution has no authorized retrieval surface.");
        const validationFragment = envelope.fragments.find((fragment) => fragment.id === "validation-evidence");
        if (!validationFragment) throw new Error("Full-stack context envelope omitted the validation evidence fragment.");
        const validationSource = await fs.readFile(path.resolve(root, validationFragment.source?.artifact ?? `.harness/reports/${queued.id}.json`), "utf8");
        const retrieval = await retrieveAuthorizedContext(root, root, queued.id, bound.authority.participantId, materialized.id, selection.logicalAgent, options.phase, {
          refId: "validation-evidence",
          requestId: `full-stack-recovery:${queued.id}`
        });
        if (retrieval.content !== validationSource) throw new Error("CONTEXT_RUNTIME_V2_SOURCE_DIGEST_MISMATCH: authorized recovery did not return the exact validation artifact bytes.");
        if (strict && (!validationFragment.compressed || validationFragment.compression?.reversible !== true || !validationFragment.compression.handle)) throw new Error("CONTEXT_COMPRESSION_REVERSIBILITY_UNAVAILABLE: strict validation evidence has no reversible compression recovery handle. " + JSON.stringify({ compressed: validationFragment.compressed ?? false, originalTokens: validationFragment.originalTokens, projectedTokens: validationFragment.estimatedTokens, compression: validationFragment.compression, retrievalAvailable: envelope.retrieval.available, sourceArtifact: validationFragment.source?.artifact }));
        const finalOptions = { ...preparedOptions, executionBinding: bound.binding, executionSessionId: materialized.id, materializedPaseoSession: materialized };
        const session = await executeAgentPrompt(root, operationConfig, operationContract, selection, projected.prompt, finalOptions);
        if (session.exitCode !== 0 || session.id !== materialized.id) throw new Error(`Deterministic full-stack participant did not complete on its bound session: ${session.stderr || session.stdout || `exit ${session.exitCode}`}`);
        const current = await loadOperation(root, queued.id);
        const currentBinding = current.participants[bound.authority.participantId]?.executionBinding;
        if (!currentBinding || currentBinding.digest !== bound.binding.digest || currentBinding.runtime.sessionId !== session.id || currentBinding.controllerEpoch !== current.controller?.epoch) throw new Error("EXECUTION_BINDING_STALE: durable participant identity does not match the controller-issued runtime session.");
        const readLease = bound.authority.leases.find((lease) => lease.capability === "read");
        if (!readLease || !currentBinding.leaseIdentities.includes(readLease.leaseId)) throw new Error("V2_AUTHORITY_REQUIRED: durable execution binding does not reference its controller-issued read lease.");
        const latestParticipant = current.participants[session.id];
        const receipt = Object.values(current.participantReceipts ?? {}).find((item) => item.participantId === bound.authority.participantId && item.sessionId === session.id);
        if (!latestParticipant || latestParticipant.status !== "COMPLETED" || !receipt) throw new Error("V2_RECEIPT_REJECTED: controller did not complete and receipt the context-bound participant.");
        check("context.controller-identity", "context", "PASS", "Controller-owned audit execution produced the participant identity, read lease, current ExecutionBinding and durable result receipt.", true, {
          operationId: queued.id,
          participantId: bound.authority.participantId,
          controllerEpoch: currentBinding.controllerEpoch,
          executionBindingDigest: currentBinding.digest,
          sessionId: session.id,
          readLeaseId: readLease.leaseId,
          leaseCapabilities: bound.authority.leases.map((lease) => lease.capability),
          participantStatus: latestParticipant.status,
          resultArtifact: latestParticipant.resultArtifact,
          receiptId: receipt.receiptId
        });
        check("context.authorized-recovery", "context", retrieval.receipt.executionBindingDigest === bound.binding.digest && retrieval.receipt.sessionId === session.id && retrieval.content === validationSource ? "PASS" : "FAIL", retrieval.content === validationSource ? "Authorized current-session retrieval recovered the exact validation evidence behind its compression handle." : "Authorized retrieval did not recover the exact validation evidence.", true, {
          refId: retrieval.receipt.refId,
          sourceDigest: retrieval.receipt.sourceDigest,
          deliveredContentDigest: retrieval.receipt.deliveredContentDigest,
          executionBindingDigest: retrieval.receipt.executionBindingDigest,
          sessionId: retrieval.receipt.sessionId,
          compressionHandle: validationFragment.compression?.handle
        });
        const compressed = envelope.fragments.filter((fragment) => fragment.compressed);
        check("context.production-assembly", "context", "PASS", "A governed participant assembled the production envelope with normative, RepoMap, validation/evidence, retrieval and the configured Headroom gateway.", true, {
          fragmentIds: fragments,
          compressedFragments: compressed.length,
          compressionProvider: operationConfig.context?.compression?.provider,
          retrievalAvailable: envelope.retrieval.available,
          operationStatus: current.status
        });
        if (strict) check("context.reversibility", "context", "PASS", "Strict validation evidence was compressed reversibly and recovered through its controller-authorized current-session reference.", true, {
          fragmentId: validationFragment.id,
          recoveryHandle: validationFragment.compression?.handle,
          retrievedDigest: retrieval.receipt.deliveredContentDigest
        });
        fixtureAuditReport = auditReport(root, input.auditId ?? queued.id, input.request, session);
        const auditFile = path.resolve(root, ".harness/audits", (input.auditId ?? queued.id) + ".json");
        await fs.mkdir(path.dirname(auditFile), { recursive: true });
        await fs.writeFile(auditFile, JSON.stringify(fixtureAuditReport, null, 2) + "\n", "utf8");
        return fixtureAuditReport;
      }
    });
    const final = await loadOperation(fixture, queued.id);
    if (operation.status !== "SUCCEEDED" || final.status !== "SUCCEEDED") throw new Error(`Governed full-stack audit did not terminalize successfully: ${final.status}: ${final.error ?? operation.error ?? "unknown error"}`);
    const auditFile = path.resolve(fixture, ".harness/audits", queued.id + ".json");
    const persistedAudit = JSON.parse(await fs.readFile(auditFile, "utf8")) as AuditReport;
    if (!fixtureAuditReport || sha256Canonical(persistedAudit) !== sha256Canonical(fixtureAuditReport) || persistedAudit.status !== "DEGRADED" || persistedAudit.productionSafe) throw new Error("FULL_STACK_AUDIT_REPORT_SCOPE_INVALID: context fixture must persist its exact non-certifying AuditReport.");
    check("context.audit-report-scope", "context", "PASS", "The governed context operation persisted its exact non-certifying AuditReport.", true, { auditId: persistedAudit.auditId, status: persistedAudit.status, productionSafe: persistedAudit.productionSafe, dirtyPaths: persistedAudit.repository.dirtyPaths });
  } catch (error) {
    const current = operationId ? await loadOperation(fixture, operationId).catch(() => undefined) : undefined;
    const message = `Governed production context path failed${current ? ` (${current.status})` : ""}: ${error instanceof Error ? error.message : String(error)}`;
    check("context.production-assembly", "context", "FAIL", message, true, current?.error ? { operationError: current.error } : undefined);
    if (strict) check("context.reversibility", "context", "FAIL", message, true);
  } finally {
    if (previousDeterministicRuntime === undefined) delete process.env[DETERMINISTIC_RUNTIME_ENV];
    else process.env[DETERMINISTIC_RUNTIME_ENV] = previousDeterministicRuntime;
  }
}

function auditReport(root: string, auditId: string, request: string, session: import("../core/types.js").WorkerSession): AuditReport {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, note: 0 };
  const now = new Date().toISOString();
  const dirtyPaths = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
  const limitation = "This deterministic fixture verifies controller-owned context assembly and authorized recovery; it does not run the production audit aggregation or certify production safety.";
  return {
    version: 1,
    auditId,
    intent: "audit",
    request,
    status: "DEGRADED",
    startedAt: now,
    finishedAt: now,
    repository: { root, baseRef: "HEAD", dirtyPaths },
    reviewers: [],
    validationChecks: [{ id: "context-authority-recovery", category: "context", status: "PASS", message: "Controller identity, read lease, binding, and exact authorized recovery passed in the fixture.", details: { sessionId: session.id, logicalAgent: session.logicalAgent }, failureClass: "NONE" }],
    findings: [],
    counts,
    debtPoints: 0,
    debtScore: 0,
    qualityGate: { pass: false, reasons: [limitation], counts, debtPoints: 0, debtScore: 0 },
    productionSafe: false,
    sessions: [session],
    restoredPaths: []
  };
}

function fixtureConfiguration(base: HarnessProjectConfig, strict: boolean): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: base.project.name + "-full-stack-fixture" },
    memory: { provider: "engram", required: strict },
    sdd: { contractsDir: ".harness/contracts", reportsDir: ".harness/reports", runsDir: ".harness/runs" },
    // The fixture contract is about validating changed source, not scanning
    // generated control-plane state (.git/.harness/.serena). Keeping the
    // target explicit makes this production-path check deterministic while
    // the real validator remains unchanged for consumer repositories.
    validation: { baseRef: "HEAD", requireSeal: true, commands: [{ id: "smoke", command: "node -e \"process.exit(0)\"", required: true }], validators: [{ id: "trivy-evidence", adapter: "trivy", required: strict, command: "trivy fs --format json --exit-code 1 --severity HIGH,CRITICAL --scanners vuln,misconfig,secret src" }] },
    evidence: { enabled: true, outputDir: ".harness/evidence", requireComplete: true },
    codeIntelligence: { provider: "graphify", required: strict, codeOnly: true },
    context: { repositoryMap: { enabled: true, tokenBudget: 1_000 }, ...(strict ? { semanticRetrieval: { provider: "serena", required: true } } : {}), compression: { provider: "headroom", required: strict, minTokens: 2, reversible: true }, budgets: { default: { inputTokens: 16_000 } } },
    telemetry: { enabled: false },
    provenance: { outputDir: ".harness/provenance" },
    evals: { fullStack: { strictSupplyChain: strict } }
  };
}

function productionSelection(): AgentExecutionSelection {
  return { logicalAgent: "full-stack-contract-reviewer", role: "Reviewer", description: "Deterministic full-stack contract reviewer.", domains: ["validation"], runtimeName: "opencode", runtimeAdapter: "opencode", paseoProvider: "deterministic", modelAlias: "contract", modelId: "deterministic/full-stack-reviewer", modelName: "full-stack-reviewer", modelProvider: "deterministic", transport: "paseo", skills: [], mcps: [], outputContract: "reviewer", permissions: { read: "allow", write: "deny", shell: "deny", network: "deny" }, args: [], runtimeCapabilities: { mcp: true, stdioMcp: true, localMcp: true, nativeToolProjection: true, structuredOutput: true, sessions: true } };
}

function fixtureContract(strict: boolean): TaskContract { return { version: 1, task: { id: "FS-1", title: "deterministic full-stack fixture" }, source: { spec: "specs/FS-1.md" }, scope: { allowed: ["src/**", "specs/**", ".harness/**", ".serena/**", "graphify-out/**"] }, routing: { intent: "implement", route: "FORMAL_SDD", assurance: strict ? "CRITICAL" : "ELEVATED", routeEvidence: [{ route: "FORMAL_SDD", source: "full-stack-fixture", statement: "The full-stack fixture is formalized before execution." }] }, requirements: [{ id: "REQ-1", description: "changed fixture is validated", validators: ["command.smoke", ...(strict ? ["trivy-evidence"] : [])] }] }; }
async function createFixture(root: string, strict: boolean): Promise<void> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "specs"), { recursive: true });
  await fs.mkdir(path.join(root, ".harness", "contracts"), { recursive: true });
  // Model a consumer checkout: runtime state under .harness is ignored while
  // the project configuration remains a Git-owned declarative input.
  await fs.writeFile(path.join(root, ".gitignore"), "/.harness/*\n!/.harness/project.yaml\n");
  await fs.writeFile(path.join(root, "src", "feature.ts"), "export const accepted = false;\n");
  await fs.writeFile(path.join(root, "src", "serena-fixture.ts"), "export function SerenaFixtureSymbol(): boolean { return true; }\n");
  await fs.writeFile(path.join(root, "specs", "FS-1.md"), "# FS-1\n\nThe fixture must validate a changed source file.\n");
  await fs.writeFile(path.join(root, ".harness", "contracts", "FS-1.yaml"), YAML.stringify(fixtureContract(strict)));
  const init = await runShell("git init -q && git config user.email aeh@example.invalid && git config user.name AEH && git add . && git commit -qm base", { cwd: root, timeoutMs: 30_000 });
  if (init.exitCode !== 0) throw new Error("Fixture git setup failed: " + init.stderr);
}
async function digest(file: string): Promise<string> { const crypto = await import("node:crypto"); return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"); }
function configuredSurface(config: HarnessProjectConfig): string[] { const result = ["git", "node", "controller-owned OperationRecord", "CapabilityLease", "ExecutionBinding", "ContextBudgetGateway", "authorized context retrieval", "EvidenceGraph", "provenance"]; if (config.memory?.provider && config.memory.provider !== "none") result.push("memory:" + config.memory.provider); if (config.codeIntelligence?.provider && config.codeIntelligence.provider !== "none") result.push("code-intelligence:" + config.codeIntelligence.provider); return result; }
