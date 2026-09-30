import path from "node:path";
import { commandExists, runShell } from "../utils/process.js";
export function buildOpaInput(contract, changedFiles, frozenChangedFiles, evidence, executionIdentity = {}) {
    const identity = { operationId: executionIdentity.operationId, operationKind: executionIdentity.operationKind, logicalAgent: executionIdentity.logicalAgent, role: executionIdentity.role, profile: executionIdentity.profile ?? contract.routing?.profile, domains: executionIdentity.domains ?? contract.routing?.domains ?? [], risk: executionIdentity.risk ?? contract.routing?.risk ?? "low", runtime: executionIdentity.runtime, modelAlias: executionIdentity.modelAlias, permissions: executionIdentity.permissions ?? {} };
    return { operationId: identity.operationId, operationKind: identity.operationKind, identity, changedFiles, frozenChangedFiles, taskContract: contract, deterministicEvidence: evidence, ...evidence };
}
export async function runOpaPolicies(root, config, contract, changedFiles, frozenChangedFiles, evidence, policyRoot = root, executionIdentity = {}) {
    if (!config.validation?.opa?.enabled)
        return { id: "policy.opa", category: "policy", status: "SKIP", message: "OPA policy evaluation disabled." };
    if (!(await commandExists("opa", root)))
        return { id: "policy.opa", category: "policy", status: "FAIL", message: "OPA is enabled but the opa executable is not installed." };
    const policyDirs = config.validation.opa.policyDirs ?? [];
    if (!policyDirs.length)
        return { id: "policy.opa", category: "policy", status: "FAIL", message: "OPA is enabled but no policyDirs are configured." };
    const args = policyDirs.map((dir) => `--data ${quote(path.resolve(policyRoot, dir))}`).join(" ");
    const input = buildOpaInput(contract, changedFiles, frozenChangedFiles, evidence, executionIdentity);
    const command = `printf %s ${quote(JSON.stringify(input))} | opa eval --format=json ${args} --stdin-input data`;
    const result = await runShell(command, { cwd: root, timeoutMs: 30_000 });
    if (result.exitCode !== 0)
        return { id: "policy.opa", category: "policy", status: "FAIL", message: "OPA policy evaluation failed to execute.", details: { stderr: result.stderr, stdout: result.stdout } };
    try {
        const parsed = JSON.parse(result.stdout);
        const denies = collectDenies(parsed.result?.[0]?.expressions?.[0]?.value);
        return { id: "policy.opa", category: "policy", status: denies.length ? "FAIL" : "PASS", message: denies.length ? `OPA denied the change: ${denies.join("; ")}` : "OPA policies allowed the change.", details: { denies, evidence } };
    }
    catch (error) {
        return { id: "policy.opa", category: "policy", status: "FAIL", message: "OPA returned an unreadable result.", details: { error: String(error), stdout: result.stdout } };
    }
}
function collectDenies(value) { const out = []; const visit = (node) => { if (!node || typeof node !== "object")
    return; if (Array.isArray(node)) {
    for (const item of node)
        visit(item);
    return;
} for (const [key, child] of Object.entries(node)) {
    if (key === "deny") {
        if (Array.isArray(child))
            out.push(...child.map(String));
        else if (child && typeof child === "object")
            out.push(...Object.keys(child));
        else if (child)
            out.push(String(child));
    }
    visit(child);
} }; visit(value); return [...new Set(out)]; }
function quote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
//# sourceMappingURL=opa.js.map