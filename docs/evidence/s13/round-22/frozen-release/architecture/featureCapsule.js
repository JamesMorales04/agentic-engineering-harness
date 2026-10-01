import fs from "node:fs/promises";
import path from "node:path";
import { assertFeatureCapsule, serializeFeatureCapsule } from "./contracts.js";
export function createDelegatedFeatureCapsule(input) {
    return assertFeatureCapsule({
        version: 1,
        taskId: input.taskId,
        objective: input.objective,
        scope: input.scope,
        ...(input.constraints ? { constraints: input.constraints } : {}),
        ...(input.acceptance?.length ? { acceptance: input.acceptance } : {}),
        ...(input.contextRefs?.length ? { contextRefs: input.contextRefs } : {}),
        ...(input.candidateRevision ? { candidateRevision: input.candidateRevision } : {}),
        route: "DELEGATED",
        assurance: input.assurance,
        routeEvidence: input.routeEvidence,
        progress: { total: 0, completed: 0, inProgress: 0, blocked: 0 },
        workUnits: []
    });
}
export async function persistFeatureCapsule(root, capsule) {
    const value = assertFeatureCapsule(capsule);
    const file = path.resolve(root, ".harness", "capsules", `${safeId(value.taskId ?? value.featureId ?? "feature")}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${serializeFeatureCapsule(value)}\n`, { encoding: "utf8", mode: 0o600 });
    return path.relative(root, file).replaceAll("\\", "/");
}
function safeId(value) { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
//# sourceMappingURL=featureCapsule.js.map