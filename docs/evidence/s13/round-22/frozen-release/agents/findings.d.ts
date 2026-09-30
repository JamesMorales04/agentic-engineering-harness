import { type NormalizedFinding } from "./outputContracts.js";
export interface FindingMerge {
    into: string;
    from: string[];
    reason: string;
}
export interface DedupedFindings {
    inputCount: number;
    outputCount: number;
    findings: NormalizedFinding[];
    merges: FindingMerge[];
}
export declare function extractFindings(value: unknown): NormalizedFinding[];
export declare function dedupeFindings(input: NormalizedFinding[]): DedupedFindings;
