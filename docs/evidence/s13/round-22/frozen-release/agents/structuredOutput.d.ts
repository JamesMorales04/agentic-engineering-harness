export type StructuredOutputFailureReason = "EMPTY_OUTPUT" | "NO_MARKER" | "MARKER_INVALID_JSON" | "NATIVE_JSON_INVALID";
export declare class StructuredOutputError extends Error {
    readonly reason: StructuredOutputFailureReason;
    constructor(reason: StructuredOutputFailureReason, message: string);
}
export declare function extractMarkedJson(stdout: string, stderr?: string): unknown;
