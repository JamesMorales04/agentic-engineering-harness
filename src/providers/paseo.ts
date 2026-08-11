import type { OrchestrationProvider } from "./types.js";
import { commandExists } from "../utils/process.js";

export class PaseoOrchestrationProvider implements OrchestrationProvider {
  readonly name = "paseo";

  async doctor(root: string): Promise<{ ok: boolean; message: string }> {
    const ok = await commandExists("paseo", root);
    return {
      ok,
      message: ok
        ? "Paseo CLI detected. Use the lead-agent skill to keep Codex as owner and OpenCode as implementation worker."
        : "Paseo CLI was not found. Install it or set orchestration.required=false."
    };
  }
}
