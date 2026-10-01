import { type RoleProfileV1 } from "../participants/index.js";
export declare const executionTransportValues: readonly ["inherit", "paseo", "direct", "podman"];
export type ExecutionTransportV1 = (typeof executionTransportValues)[number];
export interface ExecutionBindingV1 {
    runtimeId: string;
    modelAlias: string;
    transport: ExecutionTransportV1;
    profile?: string;
    variant?: string;
    nativeAgent?: string;
    temperature?: number;
    outputContract?: string;
    args?: string[];
}
export interface ExecutionRuntimeProfileV1 {
    id: string;
    adapter: string;
    provider?: string;
    capabilities: Record<string, boolean>;
}
export interface ExecutionModelRuntimeProfileV1 {
    alias: string;
    id: string;
    runtime: string;
    provider?: string;
    model: string;
    variant?: string;
}
export interface ExecutionCatalogV1 {
    version: 1;
    runtimeProfiles: ExecutionRuntimeProfileV1[];
    modelProfiles: ExecutionModelRuntimeProfileV1[];
    roleProfiles: RoleProfileV1[];
    roleBindings: Record<string, ExecutionBindingV1>;
    skillRefs: string[];
    routeRuleIds: string[];
    policy: {
        maxParticipants: number;
        maxConcurrent: number;
    };
    digest: string;
}
export interface ExecutionCatalogInputV1 {
    runtimes: Record<string, {
        adapter: string;
        paseoProvider?: string;
        capabilities?: object;
    }>;
    models: Record<string, {
        alias?: string;
        id?: string;
        runtime: string;
        provider?: string;
        model: string;
        variant?: string;
    }>;
    roleBindings?: Record<string, ExecutionBindingV1>;
    routeRuleIds?: readonly string[];
    policy?: Partial<ExecutionCatalogV1["policy"]>;
}
export declare function compileExecutionCatalog(input: ExecutionCatalogInputV1): ExecutionCatalogV1;
