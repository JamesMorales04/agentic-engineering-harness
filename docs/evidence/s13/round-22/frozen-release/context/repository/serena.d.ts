import type { McpServerConfig } from "../../core/types.js";
import type { ProviderHealth } from "../compression/types.js";
export declare const SERENA_VERSION: string;
export declare const SERENA_HEADLESS_ARGS: readonly ["--enable-web-dashboard", "false", "--open-web-dashboard", "false", "--enable-gui-log-window", "false"];
export declare class SerenaSemanticProvider {
    private readonly command;
    readonly name = "serena";
    constructor(command?: string);
    doctor(root: string): Promise<ProviderHealth>;
    mcpServer(root: string): McpServerConfig;
}
export declare function semanticFirstInstruction(): string;
