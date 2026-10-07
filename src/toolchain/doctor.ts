import type { HarnessProjectConfig } from "../core/types.js";
import { commandExists, runExecutable, runShell } from "../utils/process.js";
import { loadToolchainConfig, loadToolchainLock, loadToolchainState } from "./config.js";
import { resolveToolchain } from "./resolve.js";
import type { ResolvedToolchainTool, ToolchainLock } from "./types.js";
import {
  checkToolchainLockConsistency,
  findLatestVersionPins,
  findLatestVersionPinsInDefinitions,
  findUnpinnedActiveContainerImages,
  findUnpinnedImagesInDefinitions,
  loadMiseLockForDoctor,
  reportedVersionsEqual,
} from "./pinning.js";

export interface ToolchainDoctorResult {
  component: string;
  required: boolean;
  ok: boolean;
  message: string;
  scope?: "SUMMARY" | "INSTALLED_PROFILE" | "ACTIVE_PROJECT";
  state?: "COMPLIANT" | "MISSING" | "EXCLUDED" | "DRIFT" | "INVALID";
}

interface ToolHealth {
  ok: boolean;
  message: string;
  state: NonNullable<ToolchainDoctorResult["state"]>;
}

/**
 * Report the installed lock profile and the current active project needs as
 * separate checks. Named setup profiles can intentionally omit tools that the
 * project's auto-resolved requirements still need.
 */
