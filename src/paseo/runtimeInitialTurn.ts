import { PaseoSdkUnavailableError } from "./sdk.js";
import {
  continueManagedPaseoAgent,
  launchManagedPaseoAgent as launchLegacyManagedPaseoAgent,
  materializeManagedPaseoAgent,
  type ManagedPaseoAgentOptions,
  type ManagedPaseoAgentResult
} from "./runtimeCore.js";

type RuntimeDeps = Parameters<typeof launchLegacyManagedPaseoAgent>[2];

/**
 * Managed AEH operation agents execute foreground initial Paseo turns through
 * the same atomic turn primitive used by resumed sessions. The concrete agent
 * is materialized and registered first, then run() executes the prompt, so a
 * fast idle -> running -> idle cycle cannot finish before AEH observes it.
 * Standalone runtime callers and explicit detached launches retain the legacy
 * lifecycle for compatibility.
 */
export async function launchManagedPaseoAgent(
  root: string,
  options: ManagedPaseoAgentOptions,
  deps?: RuntimeDeps
): Promise<ManagedPaseoAgentResult> {
  if (!isManagedForegroundTurn(options)) {
    return launchLegacyManagedPaseoAgent(root, options, deps);
  }

  let materialized: ManagedPaseoAgentResult;
  try {
    materialized = await materializeManagedPaseoAgent(
      root,
      { ...options, prompt: undefined, waitForFinish: false },
      deps
    );
  } catch (error) {
    // Compatibility fallback is safe only before a semantic turn starts. Once
    // materialization succeeds, never create a second agent for the same turn.
    if (!isSdkUnavailable(error)) throw error;
    return launchLegacyManagedPaseoAgent(root, options, deps);
  }

  if (!materialized.id) return materialized;
  return continueManagedPaseoAgent(
    root,
    materialized.id,
    options.prompt!,
    options.timeoutSeconds ?? secondsFromMs(options.timeoutMs),
    deps,
    options.outputSchema
  );
}

function isManagedForegroundTurn(options: ManagedPaseoAgentOptions): boolean {
  return options.prompt !== undefined &&
    options.waitForFinish !== false &&
    Boolean(options.labels?.["aeh.operation"]?.trim()) &&
    Boolean(options.labels?.["aeh.role"]?.trim());
}

function isSdkUnavailable(error: unknown): boolean {
  return error instanceof PaseoSdkUnavailableError ||
    (error instanceof Error && error.name === "PaseoSdkUnavailableError");
}

function secondsFromMs(ms?: number): number | undefined {
  return ms === undefined ? undefined : Math.max(1, Math.ceil(ms / 1000));
}
