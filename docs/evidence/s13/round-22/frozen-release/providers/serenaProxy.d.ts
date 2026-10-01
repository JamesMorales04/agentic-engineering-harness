/** Read-only Serena surface used by AEH-managed explorer/planner/reviewer clients. */
export declare const SERENA_READ_ONLY_TOOLS: readonly ["initial_instructions", "get_symbols_overview", "find_symbol", "find_referencing_symbols", "find_implementations", "find_declaration", "get_diagnostics_for_file", "list_dir", "find_file", "search_for_pattern", "read_memory", "list_memories"];
export interface SerenaProxyOptions {
    command?: string;
    root?: string;
    allowEdits?: boolean;
    allowedTools?: readonly string[];
}
export interface SerenaPoolIdentityV1 {
    projectId: string;
    canonicalRoot: string;
    workspaceId: string;
    serenaVersion: string;
}
export declare function createSerenaWriterLeaseSync(input: {
    canonicalRoot: string;
    projectId: string;
    workspaceId: string;
    ownerId: string;
    ttlMs?: number;
}): {
    token: string;
    filePath: string;
};
export declare function serenaPoolSocketPath(input: SerenaPoolIdentityV1): string;
/**
 * Run a line-oriented MCP stdio proxy in front of Serena.
 *
 * The proxy intentionally filters both tools/list and tools/call. Hiding the
 * schemas reduces the reader's attack surface; rejecting calls is the actual
 * enforcement boundary when a client attempts to bypass discovery.
 */
export declare function serveSerenaMcpProxy(options?: SerenaProxyOptions): Promise<void>;
export declare function serveSerenaPoolServer(): Promise<void>;
