import type { HarnessProjectConfig } from "../core/types.js";
import { commandExists, runProcess } from "../utils/process.js";
import { loadToolchainConfig, loadToolchainLock, loadToolchainState } from "./config.js";
import { resolveToolchain } from "./resolve.js";

export interface ToolchainDoctorResult { component: string; required: boolean; ok: boolean; message: string; }

export async function runToolchainDoctor(root: string, project: HarnessProjectConfig): Promise<ToolchainDoctorResult[]> {
  let toolchain;
  try { toolchain = await loadToolchainConfig(root, project); }
  catch { return [{ component: "toolchain", required: true, ok: false, message: "Toolchain config is missing or invalid; run aeh init or inspect .harness/toolchain.yaml." }]; }
  const lock = await loadToolchainLock(root, project, toolchain); const state = await loadToolchainState(root, project, toolchain);
  const resolved = await resolveToolchain(root, project, toolchain, { containerAvailable: await commandExists(toolchain.strategy?.containerEngine ?? "podman", root) });
  const results: ToolchainDoctorResult[] = [];
  results.push({ component: "toolchain-lock", required: true, ok: Boolean(lock), message: lock ? `Resolved toolchain lock profile=${lock.profile}.` : "No resolved toolchain lock; run aeh setup." });
  results.push({ component: "toolchain-state", required: true, ok: Boolean(state), message: state ? `${state.binPaths.length} provisioned bin path(s) active.` : "No machine-local toolchain state; run aeh setup." });

  for (const tool of resolved.tools) {
    const locked = lock?.tools[tool.name];
    const available = await commandExists(tool.command, root);
    const expected = locked?.resolvedVersion;
    const actual = available ? await exactToolVersion(root, tool.command, locked?.provisioning, state?.manager.command) : undefined;
    const versionOk = !expected || !actual || normalizeVersion(actual) === normalizeVersion(expected);
    const ok = Boolean(locked) && available && versionOk;
    const reasons: string[] = [];
    if (!locked) reasons.push("not present in toolchain lock");
    if (!available) reasons.push("command missing from reconciled PATH");
    if (available && expected && actual && !versionOk) reasons.push(`version drift locked=${expected} actual=${actual}`);
    results.push({
      component: `toolchain:${tool.name}`,
      required: tool.required ?? true,
      ok,
      message: ok
        ? `${tool.command} compliant; provisioning=${locked!.provisioning}${expected ? `; locked=${expected}` : ""}${locked?.digestRef ? `; digest=${locked.digestRef}` : ""}.`
        : `${tool.command} non-compliant (${reasons.join("; ") || "version could not be verified"}); selected by ${tool.selectedBy.join(", ")}.`
    });
  }
  return results;
}

async function exactToolVersion(root: string, command: string, provisioning: string | undefined, managerCommand: string | undefined): Promise<string | undefined> {
  if (provisioning === "mise" && managerCommand) {
    const result = await runProcess(`${managerCommand} which ${shell(command)} --version`, { cwd: root, timeoutMs: 30_000, toolchain: false });
    if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  if (provisioning === "container") return undefined;
  const result = await runProcess(`${command} --version`, { cwd: root, timeoutMs: 15_000 });
  return result.exitCode === 0 ? (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim() : undefined;
}
function normalizeVersion(value: string): string { return value.trim().replace(/^v/, "").replace(/^.*?((?:\d{4}|\d+)\.\d+(?:\.\d+)?).*$/, "$1"); }
function shell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
