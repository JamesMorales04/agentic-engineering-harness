export declare const MATURITY_LEVELS: readonly ["DECLARED", "ADAPTER", "EXECUTABLE", "WORKFLOW_INTEGRATED", "DOGFOODED", "EVAL_VALIDATED", "PRODUCTION_GRADE"];
export type MaturityLevel = typeof MATURITY_LEVELS[number];
export type MaturityEvidenceType = "documentation" | "design" | "adapter-source" | "unit-contract" | "provider-contract" | "workflow-test" | "dogfood-lane" | "eval-result" | "reliability-gate" | "security-gate";
export interface MaturityEvidence {
    type: MaturityEvidenceType;
    id: string;
    path: string;
}
export interface MaturityComponent {
    component: string;
    claimed: MaturityLevel;
    evidence: MaturityEvidence[];
    optional?: boolean;
}
export interface MaturityInventory {
    version: 1;
    levels: MaturityLevel[];
    components: MaturityComponent[];
}
export interface MaturityValidation {
    ok: boolean;
    issues: string[];
    supported: Array<{
        component: string;
        claimed: MaturityLevel;
        supported: MaturityLevel;
    }>;
}
export declare function loadMaturityInventory(root: string, file?: string): Promise<MaturityInventory>;
export declare function validateMaturityInventory(root: string, inventory: MaturityInventory): Promise<MaturityValidation>;
