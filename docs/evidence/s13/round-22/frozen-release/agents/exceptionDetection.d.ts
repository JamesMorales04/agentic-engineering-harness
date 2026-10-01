import { z } from "zod";
import type { WorkerSession } from "../core/types.js";
import type { NormalizedFinding } from "./outputContracts.js";
export type ExceptionType = "SPEC_CONTRADICTION" | "REQUIRES_PRODUCT_DECISION" | "BLOCKED_EXTERNAL" | "SYSTEM_FAILURE";
export interface ExceptionDecision {
    type: ExceptionType;
    humanRequired: boolean;
    rationale: string;
    findings: string[];
}
export declare const exceptionDiagnosisSchema: z.ZodObject<{
    classification: z.ZodEnum<{
        IMPLEMENTATION_DEFECT: "IMPLEMENTATION_DEFECT";
        SPEC_CONTRADICTION: "SPEC_CONTRADICTION";
        REQUIRES_PRODUCT_DECISION: "REQUIRES_PRODUCT_DECISION";
        BLOCKED_EXTERNAL: "BLOCKED_EXTERNAL";
        SYSTEM_FAILURE: "SYSTEM_FAILURE";
    }>;
    rationale: z.ZodString;
    recommendedAction: z.ZodString;
}, z.core.$strip>;
export declare function detectHumanException(findings: NormalizedFinding[]): ExceptionDecision | undefined;
export declare function detectRuntimeExternalException(session: WorkerSession): ExceptionDecision | undefined;
export declare function diagnosisToException(value: z.infer<typeof exceptionDiagnosisSchema>): ExceptionDecision | undefined;
