import type { HarnessProjectConfig, TaskContract, ValidationCapability, ValidationCheck, ValidationProviderSpec, ValidatorSpec } from "../../core/types.js";
import type { BddExecutionResult, ContractVerificationResult, IntegrationEnvironmentResult, TestExecutionResult, ValidationProvider, ValidationProviderContext } from "./types.js";
export type ValidationProviderResult = TestExecutionResult | BddExecutionResult | IntegrationEnvironmentResult | ContractVerificationResult;
export interface CapabilityResolution {
    capability: ValidationCapability;
    provider: string;
    source: "explicit" | "detected" | "fallback";
    command?: string;
}
export declare class ValidationCapabilityRegistry {
    private readonly providers;
    constructor();
    register(provider: ValidationProvider<ValidationProviderResult>): void;
    list(capability?: ValidationCapability): string[];
    resolve(context: ValidationProviderContext): Promise<CapabilityResolution | undefined>;
}
export declare const validationCapabilityRegistry: ValidationCapabilityRegistry;
export declare function runCapabilityValidator(context: ValidationProviderContext, id: string, capability: ValidationCapability, required: boolean): Promise<ValidationCheck>;
export declare function providerSpecFor(config: HarnessProjectConfig, capability: ValidationCapability, spec?: ValidatorSpec): ValidationProviderSpec | undefined;
export declare function capabilityRequirements(contract: TaskContract): ValidationCapability[];
