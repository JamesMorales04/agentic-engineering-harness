export const DEFAULT_ESCALATION_STAGES = [
    { name: "normal", action: "remediate" },
    { name: "quality", action: "remediate", role: "Implementer" },
    { name: "senior", action: "remediate", role: "Implementer", model: "@brain" },
    { name: "diagnosis", action: "diagnose", role: "Reviewer", model: "@brain" },
    { name: "replan", action: "replan", role: "Planner", model: "@brain" }
];
export function escalationStages(config) {
    const configured = config.workflow?.reviews?.escalation?.stages;
    return configured?.length ? configured : DEFAULT_ESCALATION_STAGES;
}
export function nextEscalationIndex(state, current, config) {
    const stages = escalationStages(config);
    if (!stages.length)
        return 0;
    if (state.counts.critical > 0 && state.round === 0)
        return Math.min(config.workflow?.reviews?.escalation?.criticalStartStage ?? 2, stages.length - 1);
    if (state.convergence === "STAGNATING" || state.convergence === "REGRESSING" || state.convergence === "CYCLING")
        return Math.min(current + 1, stages.length - 1);
    if (state.convergence === "IMPROVING" && current > 0)
        return current - 1;
    return Math.min(current, stages.length - 1);
}
export function resumeAfterReplan(config) {
    const stages = escalationStages(config);
    const desired = Math.min(config.workflow?.reviews?.escalation?.replanResumeStage ?? 2, Math.max(0, stages.length - 1));
    return Math.max(0, desired - 1);
}
/** Apply already-resolved outer-boundary selections without reopening topology. */
export function selectionForStage(fallback, stage, roleSelection, modelSelection) {
    return modelSelection ?? roleSelection ?? fallback;
}
//# sourceMappingURL=escalation.js.map