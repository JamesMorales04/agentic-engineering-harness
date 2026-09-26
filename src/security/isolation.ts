import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessProjectConfig, ValidatorSpec } from "../core/types.js";
import { sha256Canonical } from "../core/digest.js";
import { resolveExecutable, runExecutable } from "../utils/process.js";

export const ISOLATION_PROVIDER_UNAVAILABLE = "ISOLATION_PROVIDER_UNAVAILABLE" as const;
export const ISOLATION_PROVIDER_UNSUPPORTED = "ISOLATION_PROVIDER_UNSUPPORTED" as const;
export const ISOLATION_ENVIRONMENT_REJECTED = "ISOLATION_ENVIRONMENT_REJECTED" as const;
export const ISOLATION_COMMAND_INVALID = "ISOLATION_COMMAND_INVALID" as const;

export type IsolationProviderIdV1 = "bwrap" | "none";

export const DEFAULT_ISOLATION_ENVIRONMENT_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "TMPDIR", "SHELL", "USER"] as const;

export const DEFAULT_MASKED_HOST_PATHS = [
  "/root (host)",
  "/run (host)",
  "/home (host contents except explicit toolchain binds)",
  "/tmp (host)",
  "/var/tmp (host)",
  "/mnt (host)",
  "/media (host)",
  "/srv (host)"
] as const;

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
  podman: { available: boolean; rootless: boolean | null };
  buildah: { available: boolean };
  details: string[];
}