export async function runToolchainDoctor(root: string, project: HarnessProjectConfig): Promise<ToolchainDoctorResult[]> {
  let toolchain;
  try {
    toolchain = await loadToolchainConfig(root, project);
  } catch {
    return [{ component: "toolchain", required: true, ok: false, scope: "SUMMARY", state: "INVALID", message: "Toolchain config is missing or invalid; run aeh init or inspect .harness/toolchain.yaml." }];
  }

  const lock = await loadToolchainLock(root, project, toolchain);
  const state = await loadToolchainState(root, project, toolchain);
  const containerAvailable = await commandExists(toolchain.strategy?.containerEngine ?? "podman", root);
  const results: ToolchainDoctorResult[] = [];
  results.push({
    component: "toolchain-lock",
    required: true,
    ok: Boolean(lock),
    scope: "SUMMARY",
    state: lock ? "COMPLIANT" : "MISSING",
    message: lock ? `Resolved toolchain lock profile=${lock.profile}.` : "No resolved toolchain lock; run aeh setup."
  });
  results.push({
    component: "toolchain-state",
    required: true,
    ok: Boolean(state),
    scope: "SUMMARY",
    state: state ? "COMPLIANT" : "MISSING",
    message: state ? `${state.binPaths.length} provisioned bin path(s) active.` : "No machine-local toolchain state; run aeh setup."
  });

  let profileTools: ResolvedToolchainTool[] = [];
  let profileResolutionError: string | undefined;
  if (lock) {
    try {
      profileTools = (await resolveToolchain(root, project, toolchain, { profile: lock.profile, containerAvailable })).tools;
    } catch (error) {
      profileResolutionError = error instanceof Error ? error.message : String(error);
    }
  }

  let projectTools: ResolvedToolchainTool[] = [];
  let projectResolutionError: string | undefined;
  try {
    projectTools = (await resolveToolchain(root, project, toolchain, { containerAvailable })).tools;
  } catch (error) {
    projectResolutionError = error instanceof Error ? error.message : String(error);
  }

  const profileChecks: ToolchainDoctorResult[] = [];
  const projectChecks: ToolchainDoctorResult[] = [];
  if (!lock) {
    results.push({ component: "toolchain-profile", required: true, ok: false, scope: "INSTALLED_PROFILE", state: "MISSING", message: "No installed profile is recorded; run aeh setup to select and install a profile." });
  } else if (profileResolutionError) {
    results.push({ component: "toolchain-profile", required: true, ok: false, scope: "INSTALLED_PROFILE", state: "INVALID", message: `Installed profile '${lock.profile}' cannot be resolved from the current toolchain config: ${profileResolutionError}` });
  } else {
    for (const tool of profileTools) {
      const health = await inspectTool(root, tool, lock, state?.manager.command);
      profileChecks.push({
        component: `toolchain:profile:${tool.name}`,
        required: tool.required ?? true,
        ok: health.ok,
        scope: "INSTALLED_PROFILE",
        state: health.state,
        message: `${tool.required === false ? "Optional profile tool " : ""}${tool.command} in installed profile '${lock.profile}': ${health.message}`
      });
    }
    const failed = profileChecks.filter((item) => item.required && !item.ok);
    results.push({
      component: "toolchain-profile",
      required: true,
      ok: failed.length === 0,
      scope: "INSTALLED_PROFILE",
      state: failed.length ? "MISSING" : "COMPLIANT",
      message: failed.length
        ? `Installed profile '${lock.profile}' is not compliant; ${failed.length} required profile tool(s) are missing or drifted.`
        : `Installed profile '${lock.profile}' is compliant (${profileTools.length} selected tool(s) checked).`
    });
    results.push(...profileChecks);
  }

  if (projectResolutionError) {
    results.push({ component: "toolchain-project-requirements", required: true, ok: false, scope: "ACTIVE_PROJECT", state: "INVALID", message: `Active project tool requirements cannot be resolved: ${projectResolutionError}` });
  } else {
    const installedProfile = lock?.profile ?? "unknown";
    const profileToolNames = new Set(profileTools.map((tool) => tool.name));
    for (const tool of projectTools) {
      const locked = lock?.tools[tool.name];
      const health = await inspectTool(root, tool, lock, state?.manager.command);
      if (health.ok) {
        projectChecks.push({
          component: `toolchain:project:${tool.name}`,
          required: tool.required ?? true,
          ok: true,
          scope: "ACTIVE_PROJECT",
          state: "COMPLIANT",
          message: `${tool.command} satisfies the active project requirement${profileToolNames.has(tool.name) ? ` and is included in installed profile '${installedProfile}'` : ""}.`
        });
      } else if (lock && !profileToolNames.has(tool.name) && !locked) {
        const required = tool.required ?? true;
        projectChecks.push({
          component: `toolchain:project:${tool.name}`,
          required,
          ok: !required,
          scope: "ACTIVE_PROJECT",
          state: "EXCLUDED",
          message: required
            ? `Project requirement missing: ${tool.command} is required by the active project but excluded by installed profile '${installedProfile}'. Run aeh setup without that profile or select a profile that includes it.`
            : `Optional project tool ${tool.command} is excluded by installed profile '${installedProfile}'.`
        });
      } else if (!locked) {
        const required = tool.required ?? true;
        projectChecks.push({
          component: `toolchain:project:${tool.name}`,
          required,
          ok: !required,
          scope: "ACTIVE_PROJECT",
          state: "MISSING",
          message: required
            ? `Project requirement missing: ${tool.command} is required by the active project but not recorded in a resolved toolchain lock; run aeh setup.`
            : `Optional project tool ${tool.command} is not recorded in a resolved toolchain lock.`
        });
      } else {
        projectChecks.push({
          component: `toolchain:project:${tool.name}`,
          required: tool.required ?? true,
          ok: health.ok,
          scope: "ACTIVE_PROJECT",
          state: health.state,
          message: `Active project requirement: ${tool.command} ${health.message}`
        });
      }
    }
    const failed = projectChecks.filter((item) => item.required && !item.ok);
    results.push({
      component: "toolchain-project-requirements",
      required: failed.length > 0,
      ok: failed.length === 0,
      scope: "ACTIVE_PROJECT",
      state: failed.length ? "MISSING" : "COMPLIANT",
      message: failed.length
        ? `Active project requirements are missing or non-compliant (${failed.length} required tool(s)); see toolchain:project entries. This check is separate from installed profile '${installedProfile}'.`
        : `Active project requirements are compliant (${projectTools.length} tool(s) checked); evaluated separately from installed profile '${installedProfile}'.`
    });
    results.push(...projectChecks);
  }

  const unionByName = new Map<string, ResolvedToolchainTool>();
  for (const tool of [...profileTools, ...projectTools]) unionByName.set(tool.name, tool);
  const unionTools = [...unionByName.values()];
  // Full-config pin gates (T1): unionTools covers only ACTIVE tools — an
  // inactive `latest` definition bypasses until activation. Enumerate the FULL
  // tool configuration (all defined tools incl. inactive) so activation can
  // never introduce an unpinned tool.
  const definedUnpinned = findLatestVersionPinsInDefinitions(toolchain.tools);
  const definedUnpinnedImages = findUnpinnedImagesInDefinitions(toolchain.tools);
  if (unionTools.length || definedUnpinned.length || definedUnpinnedImages.length) {
    const unpinned = [...new Set([...findLatestVersionPins(unionTools), ...definedUnpinned])].sort();
    results.push({
      component: "toolchain-pinning",
      required: true,
      ok: unpinned.length === 0,
      scope: "SUMMARY",
      state: unpinned.length ? "INVALID" : "COMPLIANT",
      message: unpinned.length
        ? `TOOLCHAIN_UNPINNED_VERSION: toolchain tools request unpinned version 'latest': ${unpinned.join(", ")}. Pin exact versions in .harness/toolchain.yaml.`
        : `Toolchain versions are pinned (${unionTools.length} resolved tool(s) + ${Object.keys(toolchain.tools).length} defined tool(s) checked).`
    });
    const unpinnedImages = [...new Set([...findUnpinnedActiveContainerImages(unionTools), ...definedUnpinnedImages])].sort();
    results.push({
      component: "toolchain-container-pins",
      required: true,
      ok: unpinnedImages.length === 0,
      scope: "SUMMARY",
      state: unpinnedImages.length ? "INVALID" : "COMPLIANT",
      message: unpinnedImages.length
        ? `TOOLCHAIN_UNPINNED_IMAGE: container tools use unpinned ':latest' images: ${unpinnedImages.join(", ")}. Pin image@sha256 digests in .harness/toolchain.yaml.`
        : "Container image pins are compliant (no defined container tool uses a ':latest' tag)."
    });
  }
  try {
    const miseLock = await loadMiseLockForDoctor(root);
    const consistency = checkToolchainLockConsistency(toolchain, lock, miseLock?.parsed, { miseLockUnparsedInScope: miseLock?.unparsedInScope });
    results.push({
      component: "toolchain-lock-consistency",
      required: true,
      ok: consistency.ok,
      scope: "SUMMARY",
      state: consistency.ok ? "COMPLIANT" : "DRIFT",
      message: consistency.ok
        ? miseLock
          ? `Toolchain locks are consistent (toolchain.yaml vs toolchain.lock.json vs ${miseLock.file}).`
          : "No mise.lock present; lock-consistency check skipped."
        : `Toolchain lock drift: ${consistency.divergences.join("; ")}.`
    });
  } catch (error) {
    results.push({
      component: "toolchain-lock-consistency",
      required: true,
      ok: false,
      scope: "SUMMARY",
      state: "INVALID",
      message: `Toolchain lock-consistency check failed: ${error instanceof Error ? error.message : String(error)}.`
    });
  }

  return results;
}

