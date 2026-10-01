export interface ProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut?: boolean;
}
export interface ManagedProcessHandle {
    pid: number;
    processGroupId: number;
}
export declare function clearToolchainEnvCache(): void;
export interface ProcessOptions {
    cwd: string;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
    toolchain?: boolean;
    stdin?: string | Buffer;
    signal?: AbortSignal;
}
/** Execute one program with literal argv boundaries and no shell parsing. */
export declare function runExecutable(executable: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult>;
/** Execute an explicit shell program. Use only when shell syntax is required. */
export declare function runShell(command: string, options: ProcessOptions): Promise<ProcessResult>;
export declare function listManagedProcessHandles(root: string, operationId: string): Promise<ManagedProcessHandle[]>;
export declare function clearManagedProcessHandles(root: string, operationId: string): Promise<void>;
export declare function terminateManagedProcessGroup(pid: number, graceMs?: number): Promise<void>;
export declare function registerManagedProcessHandle(pid: number | undefined): Promise<() => Promise<void>>;
export declare function commandExists(command: string, cwd: string): Promise<boolean>;
export declare function resolveExecutable(command: string, cwd: string): Promise<string | undefined>;
