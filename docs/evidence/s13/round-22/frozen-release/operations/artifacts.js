import fs from "node:fs/promises";
import path from "node:path";
import { operationArtifactDir } from "./state.js";
export async function persistOperationAgentArtifact(root, operationId, key, payload) {
    return persistArtifact(root, operationId, "agent", "agents", key, payload);
}
export async function persistOperationConsolidation(root, operationId, key, payload) {
    return persistArtifact(root, operationId, "consolidation", "consolidations", key, payload);
}
export async function persistSupervisorCheckpoint(root, operationId, generation, payload) {
    return persistArtifact(root, operationId, "supervisor-checkpoint", "supervisors", `generation-${generation}`, payload);
}
export async function loadOperationArtifact(root, relativePath) {
    return JSON.parse(await fs.readFile(path.resolve(root, relativePath), "utf8"));
}
async function persistArtifact(root, operationId, kind, directory, key, payload) {
    const safe = safeKey(key);
    const dir = path.join(operationArtifactDir(root, operationId), directory);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${safe}.json`);
    const envelope = {
        version: 1,
        operationId,
        kind,
        key,
        createdAt: new Date().toISOString(),
        payload
    };
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(envelope, null, 2)}\n`);
    try {
        await fs.rename(temp, file);
    }
    finally {
        await fs.rm(temp, { force: true }).catch(() => undefined);
    }
    return path.relative(root, file).replaceAll("\\", "/");
}
function safeKey(value) {
    const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!normalized)
        throw new Error("operation artifact key is required");
    return normalized;
}
//# sourceMappingURL=artifacts.js.map