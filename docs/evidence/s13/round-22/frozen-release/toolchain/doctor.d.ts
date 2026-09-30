import type { HarnessProjectConfig } from "../core/types.js";
export interface ToolchainDoctorResult {
    component: string;
    required: boolean;
    ok: boolean;
    message: string;
    scope?: "SUMMARY" | "INSTALLED_PROFILE" | "ACTIVE_PROJECT";
    state?: "COMPLIANT" | "MISSING" | "EXCLUDED" | "DRIFT" | "INVALID";
}
/**
 * Report the installed lock profile and the current active project needs as
 * separate checks. Named setup profiles can intentionally omit tools that the
 * project's auto-resolved requirements still need.
 */
export declare function runToolchainDoctor(root: string, project: HarnessProjectConfig): Promise<ToolchainDoctorResult[]>;
