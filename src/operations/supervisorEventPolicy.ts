export const supervisorSemanticEvents = ["initialize", "coordinate", "consolidate", "recover", "handoff"] as const;
export type SupervisorSemanticEvent = (typeof supervisorSemanticEvents)[number];

export function supervisorEventSkills(event: SupervisorSemanticEvent, operationKind?: string, traceableAcceptance = false): string[] {
  if (event === "initialize" || event === "handoff") return [];
  if (event === "recover") return ["recovery-classifier"];
  if (event === "coordinate") return ["verification-planning", ...(traceableAcceptance ? ["acceptance-traceability"] : [])];
  return ["finding-dedup", ...(operationKind === "audit" ? ["audit-consolidation-protocol"] : []), ...(traceableAcceptance ? ["acceptance-traceability"] : [])];
}
