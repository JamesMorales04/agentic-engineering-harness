import type { ValidationFinding } from "../core/types.js";
export interface NormalizedFinding extends ValidationFinding {
}
export interface ToolEvidenceParseResult {
    findings: NormalizedFinding[];
    valid: boolean;
}
export declare function normalizeOpengrepOutput(value: unknown): NormalizedFinding[];
export declare function normalizeTrivyOutput(value: unknown): NormalizedFinding[];
export declare function normalizePlaywrightOutput(value: unknown): NormalizedFinding[];
export declare function normalizePactOutput(value: unknown): NormalizedFinding[];
export declare function parseToolEvidence(adapter: string, stdout: string): NormalizedFinding[];
export declare function parseToolEvidenceResult(adapter: string, stdout: string): ToolEvidenceParseResult;
export declare function findingFingerprint(finding: Omit<NormalizedFinding, "fingerprint"> | NormalizedFinding): string;
