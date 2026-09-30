import type { ContextCompressionProvider, ContextCompressionRequest, ContextCompressionResult, ProviderHealth } from "./types.js";
import { runShell } from "../../utils/process.js";
export interface HeadroomOptions {
    command?: string;
    version?: string;
    python?: string;
    bridge?: string;
    executor?: typeof runShell;
}
export declare const HEADROOM_VERSION: string;
/** AEH-owned adapter. It talks to a local Headroom executable and never starts an agent process. */
export declare class HeadroomCompressionProvider implements ContextCompressionProvider {
    readonly name = "headroom";
    private readonly command;
    private readonly expectedVersion?;
    private readonly python?;
    private readonly bridge?;
    private readonly executor;
    constructor(options?: HeadroomOptions);
    doctor(root: string): Promise<ProviderHealth>;
    compress(root: string, request: ContextCompressionRequest): Promise<ContextCompressionResult>;
    private bridgeCommand;
}
