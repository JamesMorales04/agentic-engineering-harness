import type { WorkerSession } from "../core/types.js";
export interface DurableAgentEvidence<T> {
    payload: T;
    artifact: string;
    sha256: string;
}
export declare function requireDurableChangeHandoff<T>(root: string, label: string, session: WorkerSession, schema: {
    parse(value: unknown): T;
}, controlRoot?: string, expected?: {
    operationId?: string;
    contract?: string;
    phase?: string;
}): Promise<DurableAgentEvidence<T>>;
