import type { HarnessProjectConfig } from "./types.js";
export interface DoctorResult {
    component: string;
    required: boolean;
    ok: boolean;
    message: string;
}
export declare function runDoctor(root: string, config: HarnessProjectConfig): Promise<DoctorResult[]>;
