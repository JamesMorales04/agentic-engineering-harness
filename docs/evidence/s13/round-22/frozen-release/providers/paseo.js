import { commandExists } from "../utils/process.js";
export class PaseoOrchestrationProvider {
    name = "paseo";
    async doctor(root) {
        const ok = await commandExists("paseo", root);
        return {
            ok,
            message: ok
                ? "Paseo CLI detected. Use the lead-agent skill to keep Codex as owner and OpenCode as implementation worker."
                : "Paseo CLI was not found. Install it or set orchestration.required=false."
        };
    }
}
//# sourceMappingURL=paseo.js.map