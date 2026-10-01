import fs from "node:fs/promises";
import path from "node:path";
import { validateAgentOutput } from "../agents/outputContracts.js";
import { operationArtifactDir, resolveOperationStateRoot } from "../operations/state.js";
import { acceptStructuredResult, loadStructuredResultChannel } from "./resultGateway.js";
import { sha256Canonical } from "../core/digest.js";
export async function commitStructuredResult(root, operationId, channelId, payload, source) {
    const lock = path.join(operationArtifactDir(resolveOperationStateRoot(root), operationId), "result-channels", `${safe(channelId)}.commit.lock`);
    return withLock(lock, async () => {
        const channel = await loadStructuredResultChannel(root, operationId, channelId);
        const turn = channel.activeTurn;
        if (!turn)
            throw new Error("AEH_RESULT_NO_ACTIVE_TURN: no controller-activated result turn exists.");
        if (turn.status === "ACCEPTED" && turn.sha256 && turn.artifact) {
            const validation = validateAgentOutput(turn.contract, payload);
            if (!validation.ok)
                throw new Error(`RESULT_ALREADY_ACCEPTED: ${validation.issues.join("; ")}`);
            const normalized = validation.value;
            const sha256 = sha256Canonical(normalized);
            if (sha256 !== turn.sha256)
                throw new Error("CONFLICTING_RESULT: the active turn already has a different accepted payload.");
            return acceptStructuredResult(root, operationId, channelId, normalized, source);
        }
        return acceptStructuredResult(root, operationId, channelId, payload, source);
    });
}
function safe(value) { return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "result"; }
async function withLock(file, action) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const deadline = Date.now() + 5_000;
    for (;;) {
        try {
            const handle = await fs.open(file, "wx");
            try {
                return await action();
            }
            finally {
                await handle.close().catch(() => undefined);
                await fs.rm(file, { force: true }).catch(() => undefined);
            }
        }
        catch (error) {
            if (error.code !== "EEXIST" || Date.now() >= deadline)
                throw error;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
}
//# sourceMappingURL=resultCommit.js.map