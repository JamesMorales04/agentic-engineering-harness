export type RepositoryIdentityInput = string | {
    canonical?: string;
    host?: string;
    name?: string;
    owner?: string;
    remoteUrl?: string;
    url?: string;
};
export interface ProjectIdentityV1 {
    version: 1;
    projectId: string;
    canonicalRealpath: string;
    repositoryIdentity: string;
    displayName: string;
    configDigest: string;
    createdAt: string;
    updatedAt: string;
}
export type ProjectAvailabilityV1 = "available" | "moved-or-missing";
export type ProjectHealthStatusV1 = "healthy" | "unhealthy";
export interface ProjectHealthMetadataV1 {
    status: ProjectHealthStatusV1;
    healthUrl: string;
    pid?: number;
    nonceRegistered: boolean;
    registeredAt: string;
    lastCheckedAt: string;
}
export interface ProjectRecordV1 extends ProjectIdentityV1 {
    availability: ProjectAvailabilityV1;
    health?: ProjectHealthMetadataV1;
}
export interface RegisterProjectInputV1 {
    canonicalRealpath?: string;
    config?: unknown;
    configDigest?: string;
    displayName?: string;
    health?: RuntimeRegistrationInputV1;
    projectId?: string;
    projectPath?: string;
    repositoryIdentity: RepositoryIdentityInput;
    rootPath?: string;
}
export interface RuntimeRegistrationInputV1 {
    healthUrl: string;
    nonce: string;
    pid?: number;
    status?: ProjectHealthStatusV1;
}
export interface ProjectFindQueryV1 {
    canonicalRealpath?: string;
    displayName?: string;
    projectId?: string;
    repositoryIdentity?: RepositoryIdentityInput;
}
export interface ProjectUpdateInputV1 {
    canonicalRealpath?: string;
    config?: unknown;
    configDigest?: string;
    displayName?: string;
    projectPath?: string;
    rootPath?: string;
}
export interface ProjectRegistryOptionsV1 {
    clock?: () => Date;
    statePath?: string;
    lockTimeoutMs?: number;
}
interface PersistedHealthV1 {
    healthUrl: string;
    lastCheckedAt: string;
    nonceDigest: string;
    pid?: number;
    registeredAt: string;
    status: ProjectHealthStatusV1;
}
interface PersistedProjectV1 extends ProjectIdentityV1 {
    health?: PersistedHealthV1;
}
export declare class ProjectRegistryError extends Error {
    constructor(message: string);
}
export declare class ProjectPathUnavailableError extends ProjectRegistryError {
    constructor(projectPath: string);
}
export declare class DuplicateProjectError extends ProjectRegistryError {
    constructor(message: string);
}
export declare class AmbiguousProjectError extends ProjectRegistryError {
    constructor(message: string);
}
export declare class ProjectNotFoundError extends ProjectRegistryError {
    constructor(projectId: string);
}
declare function projectIdentityFrom(project: PersistedProjectV1): ProjectIdentityV1;
export declare class ProjectRegistryV1 {
    readonly statePath: string;
    private readonly clock;
    private readonly lockTimeoutMs;
    constructor(statePath?: string, options?: Omit<ProjectRegistryOptionsV1, "statePath">);
    constructor(options?: ProjectRegistryOptionsV1);
    register(input: RegisterProjectInputV1): Promise<ProjectRecordV1>;
    list(): Promise<ProjectRecordV1[]>;
    find(query: string | ProjectFindQueryV1): Promise<ProjectRecordV1 | undefined>;
    findAll(query: string | ProjectFindQueryV1): Promise<ProjectRecordV1[]>;
    update(query: string | ProjectFindQueryV1, patch: ProjectUpdateInputV1): Promise<ProjectRecordV1>;
    remove(query: string | ProjectFindQueryV1): Promise<boolean>;
    recordHealth(projectId: string, input: RuntimeRegistrationInputV1): Promise<ProjectHealthMetadataV1>;
    updateHealth(projectId: string, input: RuntimeRegistrationInputV1): Promise<ProjectHealthMetadataV1>;
    getHealth(projectId: string): Promise<ProjectHealthMetadataV1 | undefined>;
    health(projectId: string, input?: RuntimeRegistrationInputV1): Promise<ProjectHealthMetadataV1 | undefined>;
    verifyRuntime(input: {
        healthUrl: string;
        nonce: string;
        projectId: string;
    }): Promise<boolean>;
    isRuntimeRegistered(input: {
        healthUrl: string;
        nonce: string;
        projectId: string;
    }): Promise<boolean>;
    private resolveExistingProjectPath;
    private canonicalQueryPath;
    private availability;
    private findPersistedAll;
    private findPersisted;
    private persistHealth;
    private sameRuntime;
    private readState;
    private mutate;
    private writeState;
    private acquireLock;
}
export declare function createProjectRegistry(options?: ProjectRegistryOptionsV1): ProjectRegistryV1;
export { projectIdentityFrom };
