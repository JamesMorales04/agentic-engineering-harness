export interface InteractiveOperationPromotion {
    kind: "audit" | "run";
    operationArgv: string[];
}
export declare function promoteInteractiveOperation(argv: string[], env?: NodeJS.ProcessEnv): InteractiveOperationPromotion | undefined;
