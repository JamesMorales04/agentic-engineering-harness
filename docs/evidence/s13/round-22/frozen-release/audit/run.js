import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { loadResolvedAgentTopology } from "../agents/config.js";
import { executionSelectionForAgent, resolveRoute, selectAgentNames } from "../agents/routing.js";
import { dedupeFindings } from "../agents/findings.js";
import { reviewerOutputSchema } from "../agents/outputContracts.js";
import { extractMarkedJson } from "../agents/structuredOutput.js";
import { calculateQuality, evaluateFinalQualityGate } from "../agents/qualityConvergence.js";
import { createWorktreeCheckpoint, rollbackWorktreeCheckpoint } from "../agents/gitCheckpoint.js";
import { createControlPlaneSnapshot } from "../core/controlPlane.js";
import { sealTask } from "../core/seal.js";
import { currentOperationContext, loadOperation, resolveOperationStateRoot, setOperationStage } from "../operations/state.js";
import { consolidateWithOperationSupervisor, ensureOperationSupervisor, maybeRotateOperationSupervisor, settleDrainingSupervisorGenerations } from "../operations/supervisor.js";
import { runValidationCommand } from "../validators/commands.js";
import { runConfiguredValidators } from "../validators/registry.js";
import { dispatchMaterializedAgentPrompt, materializeAgentPrompt } from "../workers/agentPrompt.js";
import { recordEvent } from "../telemetry/events.js";
import { runExecutable } from "../utils/process.js";
import { compileAuditReviewerPrompt } from "./reviewerPrompt.js";
const AUDIT_OUTPUT_DIR = ".harness/audits";
const DEFAULT_AUDIT_REVIEWER = { role: "Reviewer", domains: ["*"] };
const AUDIT_REVIEWER_BUDGET = { low: 5, medium: 6, high: 8 };
export async function runAudit(root, config, input) {
    const startedAt = new Date().toISOString();
    const auditId = input.auditId ?? createAuditId(input.request);
    const baseRef = config.validation?.baseRef ?? "HEAD";
    const checkpoint = await createWorktreeCheckpoint(root);
    const dirtyPaths = [...checkpoint.files.keys()].sort();
    const commit = await gitCommit(root);
    const contract = auditContract(auditId, input, baseRef);
    await materializeAuditContract(root, config, contract);
    await sealTask(root, config, contract);
    const snapshot = await createControlPlaneSnapshot(root, config, auditId);
    const topology = await loadResolvedAgentTopology(root, config, config.agents?.activeProfile);
    const supervisorAgent = topology.agents["operation-supervisor"];
    const supervisorSelection = supervisorAgent && !supervisorAgent.disabled ? executionSelectionForAgent(topology, "operation-supervisor") : undefined;
    const reviewers = selectAuditReviewers(topology, input);
    const reviewerSelections = Object.fromEntries(reviewers.map((reviewer) => [reviewer, executionSelectionForAgent(topology, reviewer)]));
    const sessions = [];
    const validationChecks = [];
    const rawFindings = [];
    let restoredPaths = [];
    await recordEvent(root, config, "harness.audit.start", {
        auditId,
        request: input.request,
        reviewers,
        dirtyPaths,
        commit
    });
    await operationStage(root, "supervision", "RUNNING");
    const supervisor = await ensureOperationSupervisor(root, config, contract, supervisorSelection, {
        required: true,
        forceMaterialize: true
    });
    if (!supervisor?.agentId) {
        throw new Error("AEH_OPERATION_SUPERVISOR_UNAVAILABLE: AUDIT requires a materialized semantic supervisor.");
    }
    await operationStage(root, "supervision", "COMPLETED");
    let outputs = [];
    try {
        await operationStage(root, "materializing-reviewers", "RUNNING");
        const prepared = await Promise.all(reviewers.map((reviewer) => prepareAuditReviewer(root, config, contract, reviewerSelections[reviewer], reviewer)));
        await operationStage(root, "materializing-reviewers", "COMPLETED");
        await operationStage(root, "validating", "RUNNING");
        for (const command of config.validation?.commands ?? []) {
            validationChecks.push(classifyValidationCheck(await runValidationCommand(root, command, { config })));
        }
        validationChecks.push(...(await runConfiguredValidators(root, config, contract, baseRef, [])).map(classifyValidationCheck));
        await operationStage(root, "validating", "COMPLETED");
        await operationStage(root, "reviewing", "RUNNING");
        outputs = await Promise.all(prepared.map((reviewer) => runPreparedAuditReviewer(root, config, contract, reviewer, input, validationChecks, dirtyPaths)));
        for (const output of outputs) {
            sessions.push(output.session);
            rawFindings.push(...output.findings.map((finding) => ({
                ...finding,
                id: `${output.reviewer}:${finding.id}`
            })));
        }
        await operationStage(root, "reviewing", "COMPLETED");
    }
    finally {
        restoredPaths = await rollbackWorktreeCheckpoint(root, checkpoint);
    }
    await operationStage(root, "consolidating", "RUNNING");
    const sourceArtifacts = await reviewerArtifacts(root, outputs);
    const consolidation = await consolidateWithOperationSupervisor(root, config, contract, supervisorSelection, {
        key: "audit-reviewers",
        purpose: "AUDIT reviewer findings",
        findings: rawFindings,
        sourceArtifacts,
        deterministicEvidence: validationChecks
    });
    sessions.push(consolidation.session);
    const deduped = dedupeFindings(consolidation.output.consolidatedFindings);
    await operationStage(root, "consolidating", "COMPLETED", {
        artifact: consolidation.artifact
    });
    await maybeRotateOperationSupervisor(root, config, contract, supervisorSelection);
    const operationId = currentOperationContext().id;
    if (operationId)
        await settleDrainingSupervisorGenerations(root, operationId);
    const quality = calculateQuality(deduped.findings, config);
    const qualityGate = evaluateFinalQualityGate(deduped.findings, config);
    const validationDegraded = validationChecks.some((check) => check.status === "FAIL" || check.status === "WARN");
    const status = validationDegraded
        ? "DEGRADED"
        : deduped.findings.length
            ? "FINDINGS"
            : "CLEAN";
    const report = {
        version: 1,
        auditId,
        intent: "audit",
        intentDecision: input.intentDecision,
        request: input.request,
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        repository: { root: path.resolve(root), commit, baseRef, dirtyPaths },
        reviewers,
        validationChecks,
        findings: deduped.findings,
        counts: quality.counts,
        debtPoints: quality.debtPoints,
        debtScore: quality.debtScore,
        qualityGate,
        productionSafe: !validationChecks.some((check) => check.status === "FAIL") && qualityGate.pass,
        sessions,
        restoredPaths,
        controlPlaneSha256: snapshot.compositeSha256,
        supervisor: {
            generation: supervisor.generation,
            consolidationArtifact: consolidation.artifact,
            summary: consolidation.output.summary,
            conflicts: consolidation.output.conflicts.length,
            missingEvidence: consolidation.output.missingEvidence
        }
    };
    await persistAudit(root, report);
    await recordEvent(root, config, "harness.audit.finish", {
        auditId,
        status,
        findings: report.findings.length,
        rawFindings: rawFindings.length,
        debtPoints: report.debtPoints,
        productionSafe: report.productionSafe,
        supervisorGeneration: supervisor.generation,
        consolidationArtifact: consolidation.artifact
    });
    return report;
}
export async function loadAuditReport(root, auditId) {
    return JSON.parse(await fs.readFile(path.resolve(root, AUDIT_OUTPUT_DIR, `${auditId}.json`), "utf8"));
}
export function classifyValidationCheck(check) {
    return { ...check, failureClass: classifyAuditFailure(check) };
}
export function classifyAuditFailure(check) {
    if (check.status === "PASS" || check.status === "SKIP")
        return "NONE";
    const details = check.details ?? {};
    const text = [
        check.message,
        String(details.stderr ?? ""),
        String(details.stdout ?? ""),
        String(details.error ?? "")
    ]
        .join("\n")
        .toLowerCase();
    if (/\b(assert|assertion|expected .* received|expected .* to)\b/.test(text))
        return "ASSERTION_FAILURE";
    if (/\b(eperm|eacces|permission denied|operation not permitted|sandbox|seccomp|denied by policy)\b/.test(text))
        return "SANDBOX_DENIAL";
    if (/\b(enoent|command not found|not found:|cannot find module|module not found|missing dependency|no such file or directory)\b/.test(text))
        return "MISSING_DEPENDENCY";
    if (/\b(timeout|timed out|environment failure|environment error|out of memory|oom|resource temporarily unavailable|network unavailable|dns failure|dns error)\b/.test(text))
        return "ENVIRONMENT_FAILURE";
    return "TOOL_FAILURE";
}
function auditContract(auditId, input, baseRef) {
    return {
        version: 1,
        task: { id: auditId, title: `Audit: ${input.request.slice(0, 120)}` },
        git: { baseRef },
        scope: { allowed: input.files ?? [] },
        routing: {
            intent: "audit",
            domains: input.domains ?? [],
            risk: input.risk ?? "low",
            route: "DELEGATED",
            assurance: input.risk === "high" ? "CRITICAL" : "STANDARD",
            routeEvidence: [{ route: "DELEGATED", source: "audit-entry", statement: "Audits use the delegated read-only review route." }]
        },
        constraints: {
            breakingApiChanges: false,
            newDependencies: false,
            schemaChanges: false
        }
    };
}
async function materializeAuditContract(root, config, contract) {
    const contractsDir = path.resolve(root, config.sdd?.contractsDir ?? ".harness/contracts");
    await fs.mkdir(contractsDir, { recursive: true });
    await fs.writeFile(path.join(contractsDir, `${contract.task.id}.yaml`), YAML.stringify(contract));
}
export function selectAuditReviewers(topology, input) {
    const risk = input.risk ?? "low";
    const routed = resolveRoute(topology, {
        intent: "audit",
        domains: input.domains ?? [],
        files: input.files ?? [],
        risk
    }).review.flatMap((selector) => selectAgentNames(topology, selector));
    const explicitlyRequested = [...new Set(input.reviewers ?? [])];
    const ordered = [...new Set([...explicitlyRequested, ...routed, ...selectAgentNames(topology, DEFAULT_AUDIT_REVIEWER)])];
    const available = ordered.filter((name) => topology.agents[name]?.role === "Reviewer" && !topology.agents[name]?.disabled);
    const fallback = Object.values(topology.agents)
        .filter((agent) => agent.role === "Reviewer" && !agent.disabled)
        .map((agent) => agent.name);
    const candidates = available.length ? available : fallback;
    const budget = Math.max(AUDIT_REVIEWER_BUDGET[risk], explicitlyRequested.length);
    return candidates.slice(0, budget);
}
async function prepareAuditReviewer(root, config, contract, base, reviewer) {
    if (!base)
        throw new Error(`AUDIT_REVIEW_EXECUTION_INVALID: no frozen selection exists for reviewer '${reviewer}'.`);
    const selection = {
        ...base,
        permissions: { ...base.permissions, write: "deny", gitWrite: "deny", delegate: "deny" }
    };
    const materialized = await materializeAgentPrompt(root, config, contract, selection, {
        outputContract: "reviewer",
        phase: "review",
        operationKind: "audit"
    });
    return { reviewer, selection, materialized };
}
async function runPreparedAuditReviewer(root, config, contract, prepared, input, checks, dirtyPaths) {
    const session = await dispatchMaterializedAgentPrompt(root, config, contract, prepared.selection, prepared.materialized, compileAuditReviewerPrompt({ input, reviewer: prepared.reviewer, checks, dirtyPaths }), { outputContract: "reviewer", phase: "review", operationKind: "audit" });
    if (session.exitCode !== 0) {
        return {
            reviewer: prepared.reviewer,
            session,
            findings: [
                syntheticFinding(prepared.reviewer, `Audit reviewer runtime exited with code ${session.exitCode}.`)
            ]
        };
    }
    try {
        const output = reviewerOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr));
        if (output.verdict === "FAIL" && output.findings.length === 0) {
            return {
                reviewer: prepared.reviewer,
                session,
                findings: [
                    syntheticFinding(prepared.reviewer, "Audit reviewer returned FAIL without a structured finding.")
                ]
            };
        }
        return { reviewer: prepared.reviewer, session, findings: output.findings };
    }
    catch (error) {
        return {
            reviewer: prepared.reviewer,
            session,
            findings: [
                syntheticFinding(prepared.reviewer, `Invalid audit reviewer output contract: ${String(error)}`)
            ]
        };
    }
}
function syntheticFinding(agent, evidence) {
    return {
        id: `AUDIT-${agent}-SYSTEM`,
        severity: "critical",
        category: "audit-system",
        location: { file: ".harness" },
        evidence,
        impact: "The requested audit could not be completed reliably.",
        recommendedFix: "Repair the reviewer/runtime contract and rerun the audit.",
        requiredCompetencies: ["audit-review"],
        reviewDimensions: ["audit-evidence"],
        exceptionType: "SYSTEM_FAILURE"
    };
}
async function reviewerArtifacts(root, outputs) {
    const operationId = currentOperationContext().id;
    if (!operationId)
        return [];
    const operation = await loadOperation(resolveOperationStateRoot(root), operationId);
    return outputs
        .map((output) => output.session.id ? operation.participants[output.session.id]?.resultArtifact : undefined)
        .filter((value) => Boolean(value));
}
async function operationStage(root, name, status, options = {}) {
    const operationId = currentOperationContext().id;
    if (!operationId)
        return;
    await setOperationStage(resolveOperationStateRoot(root), operationId, name, status, options);
}
async function persistAudit(root, report) {
    const outputDir = path.resolve(root, AUDIT_OUTPUT_DIR);
    await fs.mkdir(outputDir, { recursive: true });
    const file = path.join(outputDir, `${report.auditId}.json`);
    await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    await fs.writeFile(path.join(outputDir, "latest.json"), `${JSON.stringify({ auditId: report.auditId, report: path.relative(root, file), finishedAt: report.finishedAt }, null, 2)}\n`);
}
function createAuditId(request) {
    const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
    const hash = crypto.createHash("sha256").update(request).digest("hex").slice(0, 8);
    return `AUDIT-${stamp}-${hash}`;
}
async function gitCommit(root) {
    const result = await runExecutable("git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 });
    return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}
//# sourceMappingURL=run.js.map