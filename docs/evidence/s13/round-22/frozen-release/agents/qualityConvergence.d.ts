import type { HarnessProjectConfig } from "../core/types.js";
import type { NormalizedFinding } from "./outputContracts.js";
export type FindingSeverity = NormalizedFinding["severity"];
export type ConvergenceStatus = "INITIAL" | "CONVERGED" | "IMPROVING" | "STABLE" | "STAGNATING" | "REGRESSING" | "CYCLING";
export interface SeverityCounts {
    critical: number;
    high: number;
    medium: number;
    low: number;
    note: number;
}
export interface QualityState {
    round: number;
    counts: SeverityCounts;
    debtPoints: number;
    debtScore: number;
    fingerprint: string;
    findingFingerprints: string[];
    resolved: string[];
    persistent: string[];
    introduced: string[];
    convergence: ConvergenceStatus;
    gate: QualityGateResult;
    candidateDigest?: string;
}
export interface QualityGateResult {
    pass: boolean;
    reasons: string[];
    counts: SeverityCounts;
    debtPoints: number;
    debtScore: number;
}
export declare const DEFAULT_SEVERITY_POINTS: Record<FindingSeverity, number>;
export declare const DEFAULT_FINAL_MAX: SeverityCounts;
export declare function severityPoints(config: HarnessProjectConfig): Record<FindingSeverity, number>;
export declare function calculateQuality(findings: NormalizedFinding[], config: HarnessProjectConfig): {
    counts: SeverityCounts;
    debtPoints: number;
    debtScore: number;
};
export declare function evaluateFinalQualityGate(findings: NormalizedFinding[], config: HarnessProjectConfig): QualityGateResult;
export declare function analyzeQualityState(findings: NormalizedFinding[], history: QualityState[], config: HarnessProjectConfig, candidateDigest?: string): QualityState;
export declare function remediationRequired(state: QualityState): boolean;
export declare function findingFingerprint(finding: NormalizedFinding): string;
export declare function formatDebtScore(value: number): string;
