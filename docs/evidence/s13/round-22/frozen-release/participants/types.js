export const canonicalRoleValues = [
    "Lead/Director",
    "Operation Supervisor",
    "Explorer",
    "Librarian",
    "Planner",
    "Spec Manager",
    "Implementer",
    "Reviewer",
    "Repairer"
];
/** AEH Agent responsibility classes include bounded actors that are not WorkGraph Participants. */
export const canonicalAgentRoleValues = [...canonicalRoleValues, "Semantic Assessor"];
export const participantCapabilityValues = [
    "read",
    "write",
    "execute",
    "research",
    "plan",
    "specify",
    "implement",
    "review",
    "validate",
    "repair",
    "supervise",
    "delegate"
];
export function isCanonicalRole(value) {
    return typeof value === "string" && canonicalRoleValues.includes(value);
}
export function assertCanonicalRole(value) {
    if (!isCanonicalRole(value))
        throw new Error(`Unknown canonical participant role: ${String(value)}`);
    return value;
}
/** Selects a role contract without assigning a runtime or concrete agent identity. */
export function selectCanonicalRole(role) {
    return { version: 1, role: assertCanonicalRole(role), profileVersion: 1 };
}
//# sourceMappingURL=types.js.map