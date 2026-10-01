import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { loadOperation, patchOperationMetadata } from "./state.js";
export async function spawnOperationMonitor(root, operation, options) {
    const absoluteRoot = path.resolve(root);
    const spawnProcess = options.spawnProcess ?? spawn;
    let child;
    try {
        child = spawnProcess(options.nodeExecutable, [options.entryFile, "operation", "monitor", operation.id, absoluteRoot], {
            cwd: absoluteRoot,
            detached: true,
            stdio: "ignore",
            env: {
                ...process.env,
                AEH_CONTROL_ROOT: absoluteRoot,
                AEH_OPERATION_ID: operation.id,
                AEH_OPERATION_KIND: operation.kind,
                AEH_OPERATION_STATE_REDIRECT: "1"
            }
        });
        child.once("error", (error) => {
            void (async () => {
                const current = await loadOperation(absoluteRoot, operation.id).catch(() => operation);
                const warning = `liveness monitor: ${error instanceof Error ? error.message : String(error)}`;
                await patchOperationMetadata(absoluteRoot, operation.id, {
                    cleanupWarnings: [...new Set([...(current.cleanupWarnings ?? []), warning])]
                }).catch(() => undefined);
            })().catch(() => undefined);
        });
        child.unref();
        return child.pid;
    }
    catch (error) {
        const current = await loadOperation(absoluteRoot, operation.id).catch(() => operation);
        const warning = `liveness monitor: ${error instanceof Error ? error.message : String(error)}`;
        await patchOperationMetadata(absoluteRoot, operation.id, {
            cleanupWarnings: [...new Set([...(current.cleanupWarnings ?? []), warning])]
        }).catch(() => undefined);
        return undefined;
    }
}
//# sourceMappingURL=monitorProcess.js.map