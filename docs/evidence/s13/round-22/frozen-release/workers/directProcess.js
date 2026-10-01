import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerManagedProcessHandle } from "../utils/process.js";
const SAFE_RUNTIME_ENVIRONMENT = ["PATH", "NODE_PATH", "LANG", "LC_ALL", "CI", "TERM"];
/**
 * Run a direct runtime with an explicit environment. Direct workers must not
 * inherit the controller's ambient credentials or user runtime configuration.
 */
export async function runDirectWorkerProcess(command, args, config, options) {
    const ownedHome = options.homeDirectory ? undefined : await createDirectWorkerHome(path.basename(command));
    const home = options.homeDirectory ?? ownedHome.directory;
    const environment = buildDirectWorkerEnvironment(config, options.environment, home);
    const started = Date.now();
    try {
        return await new Promise((resolve, reject) => {
            const child = spawn(command, [...args], {
                cwd: options.cwd,
                env: environment,
                shell: false,
                detached: process.platform !== "win32",
                stdio: ["ignore", "pipe", "pipe"]
            });
            let stdout = "";
            let stderr = "";
            let outputBytes = 0;
            let settled = false;
            let timer;
            let killTimer;
            let forceSettleTimer;
            let terminated = false;
            let timedOut = false;
            let outputLimit = false;
            let exited = false;
            let exitCode = null;
            let unregister = async () => undefined;
            const registered = registerManagedProcessHandle(child.pid);
            void registered.then((cleanup) => {
                unregister = cleanup;
                if (settled)
                    void unregister();
            });
            const kill = (signal) => {
                try {
                    if (process.platform !== "win32" && child.pid)
                        process.kill(-child.pid, signal);
                    else
                        child.kill(signal);
                }
                catch { /* process already exited */ }
            };
            const terminate = () => {
                if (terminated)
                    return;
                terminated = true;
                kill("SIGTERM");
                killTimer = setTimeout(() => kill("SIGKILL"), 250);
                killTimer.unref();
                forceSettleTimer = setTimeout(() => finish(124, true), 1_000);
                forceSettleTimer.unref();
            };
            const collect = (target, chunk) => {
                outputBytes += chunk.byteLength;
                if (options.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) {
                    outputLimit = true;
                    terminate();
                    return;
                }
                if (target === "stdout")
                    stdout += chunk.toString();
                else
                    stderr += chunk.toString();
            };
            child.stdout.on("data", (chunk) => collect("stdout", chunk));
            child.stderr.on("data", (chunk) => collect("stderr", chunk));
            timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
            child.once("error", (error) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                if (killTimer)
                    clearTimeout(killTimer);
                if (forceSettleTimer)
                    clearTimeout(forceSettleTimer);
                void unregister().finally(() => reject(error));
            });
            child.once("exit", (code) => {
                exited = true;
                exitCode = code;
                if (!settled && !forceSettleTimer) {
                    forceSettleTimer = setTimeout(() => finish(code ?? 1, false), 1_000);
                    forceSettleTimer.unref();
                }
            });
            child.once("close", (code) => {
                finish(code ?? exitCode ?? 1, false);
            });
            function finish(code, forced) {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                if (killTimer)
                    clearTimeout(killTimer);
                if (forceSettleTimer)
                    clearTimeout(forceSettleTimer);
                if (forced || !exited) {
                    child.stdout?.destroy();
                    child.stderr?.destroy();
                }
                void unregister().finally(() => resolve({ exitCode: outputLimit || timedOut ? 124 : code, stdout, stderr, durationMs: Date.now() - started }));
            }
        });
    }
    finally {
        if (ownedHome)
            await fs.rm(ownedHome.directory, { recursive: true, force: true });
    }
}
export async function createDirectWorkerHome(runtime) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-direct-home-"));
    await projectDirectProviderAuth(directory, runtime);
    return { directory };
}
/**
 * Project only the exact provider auth file the selected direct runtime needs into its ephemeral
 * controlled home, with 0600 permissions, mirroring the certified CodexAgentProvider boundary.
 * The same OS user's provider process reads its own credential; no credential is minted,
 * broadened, logged or shared, and the home is removed with the turn. A missing auth file is not
 * an error here: the provider reports unauthenticated startup through its own failure.
 */
export async function projectDirectProviderAuth(directory, runtime) {
    const hostHome = os.homedir();
    const codexHome = process.env.CODEX_HOME?.trim() || path.join(hostHome, ".codex");
    const openCodeData = process.env.XDG_DATA_HOME?.trim() || path.join(hostHome, ".local", "share");
    const targets = [];
    if (runtime === undefined || runtime === "codex")
        targets.push({ source: path.join(codexHome, "auth.json"), target: path.join(directory, ".codex", "auth.json") });
    if (runtime === undefined || runtime === "opencode")
        targets.push({ source: path.join(openCodeData, "opencode", "auth.json"), target: path.join(directory, ".local", "share", "opencode", "auth.json") });
    for (const entry of targets) {
        try {
            await fs.mkdir(path.dirname(entry.target), { recursive: true, mode: 0o700 });
            await fs.copyFile(entry.source, entry.target);
            await fs.chmod(entry.target, 0o600);
        }
        catch { /* absent auth file: the provider reports its own unauthenticated startup */ }
    }
}
export async function removeDirectWorkerHome(home) {
    if (home)
        await fs.rm(home.directory, { recursive: true, force: true });
}
export function buildDirectWorkerEnvironment(config, explicit = {}, controlledHome = "") {
    const sandbox = config.security?.sandbox;
    const allowlisted = new Set([
        ...SAFE_RUNTIME_ENVIRONMENT,
        ...(sandbox?.environmentAllowlist ?? []),
        ...(sandbox?.credentialEnvAllowlist ?? [])
    ]);
    const result = {};
    for (const name of allowlisted) {
        const value = process.env[name];
        if (value !== undefined)
            result[name] = value;
    }
    for (const [name, value] of Object.entries(explicit)) {
        if (value !== undefined)
            result[name] = value;
    }
    if (controlledHome) {
        result.HOME = controlledHome;
        result.XDG_CONFIG_HOME = path.join(controlledHome, ".config");
        result.XDG_CACHE_HOME = path.join(controlledHome, ".cache");
    }
    result.TMPDIR ??= os.tmpdir();
    return result;
}
//# sourceMappingURL=directProcess.js.map