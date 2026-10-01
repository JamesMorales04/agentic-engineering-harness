import { HumanDecisionLedgerV2 } from "../security/humanDecision.js";
export declare class ProductChoiceConflictError extends Error {
    readonly statusCode = 409;
    constructor(message: string);
}
export declare function recordControlCenterDecision(root: string, ledger: HumanDecisionLedgerV2, value: unknown, actorId: string): Promise<Record<string, unknown>>;
