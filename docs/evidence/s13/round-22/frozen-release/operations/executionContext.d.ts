export interface ManagedAgentExecutionIdentity {
    logicalAgent: string;
    role?: string;
    operationId?: string;
    operationKind?: string;
    phase?: string;
    interactiveLead?: boolean;
    orchestrationAllowed?: boolean;
}
export declare function buildManagedAgentEnvironment(identity: ManagedAgentExecutionIdentity): Record<string, string>;
export declare function isManagedInteractiveLead(env?: NodeJS.ProcessEnv): boolean;
export declare function isManagedBoundedAgent(env?: NodeJS.ProcessEnv): boolean;
export declare function isSideEffectFreeMetaInvocation(argv: string[]): boolean;
export declare function assertHarnessWorkflowEntryAllowed(argv: string[], env?: NodeJS.ProcessEnv): void;
export declare function managedBoundedAgentPromptContext(identity: ManagedAgentExecutionIdentity): string;
