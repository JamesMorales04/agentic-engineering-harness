export interface HeadroomRuntimeHandle {
    operationId: string;
    pid?: number;
    port: number;
    endpoint: string;
}
export interface HeadroomRuntimeOptions {
    command?: string;
    host?: string;
    port?: number;
    environment?: Record<string, string>;
    healthTimeoutMs?: number;
}
/** Owns only a local Headroom proxy process; Paseo remains the agent/session owner. */
export declare class HeadroomRuntimeManager {
    private readonly processes;
    start(root: string, operationId: string, options?: HeadroomRuntimeOptions): Promise<HeadroomRuntimeHandle>;
    stop(operationId: string): Promise<void>;
    stopAll(): Promise<void>;
}
