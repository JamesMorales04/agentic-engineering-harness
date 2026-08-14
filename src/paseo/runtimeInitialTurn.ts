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
 * Execute foreground initial Paseo turns with the same atomic turn primitive
 * used by resumed sessions. The concrete agent is materialized and registered
 * first, then the prompt is dispatched through run(), so a fast
 * idle -> running -> idle cycle cannot finish before AEH starts observing it.
 * Explicit detached launches preserve the legacy background lifecycle.
 */
export async function launchManagedPaseoAgent(
  root: string,
  options: ManagedPaseoAgentOptions,
  deps?: RuntimeDeps
): Promise<ManagedPaseoAgentResult> {
  if (options.prompt === undefined || options.waitForFinish === false) {
    return launchLegacyManagedPaseoAgent(root, options, deps);
  }

  try {
    const materialized = await materializeManagedPaseoAgent(
      root,
      { ...options, prompt: undefined, waitForFinish: false },
      deps
    );
    if (!materialized.id) return materialized;

    return continueManagedPaseoAgent(
      root,
      materialized.id,
      options.prompt,
      options.timeoutSeconds ?? secondsFromMs(options.timeoutMs),
      deps,
      options.outputSchema
    );
  } catch (error) {
    if (!isSdkUnavailable(error)) throw error;
    return launchLegacyManagedPaseoAgent(root, options, deps);
  }
}

function isSdkUnavailable(error: unknown): boolean {
  return error instanceof PaseoSdkUnavailableError ||
    (error instanceof Error && error.name === "PaseoSdkUnavailableError");
}

function secondsFromMs(ms?: number): number | undefined {
  return ms === undefined ? undefined : Math.max(1, Math.ceil(ms / 1000));
}
