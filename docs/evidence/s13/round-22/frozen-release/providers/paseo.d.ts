import type { OrchestrationProvider } from "./types.js";
export declare class PaseoOrchestrationProvider implements OrchestrationProvider {
    readonly name = "paseo";
    doctor(root: string): Promise<{
        ok: boolean;
        message: string;
    }>;
}
