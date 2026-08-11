import type { CodeIntelligenceProvider } from "./types.js";
import { commandExists, runProcess } from "../utils/process.js";

export class GraphifyCodeIntelligenceProvider implements CodeIntelligenceProvider {
  readonly name = "graphify";

  async doctor(root: string): Promise<{ ok: boolean; message: string }> {
    const ok = await commandExists("graphify", root);
    return {
      ok,
      message: ok
        ? "Graphify CLI detected. Only extracted/deterministic relationships should be allowed to block CI by default."
        : "Graphify CLI was not found. Install it or set codeIntelligence.required=false."
    };
  }

  async update(root: string): Promise<void> {
    const result = await runProcess("graphify . --update", { cwd: root });
    if (result.exitCode !== 0) {
      throw new Error(`Graphify update failed: ${result.stderr || result.stdout}`);
    }
  }
}
