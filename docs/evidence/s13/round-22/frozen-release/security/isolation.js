import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256Canonical } from "../core/digest.js";
import { resolveExecutable, runExecutable } from "../utils/process.js";
export const ISOLATION_PROVIDER_UNAVAILABLE = "ISOLATION_PROVIDER_UNAVAILABLE";
export const ISOLATION_PROVIDER_UNSUPPORTED = "ISOLATION_PROVIDER_UNSUPPORTED";
export const ISOLATION_ENVIRONMENT_REJECTED = "ISOLATION_ENVIRONMENT_REJECTED";
export const ISOLATION_COMMAND_INVALID = "ISOLATION_COMMAND_INVALID";
export const DEFAULT_ISOLATION_ENVIRONMENT_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "TMPDIR", "SHELL", "USER"];
export const DEFAULT_MASKED_HOST_PATHS = [
    "/root (host)",
    "/run (host)",
    "/home (host contents except explicit toolchain binds)",
    "/tmp (host)",
    "/var/tmp (host)",
    "/mnt (host)",
    "/media (host)",
    "/srv (host)"
];
export class IsolationProviderUnavailableError extends Error {
    code = ISOLATION_PROVIDER_UNAVAILABLE;
    constructor(message) {
        super(`${ISOLATION_PROVIDER_UNAVAILABLE}: ${message}`);
        this.name = "IsolationProviderUnavailableError";
    }
}
const capabilityCache = new Map();
export function clearIsolationCapabilityCache() {
    capabilityCache.clear();
}
export async function detectIsolationCapabilities(root) {
    const key = path.resolve(root);
    const cached = capabilityCache.get(key);
    if (cached)
        return cached;
    const pending = detect(root).catch((error) => {
        capabilityCache.delete(key);
        throw error;
    });
    capabilityCache.set(key, pending);
    return pending;
}
async function detect(root) {
    const details = [];
    const bwrapPath = await resolveExecutable("bwrap", root);
    let providerVersion;
    if (bwrapPath) {
        const version = await runExecutable(bwrapPath, ["--version"], { cwd: root, timeoutMs: 10_000 }).catch(() => undefined);
        providerVersion = parseBwrapVersion(`${version?.stdout ?? ""}${version?.stderr ?? ""}`);
        details.push(`bwrap: ${bwrapPath}${providerVersion ? ` (${providerVersion})` : ""}`);
    }
    else {
        details.push("bwrap: missing");
    }
    const podmanPath = await resolveExecutable("podman", root);
    let podmanRootless = null;
    if (podmanPath) {
        const info = await runExecutable(podmanPath, ["info", "--format", "{{.Host.Security.Rootless}}"], { cwd: root, timeoutMs: 20_000 }).catch(() => undefined);
        const value = `${info?.stdout ?? ""}`.trim().toLowerCase();
        podmanRootless = value === "true" ? true : value === "false" ? false : null;
        details.push(`podman: ${podmanPath} (rootless=${podmanRootless === null ? "unknown" : String(podmanRootless)})`);
    }
    else {
        details.push("podman: missing");
    }
    const buildahPath = await resolveExecutable("buildah", root);
    details.push(buildahPath ? `buildah: ${buildahPath}` : "buildah: missing");
    const userNamespaces = await unprivilegedUserNamespacesAvailable();
    details.push(`unprivileged user namespaces: ${userNamespaces ? "available" : "unavailable"}`);
    const seccompKernel = fs.existsSync("/proc/sys/kernel/seccomp/actions_avail");
    details.push(`seccomp kernel interface: ${seccompKernel ? "available" : "absent"}`);
    const apparmor = await apparmorStatus();
    details.push(`apparmor: ${apparmor}`);
    const available = Boolean(bwrapPath);
    if (!available)
        details.push("no rootless isolation provider is currently executable");
    return {
        version: 1,
        provider: available ? "bwrap" : "none",
        available,
        executable: bwrapPath,
        providerVersion,
        rootless: true,
        userNamespaces,
        networkNamespace: process.platform === "linux",
        seccompKernel,
        apparmor,
        podman: { available: Boolean(podmanPath), rootless: podmanRootless },
        buildah: { available: Boolean(buildahPath) },
        details
    };
}
function parseBwrapVersion(value) {
    const match = value.match(/bubblewrap\s+([0-9][^\s]*)/i);
    return match?.[1];
}
async function unprivilegedUserNamespacesAvailable() {
    if (process.platform !== "linux")
        return false;
    try {
        const value = (await fsPromises.readFile("/proc/sys/kernel/unprivileged_userns_clone", "utf8")).trim();
        return value === "1";
    }
    catch { /* knob absent on this kernel */ }
    try {
        const value = Number((await fsPromises.readFile("/proc/sys/user/max_user_namespaces", "utf8")).trim());
        return Number.isSafeInteger(value) && value > 0;
    }
    catch {
        return true;
    }
}
async function apparmorStatus() {
    try {
        const value = (await fsPromises.readFile("/sys/module/apparmor/parameters/enabled", "utf8")).trim().toLowerCase();
        return value === "y" ? "enabled" : "disabled";
    }
    catch { /* module parameter absent */ }
    return fs.existsSync("/sys/kernel/security/apparmor") ? "enabled" : "absent";
}
export function assertSupportedIsolationProvider(config) {
    const provider = config.security?.isolation?.provider;
    if (provider === undefined || provider === "bwrap")
        return;
    throw new Error(`${ISOLATION_PROVIDER_UNSUPPORTED}: isolation provider '${provider}' is not supported; only the rootless 'bwrap' provider is implemented.`);
}
export function validatorIsolationRequired(config, spec) {
    if (spec?.options?.isolate === true)
        return true;
    return config.security?.isolation?.required === true;
}
export function validatorIsolationNetwork(config) {
    return config.security?.isolation?.network === true;
}
export function validatorIsolationEnvironmentAllowlist(config) {
    return [...DEFAULT_ISOLATION_ENVIRONMENT_ALLOWLIST, ...(config.security?.isolation?.environmentAllowlist ?? [])];
}
export function toolchainReadOnlyPaths(root) {
    const workspace = path.resolve(root);
    const home = path.resolve(os.homedir());
    const found = new Set();
    const add = (candidate) => {
        const resolved = path.resolve(candidate);
        if (resolved === workspace || resolved.startsWith(`${workspace}${path.sep}`))
            return;
        if (!fs.existsSync(resolved))
            return;
        found.add(resolved);
    };
    const addWithInstallRoot = (directory) => {
        add(directory);
        let current = path.resolve(directory);
        while (isUnder(current, home)) {
            const parent = path.dirname(current);
            if (!isUnder(parent, home))
                break;
            if (!fs.existsSync(path.join(parent, "bin")))
                break;
            add(parent);
            current = parent;
        }
    };
    for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean))
        addWithInstallRoot(directory);
    addWithInstallRoot(path.dirname(process.execPath));
    return [...found].sort();
}
function isUnder(candidate, parent) {
    return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}
