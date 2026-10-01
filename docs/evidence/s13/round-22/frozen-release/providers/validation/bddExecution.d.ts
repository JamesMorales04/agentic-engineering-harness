import type { ValidationCapability } from "../../core/types.js";
import type { BddExecutionResult, ProviderDetection, ProviderDoctorResult, ProviderExecution, ProviderPlan, ValidationProvider, ValidationProviderContext } from "./types.js";
export declare class GenericBddExecutionProvider implements ValidationProvider<BddExecutionResult> {
    readonly id: string;
    readonly capabilities: ValidationCapability[];
    detect(context: ValidationProviderContext): Promise<ProviderDetection | undefined>;
    doctor(context: ValidationProviderContext): Promise<ProviderDoctorResult>;
    plan(context: ValidationProviderContext, detection?: ProviderDetection): Promise<ProviderPlan>;
    execute(context: ValidationProviderContext, plan: ProviderPlan): Promise<ProviderExecution>;
    normalize(context: ValidationProviderContext, execution: ProviderExecution): Promise<BddExecutionResult>;
}
export declare function runBddExecution(context: ValidationProviderContext, provider?: ValidationProvider<BddExecutionResult>): Promise<{
    result: BddExecutionResult;
    required: boolean;
}>;
