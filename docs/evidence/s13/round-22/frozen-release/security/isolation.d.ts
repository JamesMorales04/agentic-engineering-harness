import type { HarnessProjectConfig, ValidatorSpec } from "../core/types.js";
export declare const ISOLATION_PROVIDER_UNAVAILABLE: "ISOLATION_PROVIDER_UNAVAILABLE";
export declare const ISOLATION_PROVIDER_UNSUPPORTED: "ISOLATION_PROVIDER_UNSUPPORTED";
export declare const ISOLATION_ENVIRONMENT_REJECTED: "ISOLATION_ENVIRONMENT_REJECTED";
export declare const ISOLATION_COMMAND_INVALID: "ISOLATION_COMMAND_INVALID";
export type IsolationProviderIdV1 = "bwrap" | "none";
export declare const DEFAULT_ISOLATION_ENVIRONMENT_ALLOWLIST: readonly ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "TMPDIR", "SHELL", "USER"];
export declare const DEFAULT_MASKED_HOST_PATHS: readonly ["/root (host)", "/run (host)", "/home (host contents except explicit toolchain binds)", "/tmp (host)", "/var/tmp (host)", "/mnt (host)", "/media (host)", "/srv (host)"];
export interface IsolationCapabilitiesV1 {
    version: 1;
    provider: IsolationProviderIdV1;
    available: boolean;
    executable?: string;
    providerVersion?: string;
    rootless: boolean;
    userNamespaces: boolean;
    networkNamespace: boolean;
    seccompKernel: boolean;
    apparmor: string;
    podman: {
        available: boolean;
        rootless: boolean | null;
    };
    buildah: {
        available: boolean;
    };
    details: string[];
}
export interface IsolationExecutionEvidenceV1 {
    version: 1;
    provider: "bwrap";
    providerVersion: string;
    rootless: true;
    namespaces: {
        user: true;
        mount: true;
        pid: true;
        uts: true;
        ipc: true;
        network: boolean;
    };
    networkAccess: "host" | "none";
    readOnlyRoot: true;
    visibleReadOnlyPaths: string[];
    maskedHostPaths: string[];
    writablePaths: string[];
    environmentAllowlist: string[];
    noNewPrivileges: true;
    seccomp: "not-applied";
    commandDigest: string;
}
export interface IsolatedCommandRequestV1 {
    root: string;
    command?: string;
    argv?: string[];
    cwd: string;
    workspaceRoot: string;
    writablePaths?: string[];
    readOnlyPaths?: string[];
    network?: boolean;
    environment?: Record<string, string>;
    timeoutMs?: number;
}
export interface IsolatedCommandResultV1 {
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    isolation: IsolationExecutionEvidenceV1;
}
export interface IsolatedCommandOptionsV1 {
    capabilities?: IsolationCapabilitiesV1;
    environmentAllowlist?: string[];
}
export declare class IsolationProviderUnavailableError extends Error {
    readonly code: "ISOLATION_PROVIDER_UNAVAILABLE";
    constructor(message: string);
}
export declare function clearIsolationCapabilityCache(): void;
export declare function detectIsolationCapabilities(root: string): Promise<IsolationCapabilitiesV1>;
export declare function assertSupportedIsolationProvider(config: HarnessProjectConfig): void;
export declare function validatorIsolationRequired(config: HarnessProjectConfig, spec?: ValidatorSpec): boolean;
export declare function validatorIsolationNetwork(config: HarnessProjectConfig): boolean;
export declare function validatorIsolationEnvironmentAllowlist(config: HarnessProjectConfig): string[];
export declare function toolchainReadOnlyPaths(root: string): string[];
export interface BuildBwrapOptionsV1 {
    environmentAllowlist?: string[];
}
export interface BwrapBuildV1 {
    executable: string;
    args: string[];
    evidence: IsolationExecutionEvidenceV1;
}
export declare function buildBwrapArgs(request: IsolatedCommandRequestV1, capabilities: IsolationCapabilitiesV1, options?: BuildBwrapOptionsV1): BwrapBuildV1;
export declare function isolationEnvironment(request: IsolatedCommandRequestV1, allowlist: readonly string[]): Record<string, string>;
export declare function runIsolatedCommand(request: IsolatedCommandRequestV1, options?: IsolatedCommandOptionsV1): Promise<IsolatedCommandResultV1>;
