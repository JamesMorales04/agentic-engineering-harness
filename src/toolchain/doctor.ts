import type { HarnessProjectConfig } from "../core/types.js";
import { commandExists, runProcess } from "../utils/process.js";
import { loadToolchainConfig, loadToolchainLock, loadToolchainState } from "./config.js";
import { resolveToolchain } from "./resolve.js";

export interface ToolchainDoctorResult { component: string; required: boolean; ok: boolean; message: string; }

export async function runToolchainDoctor(root: string, project: HarnessProjectConfig): Promise<ToolchainDoctorResult[]> {
  let toolchain;
  try { toolchain = await loadToolchainConfig(root, project); }
  catch { return [{ component: "toolchain", required: false, ok: false, message: "Toolchain config is missing or invalid; run aeh init or inspect .harness/toolchain.yaml." }]; }
  const lock = await loadToolchainLock(root, project, toolchain); const state = await loadToolchainState(root, project, toolchain);
  const resolved = await resolveToolchain(root, project, toolchain, { containerAvailable: await commandExists(toolchain.strategy?.containerEngine ?? "podman", root) });
  const results: ToolchainDoctorResult[] = [];
  results.push({ component: "toolchain-lock", required: false, ok: Boolean(lock), message: lock ? `Resolved toolchain lock profile=${lock.profile}.` : "No resolved toolchain lock; run aeh setup." });
  results.push({ component: "toolchain-state", required: false, ok: Boolean(state), message: state ? `${state.binPaths.length} provisioned bin path(s) active.` : "No machine-local toolchain state; run aeh setup." });
  for (const tool of resolved.tools) {
    const ok = await commandExists(tool.command, root); const expected = lock?.tools[tool.name]?.resolvedVersion;
    let actual: string | undefined;
    if (ok) { const version = await runProcess(`${tool.command} --version`, { cwd: root, timeoutMs: 15_000 }); if (version.exitCode === 0) actual = (version.stdout || version.stderr).split(/\r?\n/)[0]?.trim(); }
    results.push({ component: `toolchain:${tool.name}`, required: tool.required ?? false, ok, message: ok ? `${tool.command} available${expected ? `; locked=${expected}` : ""}${actual ? `; actual=${actual}` : ""}.` : `${tool.command} missing; selected by ${tool.selectedBy.join(", ")}.` });
  }
  return results;
}
