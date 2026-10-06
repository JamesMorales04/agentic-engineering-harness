import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  stdoutDigest?: string;
  stderrDigest?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  timedOut?: boolean;
}

export interface ManagedProcessHandle {
  pid: number;
  processGroupId: number;
}

const toolchainPathCache = new Map<string, string | undefined>();
export function clearToolchainEnvCache(): void { toolchainPathCache.clear(); }

/**
 * Canonical managed-envelope scrub list (C6).
 *
 * MECHANISM: DETERMINISTIC. Single source shared by prod runChild and the
 * browser fixture sanitizer. Strips controller identity, the managed-agent
 * envelope, participant/candidate/lease/binding/scratch authority, deterministic
 * Paseo markers, S9 roots, Paseo session binding, context extras, NODE_PATH
 * host leakage (consistent with sdkResolve's NODE_PATH scrub during resolve),
 * all MISE_* and ASDF_* shim configuration, and XDG shim-directory overrides.
 *
 * Shim-var enumeration (mise docs/behavior in-repo):
 * - MISE_* prefix: covers MISE_DATA_DIR, MISE_INSTALLS_DIR, MISE_SHIMS_DIR,
 *   MISE_SYSTEM_DATA_DIR, MISE_SYSTEM_INSTALLS_DIR, MISE_SYSTEM_SHIMS_DIR,
 *   MISE_CONFIG_DIR, MISE_CACHE_DIR, MISE_STATE_DIR, MISE_CONFIG_FILE,
 *   MISE_ENV, MISE_ENV_FILE, MISE_TRUSTED_CONFIG_PATHS, MISE_SHELL,
 *   MISE_TOOL_* / MISE_*_VERSION overrides, MISE_OVERRIDE_*, MISE_PIPX_UVX,
 *   MISE_PYPI_UVX, MISE_ASDF_COMPAT, MISE_DISABLE_BACKENDS, etc.
 *   Sources: mise directories table + env.rs (MISE_DATA_DIR/INSTALLS/SHIMS),
 *   settings reference (shims_dir/system_shims_dir/trusted_config_paths),
 *   in-repo src/toolchain/mise.ts (MISE_PIPX_UVX/MISE_PYPI_UVX).
 * - ASDF_* prefix: asdf-compat backend (ASDF_DATA_DIR/CONFIG_FILE) can redirect
 *   mise's asdf backend to host shims; scrubbed for the same reason.
 * - XDG_DATA_HOME/XDG_CONFIG_HOME/XDG_CACHE_HOME/XDG_STATE_HOME: control mise
 *   defaults (data/config/cache/state dirs) when MISE_* unset (mise directories
 *   table); scrubbed so host XDG cannot reintroduce host installs/shims.
 *   Other XDG_* (SESSION/DESKTOP/etc.) are not shim-resolving and are preserved.
 *
 * PATH is hermetic (no ambient tail, not even filtered): managed children
 * (toolchain !== false) get `pinned prefix + explicit extra + minimal system
 * dirs` when `.harness/toolchain.state.json` exists and/or
 * `AEH_TOOLCHAIN_EXTRA_BIN_PATHS` explicitly marks dirs, and minimal system
 * dirs ONLY when both are missing. Ambient PATH is never consulted:
 * mise-provisioned tools, `~/.local/bin`, `/opt/homebrew/bin`, temp-dir test
 * stubs, and every other ambient-only directory do NOT resolve in the
 * missing-state-and-unmarked case. Explicit marking is not ambient: only
 * absolute dirs listed in AEH_TOOLCHAIN_EXTRA_BIN_PATHS (CI mise bin-paths +
 * ~/.local/bin + npm-global/cosign dirs, set explicitly via GITHUB_ENV) are
 * honored beyond the pinned prefix. The pinned prefix comes from
 * `.harness/toolchain.state.json` (toolchainPathPrefix); the Paseo SDK via
 * `resolvePaseoSdkFromCli` diagnostics; the candidate release via
 * `dist/releases/<id>/build-identity.json` plus AEH_S9_REPO_ROOT. AEH_ENTRY_FILE
 * is stripped fail-closed so entry resolution must be explicit (argv[1]).
 *
 * Hermetic PATH breakage (fail-closed, never silent ambient):
 * - When toolchain.state.json is missing and no explicit marking exists
 *   (fresh checkout, disposable fixture root, CI without setup/marking):
 *   mise-provisioned `node/npm/paseo/opencode/codex/python/uv/...` are NOT in
 *   minimal system dirs and will NOT be found. Direct spawns reject with
 *   AEH_TOOLCHAIN_NOT_CONFIGURED (run `aeh setup` to generate
 *   `.harness/toolchain.state.json`, or explicitly mark CI mise bins via
 *   AEH_TOOLCHAIN_EXTRA_BIN_PATHS, then retry); shell commands fail visibly
 *   (127/command-not-found); resolveExecutable/commandExists report unresolved
 *   so callers surface missing-tool errors. Never falls back to ambient, not
 *   even filtered ambient.
 * - When a system tool lives only in a non-standard ambient dir (e.g.
 *   ~/.local/bin, /opt/homebrew/bin, ~/.bun/bin, flatpak exports): it will NOT
 *   be found in hermetic minimal unless explicitly marked. Fallback: install
 *   via standard system dirs (/usr/local/bin:/usr/bin:/bin), declare via
 *   toolchain config and run `aeh setup`, or explicitly mark the dir via
 *   AEH_TOOLCHAIN_EXTRA_BIN_PATHS; fail-closed with missing-command error,
 *   never silent ambient resolution.
 * - Migration (stale/missing state): run `aeh setup` to (re)generate
 *   `.harness/toolchain.state.json`, then retry; CI ambient mise shapes set
 *   AEH_TOOLCHAIN_EXTRA_BIN_PATHS explicitly instead of relying on ambient.
 *   Tests that stub executables via ambient PATH must pin the stub dir in the
 *   state binPaths (or mark via AEH_TOOLCHAIN_EXTRA_BIN_PATHS, or use
 *   toolchain:false / absolute executable paths) instead of relying on ambient
 *   resolution.
 * - toolchain:false (mise internal: `mise --version`, trust, install, bin-paths,
 *   which, container pulls, project-dependency setup with explicit PATH) keeps
 *   ambient/explicit PATH to locate `mise` itself, but still scrubs ambient
 *   MISE_* and ASDF_* and XDG-shim vars; only explicit options.env MISE_* are
 *   re-allowed for toolchain:false (required for MISE_PIPX_UVX and MISE_PYPI_UVX
 *   in `mise lock`).
 *
 * Fail-closed: even explicit options.env values for scrubbed keys are removed
 * in managed children (toolchain !== false); repository children must use
 * explicit roots, never inherited controller identity or host shim config.
 */
