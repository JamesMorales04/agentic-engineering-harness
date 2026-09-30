import type { ValidationCapability } from "../../core/types.js";
import type { IntegrationEnvironmentResult, ProviderDetection, ProviderDoctorResult, ProviderExecution, ProviderPlan, ValidationProvider, ValidationProviderContext } from "./types.js";
export declare class IntegrationEnvironmentProvider implements ValidationProvider<IntegrationEnvironmentResult> {
    readonly id = "integration-environment";
    readonly capabilities: ValidationCapability[];
    detect(context: ValidationProviderContext): Promise<ProviderDetection | undefined>;
    doctor(context: ValidationProviderContext): Promise<ProviderDoctorResult>;
    plan(context: ValidationProviderContext, detection?: ProviderDetection): Promise<ProviderPlan>;
    execute(context: ValidationProviderContext, plan: ProviderPlan): Promise<ProviderExecution>;
    normalize(context: ValidationProviderContext, execution: ProviderExecution): Promise<IntegrationEnvironmentResult>;
}
export declare function validateEnvironmentRequirements(context: ValidationProviderContext): string[];
