import { initializingOperationSupervisor } from "./state.js";
const MAX_EVIDENCE_STRING = 4000;
const MAX_EVIDENCE_ARRAY = 100;
export function supervisorInitializationProjection(operation, generation) {
    return { operationId: operation.id, kind: operation.kind, revision: operation.revision, generation, status: operation.status };
}
export function supervisorConsolidationProjection(operation) {
    return {
        operationId: operation.id,
        kind: operation.kind,
        revision: operation.revision,
        phase: operation.phase,
        progress: {
            expected: operation.progress.expected,
            completed: operation.progress.completed,
            failed: operation.progress.failed,
            blocked: operation.progress.blocked
        },
        latestConsolidationArtifact: operation.supervision.latestConsolidationArtifact
    };
}
export function supervisorHandoffProjection(operation, generation, checkpointArtifact) {
    return {
        operationId: operation.id,
        kind: operation.kind,
        revision: operation.revision,
        generation,
        phase: operation.phase,
        status: operation.status,
        checkpointArtifact,
        latestConsolidationArtifact: operation.supervision.latestConsolidationArtifact,
        progress: { ...operation.progress },
        unresolvedParticipants: unresolvedParticipants(operation)
    };
}
export function supervisorCheckpointProjection(operation, contextRatio) {
    return {
        operationId: operation.id,
        kind: operation.kind,
        revision: operation.revision,
        phase: operation.phase,
        status: operation.status,
        intent: operation.intent,
        lead: operation.lead ? { generation: operation.lead.generation, acknowledgedRevision: operation.lead.acknowledgedRevision } : undefined,
        stages: operation.stages,
        progress: operation.progress,
        latestConsolidationArtifact: operation.supervision.latestConsolidationArtifact,
        activeSupervisorGeneration: operation.supervision.activeGeneration,
        initializingSupervisorGeneration: initializingOperationSupervisor(operation)?.generation,
        unresolvedParticipants: unresolvedParticipants(operation),
        contextRatio
    };
}
export function compactDeterministicEvidence(value) {
    if (Array.isArray(value))
        return value.slice(0, MAX_EVIDENCE_ARRAY).map(compactEvidenceNode);
    return compactEvidenceNode(value);
}
function compactEvidenceNode(value) {
    if (typeof value === "string")
        return boundString(value);
    if (Array.isArray(value))
        return value.slice(0, MAX_EVIDENCE_ARRAY).map(compactEvidenceNode);
    if (!value || typeof value !== "object")
        return value;
    const source = value;
    const status = typeof source.status === "string" ? source.status : undefined;
    const result = {};
    for (const [key, child] of Object.entries(source)) {
        if (key === "details" && child && typeof child === "object" && !Array.isArray(child))
            result.details = compactEvidenceDetails(child, status);
        else
            result[key] = compactEvidenceNode(child);
    }
    return result;
}
function compactEvidenceDetails(details, status) {
    const passing = status === "PASS" || status === "SKIP";
    const result = {};
    for (const [key, value] of Object.entries(details)) {
        if (passing && (key === "stdout" || key === "stderr" || key === "error"))
            continue;
        result[key] = compactEvidenceNode(value);
    }
    return result;
}
function unresolvedParticipants(operation) {
    return Object.values(operation.participants)
        .filter((participant) => !["COMPLETED", "FAILED", "CANCELLED"].includes(participant.status))
        .map((participant) => ({
        id: participant.id,
        logicalAgent: participant.logicalAgent,
        role: participant.role,
        phase: participant.phase,
        status: participant.status,
        resultArtifact: participant.resultArtifact,
        error: participant.error
    }));
}
function boundString(value) {
    return value.length <= MAX_EVIDENCE_STRING ? value : `${value.slice(0, MAX_EVIDENCE_STRING)}\n...[truncated]`;
}
//# sourceMappingURL=supervisorPrompt.js.map