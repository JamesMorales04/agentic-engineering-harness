import { SerenaSemanticProvider } from "../context/repository/serena.js";
export type SerenaPoolAccessV1 = "read" | "write";
export interface SerenaPoolKeyV1 {
    projectId: string;
    canonicalRoot: string;
    workspaceId: string;
    serenaVersion: string;
}
export interface SerenaPoolSessionV1 {
    sessionId: string;
    key: SerenaPoolKeyV1;
    access: SerenaPoolAccessV1;
    ownerId: string;
    editingEnabled: boolean;
    mcpServer: ReturnType<SerenaSemanticProvider["mcpServer"]>;
    allowedTools: string[];
    deniedTools: string[];
    socketPath: string;
}
export declare class SerenaPoolOwnershipError extends Error {
    constructor(message: string);
}
export declare class SerenaPoolV1 {
    private readonly provider;
    private readonly entries;
    constructor(provider?: SerenaSemanticProvider);
    acquire(input: SerenaPoolKeyV1 & {
        ownerId: string;
        access?: SerenaPoolAccessV1;
        editingEnabled?: boolean;
    }): SerenaPoolSessionV1;
    release(sessionId: string, ownerId: string): void;
    snapshot(): SerenaPoolSessionV1[];
}
/** One controller-local pool is shared by all launch-spec projections. */
export declare const managedSerenaPool: SerenaPoolV1;
