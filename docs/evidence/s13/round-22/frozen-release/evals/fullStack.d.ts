import type { HarnessProjectConfig } from "../core/types.js";
export interface FullStackCheck {
    id: string;
    stage: string;
    status: "PASS" | "FAIL" | "SKIP";
    required: boolean;
    message: string;
    details?: Record<string, unknown>;
}
export interface FullStackDogfoodReport {
    version: 1;
    profile: "full-stack";
    generatedAt: string;
    status: "PASS" | "FAIL";
    checks: FullStackCheck[];
    configuredComponents: string[];
    limitations: string[];
}
/** Deterministic local dogfood lane, with strict CI mode requiring installed providers. */
export declare function runFullStackDogfood(root: string, config: HarnessProjectConfig): Promise<FullStackDogfoodReport>;
