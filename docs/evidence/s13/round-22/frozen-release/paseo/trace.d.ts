export interface PaseoTraceRecord {
    at: string;
    name: string;
    attributes: Record<string, unknown>;
}
/**
 * Paseo integration traces are always persisted locally because they are
 * operational evidence, even when OTLP export is disabled. When Harness
 * telemetry is configured the same event is also sent through the normal
 * recordEvent/OTLP path.
 */
export declare function recordPaseoTrace(root: string, name: string, attributes?: Record<string, unknown>): Promise<void>;
