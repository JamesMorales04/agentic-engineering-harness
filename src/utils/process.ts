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
  /**
   * Raw stdout bytes (no UTF-8 decode). Present only when the caller opted in
   * via `ProcessOptions.rawStdout`. Callers hashing content that may not be
   * valid UTF-8 (e.g. `git show` blob bytes) must use this buffer: `stdout`
   * decodes with replacement characters and re-encoding it hashes different
   * bytes. When `captureOutputLimitBytes` truncates retention, this buffer is
   * truncated to the retained tail the same way `stdout` is.
   */
  stdoutBuffer?: Buffer;
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
 * all MISE_* and ASDF_* shim configuration, XDG shim-directory overrides,
 * and AEH_TOOLCHAIN_EXTRA_BIN_PATHS (controller-input-only; never from
 * merged per-turn env).
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
 * - AEH_TOOLCHAIN_EXTRA_BIN_PATHS: controller-input-only extra bins. Scrubbed
 *   so a model-influenced merged parent env (options.env + live process.env)
 *   can never inject absolute shim dirs. The only inflow is explicit
 *   ProcessOptions.toolchainExtraBinPaths from the operation controller's
 *   startup-resolved config (outer trusted env read once, or project config),
 *   plus the frozen startup snapshot for static/CI contexts. Never per-turn env.
 *
 * PATH is hermetic (no ambient tail, not even filtered): managed children
 * (toolchain !== false) get `pinned prefix + explicit extra + minimal system
 * dirs` when `.harness/toolchain.state.json` exists and/or controller-supplied
 * extra bins exist, and minimal system dirs ONLY when both are missing.
 * Ambient PATH is never consulted:
 * mise-provisioned tools, `~/.local/bin`, `/opt/homebrew/bin`, temp-dir test
 * stubs, and every other ambient-only directory do NOT resolve in the
 * missing-state-and-unmarked case. Explicit marking is controller-input-only:
 * only absolute dirs supplied via ProcessOptions.toolchainExtraBinPaths (or
 * the frozen controller startup snapshot fed from outer trusted env) are
 * honored beyond the pinned prefix (CI mise bin-paths + ~/.local/bin +
 * npm-global/cosign dirs flow outer trusted env -> controller startup ->
 * options). Merged per-turn env (options.env + live process.env) never flows.
 * The pinned prefix comes from
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
  "AEH_TOOLCHAIN_EXTRA_BIN_PATHS",
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
 * Explicitly-marked extra toolchain bin paths (DETERMINISTIC, controller-input-only).
 *
 * CI provider jobs (full-stack-contract, provider-contracts, supply-chain)
 * provision real providers via ambient `mise bin-paths >> GITHUB_PATH` plus
 * `~/.local/bin` (uv tools) and npm-global/cosign dirs, without running
 * `aeh setup` and without a `.harness/toolchain.state.json` under isolated
 * temp-dir fixture roots. Hermetic blocks silent ambient, so those jobs fail
 * with reconciled-PATH misses. This allowlist restores them explicitly, but
 * ONLY as controller input:
 *
 *   outer trusted env (CI GITHUB_ENV exports) -> controller startup (trusted
 *   context, read once) -> ProcessOptions.toolchainExtraBinPaths (or the frozen
 *   startup snapshot below for static contexts) -> hermetic PATH.
 *
 * Per-turn env is NEVER trusted: AEH_TOOLCHAIN_EXTRA_BIN_PATHS is in the
 * canonical SCRUB list, so merged `process.env + options.env` never flows to
 * managed children. Only absolute dirs are honored; unlisted ambient dirs
 * (decoy shims, host farms) stay blocked. Unset/empty preserves fail-closed
 * minimal-only behavior.
 */
export const AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV = "AEH_TOOLCHAIN_EXTRA_BIN_PATHS";

