import fs from "node:fs/promises";
import path from "node:path";
import { sha256Canonical } from "../../core/digest.js";
export async function persistRawArtifact(root, directory, id, stdout, stderr) {
    const safe = id.replace(/[^A-Za-z0-9._-]/g, "-");
    const output = path.resolve(root, directory, `${safe}.raw`);
    await fs.mkdir(path.dirname(output), { recursive: true });
    const body = `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`;
    await fs.writeFile(output, body, "utf8");
    return path.relative(root, output).replaceAll("\\", "/");
}
export function resultCheck(id, category, result, required) {
    const failed = result.status === "FAIL";
    const skipped = result.status === "SKIP";
    return {
        id,
        category,
        status: failed ? "FAIL" : skipped ? (required ? "FAIL" : "SKIP") : "PASS",
        message: failed ? `${result.provider} ${category} failed.` : skipped ? `${result.provider} ${category} was skipped.` : `${result.provider} ${category} passed.`,
        durationMs: "summary" in result ? result.summary.durationMs : result.lifecycle.durationMs,
        details: { provider: result.provider, capability: result.capability, result, rawArtifact: result.rawArtifact }
    };
}
export function parseJson(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
export function stableFingerprint(value) {
    return sha256Canonical(value);
}
//# sourceMappingURL=protocol.js.map