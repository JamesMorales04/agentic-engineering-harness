export const supervisorSemanticEvents = ["initialize", "coordinate", "consolidate", "recover", "handoff"];
export function supervisorEventSkills(event, operationKind, traceableAcceptance = false) {
    if (event === "initialize" || event === "handoff")
        return [];
    if (event === "recover")
        return ["recovery-classifier"];
    if (event === "coordinate")
        return ["verification-planning", ...(traceableAcceptance ? ["acceptance-traceability"] : [])];
    return ["finding-dedup", ...(operationKind === "audit" ? ["audit-consolidation-protocol"] : []), ...(traceableAcceptance ? ["acceptance-traceability"] : [])];
}
//# sourceMappingURL=supervisorEventPolicy.js.map