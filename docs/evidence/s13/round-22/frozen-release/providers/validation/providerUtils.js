import fs from "node:fs/promises";
import path from "node:path";
import { commandExists, runShell } from "../../utils/process.js";
export async function fileExists(file) {
    try {
        await fs.access(file);
        return true;
    }
    catch {
        return false;
    }
}
export async function readJsonFile(file) {
    try {
        return JSON.parse(await fs.readFile(file, "utf8"));
    }
    catch {
        return undefined;
    }
}
export async function configuredCommand(context, fallback) {
    const providerSpec = context.providerSpec;
    const spec = context.spec;
    const command = providerSpec?.command ?? spec?.command ?? fallback;
    const provider = providerSpec?.provider ?? spec?.options?.provider;
    return { command, runtime: typeof spec?.options?.runtime === "string" ? spec.options.runtime : undefined, provider: typeof provider === "string" ? provider : "configured-command" };
}
export async function doctorForCommand(command, cwd, provider, details = {}) {
    const executable = command?.trim().split(/\s+/, 1)[0];
    const available = Boolean(executable) && await commandExists(executable, cwd);
    return { provider, available, message: available ? `${provider} is available.` : `${provider} command is unavailable.`, details: { ...details, executable } };
}
export async function executePlan(plan) {
    const result = await runShell(plan.command, { cwd: plan.cwd, timeoutMs: Number(plan.options?.timeoutMs ?? 900_000), env: plan.env });
    return { plan, ...result, rawArtifact: "" };
}
export function resolveCwd(context) {
    return path.resolve(context.root, context.providerSpec?.workingDirectory ?? context.spec?.workingDirectory ?? ".");
}
//# sourceMappingURL=providerUtils.js.map