export const MANAGED_CHILD_ENV_SCRUB_KEYS = [
  "AEH_OPERATION_ID", "AEH_OPERATION_KIND", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT", "AEH_OPERATION_WORKSPACE_ID",
  "AEH_MANAGED_AGENT", "AEH_LOGICAL_AGENT", "AEH_AGENT_ROLE", "AEH_PARENT_OPERATION_ID", "AEH_PARENT_OPERATION_KIND", "AEH_AGENT_PHASE",
  "AEH_INTERACTIVE_LEAD", "AEH_ORCHESTRATION_ALLOWED", "AEH_ALLOW_NESTED_OPERATION", "AEH_OPERATION_SUPERVISOR", "AEH_PARENT_AGENT_ID",
  "AEH_SUPERVISOR_GENERATION", "AEH_CONTEXT_OPERATION_ID", "AEH_CONTEXT_PHASE", "AEH_CONTEXT_ROOT", "AEH_ENTRY_FILE",
  "AEH_SELF_REEXEC",
  "AEH_CONTROLLER_EPOCH", "AEH_CONTROLLER_TOKEN",
  "AEH_DETERMINISTIC_PASEO", "AEH_DETERMINISTIC_PASEO_RUNTIME",
  "AEH_S9_REPO_ROOT",
  "PASEO_AGENT_ID", "PASEO_PARENT_AGENT_ID", "PASEO_SESSION_ID",
  "AEH_PARTICIPANT_ID",
  "AEH_CANDIDATE_DIGEST",
  "AEH_CAPABILITY_LEASES",
  "AEH_EXECUTION_BINDING",
  "AEH_CONTEXT_MANIFEST_DIGEST", "AEH_PROMPT_MANIFEST_DIGEST", "AEH_SKILL_MANIFEST_DIGEST",
  "AEH_SCRATCH_RESOURCE", "AEH_SCRATCH_DIGEST",
  "AEH_CONTEXT_CONTROL_ROOT", "AEH_CONTEXT_PARTICIPANT_ID", "AEH_CONTEXT_SESSION_ID",
  "AEH_SUPERVISOR_SESSION_ID",
  "NODE_PATH",
] as const;

