import type { HarnessProjectConfig, TaskContract, ValidationCheck } from "../core/types.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
export interface RunConfiguredValidatorsOptionsV1 {
    candidate?: CandidateRevisionV1;
}
export declare function runConfiguredValidators(root: string, config: HarnessProjectConfig, contract: TaskContract, baseRef: string, changedFiles: string[], options?: RunConfiguredValidatorsOptionsV1): Promise<ValidationCheck[]>;