/**
 * Parse a trusted controller startup env record (DETERMINISTIC).
 *
 * TRUST BOUNDARY: call ONLY with the controller's own startup-resolved env
 * (outer trusted env read once in trusted context, or project config derived
 * input). NEVER call with merged per-turn env (`{...process.env, ...options.env}`,
 * sanitized `inherited`, or live `process.env` at call time): that path lets a
 * model-influenced env inject absolute shim dirs. runChild/resolveExecutable
 * never call this on untrusted env; they use explicit options or the frozen
 * startup snapshot.
 */
export function explicitExtraBinPaths(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string[] {
  const raw = (env as Record<string, unknown>)[AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV];
  return normalizeControllerExtraBinPaths(typeof raw === "string" ? raw : undefined);
}

/** Normalize explicit controller extra-bin input (absolute-only, deduped). */
export function normalizeControllerExtraBinPaths(value: readonly string[] | string | undefined): string[] {
  if (value === undefined) return [];
  const parts = typeof value === "string" ? value.split(path.delimiter) : value;
  const seen = new Set<string>();
  for (const part of parts) {
    const trimmed = String(part).trim();
    if (!trimmed || !path.isAbsolute(trimmed)) continue;
    const normalized = path.normalize(trimmed);
    if (!seen.has(normalized)) seen.add(normalized);
  }
  return [...seen];
}

/**
 * Frozen controller startup snapshot (DETERMINISTIC).
 *
 * Captured once at module load from the outer trusted env, before any
 * per-turn model-influenced mutation. This is the static/CI inflow that keeps
 * `.github/workflows/ci.yml` GITHUB_ENV exports working: the CI controller
 * process starts with AEH_TOOLCHAIN_EXTRA_BIN_PATHS set, the snapshot freezes
 * it, and runChild/resolveExecutable fall back to it when the caller does not
 * supply explicit `toolchainExtraBinPaths`. Live `process.env` mutations and
 * `options.env` values after startup are ignored.
 */
const CONTROLLER_STARTUP_EXTRA_BIN_PATHS: readonly string[] = Object.freeze(
  normalizeControllerExtraBinPaths(
    typeof process.env[AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV] === "string"
      ? process.env[AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV]
      : undefined,
  ),
);

/** Read-only accessor for the frozen controller startup extra bins. */
export function controllerStartupExtraBinPaths(): readonly string[] {
  return CONTROLLER_STARTUP_EXTRA_BIN_PATHS;
}

/**
 * Resolve trusted outer env -> controller options input (DETERMINISTIC).
 *
 * Helper for the operation controller (and tests simulating it): parse a
 * trusted startup env record once, then thread the result via
 * `ProcessOptions.toolchainExtraBinPaths`. Never pass per-turn merged env here.
 */
export function resolveControllerExtraBinPaths(
  trustedEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string[] {
  return explicitExtraBinPaths(trustedEnv);
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
  /**
   * Retain the raw stdout bytes (no UTF-8 decode/re-encode round-trip) on
   * `ProcessResult.stdoutBuffer`. Required for hashing content that may not
   * be valid UTF-8: `stdout` decodes with replacement characters, so a raw
   * byte such as 0xFF hashes like the valid UTF-8 U+FFFD sequence when read
   * back from `stdout`. Binary callers must hash `stdoutBuffer`, never
   * `Buffer.from(stdout, "utf8")`.
   */
  rawStdout?: boolean;
  /**
   * Controller-input-only extra toolchain bin dirs (DETERMINISTIC).
   *
   * The operation controller supplies this from its startup-resolved config
   * (outer trusted env read once, or project config), never from per-turn
   * env. `options.env[AEH_TOOLCHAIN_EXTRA_BIN_PATHS]` is scrubbed and ignored:
   * a model-influenced env cannot inject shim dirs. When omitted, the frozen
   * controller startup snapshot applies (keeps CI GITHUB_ENV exports working).
   */
  toolchainExtraBinPaths?: readonly string[] | string;
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
  // prefixes plus XDG shim keys plus AEH_TOOLCHAIN_EXTRA_BIN_PATHS (single
  // source; fixture shares it). PATH for managed children is hermetic ALWAYS:
  // pinned prefix + controller-supplied extra + minimal when state and/or
  // controller extra exists, minimal ONLY when both are missing (no ambient
  // tail, not even filtered). Missing pinned and unmarked ambient-only tools
  // fail VISIBLY (ENOENT carries the `aeh setup` direction when neither prefix
  // nor controller extra exists; shell 127s surface unmodified); stale state
  // migrates via `aeh setup`, CI ambient mise shapes flow outer trusted env ->
  // controller startup -> options/snapshot, never per-turn env.
  // NODE_PATH and MISE_* and related shim vars stripped.
  let toolchainPrefixMissing = false;
  if (options.toolchain !== false) {
    const prefix = await toolchainPathPrefix(options.cwd);
    // Hermetic: ignore ambient AND explicit PATH tails AND merged per-turn
    // AEH_TOOLCHAIN_EXTRA_BIN_PATHS (scrubbed above, fail-closed). Only
    // controller input is honored: explicit options.toolchainExtraBinPaths,
    // else the frozen controller startup snapshot. See trust docs above.
    const explicit = normalizeControllerExtraBinPaths(
      options.toolchainExtraBinPaths ?? controllerStartupExtraBinPaths(),
    );
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
    // Reified registration outcome. finish() is the SOLE settler and awaits
    // this before reporting anything, so a failed registration can never lose
    // a race to a normal resolve (the close→finish path cannot slip in during
    // a kill+verify window). The rejection callback below only starts killing
    // immediately (finish may never fire without it); it never settles.
    let resolveRegistrationOutcome: (outcome: { cleanup?: () => Promise<void>; error?: unknown }) => void = () => undefined;
    const registrationOutcome = new Promise<{ cleanup?: () => Promise<void>; error?: unknown }>((resolve) => { resolveRegistrationOutcome = resolve; });
    void registered.then(
      (cleanup) => {
        unregister = cleanup;
        if (settled) void unregister();
        resolveRegistrationOutcome({ cleanup });
      },
      (error) => {
        resolveRegistrationOutcome({ error });
        // Registration persistence failed: never leave a live-but-unregistered
        // (unfenced) child. Start the SIGKILL arrangement UNCONDITIONALLY and
        // immediately — output may already have force-settled while the child
        // is still live. finish() performs the verified settle below.
          // CONFIRMED KILL: delivery is best-effort — death is VERIFIED with a
          // bounded GROUP poll there; a still-live group rejects as ORPHAN_UNKILLABLE.
          void (async () => {
            killProcessGroupBestEffort(child, "SIGKILL");
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.stdin?.destroy();
            await verifyProcessGroupExit(child.pid, 500);
          })().catch(() => undefined);
      }
    );
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
      // Sole settler: the registration outcome is awaited first so a failed
      // registration deterministically rejects (kill+verify, ORPHAN_UNKILLABLE
      // when the child survives) instead of racing a normal resolve.
      void (async () => {
        const outcome = await registrationOutcome;
        if (outcome.error !== undefined) {
          killProcessGroupBestEffort(child, "SIGKILL");
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.stdin?.destroy();
          const dead = await verifyProcessGroupExit(child.pid, 500);
          if (!dead) {
            reject(orphanUnkillableError(
              child.pid!,
              `registration persistence failed for operation ${process.env.AEH_OPERATION_ID ?? "unknown"} and SIGKILL could not be verified`,
              outcome.error
            ));
            return;
          }
          reject(outcome.error);
          return;
        }
        if (!exited) {
          // CONFIRMED KILL: the child may still be live (forced settle or no
          // exit observed). SIGKILL best-effort runs unconditionally, then
          // GROUP death is VERIFIED with a bounded poll before the output is
          // reported: the signal went to the whole group, so a leader-only
          // probe would pass while a descendant survives and lose the
          // durable handle for an unfenced live process. A still-live group
          // rejects with ORPHAN_UNKILLABLE (never silent
          // success); the reported output is attached for diagnosis. The handle
          // stays registered until death is proven (unregister runs after the
          // verdict), so a live group is never unfenced-and-reported-dead.
          killProcessGroupBestEffort(child, "SIGKILL");
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.stdin?.destroy();
          const dead = await verifyProcessGroupExit(child.pid, 500);
          if (!dead) {
            const output = {
              exitCode: code,
              stdout: stdout.text(),
              stderr: stderr.text(),
              durationMs: Date.now() - started,
              stdoutDigest: stdout.digest(),
              stderrDigest: stderr.digest(),
              stdoutBytes: stdout.bytes,
              stderrBytes: stderr.bytes,
              timedOut
            };
            const orphan = orphanUnkillableError(
              child.pid!,
              `force-settled output could not prove child death (exit ${code}${signal ? ` via ${signal}` : ""})`
            );
            Object.assign(orphan, { output });
            reject(orphan);
            return;
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
            timedOut,
            ...(options.rawStdout ? { stdoutBuffer: stdout.buffer() } : {})
          }));
          return;
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        void unregister().finally(() => resolve({
          exitCode: code,
          stdout: stdout.text(),
          stderr: stderr.text(),
          durationMs: Date.now() - started,
          stdoutDigest: stdout.digest(),
          stderrDigest: stderr.digest(),
          stdoutBytes: stdout.bytes,
          stderrBytes: stderr.bytes,
          timedOut,
          ...(options.rawStdout ? { stdoutBuffer: stdout.buffer() } : {})
        }));
      })().catch(() => undefined);
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
  /** Raw retained bytes (no UTF-8 decode); truncated to the retained tail when a limit is set. */
  buffer(): Buffer { return Buffer.concat(this.chunks); }
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

/**
 * Strict managed-process handle pid listing for sibling-ownership fencing.
 * MECHANISM: DETERMINISTIC gate. Unlike listManagedProcessHandles (which serves
 * this operation's own best-effort cleanup), an unreadable or unprovable
 * sibling handle file cannot be skipped: skipping would shrink the exclusion
 * set and re-open cross-kill on pid reuse. A missing handles directory proves
 * "no handles" (empty); any other listing failure, unreadable file, or file
 * that does not name a provable positive pid THROWS so the caller fails closed.
 */
export async function listManagedProcessHandlePidsStrict(root: string, operationId: string): Promise<number[]> {
  const directory = managedProcessDirectory(root, operationId);
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    let value: Partial<ManagedProcessHandle>;
    try {
      value = JSON.parse(await fs.readFile(path.join(directory, entry), "utf8")) as Partial<ManagedProcessHandle>;
    } catch (error) {
      throw new Error(`managed-process handle ${entry} for operation ${operationId} is unreadable and sibling ownership cannot be proven: ${String(error)}`);
    }
    const pid = Number(value.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`managed-process handle ${entry} for operation ${operationId} does not name a provable pid and sibling ownership cannot be proven`);
    }
    pids.push(pid);
    const processGroupId = Number(value.processGroupId);
    if (Number.isInteger(processGroupId) && processGroupId > 0) pids.push(processGroupId);
  }
  return pids;
}

export async function clearManagedProcessHandles(root: string, operationId: string): Promise<void> {
  // Fail LOUD (Luna durable-handoff): a failed clear must propagate
  // (throw) so the terminal hook and recovery reconciliation observe it.
  // Callers that tolerate best-effort cleanup report explicitly; no silent
  // swallow here — a swallowed failure reads as "no workers" while live
  // workers exist and re-opens cross-kill on pid reuse.
  await fs.rm(managedProcessDirectory(root, operationId), { recursive: true, force: true });
}

/**
 * Bounded death verification for confirmed kill (Luna confirmed-kill).
 * MECHANISM: DETERMINISTIC. Polls kill(pid, 0) until ESRCH (proven dead) or
 * the bounded budget expires. Only ESRCH proves death; any other outcome
 * (alive, EPERM, unknown) counts as still-live. Never signals.
 */
export async function verifyProcessExit(pid: number | undefined, timeoutMs = 500): Promise<boolean> {
  if (!Number.isInteger(pid) || (pid as number) <= 0 || (pid as number) === process.pid) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try {
      process.kill(pid as number, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Bounded GROUP death verification for confirmed kill (Luna B1).
 * MECHANISM: DETERMINISTIC. Termination signals the whole process group
 * (kill(-pgid)), so death must be proven at group scope: only ESRCH on BOTH
 * the group probe (kill(-pid, 0)) and the leader probe (kill(pid, 0)) proves
 * death. A leader that exits while a same-group descendant survives passes a
 * leader-only probe and would lose its durable handle -> unfenced live
 * process. Any other outcome (alive, EPERM, unknown) counts as still-live
 * until the bounded budget expires. Never signals. Win32 has no process
 * groups and falls back to the leader probe.
 */
export async function verifyProcessGroupExit(pid: number | undefined, timeoutMs = 500): Promise<boolean> {
  if (!Number.isInteger(pid) || (pid as number) <= 0 || (pid as number) === process.pid) return true;
  if (process.platform === "win32") return verifyProcessExit(pid, timeoutMs);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (isProcessGroupDead(pid as number)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Dead only when neither the group nor the leader answers the probe. */
function isProcessGroupDead(pid: number): boolean {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") return false;
    try {
      process.kill(pid, 0);
    } catch (leaderError) {
      return (leaderError as NodeJS.ErrnoException)?.code === "ESRCH";
    }
    return false;
  }
  return false;
}

/**
 * Fencing error for a process that survived SIGKILL + bounded verification.
 * Carries the explicit ORPHAN_UNKILLABLE record (code + pid + reason) so the
 * unfenced orphan is never a silent success.
 */
export function orphanUnkillableError(pid: number, reason: string, cause?: unknown): Error {
  const failure = new Error(
    `AEH_ORPHAN_UNKILLABLE: managed child process group ${pid} remains live after SIGKILL and bounded death verification (${reason}); it is an unfenced orphan; operator intervention required.`
  );
  Object.assign(failure, { code: "AEH_ORPHAN_UNKILLABLE", pid, reason });
  if (cause !== undefined) (failure as { cause?: unknown }).cause = cause;
  return failure;
}

/**
 * Best-effort SIGKILL of a process group plus the direct child. Every attempt
 * is swallowed: delivery success is decided ONLY by verifyProcessGroupExit, never
 * by the absence of a throw here.
 */
function killProcessGroupBestEffort(child: { pid?: number; kill: (signal: NodeJS.Signals) => unknown }, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* already exited or undeliverable; verification decides */ }
  try { child.kill(signal); } catch { /* already exited or undeliverable */ }
}

/**
 * Signal a managed process group with honest delivery confirmation.
 * MECHANISM: DETERMINISTIC. Resolves ONLY when at least one kill() call
 * succeeded (signal delivery confirmed). When no signal could be delivered
 * because the target is already gone, rejects with a code-ESRCH error (the
 * caller records already-dead, never signaled). When the target is alive but
 * no signal could be delivered (for example EPERM), rejects with the delivery
 * error preserving its code (the caller records failed, never signaled).
 * Callers must not record a pid as signaled from a swallowing terminator.
 */
export async function terminateManagedProcessGroup(pid: number, graceMs = 250): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  let delivered = false;
  let lastError: unknown;
  const attempt = (target: number, value: NodeJS.Signals): void => {
    try {
      process.kill(target, value);
      delivered = true;
    } catch (error) {
      lastError = error;
    }
  };
  const signal = (value: NodeJS.Signals): void => {
    if (process.platform !== "win32") {
      attempt(-pid, value);
      if (!delivered) attempt(pid, value);
    } else attempt(pid, value);
  };
  signal("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  signal("SIGKILL");
  if (delivered) return;
  // Neither SIGTERM nor SIGKILL was delivered. Distinguish honestly: an
  // already-gone target is already-dead (never signaled); a live target is a
  // delivery failure (never signaled).
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      throw Object.assign(
        new Error(`terminateManagedProcessGroup: process group ${pid} already exited (ESRCH); no signal was delivered`),
        { code: "ESRCH" }
      );
    }
  }
  const failure = new Error(`terminateManagedProcessGroup: signal delivery failed for process group ${pid}: ${String(lastError)}`);
  const code = (lastError as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code) Object.assign(failure, { code });
  throw failure;
}

export async function registerManagedProcessHandle(pid: number | undefined): Promise<() => Promise<void>> {
  const operationId = process.env.AEH_OPERATION_ID?.trim();
  const controlRoot = process.env.AEH_CONTROL_ROOT?.trim();
  if (!pid || !operationId || !controlRoot || process.env.AEH_OPERATION_STATE_REDIRECT !== "1") return async () => undefined;
  const directory = managedProcessDirectory(controlRoot, operationId);
  const file = path.join(directory, `${pid}.json`);
  // FAIL LOUDLY (Luna-b): an unpersisted live child is exactly what later
  // causes cross-kill ambiguity (empty handle dir reads as "no workers" while
  // live workers exist). Killing a bookkeeping-failed spawn is availability
  // cost, the correct safety choice over an unfenced live child. Callers must
  // best-effort STOP the just-spawned process and throw spawn failure; they
  // must never continue with a live-but-unregistered child.
  try {
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(file, `${JSON.stringify({ pid, processGroupId: pid, startedAt: new Date().toISOString() })}\n`, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      // Same-pid re-registration (pid reuse while a stale handle file lingers):
      // overwrite idempotently — the file names this pid either way.
      await fs.writeFile(file, `${JSON.stringify({ pid, processGroupId: pid, startedAt: new Date().toISOString() })}\n`);
    }
    return async () => { await fs.rm(file, { force: true }).catch(() => undefined); };
  } catch (error) {
    throw new Error(`AEH_MANAGED_PROCESS_HANDLE_REGISTER_FAILED: could not persist handle for pid ${pid} of operation ${operationId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function managedProcessDirectory(root: string, operationId: string): string {
  const safeOperationId = operationId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.resolve(root, ".harness", "operations", `${safeOperationId}.processes`);
}

export async function commandExists(
  command: string,
  cwd: string,
  options?: Pick<ProcessOptions, "toolchainExtraBinPaths">,
): Promise<boolean> {
  return (await resolveExecutable(command, cwd, options)) !== undefined;
}

export async function resolveExecutable(
  command: string,
  cwd: string,
  options?: Pick<ProcessOptions, "toolchainExtraBinPaths">,
): Promise<string | undefined> {
  if (!command.trim()) return undefined;
  const directPath = path.isAbsolute(command) || command.includes(path.sep) || (path.sep === "/" && command.includes("\\"));
  const prefix = await toolchainPathPrefix(cwd);
  // Hermetic always: pinned prefix + controller-supplied extra + minimal when
  // state and/or controller extra exists, minimal ONLY when both are missing
  // (no ambient tail, not even filtered). Unmarked ambient-only executables
  // (decoy shims, host farms, unmarked mise installs, ~/.local/bin, temp-dir
  // stubs) do NOT resolve: callers surface missing-tool errors visibly instead
  // of silently running an unpinned binary. Migration: run `aeh setup` for
  // pinned state, or supply controller extra bins via
  // ProcessOptions.toolchainExtraBinPaths (outer trusted env -> controller
  // startup -> options; never per-turn env).
  const explicit = normalizeControllerExtraBinPaths(
    options?.toolchainExtraBinPaths ?? controllerStartupExtraBinPaths(),
  );
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
