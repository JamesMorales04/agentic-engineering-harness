import fs from "node:fs/promises";
import path from "node:path";
import { validateExecutionCapabilities } from "./permissions.js";
import { dedupeFindings } from "./findings.js";
import { orchestratorOutputSchema, plannerOutputSchema, reviewerOutputSchema } from "./outputContracts.js";
import { extractMarkedJson } from "./structuredOutput.js";
import { analyzeQualityState, evaluateFinalQualityGate, formatDebtScore } from "./qualityConvergence.js";
import { escalationStages, nextEscalationIndex, resumeAfterReplan } from "./escalation.js";
import { detectHumanException, detectRuntimeExternalException, diagnosisToException, exceptionDiagnosisSchema } from "./exceptionDetection.js";
import { executeAgentPrompt } from "../workers/agentPrompt.js";
import { executeRepairerCandidateMutation, rejectRepairCandidateChangeSet } from "../candidates/repair.js";
import { executeIsolatedCandidateMutation } from "../candidates/direct.js";
import { assertWorkspaceMatchesCandidate } from "../candidates/identity.js";
import { recordEvent } from "../telemetry/events.js";
import { currentOperationContext, loadOperation, resolveOperationStateRoot } from "../operations/state.js";
import { consolidateWithOperationSupervisor, maybeRotateOperationSupervisor } from "../operations/supervisor.js";
export async function runReviewLifecycle(input) {
    const { root, config, contract, route, reviewerSelections, leadSelection, repairerSelection, executionCatalog, prepareRepairWorkspace, stageSelections, supervisorSelection, implementationSelection } = input;
    const stateRoot = input.stateRoot ?? root;
    let report = input.report;
    const sessions = [];
    const checks = [];
    const qualityHistory = [];
    const policy = config.workflow?.reviews;
    let candidateImpact = input.candidateImpact;
    let candidateAssurance = input.candidateAssurance;
    let assuranceGateCheck = input.assuranceGateCheck;
    const requiredAssignments = candidateAssurance?.reviewAssignments ?? [];
    if (policy?.enabled === false && requiredAssignments.length === 0)
        return emptyResult(report, checks, sessions);
    if (!report.candidate)
        throw new Error("CANDIDATE_BINDING_REQUIRED: review requires a candidate-bound validation report.");
    checks.push(candidateIdentityCheck("candidate.workspace-identity.review-entry", await assertCurrentReviewCandidate(root, report.candidate)));
    if (assuranceGateCheck)
        checks.push(assuranceGateCheck);
    const isDirect = contract.routing?.route === "DIRECT";
    const runReviewers = requiredAssignments.length > 0 || !isDirect || policy?.directReview === true;
    let reviewerAssignments = requiredAssignments;
    let reviewerNames = requiredAssignments.length
        ? requiredAssignments.map((assignment) => assignment.reviewerIdentity)
        : runReviewers ? route.reviewers : [];
    const recompileCandidate = async (impact, candidateReport) => {
        if (!input.recompileCandidateAssurance)
            return candidateReport;
        const evaluation = await input.recompileCandidateAssurance(impact, candidateReport);
        candidateImpact = impact;
        candidateAssurance = evaluation.compilation;
        assuranceGateCheck = evaluation.gateCheck;
        reviewerAssignments = candidateAssurance?.reviewAssignments ?? [];
        reviewerNames = reviewerAssignments.length
            ? reviewerAssignments.map((assignment) => assignment.reviewerIdentity)
            : runReviewers ? route.reviewers : [];
        const prior = checks.findIndex((check) => check.id === evaluation.gateCheck.id);
        if (prior >= 0)
            checks[prior] = evaluation.gateCheck;
        else
            checks.push(evaluation.gateCheck);
        const withValidationChecks = mergeChecksById(candidateReport, evaluation.validationChecks);
        return mergeReviewCheck(withValidationChecks, evaluation.gateCheck);
    };
    const stages = escalationStages(config);
    let stageIndex = 0;
    let remediationRounds = 0;
    let replanContext;
    let deduped = emptyFindings();
    if (reviewerNames.length) {
        const initialRound = await runReviewRound(root, stateRoot, config, contract, reviewerSelections, implementationSelection, supervisorSelection, reviewerNames, report, sessions, 0, checks, prepareRepairWorkspace, reviewerAssignments);
        if (initialRound.failures.length)
            return await reviewerProviderFailureResult(stateRoot, config, contract, initialRound.failures, remediationRounds, report, initialRound.findings, checks, sessions, qualityHistory);
        deduped = initialRound.findings;
    }
    let state = analyzeQualityState(deduped.findings, qualityHistory, config, report.candidate?.identityDigest);
    qualityHistory.push(state);
    await persistQualityState(stateRoot, config, contract.task.id, state);
    while (true) {
        const exception = detectHumanException(deduped.findings);
        if (exception?.humanRequired)
            return humanExceptionResult(exception, remediationRounds, report, deduped, checks, sessions, qualityHistory);
        // A SYSTEM_FAILURE finding (reviewer/runtime contract failure or an explicit model
        // classification) is a terminal system failure, never remediable implementation debt.
        if (exception)
            return await systemFailureResult(stateRoot, config, contract, `Review system failure (${exception.type}): ${exception.rationale}`, remediationRounds, report, deduped, checks, sessions, qualityHistory);
        if (state.gate.pass) {
            checks.push({ id: "agent.final-quality-gate", category: "agent-review", status: "PASS", message: `Final Quality Gate passed: critical=${state.counts.critical}, high=${state.counts.high}, medium=${state.counts.medium}, low=${state.counts.low}, note=${state.counts.note}, DebtScore=${formatDebtScore(state.debtScore)}.`, details: { state } });
            const shouldLeadAccept = policy?.leadAcceptance !== false && (!isDirect || policy?.leadAcceptanceDirect === true);
            if (!shouldLeadAccept)
                return successResult(remediationRounds, report, deduped, checks, sessions, qualityHistory);
            if (currentOperationContext().id) {
                // The durable operation is bound to the actual interactive lead. Do not
                // synthesize a second hidden orchestrator session inside the RUN. The
                // controller uses the bound Lead for candidate-bound semantic evidence
                // in the S6 AcceptanceOracle phase before any delivery effects.
                checks.push({
                    id: "agent.interactive-lead-acceptance",
                    category: "agent-review",
                    status: "PASS",
                    message: "Deterministic quality checks passed; bound Lead semantic evidence and the controller-owned AcceptanceOracle run afterward before delivery. This quality check is not product acceptance."
                });
                return successResult(remediationRounds, report, deduped, checks, sessions, qualityHistory);
            }
            // Synchronous/non-controller compatibility path.
            const leadResult = await runLeadAcceptance(root, config, contract, leadSelection, report, deduped, sessions);
            if (leadResult.accepted) {
                checks.push({ id: "agent.lead-acceptance", category: "agent-review", status: "PASS", message: `Lead ${leadResult.agent} accepted finalization.`, details: { summary: leadResult.summary } });
                return successResult(remediationRounds, report, deduped, checks, sessions, qualityHistory, true);
            }
            if (leadResult.externalException)
                return humanExceptionResult(leadResult.externalException, remediationRounds, report, deduped, checks, sessions, qualityHistory);
            if (leadResult.contractFailure) {
                checks.push({ id: "agent.lead-acceptance", category: "agent-review", status: "FAIL", message: leadResult.contractFailure });
                return { status: "FAIL", finalState: "SYSTEM_FAILURE", humanRequired: false, rounds: remediationRounds, report, findings: deduped, checks, sessions, qualityHistory, leadAccepted: false };
            }
            deduped = dedupeFindings(leadResult.unresolved.map((item, index) => leadFinding(index, item, implementationSelection.logicalAgent)));
            state = analyzeQualityState(deduped.findings, qualityHistory, config, report.candidate?.identityDigest);
            qualityHistory.push(state);
            await persistQualityState(stateRoot, config, contract.task.id, state);
            stageIndex = Math.max(stageIndex, Math.min(2, Math.max(0, stages.length - 1)));
            continue;
        }
        checks.push({ id: "agent.final-quality-gate", category: "agent-review", status: "FAIL", message: `Quality Gate not yet satisfied: ${state.gate.reasons.join("; ")}. Autonomous remediation continues.`, details: { state } });
        stageIndex = nextEscalationIndex(state, stageIndex, config);
        const stage = stages[stageIndex] ?? { name: "normal", action: "remediate" };
        if (stage.action === "diagnose") {
            const diagnosis = await runDiagnosis(root, config, contract, stageSelections?.[stage.name] ?? implementationSelection, state, deduped, sessions);
            if (diagnosis?.humanRequired)
                return humanExceptionResult(diagnosis, remediationRounds, report, deduped, checks, sessions, qualityHistory);
            await recordEvent(stateRoot, config, "harness.quality.diagnosis", { taskId: contract.task.id, round: remediationRounds, stage: stage.name, classification: diagnosis?.type ?? "IMPLEMENTATION_DEFECT" });
            stageIndex = Math.min(stageIndex + 1, Math.max(0, stages.length - 1));
            continue;
        }
        if (stage.action === "replan") {
            const replanned = await runAutonomousReplan(root, config, contract, stageSelections?.[stage.name] ?? implementationSelection, state, deduped, sessions);
            if (replanned.exception?.humanRequired)
                return humanExceptionResult(replanned.exception, remediationRounds, report, deduped, checks, sessions, qualityHistory);
            if (replanned.plan) {
                replanContext = replanned.plan;
                await persistReplan(stateRoot, config, contract.task.id, remediationRounds, replanned.plan);
            }
            await recordEvent(stateRoot, config, "harness.quality.replan", { taskId: contract.task.id, round: remediationRounds, stage: stage.name, workUnits: replanned.plan?.workUnits.length ?? 0 });
            stageIndex = resumeAfterReplan(config);
            continue;
        }
        // Deterministic execution budget: an autonomous remediation loop that repeatedly fails to reach
        // the Final Quality Gate must terminalize instead of running forever (AEH-V2-0119). A reviewer
        // provider stop surfaces as a synthetic critical finding, so without this bound a participant
        // runtime failure could remediate indefinitely without changing anything.
        if (remediationBudgetReached(remediationRounds, config)) {
            const budget = remediationBudgetRounds(config);
            const message = `Remediation budget of ${budget} round(s) is exhausted without satisfying the Final Quality Gate: ${state.gate.reasons.join("; ")}.`;
            checks.push({ id: "agent.remediation-budget", category: "agent-review", status: "FAIL", message, details: { round: remediationRounds, budget, state } });
            await recordEvent(stateRoot, config, "harness.quality.remediation-budget-exhausted", { taskId: contract.task.id, round: remediationRounds, budget, convergence: state.convergence, debtPoints: state.debtPoints });
            return { status: "FAIL", finalState: "SYSTEM_FAILURE", humanRequired: false, rounds: remediationRounds, report, findings: deduped, checks, sessions, qualityHistory, leadAccepted: false };
        }
        const remediationSelection = repairerSelection;
        if (!remediationSelection || !executionCatalog)
            throw new Error("REPAIR_AUTHORITY_REQUIRED: review remediation requires a frozen Repairer selection and compiled role binding.");
        const transport = remediationSelection.transport === "inherit" ? (config.orchestration?.provider ?? "none") : remediationSelection.transport;
        const capabilityIssues = validateExecutionCapabilities(remediationSelection, transport);
        if (remediationSelection.role !== "Repairer")
            throw new Error("REPAIR_AUTHORITY_REQUIRED: quality remediation may only be performed by the canonical Repairer role.");
        if (capabilityIssues.length)
            throw new Error(`Quality Repairer ${remediationSelection.logicalAgent} is not executable: ${capabilityIssues.join("; ")}`);
        remediationRounds += 1;
        const operationId = currentOperationContext().id;
        if (!operationId)
            throw new Error("REPAIR_AUTHORITY_REQUIRED: quality remediation requires a managed operation.");
        const repairPrompt = `${buildRemediationPrompt(contract, stage, state, deduped.findings, replanContext)}\n\nYou are the canonical Repairer. Change implementation only within the frozen task scope. Do not change requirements, acceptance, validators, policy, or review outcomes. You cannot approve or accept the candidate.`;
        const mutation = await executeRepairerCandidateMutation({
            root,
            stateRoot,
            operationId,
            taskId: contract.task.id,
            workUnitId: `quality-repair:${contract.task.id}:${remediationRounds}`,
            phase: "review-remediation",
            config,
            contract,
            selection: remediationSelection,
            executionCatalog,
            allowedScope: contract.scope?.allowed ?? ["**"],
            forbiddenScope: [...(contract.scope?.forbidden ?? []), ...(contract.scope?.frozen ?? []), ...(config.validation?.frozenPaths ?? [])],
            prompt: repairPrompt,
            prepareWorkspace: prepareRepairWorkspace,
            semanticAssessment: input.candidateImpactAssessment,
            execute: (isolatedRoot, participantId) => executeAgentPrompt(isolatedRoot, config, contract, remediationSelection, repairPrompt, { outputContract: remediationSelection.outputContract ?? "implementer", phase: "repair", operationKind: currentOperationContext().kind, participantId, requireExecutionAuthority: true })
        });
        const remediation = mutation.session;
        sessions.push(remediation);
        const rejectMutation = async (reason) => {
            let restoredImpact = candidateImpact;
            if (mutation.changeSet) {
                const restored = await rejectRepairCandidateChangeSet({
                    root,
                    stateRoot,
                    operationId,
                    taskId: contract.task.id,
                    workUnitId: `quality-repair:${contract.task.id}:${remediationRounds}:reject`,
                    config,
                    contract,
                    rejectedChangeSet: mutation.changeSet,
                    allowedScope: contract.scope?.allowed ?? ["**"],
                    forbiddenScope: [...(contract.scope?.forbidden ?? []), ...(contract.scope?.frozen ?? []), ...(config.validation?.frozenPaths ?? [])],
                    prepareWorkspace: prepareRepairWorkspace,
                    semanticAssessment: input.candidateImpactAssessment
                });
                restoredImpact = restored.impact;
            }
            report = await input.revalidate();
            report = await recompileCandidate(restoredImpact, report);
            await recordEvent(stateRoot, config, "harness.quality.candidate-rejected", { taskId: contract.task.id, round: remediationRounds, reason, candidateRevision: report.candidate?.revision, candidateDigest: report.candidate?.sourceDigest });
        };
        const runtimeException = detectRuntimeExternalException(remediation);
        if (runtimeException?.humanRequired) {
            await rejectMutation("external-exception");
            return humanExceptionResult(runtimeException, remediationRounds, report, deduped, checks, sessions, qualityHistory);
        }
        if (remediation.exitCode !== 0) {
            await rejectMutation("repairer-runtime-failure");
            stageIndex = Math.min(stageIndex + 1, Math.max(0, stages.length - 1));
            continue;
        }
        let candidateReport = await input.revalidate();
        candidateReport = await recompileCandidate(mutation.impact ?? candidateImpact, candidateReport);
        const expectedCandidate = mutation.candidate?.identityDigest ?? report.candidate?.identityDigest;
        const observedCandidate = candidateReport.candidate?.identityDigest;
        if (expectedCandidate !== observedCandidate && (expectedCandidate !== undefined || observedCandidate !== undefined)) {
            throw new Error(`V2_CANDIDATE_BINDING_REJECTED: Repairer candidate identity drifted during review remediation (expected ${expectedCandidate}, observed ${observedCandidate}).`);
        }
        if (candidateReport.status === "FAIL") {
            await rejectMutation("deterministic-regression");
            stageIndex = Math.min(stageIndex + 1, Math.max(0, stages.length - 1));
            continue;
        }
        const candidateRound = reviewerNames.length
            ? await runReviewRound(root, stateRoot, config, contract, reviewerSelections, implementationSelection, supervisorSelection, reviewerNames, candidateReport, sessions, qualityHistory.length, checks, prepareRepairWorkspace, reviewerAssignments)
            : { findings: emptyFindings(), failures: [] };
        if (candidateRound.failures.length)
            return await reviewerProviderFailureResult(stateRoot, config, contract, candidateRound.failures, remediationRounds, candidateReport, candidateRound.findings, checks, sessions, qualityHistory);
        const candidateFindings = candidateRound.findings;
        const candidateState = analyzeQualityState(candidateFindings.findings, qualityHistory, config, candidateReport.candidate?.identityDigest);
        await persistQualityState(stateRoot, config, contract.task.id, candidateState);
        if (candidateState.convergence === "REGRESSING") {
            await rejectMutation("review-debt-regression");
            await persistRejectedState(stateRoot, config, contract.task.id, candidateState, stage.name, [report.candidate ? `candidate-r${report.candidate.revision}` : "candidate-unknown"]);
            await recordEvent(stateRoot, config, "harness.quality.candidate-rejected", { taskId: contract.task.id, round: remediationRounds, reason: "review-debt-regression", stage: stage.name, beforeDebtPoints: state.debtPoints, candidateDebtPoints: candidateState.debtPoints, candidateRevision: report.candidate?.revision });
            stageIndex = Math.min(stageIndex + 1, Math.max(0, stages.length - 1));
            continue;
        }
        report = candidateReport;
        deduped = candidateFindings;
        state = candidateState;
        qualityHistory.push(state);
        await recordEvent(stateRoot, config, "harness.review.round", { taskId: contract.task.id, round: remediationRounds, reviewers: reviewerNames, findings: deduped.outputCount, debtPoints: state.debtPoints, debtScore: state.debtScore, convergence: state.convergence, resolved: state.resolved.length, persistent: state.persistent.length, introduced: state.introduced.length, stage: stage.name, agent: remediationSelection.logicalAgent, model: remediationSelection.modelId });
    }
}
/** Bounded autonomous remediation budget (deterministic execution policy, AEH-V2-0119). */
export function remediationBudgetRounds(config) {
    return config.workflow?.reviews?.escalation?.maxRounds ?? 6;
}
export function remediationBudgetReached(rounds, config) {
    return rounds >= remediationBudgetRounds(config);
}
async function runReviewRound(root, stateRoot, config, contract, reviewerSelections, implementationSelection, supervisorSelection, reviewerNames, report, sessions, round, checks, prepareReviewWorkspace, assuranceAssignments = []) {
    if (!report.candidate)
        throw new Error("CANDIDATE_BINDING_REQUIRED: reviewer invocation requires a candidate-bound report.");
    const assuranceByIdentity = new Map(assuranceAssignments.map((assignment) => [assignment.reviewerIdentity, assignment]));
    const outputs = await Promise.all(reviewerNames.map(async (name) => {
        const selection = reviewerSelections[name];
        if (!selection || selection.role !== "Reviewer")
            throw new Error(`REVIEW_AUTHORITY_REQUIRED: '${name}' is not a frozen canonical Reviewer selection.`);
        if (selection.logicalAgent === implementationSelection.logicalAgent)
            throw new Error("REVIEW_INDEPENDENCE_REQUIRED: the Implementer cannot review its own candidate.");
        if (selection.permissions.write !== "deny")
            throw new Error(`REVIEW_AUTHORITY_REQUIRED: Reviewer '${name}' must have denied source-write authority.`);
        const transport = selection.transport === "inherit" ? (config.orchestration?.provider ?? "none") : selection.transport;
        const capabilityIssues = validateExecutionCapabilities(selection, transport);
        if (capabilityIssues.length)
            throw new Error(`REVIEW_EXECUTION_INVALID: Reviewer '${name}' is not executable: ${capabilityIssues.join("; ")}`);
        const identityEvidence = await assertCurrentReviewCandidate(root, report.candidate);
        checks.push(candidateIdentityCheck(`candidate.workspace-identity.reviewer-${round}-${name}`, identityEvidence));
        return runReviewer(root, config, contract, selection, name, report, assuranceByIdentity.get(name)?.dimensions ?? [], prepareReviewWorkspace);
    }));
    const afterReviewerIdentity = await assertCurrentReviewCandidate(root, report.candidate);
    checks.push(candidateIdentityCheck(`candidate.workspace-identity.after-review-${round}`, afterReviewerIdentity));
    const rawFindings = [];
    const failures = [];
    for (const output of outputs) {
        sessions.push(output.session);
        rawFindings.push(...output.findings.map((finding) => ({ ...finding, id: `${output.reviewer}:${finding.id}` })));
        if (output.failure)
            failures.push(output.failure);
        const assignment = assuranceByIdentity.get(output.reviewer);
        if (assignment) {
            const identityMatches = output.session.logicalAgent === assignment.reviewerIdentity;
            const evidenceValid = output.valid && identityMatches;
            replaceSupersededReviewerChecksV1(checks, round, output.reviewer, {
                id: `candidate.assurance.reviewer.${round}.${output.reviewer}`,
                category: "candidate-assurance",
                status: evidenceValid ? "PASS" : "FAIL",
                message: evidenceValid ? `Configured independent Reviewer '${output.reviewer}' returned structured evidence for the assigned impact dimensions.` : `Assigned Reviewer '${output.reviewer}' did not return valid structured evidence from its exact configured identity.`,
                details: { reviewerIdentity: assignment.reviewerIdentity, observedReviewerIdentity: output.session.logicalAgent, provider: assignment.provider, actualProvider: output.session.provider, dimensions: assignment.dimensions, candidate: assignment.candidate, impactDigest: assignment.impactDigest, policyDigest: assignment.policyDigest, sessionId: output.session.id }
            });
        }
    }
    // A failed reviewer turn is terminal system evidence, not a finding to consolidate or remediate.
    // Short-circuit before the supervisor turn so a model cannot reclassify a provider stop into debt.
    if (failures.length)
        return { findings: dedupeFindings(rawFindings), failures };
    let deduped;
    const operationId = currentOperationContext().id;
    if (operationId) {
        const operation = await loadOperation(resolveOperationStateRoot(root), operationId);
        const sourceArtifacts = outputs.map((output) => output.session.id ? operation.participants[output.session.id]?.resultArtifact : undefined).filter((value) => Boolean(value));
        const consolidation = await consolidateWithOperationSupervisor(root, config, contract, supervisorSelection, {
            key: `review-round-${round}`,
            purpose: `quality review round ${round}`,
            findings: rawFindings,
            sourceArtifacts,
            deterministicEvidence: report
        });
        sessions.push(consolidation.session);
        deduped = dedupeFindings(consolidation.output.consolidatedFindings);
        await maybeRotateOperationSupervisor(root, config, contract, supervisorSelection);
    }
    else {
        deduped = dedupeFindings(rawFindings);
    }
    const afterConsolidationIdentity = await assertCurrentReviewCandidate(root, report.candidate);
    checks.push(candidateIdentityCheck(`candidate.workspace-identity.after-review-consolidation-${round}`, afterConsolidationIdentity));
    await persistFindings(stateRoot, config, contract.task.id, round, deduped);
    return { findings: deduped, failures: [] };
}
async function assertCurrentReviewCandidate(root, candidate) {
    const operationId = currentOperationContext().id;
    if (!operationId)
        return assertWorkspaceMatchesCandidate(root, candidate);
    const operation = await loadOperation(resolveOperationStateRoot(root), operationId);
    return assertWorkspaceMatchesCandidate(root, candidate, operation.candidateRevision ?? null);
}
async function runReviewer(root, config, contract, selection, name, report, assignedDimensions, prepareReviewWorkspace) {
    if (!selection)
        throw new Error(`REVIEW_EXECUTION_INVALID: no frozen selection exists for reviewer '${name}'.`);
    const candidate = report.candidate;
    if (!candidate)
        throw new Error("CANDIDATE_BINDING_REQUIRED: reviewer invocation requires a candidate-bound report.");
    const isolated = await executeIsolatedCandidateMutation({
        root,
        operationId: candidate.operationId,
        taskId: contract.task.id,
        workUnitId: `review:${contract.task.id}:${name}:${candidate.revision}`,
        candidate,
        config,
        contract,
        prepareWorkspace: prepareReviewWorkspace,
        execute: (isolatedRoot) => executeAgentPrompt(isolatedRoot, config, contract, selection, buildReviewerPrompt(contract, name, report, assignedDimensions), { outputContract: "reviewer", phase: "review", operationKind: currentOperationContext().kind, requireExecutionAuthority: true })
    });
    const session = isolated.session;
    if (isolated.changeSet) {
        const detail = "Reviewer attempted to modify its isolated candidate snapshot; the output was rejected.";
        return { reviewer: name, session, findings: [syntheticFinding(name, detail)], valid: false, failure: { reviewer: name, kind: "MUTATION", detail, sessionId: session.id, exitCode: session.exitCode } };
    }
    if (session.exitCode !== 0) {
        const stop = (session.stderr || session.stdout || "no provider output").replace(/\s+/g, " ").trim().slice(0, 600);
        const detail = `Reviewer provider session stopped or exited with code ${session.exitCode}: ${stop}`;
        return { reviewer: name, session, findings: [syntheticFinding(name, detail)], valid: false, failure: { reviewer: name, kind: "RUNTIME", detail, sessionId: session.id, exitCode: session.exitCode } };
    }
    try {
        const output = reviewerOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr));
        if (output.verdict === "FAIL" && output.findings.length === 0)
            return { reviewer: name, session, findings: [syntheticFinding(name, "Reviewer returned FAIL without a structured finding.")], valid: false };
        return { reviewer: name, session, findings: output.findings, valid: true };
    }
    catch (error) {
        const detail = `Invalid reviewer output contract: ${String(error)}`;
        return { reviewer: name, session, findings: [syntheticFinding(name, detail)], valid: false, failure: { reviewer: name, kind: "CONTRACT", detail, sessionId: session.id, exitCode: session.exitCode } };
    }
}
function reviewerProviderFailureResult(stateRoot, config, contract, failures, rounds, report, findings, checks, sessions, qualityHistory) {
    const detail = failures.map((failure) => `${failure.reviewer} (${failure.kind}${failure.sessionId ? `, session ${failure.sessionId}` : ""}${failure.exitCode !== undefined ? `, exit ${failure.exitCode}` : ""}): ${failure.detail}`).join(" | ");
    return systemFailureResult(stateRoot, config, contract, `Reviewer provider turn failed; this is not remediable implementation debt. ${detail}`, rounds, report, findings, checks, sessions, qualityHistory);
}
async function systemFailureResult(stateRoot, config, contract, message, rounds, report, findings, checks, sessions, qualityHistory) {
    const bounded = message.replace(/\s+/g, " ").trim().slice(0, 1200);
    checks.push({ id: "agent.system-failure", category: "agent-review", status: "FAIL", message: bounded, details: { round: rounds } });
    // Every returned lifecycle result carries at least one quality state; callers persist the review
    // summary from it and must not crash on a terminal failure path (AEH-V2-0120).
    qualityHistory.push(analyzeQualityState(findings.findings, qualityHistory, config, report.candidate?.identityDigest));
    await recordEvent(stateRoot, config, "harness.review.system-failure", { taskId: contract.task.id, round: rounds, message: bounded }).catch(() => undefined);
    return { status: "FAIL", finalState: "SYSTEM_FAILURE", humanRequired: false, rounds, report, findings, checks, sessions, qualityHistory, leadAccepted: false };
}
function candidateIdentityCheck(id, evidence) {
    return {
        id,
        category: "candidate-identity",
        status: "PASS",
        message: `Workspace digest matches CandidateRevision ${evidence.candidateId} r${evidence.candidateRevision}.`,
        details: { ...evidence }
    };
}
/**
 * Replace a reviewer's superseded round checks with the current round's check. A report carries
 * checks across review/remediation rounds; an earlier failed round for a superseded candidate is
 * not the current candidate's review state and must not poison the merged report status once a
 * newer round produced the current evidence. Exactly one current check remains per reviewer.
 */
