import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadProjectConfig, loadTaskContract } from "../core/config.js";
import { createIntentDecision } from "../audit/intentDecision.js";
import { startDetachedOperation, waitForOperation } from "../operations/controller.js";
import { prepareGithubIssueTask } from "./intake.js";
/**
 * Import an existing GitHub issue through the managed controller authority path. The import runs
 * inside a controller-owned change operation whose deterministic normalization policy, candidate
 * revision and epoch authorize the bounded Planner launch; the sealed TaskContract and the frozen
 * snapshot persist under the control root.
 */
export async function importIssueThroughManagedOperation(root, issueNumber, options = {}, dependencies = {}) {
    const loadConfig = dependencies.loadConfig ?? loadProjectConfig;
    const startOperation = dependencies.startOperation ?? startDetachedOperation;
    const waitOperation = dependencies.waitForOperation ?? waitForOperation;
    const config = await loadConfig(root);
    void config;
    const payload = {
        request: `Import GitHub issue #${issueNumber}`,
        ...(options.profile ? { profile: options.profile } : {}),
        issueIntake: { number: issueNumber, ...(options.refresh ? { refresh: true } : {}), ...(options.force ? { force: true } : {}) }
    };
    const operation = await startOperation(root, "change", payload, {
        nodeExecutable: dependencies.nodeExecutable ?? process.execPath,
        entryFile: path.resolve(dependencies.entryFile ?? process.argv[1] ?? "")
    });
    const finished = await waitOperation(root, operation.id);
    return issueImportResult(finished);
}
/** Deterministic projection of the durable intake result; never re-derives product facts. */
export function issueImportResult(record) {
    if (record.status !== "SUCCEEDED")
        throw new Error(`ISSUE_IMPORT_FAILED: operation ${record.id} finished ${record.status}: ${record.error ?? "no error recorded"}`);
    const evidence = record.result?.issueIntake;
    if (!evidence || evidence.version !== 1 || !evidence.taskId || !evidence.route || !evidence.snapshot?.repository || typeof evidence.snapshot.number !== "number" || !evidence.snapshot.contentSha256 || !evidence.snapshot.path) {
        throw new Error(`ISSUE_IMPORT_EVIDENCE_MISSING: operation ${record.id} has no durable issue-intake evidence.`);
    }
    return { operationId: record.id, taskId: evidence.taskId, route: evidence.route, snapshot: evidence.snapshot, ...(evidence.traceability ? { traceability: evidence.traceability } : {}) };
}
/**
 * Import an existing issue, then execute its sealed contract as a managed
 * controller run. Public delivery is owned by the accepted run finalizer;
 * this entrypoint never performs a pre-acceptance handoff.
 */
export async function executeIssueWorkflow(root, issueNumber, options = {}, dependencies = {}) {
    const loadConfig = dependencies.loadConfig ?? loadProjectConfig;
    const importIssue = dependencies.importIssue ?? importIssueThroughManagedOperation;
    const startOperation = dependencies.startOperation ?? startDetachedOperation;
    const waitOperation = dependencies.waitForOperation ?? waitForOperation;
    const nodeExecutable = dependencies.nodeExecutable ?? process.execPath;
    const entryFile = path.resolve(dependencies.entryFile ?? process.argv[1] ?? "");
    const config = await loadConfig(root);
    const imported = await importIssue(root, issueNumber, { profile: options.profile, refresh: options.refresh, force: options.force }, { loadConfig, startOperation, waitForOperation: waitOperation, nodeExecutable, entryFile });
    const contract = await loadTaskContract(root, imported.taskId, config);
    const payload = {
        taskId: imported.taskId,
        profile: options.profile,
        intentDecision: createIntentDecision("run", `Execute GitHub issue #${issueNumber}`, "explicit-cli")
    };
    const operation = await startOperation(root, "run", payload, { nodeExecutable, entryFile });
    const finished = await waitOperation(root, operation.id);
    const runFile = path.resolve(root, config.sdd?.runsDir ?? ".harness/runs", `${imported.taskId}.json`);
    try {
        return { result: JSON.parse(await fs.readFile(runFile, "utf8")), contract };
    }
    catch (error) {
        const detail = finished.error ?? (error instanceof Error ? error.message : String(error));
        throw new Error(`Issue operation ${operation.id} finished without a task run result: ${detail}`);
    }
}
export { prepareGithubIssueTask };
//# sourceMappingURL=workflow.js.map