/** Prefix-scrubbed shim config (all current/future MISE_* + asdf-compat ASDF_*). */
export const MANAGED_CHILD_ENV_SCRUB_PREFIXES = ["MISE_", "ASDF_"] as const;

/** XDG overrides that control mise defaults (data/config/cache/state dirs). */
export const MANAGED_CHILD_ENV_SCRUB_XDG_SHIM_KEYS = [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
] as const;

/** Minimal system dirs for hermetic PATH (no ambient tail). See breakage docs above. */
export const HERMITIC_SYSTEM_PATH_DIRS: readonly string[] = process.platform === "win32"
  ? ["C:\\Windows\\System32", "C:\\Windows"]
  : ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];

/**
 * Explicitly-marked extra toolchain bin paths (DETERMINISTIC).
 *
 * CI provider jobs (full-stack-contract, provider-contracts, supply-chain)
 * provision real providers via ambient `mise bin-paths >> GITHUB_PATH` plus
 * `~/.local/bin` (uv tools) and npm-global/cosign dirs, without running
 * `aeh setup` and without a `.harness/toolchain.state.json` under isolated
 * temp-dir fixture roots. Hermetic blocks silent ambient, so those jobs fail
 * with reconciled-PATH misses. This allowlist restores them explicitly:
 * only dirs listed in `AEH_TOOLCHAIN_EXTRA_BIN_PATHS` (path.delimiter-joined,
 * absolute only) are appended after the pinned prefix and before minimal.
 * Unlisted ambient dirs (decoy shims, host farms) stay blocked. Unset/empty
 * preserves the prior fail-closed minimal-only behavior, so the decoy-shim
 * regression still passes.
 */
export const AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV = "AEH_TOOLCHAIN_EXTRA_BIN_PATHS";

export function explicitExtraBinPaths(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string[] {
  const raw = (env as Record<string, unknown>)[AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV];
  if (typeof raw !== "string" || !raw.trim()) return [];
  const seen = new Set<string>();
  for (const part of raw.split(path.delimiter)) {
    const trimmed = part.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) continue;
    const normalized = path.normalize(trimmed);
    if (!seen.has(normalized)) seen.add(normalized);
  }
  return [...seen];
}

/** Build hermetic PATH: pinned prefix + explicit extra + minimal system dirs, no ambient tail. */
export function buildHermeticChildPath(prefix?: string, explicitExtra?: readonly string[] | string): string {
  const explicit = typeof explicitExtra === "string"
    ? explicitExtra.split(path.delimiter).map((part) => part.trim()).filter(Boolean)
    : (explicitExtra ?? []);
  const parts = [prefix, ...explicit, ...HERMITIC_SYSTEM_PATH_DIRS].filter(Boolean);
  return parts.join(path.delimiter);
}

export function sanitizeManagedChildEnvironment(parent: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  for (const key of MANAGED_CHILD_ENV_SCRUB_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    for (const prefix of MANAGED_CHILD_ENV_SCRUB_PREFIXES) {
      if (key.startsWith(prefix)) { delete env[key]; break; }
    }
  }
  for (const key of MANAGED_CHILD_ENV_SCRUB_XDG_SHIM_KEYS) delete env[key];
  return env;
}

export function managedChildEnvScrubEvidence(parent: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): { removed: string[]; pinned: { toolchainState: string; sdkDiagnostics: string; candidateIdentity: string; entryExplicit: string } } {
  const record = parent as Record<string, unknown>;
  const removedExact = (MANAGED_CHILD_ENV_SCRUB_KEYS as readonly string[]).filter((key) => record[key] !== undefined);
  const removedPrefix = Object.keys(record).filter((key) => (MANAGED_CHILD_ENV_SCRUB_PREFIXES as readonly string[]).some((prefix) => key.startsWith(prefix)));
  const removedXdg = (MANAGED_CHILD_ENV_SCRUB_XDG_SHIM_KEYS as readonly string[]).filter((key) => record[key] !== undefined);
  return {
    removed: [...removedExact, ...removedPrefix, ...removedXdg],
    pinned: {
      toolchainState: ".harness/toolchain.state.json",
      sdkDiagnostics: "resolvePaseoSdkFromCli.diagnostics",
      candidateIdentity: "dist/releases/<id>/build-identity.json",
      entryExplicit: "process.argv[1] (AEH_ENTRY_FILE stripped fail-closed)",
    },
  };
}