export interface IsolationExecutionEvidenceV1 {
  version: 1;
  provider: "bwrap";
  providerVersion: string;
  rootless: true;
  namespaces: { user: true; mount: true; pid: true; uts: true; ipc: true; network: boolean };
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

export class IsolationProviderUnavailableError extends Error {
  readonly code = ISOLATION_PROVIDER_UNAVAILABLE;
  constructor(message: string) {
    super(`${ISOLATION_PROVIDER_UNAVAILABLE}: ${message}`);
    this.name = "IsolationProviderUnavailableError";
  }
}

const capabilityCache = new Map<string, Promise<IsolationCapabilitiesV1>>();

export function clearIsolationCapabilityCache(): void {
  capabilityCache.clear();
}

export async function detectIsolationCapabilities(root: string): Promise<IsolationCapabilitiesV1> {
  const key = path.resolve(root);
  const cached = capabilityCache.get(key);
  if (cached) return cached;
  const pending = detect(root).catch((error: unknown) => {
    capabilityCache.delete(key);
    throw error;
  });
  capabilityCache.set(key, pending);
  return pending;
}

async function detect(root: string): Promise<IsolationCapabilitiesV1> {
  const details: string[] = [];
  const bwrapPath = await resolveExecutable("bwrap", root);
  let providerVersion: string | undefined;
  if (bwrapPath) {
    const version = await runExecutable(bwrapPath, ["--version"], { cwd: root, timeoutMs: 10_000 }).catch(() => undefined);
    providerVersion = parseBwrapVersion(`${version?.stdout ?? ""}${version?.stderr ?? ""}`);
    details.push(`bwrap: ${bwrapPath}${providerVersion ? ` (${providerVersion})` : ""}`);
  } else {
    details.push("bwrap: missing");
  }
  const podmanPath = await resolveExecutable("podman", root);
  let podmanRootless: boolean | null = null;
  if (podmanPath) {
    const info = await runExecutable(podmanPath, ["info", "--format", "{{.Host.Security.Rootless}}"], { cwd: root, timeoutMs: 20_000 }).catch(() => undefined);
    const value = `${info?.stdout ?? ""}`.trim().toLowerCase();
    podmanRootless = value === "true" ? true : value === "false" ? false : null;
    details.push(`podman: ${podmanPath} (rootless=${podmanRootless === null ? "unknown" : String(podmanRootless)})`);
  } else {
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
  if (!available) details.push("no rootless isolation provider is currently executable");
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

function parseBwrapVersion(value: string): string | undefined {
  const match = value.match(/bubblewrap\s+([0-9][^\s]*)/i);
  return match?.[1];
}

async function unprivilegedUserNamespacesAvailable(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    const value = (await fsPromises.readFile("/proc/sys/kernel/unprivileged_userns_clone", "utf8")).trim();
    return value === "1";
  } catch { /* knob absent on this kernel */ }
  try {
    const value = Number((await fsPromises.readFile("/proc/sys/user/max_user_namespaces", "utf8")).trim());
    return Number.isSafeInteger(value) && value > 0;
  } catch {
    return true;
  }
}

async function apparmorStatus(): Promise<string> {
  try {
    const value = (await fsPromises.readFile("/sys/module/apparmor/parameters/enabled", "utf8")).trim().toLowerCase();
    return value === "y" ? "enabled" : "disabled";
  } catch { /* module parameter absent */ }
  return fs.existsSync("/sys/kernel/security/apparmor") ? "enabled" : "absent";
}

export function assertSupportedIsolationProvider(config: HarnessProjectConfig): void {
  const provider = config.security?.isolation?.provider;
  if (provider === undefined || provider === "bwrap") return;
  throw new Error(`${ISOLATION_PROVIDER_UNSUPPORTED}: isolation provider '${provider}' is not supported; only the rootless 'bwrap' provider is implemented.`);
}

export function validatorIsolationRequired(config: HarnessProjectConfig, spec?: ValidatorSpec): boolean {
  if (spec?.options?.isolate === true) return true;
  return config.security?.isolation?.required === true;
}

export function validatorIsolationNetwork(config: HarnessProjectConfig): boolean {
  return config.security?.isolation?.network === true;
}

export function validatorIsolationEnvironmentAllowlist(config: HarnessProjectConfig): string[] {
  return [...DEFAULT_ISOLATION_ENVIRONMENT_ALLOWLIST, ...(config.security?.isolation?.environmentAllowlist ?? [])];
}

export function toolchainReadOnlyPaths(root: string): string[] {
  const workspace = path.resolve(root);
  const home = path.resolve(os.homedir());
  const found = new Set<string>();
  const add = (candidate: string): void => {
    const resolved = path.resolve(candidate);
    if (resolved === workspace || resolved.startsWith(`${workspace}${path.sep}`)) return;
    if (!fs.existsSync(resolved)) return;
    found.add(resolved);
  };
  const addWithInstallRoot = (directory: string): void => {
    add(directory);
    let current = path.resolve(directory);
    while (isUnder(current, home)) {
      const parent = path.dirname(current);
      if (!isUnder(parent, home)) break;
      if (!fs.existsSync(path.join(parent, "bin"))) break;
      add(parent);
      current = parent;
    }
  };
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) addWithInstallRoot(directory);
  addWithInstallRoot(path.dirname(process.execPath));
  return [...found].sort();
}

function isUnder(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

export interface BuildBwrapOptionsV1 {
  environmentAllowlist?: string[];
}

export interface BwrapBuildV1 {
  executable: string;
  args: string[];
  evidence: IsolationExecutionEvidenceV1;
}

export function buildBwrapArgs(request: IsolatedCommandRequestV1, capabilities: IsolationCapabilitiesV1, options: BuildBwrapOptionsV1 = {}): BwrapBuildV1 {
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
  const args: string[] = ["--unshare-user", "--unshare-pid", "--unshare-uts", "--unshare-ipc"];
  if (request.network !== true) args.push("--unshare-net");
  args.push("--die-with-parent", "--new-session", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  for (const item of systemRoots) args.push("--ro-bind-try", item, item);
  for (const item of toolchain) args.push("--ro-bind-try", item, item);
  args.push(writableSet.has(workspace) ? "--bind" : "--ro-bind", workspace, workspace);
  for (const item of writable) {
    if (item === workspace) continue;
    args.push("--bind", item, item);
  }
  for (const item of [...new Set((request.readOnlyPaths ?? []).map((entry) => path.resolve(entry)))].sort()) {
    if (item === workspace) continue;
    args.push("--ro-bind-try", item, item);
  }
  args.push("--chdir", path.resolve(request.cwd));
  args.push("--clearenv");
  for (const [name, value] of Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))) args.push("--setenv", name, value);
  args.push("--");
  if (request.argv) args.push(...request.argv);
  else args.push("/bin/sh", "-c", request.command!);
  const evidence: IsolationExecutionEvidenceV1 = {
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

export function isolationEnvironment(request: IsolatedCommandRequestV1, allowlist: readonly string[]): Record<string, string> {
  const allowed = new Set(allowlist);
  for (const name of Object.keys(request.environment ?? {})) {
    if (!allowed.has(name)) throw new Error(`${ISOLATION_ENVIRONMENT_REJECTED}: '${name}' is not in the isolation environment allowlist.`);
  }
  const environment: Record<string, string> = {
    PATH: request.environment?.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp",
    TMPDIR: "/tmp"
  };
  for (const name of allowed) {
    if (name === "PATH" || name === "HOME" || name === "TMPDIR") continue;
    const value = request.environment?.[name] ?? process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export async function runIsolatedCommand(request: IsolatedCommandRequestV1, options: IsolatedCommandOptionsV1 = {}): Promise<IsolatedCommandResultV1> {
  for (const writable of request.writablePaths ?? []) await fsPromises.mkdir(writable, { recursive: true });
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
