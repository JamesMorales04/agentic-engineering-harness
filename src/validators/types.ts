import type { HarnessProjectConfig, TaskContract, ValidationCheck, ValidationProviderSpec, ValidatorSpec } from "../core/types.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";

export interface ValidationContext {
  root: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  spec: ValidatorSpec;
  providerSpec?: ValidationProviderSpec;
  baseRef: string;
  changedFiles: string[];
  candidate?: CandidateRevisionV1;
}

export interface HarnessValidator {
  readonly adapter: string;
  validate(context: ValidationContext): Promise<ValidationCheck>;
}
