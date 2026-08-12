import type { HarnessProjectConfig } from "../core/types.js";
import { PaseoWorkerExecutor } from "./paseo.js";
import { PodmanWorkerExecutor } from "./podman.js";
import type { WorkerExecutor } from "./types.js";

export function createWorkerExecutor(config: HarnessProjectConfig): WorkerExecutor {
  switch (config.orchestration?.provider ?? "none") {
    case "paseo": return new PaseoWorkerExecutor();
    case "podman": return new PodmanWorkerExecutor();
    default: throw new Error(`No executable orchestration provider configured: ${config.orchestration?.provider ?? "none"}`);
  }
}