async function inspectTool(root: string, tool: ResolvedToolchainTool, lock: ToolchainLock | undefined, managerCommand: string | undefined): Promise<ToolHealth> {
  const locked = lock?.tools[tool.name];
  const available = await commandExists(tool.command, root);
  const expected = locked?.resolvedVersion;
  const actual = available ? await exactToolVersion(root, tool.command, locked?.provisioning, managerCommand) : undefined;
  const versionOk = reportedVersionsEqual(expected, actual);
  if (!locked) return { ok: false, state: "MISSING", message: "not present in toolchain lock." };
  if (!available) return { ok: false, state: "MISSING", message: "command missing from reconciled PATH." };
  if (!versionOk) return { ok: false, state: "DRIFT", message: `version drift locked=${expected} actual=${actual}.` };
  return {
    ok: true,
    state: "COMPLIANT",
    message: `compliant; provisioning=${locked.provisioning}${expected ? `; locked=${expected}` : ""}${locked.digestRef ? `; digest=${locked.digestRef}` : ""}.`
  };
}

async function exactToolVersion(root: string, command: string, provisioning: string | undefined, managerCommand: string | undefined): Promise<string | undefined> {
  if (provisioning === "mise" && managerCommand) {
    const result = await runShell(`${managerCommand} which ${shell(command)} --version`, { cwd: root, timeoutMs: 30_000, toolchain: false });
    if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  if (provisioning === "container") return undefined;
  const result = await runExecutable(command, ["--version"], { cwd: root, timeoutMs: 15_000 });
  return result.exitCode === 0 ? (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim() : undefined;
}
// Display-only normalization (never used for compliance decisions).
// Compliance uses exact-equality via reportedVersionsEqual (see pinning.ts),
// mirroring scripts/security/toolPin.mjs assertToolVersion semantics so
// pre-release suffixes such as `-unpinned` are never stripped.
function normalizeVersion(value: string): string { return value.trim().replace(/^v/, "").replace(/^.*?((?:\d{4}|\d+)\.\d+(?:\.\d+)?).*$/, "$1"); }
export { normalizeVersion as displayNormalizeVersion };
function shell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