export interface ProcessOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  toolchain?: boolean;
  stdin?: string | Buffer;
  signal?: AbortSignal;
  /** Retain only the final N bytes per stream while hashing/counting the full output. */
  captureOutputLimitBytes?: number;
}

/** Execute one program with literal argv boundaries and no shell parsing. */
export async function runExecutable(
  executable: string,
  args: readonly string[],
  options: ProcessOptions
): Promise<ProcessResult> {
  return runChild(executable, [...args], false, options);
}

/** Execute an explicit shell program. Use only when shell syntax is required. */
export async function runShell(
  command: string,
  options: ProcessOptions
): Promise<ProcessResult> {
  return runChild(command, [], true, options);
}

async function runChild(
  command: string,
  args: string[],
  shell: boolean,
  options: ProcessOptions
): Promise<ProcessResult> {
  const started = Date.now();
  const inherited = sanitizeManagedChildEnvironment({ ...process.env, ...(options.env ?? {}) });
  // Controller identity is authoritative only inside the controller/AEH
  // process itself. Never leak it into arbitrary shell commands such as
  // npm test, whose explicit repository root must remain authoritative.
  // The managed-agent envelope is authoritative only inside the process that
  // owns it. Repository commands and tools must not inherit it: otherwise a
  // bounded child can be mistaken for an AEH participant and re-enter the
  // controller, or observe another operation's routing state.
  // Canonical scrub: MANAGED_CHILD_ENV_SCRUB_KEYS plus MISE_* and ASDF_*
  // prefixes plus XDG shim keys (single source; fixture shares it). PATH for
  // managed children is hermetic ALWAYS: pinned prefix + explicit extra +
  // minimal when state and/or explicit marking exists, minimal ONLY when both
  // are missing (no ambient tail, not even filtered). Missing pinned and
  // unmarked ambient-only tools fail VISIBLY (ENOENT carries the `aeh setup`
  // direction when neither prefix nor explicit marking exists; shell 127s
  // surface unmodified); stale state migrates via `aeh setup`, CI ambient
  // mise shapes migrate via AEH_TOOLCHAIN_EXTRA_BIN_PATHS explicit marking.
  // NODE_PATH and MISE_* and related shim vars stripped.
  let toolchainPrefixMissing = false;
  if (options.toolchain !== false) {
    const prefix = await toolchainPathPrefix(options.cwd);
    // Hermetic: ignore ambient AND explicit PATH tails (fail-closed, no silent
    // ambient). Only AEH_TOOLCHAIN_EXTRA_BIN_PATHS explicit marking is honored
    // beyond the pinned prefix. See HERMITIC_SYSTEM_PATH_DIRS breakage docs above.
    const explicit = explicitExtraBinPaths(inherited);
    inherited.PATH = buildHermeticChildPath(prefix, explicit);
    toolchainPrefixMissing = !prefix && explicit.length === 0;
  } else {
    // toolchain:false (mise internal, container pulls, explicit-PATH setup):
    // keep ambient/explicit PATH to locate `mise` itself, but ambient MISE_*
    // and related shim vars stay scrubbed; only explicit options.env MISE_*
    // and ASDF_* are re-allowed (required for MISE_PIPX_UVX and MISE_PYPI_UVX
    // in `mise lock --bump`).
    const explicit = options.env ?? {};
    for (const key of Object.keys(explicit)) {
      if ((MANAGED_CHILD_ENV_SCRUB_PREFIXES as readonly string[]).some((prefix) => key.startsWith(prefix))) {
        const value = explicit[key];
        if (value === undefined) delete inherited[key];
        else inherited[key] = value;
      }
    }
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell,
      env: inherited,
      detached: process.platform !== "win32",
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });

    const stdout = new BoundedOutput(options.captureOutputLimitBytes);
    const stderr = new BoundedOutput(options.captureOutputLimitBytes);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    if (options.stdin !== undefined) {
      child.stdin?.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
      child.stdin?.end(options.stdin);
    }

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let forceSettleTimer: NodeJS.Timeout | undefined;
    let terminated = false;
    let timedOut = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let unregister: () => Promise<void> = async () => undefined;
    const registered = registerManagedProcessHandle(child.pid);
    void registered.then((cleanup) => {
      unregister = cleanup;
      if (settled) void unregister();
    });
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* process already exited */ }
    };
    const terminate = (): void => {
      if (terminated) return;
      terminated = true;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 250);
      killTimer.unref();
      forceSettleTimer = setTimeout(() => finish(exitCode ?? 124, exitSignal ?? "SIGKILL", true), 1_000);
      forceSettleTimer.unref();
    };
    if (options.timeoutMs) timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
    const onAbort = (): void => terminate();
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      options.signal?.removeEventListener("abort", onAbort);
      void unregister().finally(() => reject(missingToolchainError(error, options, toolchainPrefixMissing)));
    });
    child.on("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      if (!settled && !forceSettleTimer) {
        forceSettleTimer = setTimeout(() => finish(code ?? 1, signal, false), 1_000);
        forceSettleTimer.unref();
      }
    });
    child.on("close", (code: number | null) => {
      finish(code ?? exitCode ?? 1, exitSignal, false);
    });

    function finish(code: number, signal: NodeJS.Signals | null, forced: boolean): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (forced || !exited) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
      }
      void unregister().finally(() => resolve({
        exitCode: code,
        stdout: stdout.text(),
        stderr: stderr.text(),
        durationMs: Date.now() - started,
        stdoutDigest: stdout.digest(),
        stderrDigest: stderr.digest(),
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        timedOut
      }));
    }
  });
}

