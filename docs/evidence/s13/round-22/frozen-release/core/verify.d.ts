import type { HarnessProjectConfig, TaskContract, ValidationReport } from "./types.js";
import { type OpaExecutionIdentity } from "../validators/opa.js";
export interface VerifyTaskOptions {
    stateRoot?: string;
    policyRoot?: string;
    executionIdentity?: OpaExecutionIdentity;
}
export declare function verifyTask(root: string, config: HarnessProjectConfig, contract: TaskContract, options?: VerifyTaskOptions): Promise<ValidationReport>;
