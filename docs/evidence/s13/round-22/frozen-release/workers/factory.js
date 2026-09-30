import { DirectWorkerExecutor } from "./direct.js";
import { PaseoWorkerExecutor } from "./paseo.js";
import { PodmanWorkerExecutor } from "./podman.js";
export function createWorkerExecutor(config, selection) { const requested = selection?.transport && selection.transport !== "inherit" ? selection.transport : (config.orchestration?.provider ?? "none"); switch (requested) {
    case "paseo": return new PaseoWorkerExecutor();
    case "podman": return new PodmanWorkerExecutor();
    case "direct": return new DirectWorkerExecutor();
    default: throw new Error(`No executable orchestration transport configured: ${requested}`);
} }
//# sourceMappingURL=factory.js.map