export declare const supervisorSemanticEvents: readonly ["initialize", "coordinate", "consolidate", "recover", "handoff"];
export type SupervisorSemanticEvent = (typeof supervisorSemanticEvents)[number];
export declare function supervisorEventSkills(event: SupervisorSemanticEvent, operationKind?: string, traceableAcceptance?: boolean): string[];
