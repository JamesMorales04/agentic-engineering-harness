interface JsonRpcRequest {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
}
export declare function serveResultSinkMcp(): Promise<void>;
export declare function handleResultSinkRequest(request: JsonRpcRequest): Promise<Record<string, unknown>>;
export {};
