import type { HarnessProjectConfig, ValidationCheck, ValidationCommand } from "../core/types.js";
export declare function runValidationCommand(root: string, command: ValidationCommand, options?: {
    config?: HarnessProjectConfig;
}): Promise<ValidationCheck>;