/**
 * Fail VISIBLE when pinned tools are unavailable (DETERMINISTIC).
 *
 * A managed child (toolchain !== false) whose working directory has no pinned
 * prefix and no explicitly-marked extra bin paths runs with minimal system
 * dirs only. When the OS cannot spawn the executable at all (ENOENT:
 * ambient-only tool, mise install, or stub with neither state nor explicit
 * marking), surface an explicit error directing to `aeh setup` (or explicit
 * CI marking via AEH_TOOLCHAIN_EXTRA_BIN_PATHS) instead of a bare spawn
 * ENOENT. All other errors pass through unmodified; shell 127s
 * (command-not-found inside sh) already fail visibly via exit code.
 */
function missingToolchainError(error: unknown, options: ProcessOptions, prefixMissing: boolean): unknown {
  if (!prefixMissing || options.toolchain === false) return error;
  if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message} (AEH_TOOLCHAIN_NOT_CONFIGURED: no pinned toolchain prefix nor AEH_TOOLCHAIN_EXTRA_BIN_PATHS marking for '${options.cwd}', so the managed PATH is minimal system dirs only with no ambient fallback. Run \`aeh setup\` to generate .harness/toolchain.state.json (or explicitly mark CI mise bins via AEH_TOOLCHAIN_EXTRA_BIN_PATHS), then retry.)`);
}

class BoundedOutput {
  private readonly hash = createHash("sha256");
  private chunks: Buffer[] = [];
  private retainedBytes = 0;
  bytes = 0;

  constructor(private readonly limit?: number) {}

  push(chunk: Buffer): void {
    this.hash.update(chunk);
    this.bytes += chunk.byteLength;
    if (this.limit === undefined || !Number.isFinite(this.limit) || this.limit < 0) {
      this.chunks.push(Buffer.from(chunk));
      this.retainedBytes += chunk.byteLength;
      return;
    }
    const max = Math.floor(this.limit);
    if (max === 0) return;
    const value = chunk.byteLength > max ? chunk.subarray(chunk.byteLength - max) : chunk;
    this.chunks.push(Buffer.from(value));
    this.retainedBytes += value.byteLength;
    while (this.retainedBytes > max && this.chunks.length) {
      const excess = this.retainedBytes - max;
      const first = this.chunks[0]!;
      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.retainedBytes -= first.byteLength;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.retainedBytes -= excess;
      }
    }
  }

  text(): string { return Buffer.concat(this.chunks).toString("utf8"); }
  digest(): string { return this.hash.copy().digest("hex"); }
}

export async function listManagedProcessHandles(root: string, operationId: string): Promise<ManagedProcessHandle[]> {
  const directory = managedProcessDirectory(root, operationId);
  let entries: string[];
  try { entries = await fs.readdir(directory); } catch { return []; }
  const handles: ManagedProcessHandle[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const value = JSON.parse(await fs.readFile(path.join(directory, entry), "utf8")) as Partial<ManagedProcessHandle>;
      if (Number.isInteger(value.pid) && Number(value.pid) > 0) {
        handles.push({ pid: Number(value.pid), processGroupId: Number.isInteger(value.processGroupId) && Number(value.processGroupId) > 0 ? Number(value.processGroupId) : Number(value.pid) });
      }
    } catch { /* stale or partially-written handle */ }
  }
  return handles;
}

export async function clearManagedProcessHandles(root: string, operationId: string): Promise<void> {
  await fs.rm(managedProcessDirectory(root, operationId), { recursive: true, force: true }).catch(() => undefined);
}

