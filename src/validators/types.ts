import type { HarnessProjectConfig, TaskContract, ValidationCheck, ValidatorSpec } from "../core/types.js";

export interface ValidationContext {
  root: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  spec: ValidatorSpec;
  baseRef: string;
  changedFiles: string[];
}

export interface HarnessValidator {
  readonly adapter: string;
  validate(context: ValidationContext): Promise<ValidationCheck>;
}
