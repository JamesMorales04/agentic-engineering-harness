import type { ValidationCapability } from "../../core/types.js";
import type { ProviderDetection, ProviderDoctorResult, ProviderExecution, ProviderPlan, TestExecutionResult, ValidationProvider, ValidationProviderContext } from "./types.js";
export declare class ProjectNativeTestExecutionProvider implements ValidationProvider<TestExecutionResult> {
    readonly id = "project-native-test";
    readonly capabilities: ValidationCapability[];
    detect(context: ValidationProviderContext): Promise<ProviderDetection | undefined>;
    doctor(context: ValidationProviderContext): Promise<ProviderDoctorResult>;
    plan(context: ValidationProviderContext, detection?: ProviderDetection): Promise<ProviderPlan>;
    execute(context: ValidationProviderContext, plan: ProviderPlan): Promise<ProviderExecution>;
    normalize(context: ValidationProviderContext, execution: ProviderExecution): Promise<TestExecutionResult>;
}
export declare function runTestExecution(context: ValidationProviderContext, provider?: ValidationProvider<TestExecutionResult>): Promise<{
    result: TestExecutionResult;
    checkRequired: boolean;
}>;
