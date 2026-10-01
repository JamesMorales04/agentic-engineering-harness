import type { ValidationCapability } from "../../core/types.js";
import type { ContractVerificationResult, ProviderDetection, ProviderDoctorResult, ProviderExecution, ProviderPlan, ValidationProvider, ValidationProviderContext } from "./types.js";
export declare class PactContractTestingProvider implements ValidationProvider<ContractVerificationResult> {
    readonly id = "pact";
    readonly capabilities: ValidationCapability[];
    detect(context: ValidationProviderContext): Promise<ProviderDetection | undefined>;
    doctor(context: ValidationProviderContext): Promise<ProviderDoctorResult>;
    plan(context: ValidationProviderContext, detection?: ProviderDetection): Promise<ProviderPlan>;
    execute(context: ValidationProviderContext, plan: ProviderPlan): Promise<ProviderExecution>;
    normalize(context: ValidationProviderContext, execution: ProviderExecution): Promise<ContractVerificationResult>;
}
export declare function runPactVerification(context: ValidationProviderContext, provider?: ValidationProvider<ContractVerificationResult>): Promise<{
    result: ContractVerificationResult;
    required: boolean;
}>;