export async function terminateManagedProcessGroup(pid: number, graceMs = 250): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  const signal = (value: NodeJS.Signals): void => {
    try {
      if (process.platform !== "win32") {
        try { process.kill(-pid, value); }
        catch { process.kill(pid, value); }
      } else process.kill(pid, value);
    } catch { /* process already exited */ }
  };
  signal("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  signal("SIGKILL");
}

export async function registerManagedProcessHandle(pid: number | undefined): Promise<() => Promise<void>> {
  const operationId = process.env.AEH_OPERATION_ID?.trim();
  const controlRoot = process.env.AEH_CONTROL_ROOT?.trim();
  if (!pid || !operationId || !controlRoot || process.env.AEH_OPERATION_STATE_REDIRECT !== "1") return async () => undefined;
  const directory = managedProcessDirectory(controlRoot, operationId);
  const file = path.join(directory, `${pid}.json`);
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ pid, processGroupId: pid, startedAt: new Date().toISOString() })}\n`, { flag: "wx" });
    return async () => { await fs.rm(file, { force: true }).catch(() => undefined); };
  } catch {
    return async () => undefined;
  }
}

function managedProcessDirectory(root: string, operationId: string): string {
  const safeOperationId = operationId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.resolve(root, ".harness", "operations", `${safeOperationId}.processes`);
}

export async function commandExists(command: string, cwd: string): Promise<boolean> {
  return (await resolveExecutable(command, cwd)) !== undefined;
}

export async function resolveExecutable(command: string, cwd: string): Promise<string | undefined> {
  if (!command.trim()) return undefined;
  const directPath = path.isAbsolute(command) || command.includes(path.sep) || (path.sep === "/" && command.includes("\\"));
  const prefix = await toolchainPathPrefix(cwd);
  // Hermetic always: pinned prefix + explicit extra + minimal when state and/or
  // explicit marking exists, minimal ONLY when both are missing (no ambient
  // tail, not even filtered). Unmarked ambient-only executables (decoy shims,
  // host farms, unmarked mise installs, ~/.local/bin, temp-dir stubs) do NOT
  // resolve: callers surface missing-tool errors visibly instead of silently
  // running an unpinned binary. Migration: run `aeh setup` for pinned state,
  // or explicitly mark CI mise bins via AEH_TOOLCHAIN_EXTRA_BIN_PATHS.
  const explicit = explicitExtraBinPaths();
  const searchPath = buildHermeticChildPath(prefix, explicit);
  const directories = directPath ? [path.dirname(path.resolve(cwd, command))] : searchPath.split(path.delimiter).filter(Boolean);
  const baseName = directPath ? path.basename(command) : command;
  const extensions = process.platform === "win32"
    ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)]
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, baseName + extension);
      try {
        await fs.access(candidate, process.platform === "win32" ? undefined : fs.constants.X_OK);
        return candidate;
      } catch { /* try the next executable path */ }
    }
  }
  return undefined;
}

async function toolchainPathPrefix(cwd: string): Promise<string | undefined> {
  const key = path.resolve(cwd); if (toolchainPathCache.has(key)) return toolchainPathCache.get(key);
  const roots = await candidateRoots(key);
  for (const root of roots) {
    try {
      const state = JSON.parse(await fs.readFile(path.join(root, ".harness", "toolchain.state.json"), "utf8")) as { binPaths?: string[] };
      const valid: string[] = [];
      for (const item of state.binPaths ?? []) { try { await fs.access(item); valid.push(item); } catch { /* stale machine-local path */ } }
      const prefix = valid.length ? valid.join(path.delimiter) : undefined; toolchainPathCache.set(key, prefix); return prefix;
    } catch { /* try another root */ }
  }
  toolchainPathCache.set(key, undefined); return undefined;
}

async function candidateRoots(start: string): Promise<string[]> {
  const roots: string[] = []; let current = start;
  while (true) {
    roots.push(current);
    const gitFile = path.join(current, ".git");
    try {
      const stat = await fs.stat(gitFile);
      if (stat.isFile()) {
        const value = await fs.readFile(gitFile, "utf8"); const gitDir = value.match(/^gitdir:\s*(.+)\s*$/m)?.[1];
        if (gitDir) {
          const absolute = path.resolve(current, gitDir); const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`; const index = absolute.indexOf(marker);
          if (index >= 0) roots.push(absolute.slice(0, index));
        }
      }
    } catch { /* not a worktree root */ }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return [...new Set(roots)];
}
