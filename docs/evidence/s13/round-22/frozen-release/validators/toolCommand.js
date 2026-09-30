import path from "node:path";
import { runShell } from "../utils/process.js";
import { ISOLATION_PROVIDER_UNAVAILABLE, assertSupportedIsolationProvider, runIsolatedCommand, validatorIsolationEnvironmentAllowlist, validatorIsolationNetwork, validatorIsolationRequired } from "../security/isolation.js";
export async function runSpecCommand(context, command, category, details = {}) {
    const rendered = renderTokens(command, context);
    const cwd = path.resolve(context.root, context.spec.workingDirectory ?? ".");
    const timeoutMs = (context.spec.timeoutSeconds ?? 900) * 1000;
    let result;
    let isolation;
    if (validatorIsolationRequired(context.config, context.spec)) {
        try {
            assertSupportedIsolationProvider(context.config);
            const evidenceDir = path.resolve(context.root, context.config.evidence?.outputDir ?? ".harness/evidence");
            const isolated = await runIsolatedCommand({
                root: context.root,
                command: rendered,
                cwd,
                workspaceRoot: context.root,
                writablePaths: [evidenceDir],
                network: validatorIsolationNetwork(context.config),
                timeoutMs
            }, { environmentAllowlist: validatorIsolationEnvironmentAllowlist(context.config) });
            result = { exitCode: isolated.exitCode, stdout: isolated.stdout, stderr: isolated.stderr, durationMs: isolated.durationMs, timedOut: isolated.timedOut };
            isolation = isolated.isolation;
        }
        catch (error) {
            return isolationFailure(context, category, command, error);
        }
    }
    else {
        result = await runShell(rendered, { cwd, timeoutMs });
    }
    return {
        id: context.spec.id,
        category,
        status: result.exitCode === 0 ? "PASS" : "FAIL",
        message: result.exitCode === 0 ? `${context.spec.adapter} validator passed.` : `${context.spec.adapter} validator failed with exit code ${result.exitCode}.`,
        durationMs: result.durationMs,
        details: { command: rendered, stdout: truncate(result.stdout), stderr: truncate(result.stderr), ...(isolation ? { isolation } : {}), ...details }
    };
}
export function renderTokens(command, context) {
    return command
        .replaceAll("{taskId}", context.contract.task.id)
        .replaceAll("{baseRef}", context.baseRef)
        .replaceAll("{acceptance}", context.contract.source?.acceptance ?? "");
}
export function missingTool(spec, tool, category) {
    return {
        id: spec.id,
        category,
        status: spec.required ? "FAIL" : "WARN",
        message: `${tool} is not installed; ${spec.required ? "the required validator cannot run" : "optional validator skipped"}.`
    };
}
function isolationFailure(context, category, command, error) {
    const message = error instanceof Error ? error.message : String(error);
    const blocker = message.includes(ISOLATION_PROVIDER_UNAVAILABLE) ? ISOLATION_PROVIDER_UNAVAILABLE : "ISOLATION_UNAVAILABLE";
    return {
        id: context.spec.id,
        category,
        status: context.spec.required === false ? "WARN" : "FAIL",
        message: `Validator-command isolation could not be established; the ${context.spec.required === false ? "optional" : "required"} validator did not run: ${message}`,
        details: { blocker, command, isolationRequired: true }
    };
}
function truncate(value, max = 20_000) {
    return value.length <= max ? value : `${value.slice(0, max)}\n… truncated …`;
}
//# sourceMappingURL=toolCommand.js.map