import type { ProviderExecution, ProviderPlan, ValidationProviderContext } from "./types.js";
export declare function fileExists(file: string): Promise<boolean>;
export declare function readJsonFile<T>(file: string): Promise<T | undefined>;
export declare function configuredCommand(context: ValidationProviderContext, fallback?: string): Promise<{
    command?: string;
    runtime?: string;
    provider: string;
}>;
export declare function doctorForCommand(command: string | undefined, cwd: string, provider: string, details?: Record<string, unknown>): Promise<{
    provider: string;
    available: boolean;
    message: string;
    details: {
        executable: string | undefined;
    };
}>;
export declare function executePlan(plan: ProviderPlan): Promise<ProviderExecution>;
export declare function resolveCwd(context: ValidationProviderContext): string;
