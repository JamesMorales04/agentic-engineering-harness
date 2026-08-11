import type { MemoryProvider } from "./types.js";
import { commandExists } from "../utils/process.js";

export class EngramMemoryProvider implements MemoryProvider {
  readonly name = "engram";

  async doctor(root: string): Promise<{ ok: boolean; message: string }> {
    const ok = await commandExists("engram", root);
    return {
      ok,
      message: ok
        ? "Engram CLI detected. Memory remains advisory; Git artifacts remain authoritative."
        : "Engram CLI was not found. Install/configure it or set memory.required=false."
    };
  }
}
