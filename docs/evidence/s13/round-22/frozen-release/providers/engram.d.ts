import type { MemoryProvider, MemoryRecord } from "./types.js";
import { runShell } from "../utils/process.js";
export interface EngramOptions {
    command?: string;
    storagePath?: string;
    maxRecall?: number;
    executor?: typeof runShell;
}
export declare const ENGRAM_VERSION: string;
export declare class EngramMemoryProvider implements MemoryProvider {
    private readonly root;
    readonly name = "engram";
    private readonly command;
    private readonly storagePath;
    private readonly maxRecall;
    private readonly executor;
    constructor(root: string, options?: EngramOptions);
    doctor(root: string): Promise<{
        ok: boolean;
        message: string;
        version?: string;
    }>;
    remember(record: MemoryRecord): Promise<string | undefined>;
    recall(project: string, query: string): Promise<MemoryRecord[]>;
    private readLedger;
}
export declare function createMemoryProvider(root: string, config: {
    memory?: {
        provider?: string;
        required?: boolean;
    };
}): Promise<MemoryProvider | undefined>;
export declare function memoryFingerprint(record: MemoryRecord): string;
export declare function filterStaleRecords(root: string, records: MemoryRecord[]): Promise<MemoryRecord[]>;