export function buildBwrapArgs(request, capabilities, options = {}) {
    if (!capabilities.available || !capabilities.executable) {
        throw new IsolationProviderUnavailableError(`rootless isolation requires a working bwrap executable; ${capabilities.details.join("; ")}`);
    }
    if ((request.command === undefined) === (request.argv === undefined)) {
        throw new Error(`${ISOLATION_COMMAND_INVALID}: exactly one of command or argv is required.`);
    }
    const environment = isolationEnvironment(request, options.environmentAllowlist ?? [...DEFAULT_ISOLATION_ENVIRONMENT_ALLOWLIST]);
    const workspace = path.resolve(request.workspaceRoot);
    const writable = [...new Set([...(request.writablePaths ?? []).map((item) => path.resolve(item))])].sort();
    const writableSet = new Set(writable);
    const systemRoots = ["/usr", "/etc", "/bin", "/lib", "/lib64", "/sbin"].filter((item) => fs.existsSync(item));
    const toolchain = toolchainReadOnlyPaths(request.root);
    const visibleReadOnlyPaths = [...systemRoots, ...toolchain, ...(writableSet.has(workspace) ? [] : [workspace])].sort();
    const args = ["--unshare-user", "--unshare-pid", "--unshare-uts", "--unshare-ipc"];
    if (request.network !== true)
        args.push("--unshare-net");
    args.push("--die-with-parent", "--new-session", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
    for (const item of systemRoots)
        args.push("--ro-bind-try", item, item);
    for (const item of toolchain)
        args.push("--ro-bind-try", item, item);
    args.push(writableSet.has(workspace) ? "--bind" : "--ro-bind", workspace, workspace);
    for (const item of writable) {
        if (item === workspace)
            continue;
        args.push("--bind", item, item);
    }
    for (const item of [...new Set((request.readOnlyPaths ?? []).map((entry) => path.resolve(entry)))].sort()) {
        if (item === workspace)
            continue;
        args.push("--ro-bind-try", item, item);
    }
    args.push("--chdir", path.resolve(request.cwd));
    args.push("--clearenv");
    for (const [name, value] of Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)))
        args.push("--setenv", name, value);
    args.push("--");
    if (request.argv)
        args.push(...request.argv);
    else
        args.push("/bin/sh", "-c", request.command);
    const evidence = {
        version: 1,
        provider: "bwrap",
        providerVersion: capabilities.providerVersion ?? "unknown",
        rootless: true,
        namespaces: { user: true, mount: true, pid: true, uts: true, ipc: true, network: request.network === true },
        networkAccess: request.network === true ? "host" : "none",
        readOnlyRoot: true,
        visibleReadOnlyPaths,
        maskedHostPaths: [...DEFAULT_MASKED_HOST_PATHS],
        writablePaths: writable,
        environmentAllowlist: Object.keys(environment).sort(),
        noNewPrivileges: true,
        seccomp: "not-applied",
        commandDigest: sha256Canonical({ command: request.command ?? null, argv: request.argv ?? null })
    };
    return { executable: capabilities.executable, args, evidence };
}
export function isolationEnvironment(request, allowlist) {
    const allowed = new Set(allowlist);
    for (const name of Object.keys(request.environment ?? {})) {
        if (!allowed.has(name))
            throw new Error(`${ISOLATION_ENVIRONMENT_REJECTED}: '${name}' is not in the isolation environment allowlist.`);
    }
    const environment = {
        PATH: request.environment?.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        TMPDIR: "/tmp"
    };
    for (const name of allowed) {
        if (name === "PATH" || name === "HOME" || name === "TMPDIR")
            continue;
        const value = request.environment?.[name] ?? process.env[name];
        if (value !== undefined)
            environment[name] = value;
    }
    return environment;
}
export async function runIsolatedCommand(request, options = {}) {
    for (const writable of request.writablePaths ?? [])
        await fsPromises.mkdir(writable, { recursive: true });
    const capabilities = options.capabilities ?? await detectIsolationCapabilities(request.root);
    const build = buildBwrapArgs(request, capabilities, options.environmentAllowlist ? { environmentAllowlist: options.environmentAllowlist } : {});
    const result = await runExecutable(build.executable, build.args, { cwd: request.root, timeoutMs: request.timeoutMs ?? 900_000 });
    return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut === true,
        isolation: build.evidence
    };
}
//# sourceMappingURL=isolation.js.map