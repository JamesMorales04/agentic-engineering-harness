import { randomUUID } from "node:crypto";
import { canonicalSerialize, sha256Utf8 } from "../core/digest.js";
import { statSync } from "node:fs";
import { isIP } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
export class ProjectRegistryError extends Error {
    constructor(message) {
        super(message);
        this.name = "ProjectRegistryError";
    }
}
export class ProjectPathUnavailableError extends ProjectRegistryError {
    constructor(projectPath) {
        super(`Project path is unavailable: ${projectPath}`);
        this.name = "ProjectPathUnavailableError";
    }
}
export class DuplicateProjectError extends ProjectRegistryError {
    constructor(message) {
        super(message);
        this.name = "DuplicateProjectError";
    }
}
export class AmbiguousProjectError extends ProjectRegistryError {
    constructor(message) {
        super(message);
        this.name = "AmbiguousProjectError";
    }
}
export class ProjectNotFoundError extends ProjectRegistryError {
    constructor(projectId) {
        super(`Project was not found: ${projectId}`);
        this.name = "ProjectNotFoundError";
    }
}
const DEFAULT_STATE_PATH = path.join(os.homedir(), ".config", "agentic-engineering-harness", "projects.json");
function digest(value) {
    return sha256Utf8(value);
}
function digestConfig(config) {
    return sha256Utf8(canonicalSerialize(config));
}
function normalizeRepositoryIdentity(input) {
    const raw = typeof input === "string"
        ? input
        : input.canonical ?? input.remoteUrl ?? input.url ?? (input.host && input.owner && input.name ? `${input.host}/${input.owner}/${input.name}` : "");
    const value = raw.trim();
    if (!value)
        throw new ProjectRegistryError("repositoryIdentity is required.");
    try {
        const url = new URL(/^[^/\s]+\.[^/\s]+\//.test(value) ? `https://${value}` : value);
        if (url.username || url.password || url.search || url.hash) {
            throw new ProjectRegistryError("repositoryIdentity must not contain credentials, query data, or fragments.");
        }
        url.protocol = url.protocol.toLowerCase();
        url.hostname = url.hostname.toLowerCase();
        url.pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
        return url.toString().replace(/\/$/, "");
    }
    catch (error) {
        if (error instanceof ProjectRegistryError)
            throw error;
        return value.toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
    }
}
function normalizeProjectId(projectId) {
    const value = projectId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value)) {
        throw new ProjectRegistryError("projectId must be a stable, non-empty identifier.");
    }
    return value;
}
function normalizeDisplayName(displayName, canonicalRealpath) {
    const value = (displayName ?? path.basename(canonicalRealpath)).trim();
    if (!value)
        throw new ProjectRegistryError("displayName must not be empty.");
    return value;
}
function normalizeConfigDigest(configDigest, config) {
    const value = configDigest?.trim() || (config === undefined ? "" : digestConfig(config));
    if (!value)
        throw new ProjectRegistryError("configDigest or config is required.");
    return /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : digest(value);
}
function safeHealthUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new ProjectRegistryError("healthUrl must be an absolute HTTP(S) URL.");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new ProjectRegistryError("healthUrl must be HTTP(S) without credentials, query data, or fragments.");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname !== "localhost" && !(isIP(hostname) === 4 && hostname.startsWith("127.")) && hostname !== "::1") {
        throw new ProjectRegistryError("healthUrl must target the local loopback interface.");
    }
    return url.toString();
}
function normalizeNonce(nonce) {
    if (!nonce || nonce.length > 4096)
        throw new ProjectRegistryError("nonce must be non-empty and bounded.");
    return nonce;
}
function projectIdFor(repositoryIdentity, canonicalRealpath) {
    return `project_${digest(repositoryIdentity + "\u0000" + canonicalRealpath).slice(0, 32)}`;
}
function publicHealth(health) {
    if (!health)
        return undefined;
    return {
        status: health.status,
        healthUrl: health.healthUrl,
        ...(health.pid === undefined ? {} : { pid: health.pid }),
        nonceRegistered: true,
        registeredAt: health.registeredAt,
        lastCheckedAt: health.lastCheckedAt
    };
}
function publicProject(project, availability) {
    return { ...projectIdentityFrom(project), availability, health: publicHealth(project.health) };
}
function projectIdentityFrom(project) {
    return {
        version: 1,
        projectId: project.projectId,
        canonicalRealpath: project.canonicalRealpath,
        repositoryIdentity: project.repositoryIdentity,
        displayName: project.displayName,
        configDigest: project.configDigest,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
    };
}
export class ProjectRegistryV1 {
    statePath;
    clock;
    lockTimeoutMs;
    constructor(statePathOrOptions = DEFAULT_STATE_PATH, options = {}) {
        const configured = typeof statePathOrOptions === "string" ? options : statePathOrOptions;
        const configuredStatePath = typeof statePathOrOptions === "string" ? statePathOrOptions : statePathOrOptions.statePath;
        const requestedStatePath = configuredStatePath ?? DEFAULT_STATE_PATH;
        let statePath = requestedStatePath;
        if (typeof statePathOrOptions === "string") {
            try {
                if (statSync(requestedStatePath).isDirectory())
                    statePath = path.join(requestedStatePath, "registry.json");
            }
            catch {
                // A non-existent .json path is a file; a non-existent extensionless path is treated as a directory.
                if (path.extname(requestedStatePath) === "")
                    statePath = path.join(requestedStatePath, "registry.json");
            }
        }
        this.statePath = path.resolve(statePath);
        this.clock = configured.clock ?? (() => new Date());
        this.lockTimeoutMs = configured.lockTimeoutMs ?? 5_000;
    }
    async register(input) {
        const canonicalRealpath = await this.resolveExistingProjectPath(input.rootPath ?? input.projectPath ?? input.canonicalRealpath);
        const repositoryIdentity = normalizeRepositoryIdentity(input.repositoryIdentity);
        const displayName = normalizeDisplayName(input.displayName, canonicalRealpath);
        const configDigest = normalizeConfigDigest(input.configDigest, input.config);
        const projectId = normalizeProjectId(input.projectId ?? projectIdFor(repositoryIdentity, canonicalRealpath));
        const now = this.clock().toISOString();
        return this.mutate(async (state) => {
            const existing = state.projects.find((project) => project.projectId === projectId);
            const pathCollision = state.projects.find((project) => project.canonicalRealpath === canonicalRealpath && project.projectId !== projectId);
            if (pathCollision)
                throw new DuplicateProjectError(`Project path is already registered as ${pathCollision.projectId}.`);
            if (!existing) {
                const project = {
                    version: 1,
                    projectId,
                    canonicalRealpath,
                    repositoryIdentity,
                    displayName,
                    configDigest,
                    createdAt: now,
                    updatedAt: now,
                    ...(input.health ? { health: this.persistHealth(input.health, now) } : {})
                };
                state.projects.push(project);
                return publicProject(project, "available");
            }
            if (existing.repositoryIdentity !== repositoryIdentity) {
                throw new DuplicateProjectError(`projectId ${projectId} is already bound to another repository identity.`);
            }
            if (existing.canonicalRealpath !== canonicalRealpath) {
                throw new DuplicateProjectError(`Project ${projectId} is already registered at another path; update it explicitly after a move.`);
            }
            if (existing.health && input.health && !this.sameRuntime(existing.health, input.health)) {
                throw new DuplicateProjectError(`Project ${projectId} already has a different active runtime registration.`);
            }
            existing.displayName = displayName;
            existing.configDigest = configDigest;
            existing.updatedAt = now;
            if (input.health)
                existing.health = this.persistHealth(input.health, existing.health?.registeredAt ?? now);
            return publicProject(existing, "available");
        });
    }
    async list() {
        const state = await this.readState();
        const projects = await Promise.all(state.projects.map(async (project) => publicProject(project, await this.availability(project.canonicalRealpath))));
        return projects.sort((left, right) => `${left.displayName}\u0000${left.repositoryIdentity}\u0000${left.projectId}`.localeCompare(`${right.displayName}\u0000${right.repositoryIdentity}\u0000${right.projectId}`));
    }
    async find(query) {
        const matches = await this.findAll(query);
        if (matches.length > 1)
            throw new AmbiguousProjectError("Project query matches more than one project; include projectId or repositoryIdentity.");
        return matches[0];
    }
    async findAll(query) {
        const state = await this.readState();
        const normalized = typeof query === "string" ? { projectId: query } : query;
        const repositoryIdentity = normalized.repositoryIdentity === undefined ? undefined : normalizeRepositoryIdentity(normalized.repositoryIdentity);
        const canonicalRealpath = normalized.canonicalRealpath ? await this.canonicalQueryPath(normalized.canonicalRealpath) : undefined;
        const matches = state.projects.filter((project) => (normalized.projectId === undefined || project.projectId === normalized.projectId) &&
            (canonicalRealpath === undefined || project.canonicalRealpath === canonicalRealpath) &&
            (repositoryIdentity === undefined || project.repositoryIdentity === repositoryIdentity) &&
            (normalized.displayName === undefined || project.displayName === normalized.displayName));
        return Promise.all(matches.map(async (project) => publicProject(project, await this.availability(project.canonicalRealpath))));
    }
    async update(query, patch) {
        return this.mutate(async (state) => {
            const project = this.findPersisted(state, query);
            const nextPathInput = patch.rootPath ?? patch.projectPath ?? patch.canonicalRealpath;
            if (nextPathInput !== undefined) {
                const nextPath = await this.resolveExistingProjectPath(nextPathInput);
                const pathCollision = state.projects.find((candidate) => candidate.canonicalRealpath === nextPath && candidate.projectId !== project.projectId);
                if (pathCollision)
                    throw new DuplicateProjectError(`Project path is already registered as ${pathCollision.projectId}.`);
                project.canonicalRealpath = nextPath;
            }
            if (patch.displayName !== undefined)
                project.displayName = normalizeDisplayName(patch.displayName, project.canonicalRealpath);
            if (patch.configDigest !== undefined || patch.config !== undefined)
                project.configDigest = normalizeConfigDigest(patch.configDigest, patch.config);
            project.updatedAt = this.clock().toISOString();
            return publicProject(project, await this.availability(project.canonicalRealpath));
        });
    }
    async remove(query) {
        return this.mutate(async (state) => {
            const matches = this.findPersistedAll(state, query);
            if (matches.length > 1)
                throw new AmbiguousProjectError("Project query matches more than one project; include projectId or repositoryIdentity.");
            if (!matches[0])
                return false;
            state.projects = state.projects.filter((project) => project !== matches[0]);
            return true;
        });
    }
    async recordHealth(projectId, input) {
        return this.mutate(async (state) => {
            const project = state.projects.find((candidate) => candidate.projectId === projectId);
            if (!project)
                throw new ProjectNotFoundError(projectId);
            const now = this.clock().toISOString();
            if (project.health && !this.sameRuntime(project.health, input)) {
                throw new DuplicateProjectError(`Project ${projectId} already has a different active runtime registration.`);
            }
            project.health = this.persistHealth(input, project.health?.registeredAt ?? now);
            project.updatedAt = now;
            return publicHealth(project.health);
        });
    }
    async updateHealth(projectId, input) {
        return this.recordHealth(projectId, input);
    }
    async getHealth(projectId) {
        const state = await this.readState();
        const project = state.projects.find((candidate) => candidate.projectId === projectId);
        return publicHealth(project?.health);
    }
    async health(projectId, input) {
        return input ? this.recordHealth(projectId, input) : this.getHealth(projectId);
    }
    async verifyRuntime(input) {
        const state = await this.readState();
        const project = state.projects.find((candidate) => candidate.projectId === input.projectId);
        if (!project?.health || project.health.status !== "healthy")
            return false;
        let healthUrl;
        try {
            healthUrl = safeHealthUrl(input.healthUrl);
            normalizeNonce(input.nonce);
        }
        catch {
            return false;
        }
        return project.health.healthUrl === healthUrl && project.health.nonceDigest === digest(input.nonce);
    }
    async isRuntimeRegistered(input) {
        return this.verifyRuntime(input);
    }
    async resolveExistingProjectPath(projectPath) {
        if (!projectPath)
            throw new ProjectPathUnavailableError("<missing>");
        try {
            const canonical = await fs.realpath(path.resolve(projectPath));
            const stat = await fs.stat(canonical);
            if (!stat.isDirectory())
                throw new Error("not a directory");
            return canonical;
        }
        catch {
            throw new ProjectPathUnavailableError(projectPath);
        }
    }
    async canonicalQueryPath(projectPath) {
        try {
            return await fs.realpath(path.resolve(projectPath));
        }
        catch {
            return path.resolve(projectPath);
        }
    }
    async availability(projectPath) {
        try {
            const canonical = await fs.realpath(projectPath);
            const stat = await fs.stat(canonical);
            return stat.isDirectory() && canonical === projectPath ? "available" : "moved-or-missing";
        }
        catch {
            return "moved-or-missing";
        }
    }
    findPersistedAll(state, query) {
        const normalized = typeof query === "string" ? { projectId: query } : query;
        const repositoryIdentity = normalized.repositoryIdentity === undefined ? undefined : normalizeRepositoryIdentity(normalized.repositoryIdentity);
        return state.projects.filter((project) => (normalized.projectId === undefined || project.projectId === normalized.projectId) &&
            (normalized.canonicalRealpath === undefined || project.canonicalRealpath === path.resolve(normalized.canonicalRealpath)) &&
            (repositoryIdentity === undefined || project.repositoryIdentity === repositoryIdentity) &&
            (normalized.displayName === undefined || project.displayName === normalized.displayName));
    }
    findPersisted(state, query) {
        const matches = this.findPersistedAll(state, query);
        if (!matches[0])
            throw new ProjectNotFoundError(typeof query === "string" ? query : query.projectId ?? query.displayName ?? "query");
        if (matches.length > 1)
            throw new AmbiguousProjectError("Project query matches more than one project; include projectId or repositoryIdentity.");
        return matches[0];
    }
    persistHealth(input, registeredAt) {
        const nonce = normalizeNonce(input.nonce);
        const healthUrl = safeHealthUrl(input.healthUrl);
        if (input.pid !== undefined && (!Number.isInteger(input.pid) || input.pid < 0))
            throw new ProjectRegistryError("pid must be a non-negative integer.");
        return {
            healthUrl,
            lastCheckedAt: this.clock().toISOString(),
            nonceDigest: digest(nonce),
            ...(input.pid === undefined ? {} : { pid: input.pid }),
            registeredAt,
            status: input.status ?? "healthy"
        };
    }
    sameRuntime(health, input) {
        try {
            return health.healthUrl === safeHealthUrl(input.healthUrl) && health.nonceDigest === digest(normalizeNonce(input.nonce));
        }
        catch {
            return false;
        }
    }
    async readState() {
        try {
            const raw = await fs.readFile(this.statePath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed.version !== 1 || !Array.isArray(parsed.projects))
                throw new ProjectRegistryError("Project registry has an unsupported format.");
            return parsed;
        }
        catch (error) {
            if (error instanceof ProjectRegistryError || error instanceof SyntaxError)
                throw error;
            const code = error;
            if (code.code === "ENOENT")
                return { version: 1, projects: [] };
            throw error;
        }
    }
    async mutate(operation) {
        const release = await this.acquireLock();
        try {
            const state = await this.readState();
            const result = await operation(state);
            await this.writeState(state);
            return result;
        }
        finally {
            await release();
        }
    }
    async writeState(state) {
        await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
        const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
        await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        try {
            await fs.rename(temporaryPath, this.statePath);
        }
        catch (error) {
            await fs.rm(temporaryPath, { force: true });
            throw error;
        }
    }
    async acquireLock() {
        const lockPath = `${this.statePath}.lock`;
        const startedAt = Date.now();
        await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
        while (true) {
            try {
                const handle = await fs.open(lockPath, "wx", 0o600);
                await handle.close();
                return async () => {
                    await fs.rm(lockPath, { force: true });
                };
            }
            catch (error) {
                const code = error;
                if (code.code !== "EEXIST")
                    throw error;
                if (Date.now() - startedAt >= this.lockTimeoutMs)
                    throw new ProjectRegistryError("Timed out waiting for the project registry lock.");
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        }
    }
}
export function createProjectRegistry(options = {}) {
    return new ProjectRegistryV1(options);
}
export { projectIdentityFrom };
//# sourceMappingURL=registry.js.map