import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { existingRepositoryPath } from "../utils/repositoryPath.js";
export async function sealTask(root, config, contract) {
    const artifacts = await artifactPaths(root, config, contract);
    const seal = {
        version: 1,
        taskId: contract.task.id,
        createdAt: new Date().toISOString(),
        artifacts: []
    };
    for (const relative of artifacts) {
        const content = await fs.readFile(await existingRepositoryPath(root, relative));
        seal.artifacts.push({ path: relative, sha256: sha256(content) });
    }
    const output = sealPath(root, contract.task.id);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(seal, null, 2)}\n`);
    return output;
}
export async function verifyTaskSeal(root, contract, required = true) {
    const file = sealPath(root, contract.task.id);
    let seal;
    try {
        seal = JSON.parse(await fs.readFile(file, "utf8"));
    }
    catch {
        return {
            id: "trust.seal",
            category: "trust-boundary",
            status: required ? "FAIL" : "WARN",
            message: `No valid seal exists for ${contract.task.id}. Run engineering-harness seal ${contract.task.id} before delegation.`
        };
    }
    const mismatches = [];
    for (const artifact of seal.artifacts) {
        try {
            const current = await fs.readFile(await existingRepositoryPath(root, artifact.path));
            const actual = sha256(current);
            if (actual !== artifact.sha256)
                mismatches.push({ path: artifact.path, expected: artifact.sha256, actual });
        }
        catch {
            mismatches.push({ path: artifact.path, expected: artifact.sha256 });
        }
    }
    return {
        id: "trust.seal",
        category: "trust-boundary",
        status: mismatches.length ? "FAIL" : "PASS",
        message: mismatches.length ? `Sealed artifacts changed after freeze: ${mismatches.map((x) => x.path).join(", ")}` : "TaskContract and sealed SDD artifacts match their SHA-256 seal.",
        details: { mismatches, sealedAt: seal.createdAt }
    };
}
async function artifactPaths(root, config, contract) {
    const contractsDir = config.sdd?.contractsDir ?? ".harness/contracts";
    const paths = [path.posix.join(contractsDir.replaceAll("\\", "/"), `${contract.task.id}.yaml`)];
    for (const source of Object.values(contract.source ?? {})) {
        if (source)
            paths.push(source.replaceAll("\\", "/"));
    }
    const unique = [...new Set(paths)];
    for (const relative of unique) {
        await existingRepositoryPath(root, relative);
    }
    return unique;
}
function sealPath(root, taskId) {
    return path.join(root, ".harness", "seals", `${taskId}.json`);
}
function sha256(content) {
    return crypto.createHash("sha256").update(content).digest("hex");
}
//# sourceMappingURL=seal.js.map