export function replaceSupersededReviewerChecksV1(checks, round, reviewer, check) {
    const pattern = new RegExp(`^candidate\\.assurance\\.reviewer\\.(\\d+)\\.${reviewer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    for (let index = checks.length - 1; index >= 0; index -= 1) {
        const match = pattern.exec(checks[index].id);
        if (match && Number(match[1]) < round)
            checks.splice(index, 1);
    }
    checks.push(check);
}
function mergeReviewCheck(report, check) {
    return mergeChecksById(report, [check]);
}
function mergeChecksById(report, extra) {
    const byId = new Map(report.checks.map((existing) => [existing.id, existing]));
    for (const check of extra)
        byId.set(check.id, check);
    const checks = [...byId.values()];
    return { ...report, checks, status: checks.some((item) => item.status === "FAIL") ? "FAIL" : "PASS" };
}
async function runDiagnosis(root, config, contract, selection, state, findings, sessions) {
    const session = await executeAgentPrompt(root, config, contract, selection, buildDiagnosisPrompt(contract, state, findings), { phase: "diagnosis", operationKind: currentOperationContext().kind, requireExecutionAuthority: true });
    sessions.push(session);
    const external = detectRuntimeExternalException(session);
    if (external)
        return external;
    if (session.exitCode !== 0)
        return undefined;
    try {
        return diagnosisToException(exceptionDiagnosisSchema.parse(extractMarkedJson(session.stdout, session.stderr)));
    }
    catch {
        return undefined;
    }
}
async function runAutonomousReplan(root, config, contract, selection, state, findings, sessions) {
    const session = await executeAgentPrompt(root, config, contract, selection, buildReplanPrompt(contract, state, findings), { outputContract: "planner", phase: "replanning", operationKind: currentOperationContext().kind, requireExecutionAuthority: true });
    sessions.push(session);
    const external = detectRuntimeExternalException(session);
    if (external)
        return { exception: external };
    if (session.exitCode !== 0)
        return {};
    try {
        return { plan: plannerOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr)) };
    }
    catch {
        return {};
    }
}
async function runLeadAcceptance(root, config, contract, selection, report, findings, sessions) {
    if (!selection)
        return { accepted: false, agent: "<missing>", unresolved: [], contractFailure: "Lead acceptance is enabled but no frozen Lead/Director selection is available." };
    const session = await executeAgentPrompt(root, config, contract, selection, buildLeadPrompt(contract, report, findings), { phase: "lead-acceptance", requireExecutionAuthority: true });
    sessions.push(session);
    const externalException = detectRuntimeExternalException(session);
    if (externalException)
        return { accepted: false, agent: selection.logicalAgent, unresolved: [], externalException };
    try {
        const parsed = orchestratorOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr));
        const accepted = session.exitCode === 0 && parsed.finalizationSafe === true && parsed.unresolved.length === 0;
        return { accepted, agent: selection.logicalAgent, summary: parsed.summary, unresolved: parsed.unresolved.length ? parsed.unresolved : accepted ? [] : [parsed.summary || "Lead did not declare finalization safe."] };
    }
    catch (error) {
        return { accepted: false, agent: selection.logicalAgent, unresolved: [], contractFailure: `Lead output contract was invalid: ${String(error)}` };
    }
}
function buildReviewerPrompt(contract, reviewer, report, assignedDimensions = []) {
    const assignment = assignedDimensions.length ? ` Your frozen independent review assignment covers these impact dimensions: ${assignedDimensions.join(", ")}. Inspect each assigned dimension against the assembled candidate.` : "";
    const changed = [...new Set((report.changedFiles ?? []).filter(Boolean))].slice(0, 50);
    const changedLine = changed.length ? ` The assembled candidate changed these files: ${changed.join(", ")}. Read them directly in this workspace.` : "";
    const requirements = (contract.requirements ?? []).slice(0, 20).map((requirement) => `${requirement.id}: ${requirement.description}`).join(" | ");
    const requirementsLine = requirements ? ` The sealed contract requirements are: ${requirements}.` : "";
    const boundary = " This is a read-only review turn: do not modify files and do not attempt to access paths outside this candidate workspace and the operation control root (for example /root, /home or /etc). An out-of-scope read stops the provider session and fails the operation; inspect the candidate files directly instead.";
    return `You are reviewer ${reviewer} for ${contract.task.id}. Inspect the assembled candidate against the sealed task contract, including the diff from ${contract.git?.baseRef ?? "main"} where a read-only command is available.${changedLine}${requirementsLine}${boundary} Deterministic validation currently reports ${report.status}.${assignment} Return findings with requiredCompetencies and reviewDimensions; never select a concrete agent or reviewer. Use exceptionType only when the issue cannot be resolved from the sealed requirements/repository without an external human decision or resource. Your final output MUST contain exactly one line beginning AEH_RESULT_JSON= followed by the JSON object.`;
}
function buildRemediationPrompt(contract, stage, state, findings, replan) {
    return `Autonomously remediate review debt for ${contract.task.id}. Stage=${stage.name}. Current DebtScore=${formatDebtScore(state.debtScore)}; final gate requires critical=0, high=0, medium=0, low<=3 and DebtScore<=3. Three notes equal one low. Do not change sealed contracts/specs/acceptance. Critical/high/medium findings are mandatory. Resolve low/note findings as needed to reach the final debt budget without broadening scope or creating regressions. ${replan ? `A stronger planner produced this advisory remediation plan (it does not override the sealed contract):\n${JSON.stringify(replan, null, 2)}\n` : ""}Findings:\n${JSON.stringify(findings, null, 2)}\nMake the smallest coherent changes and run focused checks. Do not ask the user unless a sealed requirement is contradictory, a product decision is genuinely missing, or an external credential/permission is required.`;
}
function buildDiagnosisPrompt(contract, state, findings) {
    return `Diagnose why quality remediation for ${contract.task.id} is not converging. Current convergence=${state.convergence}, DebtScore=${formatDebtScore(state.debtScore)}. Inspect the sealed contract/spec, actual diff, tests and findings. Classify ONLY as IMPLEMENTATION_DEFECT, SPEC_CONTRADICTION, REQUIRES_PRODUCT_DECISION, BLOCKED_EXTERNAL, or SYSTEM_FAILURE. Prefer IMPLEMENTATION_DEFECT when the repository/spec already determines the answer. Human intervention is justified only for true contradictions, missing product decisions, or unavailable external credentials/permissions. Return {"classification":"...","rationale":"...","recommendedAction":"..."}. Final line: AEH_RESULT_JSON=<json>. Findings=${JSON.stringify(findings.findings)}`;
}
function buildReplanPrompt(contract, state, findings) {
    return `Create a new implementation WorkGraph for ${contract.task.id} because remediation is ${state.convergence}. The sealed TaskContract/spec is immutable and authoritative; replan implementation only. Current DebtScore=${formatDebtScore(state.debtScore)}. Return workUnits[{id,objective,scope,dependencies,requirementRefs,acceptanceRefs,competencies,riskTags,changeKinds,risk}], reviewDimensions, typed validationRequirements and outOfScopeImprovements. Never select a concrete agent, reviewer, validator, tool or command. Final line: AEH_RESULT_JSON=<json>. Findings=${JSON.stringify(findings.findings)}`;
}
function buildLeadPrompt(contract, report, findings) {
    return `You are the lead engineer performing final semantic acceptance for ${contract.task.id}. The deterministic report and Final Quality Gate have passed. Inspect the actual final diff, sealed requirements and reviewer evidence. Do not modify files. Deterministic status=${report.status}. Remaining findings=${JSON.stringify(findings.findings)}. Return {"summary":"...","delegatedAgents":[],"validationStatus":"${report.status}","unresolved":[],"finalizationSafe":true|false}. If something is unresolved, state it concretely; the Harness will attempt autonomous replanning/remediation rather than immediately asking the user. Final line: AEH_RESULT_JSON=<json>.`;
}
function syntheticFinding(agent, evidence) {
    return { id: `REVIEW-${agent}-${Date.now()}`, severity: "critical", category: "review-contract", location: { file: "<review-output>" }, evidence, impact: "The review cannot be trusted as valid evidence.", recommendedFix: "Repair or rerun the reviewer output contract.", requiredCompetencies: ["review-contract"], reviewDimensions: ["evidence-integrity"], exceptionType: "SYSTEM_FAILURE" };
}
function leadFinding(index, text, agent) {
    return { id: `LEAD-${index + 1}`, severity: "medium", category: "lead-unresolved", location: { file: "<lead-acceptance>" }, evidence: text, impact: "Lead semantic acceptance is not yet safe.", recommendedFix: "Replan and remediate the unresolved semantic concern without changing sealed requirements.", requiredCompetencies: ["semantic-acceptance"], reviewDimensions: ["requirements"], exceptionType: "IMPLEMENTATION_DEFECT" };
}
function emptyFindings() { return { inputCount: 0, outputCount: 0, findings: [], merges: [] }; }
async function persistFindings(root, config, taskId, round, findings) { const dir = path.resolve(root, config.agents?.findingsDir ?? ".harness/findings"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `${taskId}-round-${round}.json`), `${JSON.stringify(findings, null, 2)}\n`); }
async function persistQualityState(root, config, taskId, state) { const dir = path.resolve(root, config.agents?.findingsDir ?? ".harness/findings"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `${taskId}-quality-${state.round}.json`), `${JSON.stringify(state, null, 2)}\n`); }
async function persistRejectedState(root, config, taskId, state, stage, restored) { const dir = path.resolve(root, config.agents?.findingsDir ?? ".harness/findings"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `${taskId}-rejected-${Date.now()}.json`), `${JSON.stringify({ stage, state, restored }, null, 2)}\n`); }
async function persistReplan(root, config, taskId, round, plan) { const dir = path.resolve(root, config.agents?.findingsDir ?? ".harness/findings"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `${taskId}-replan-${round}.json`), `${JSON.stringify(plan, null, 2)}\n`); }
function humanExceptionResult(exception, rounds, report, findings, checks, sessions, qualityHistory) { const nextChecks = [...checks, { id: "agent.human-on-exception", category: "agent-review", status: "FAIL", message: `${exception.type}: ${exception.rationale}`, details: { exception } }]; return { status: "FAIL", finalState: exception.type, humanRequired: true, rounds, report, findings, checks: nextChecks, sessions, qualityHistory, exception }; }
function successResult(rounds, report, findings, checks, sessions, qualityHistory, leadAccepted) { return { status: "PASS", finalState: "ACCEPTED", humanRequired: false, rounds, report, findings, checks, sessions, qualityHistory, leadAccepted }; }
function emptyResult(report, checks, sessions) { const gate = evaluateFinalQualityGate([], { version: 1, project: { name: "disabled" } }); const state = { round: 0, counts: gate.counts, debtPoints: gate.debtPoints, debtScore: gate.debtScore, fingerprint: "", findingFingerprints: [], resolved: [], persistent: [], introduced: [], convergence: "CONVERGED", gate }; return { status: "PASS", finalState: "ACCEPTED", humanRequired: false, rounds: 0, report, findings: emptyFindings(), checks, sessions, qualityHistory: [state] }; }
//# sourceMappingURL=reviewLifecycle.js.map