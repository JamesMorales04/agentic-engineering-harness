import type { DirectWorkerHome } from "./directProcess.js";
export interface RuntimeSessionPreparation {
    cwd: string;
    environment: Record<string, string>;
    home: DirectWorkerHome;
    timeoutMs: number;
    executable?: string;
}
/** Create an idle OpenCode session through its local server API without sending a prompt. */
export declare function prepareOpenCodeSession(input: RuntimeSessionPreparation): Promise<string>;
/** Create an idle persistent Codex app-server thread before the first semantic turn. */
export declare function prepareCodexThread(input: RuntimeSessionPreparation & {
    model: string;
    modelProvider?: string;
    sandbox: string;
    approvalPolicy: string;
}): Promise<string>;
