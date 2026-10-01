import { spawn } from "node:child_process";
import { runAudit } from "../audit/run.js";
import { runTask } from "../core/run.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import { runShell } from "../utils/process.js";
import { resolveChangePreflightV1, runChangeOperation } from "./change.js";
import { prepareGithubIssueTask } from "../issues/intake.js";
import { createSemanticAssessmentRuntimeV1 } from "../semantic/runtime.js";
import { startOperationWatchdog } from "./liveness.js";
import { type OperationKind, type OperationPayload, type OperationRecord, type OperationRecordV2 } from "./state.js";
import { bindBootstrapOperationPolicy } from "./bootstrapPolicy.js";
export { bindBootstrapOperationPolicy };
export interface StartOperationOptions {
    nodeExecutable: string;
    entryFile: string;
    spawnProcess?: typeof spawn;
    completionAgentId?: string;
    completionSource?: string;
    /** Test seam for deterministic preflight-ordering regressions; public callers use the semantic resolver. */
    resolveChangePreflight?: typeof resolveChangePreflightV1;
}
export interface OperationControllerDeps {
    run?: typeof runShell;
    trace?: typeof recordPaseoTrace;
    notifyCompletion?: (root: string, operation: OperationRecord) => Promise<unknown>;
    startWatchdog?: typeof startOperationWatchdog;
    runAudit?: typeof runAudit;
    runTask?: typeof runTask;
    runChange?: typeof runChangeOperation;
    runIssueIntake?: typeof prepareGithubIssueTask;
    createSemanticRuntime?: typeof createSemanticAssessmentRuntimeV1;
    /** Trusted actor from the paired Control Center session; absent callers must present a recorded scoped decision. */
    humanActorId?: string;
    /** Deterministic provider observation seam for cleanup tests and disposable packed fixtures. */
    inspectProviderSession?: (root: string, provider: string, sessionId: string) => Promise<{
        status?: string;
    } | undefined>;
}
export declare function startDetachedOperation(root: string, kind: OperationKind, payload: OperationPayload, options: StartOperationOptions): Promise<OperationRecordV2>;
export declare function executeOperation(root: string, operationId: string, deps?: OperationControllerDeps): Promise<OperationRecordV2>;
export declare function waitForOperation(root: string, operationId: string, timeoutMs?: number, pollMs?: number): Promise<OperationRecordV2>;
export declare function cancelOperation(root: string, operationId: string, deps?: OperationControllerDeps): Promise<OperationRecordV2>;
export declare function createOperationId(kind: OperationKind, seed: string): string;
export declare function extractWorkspaceId(text: string): string | undefined;
export declare function extractWorkspacePath(text: string): string | undefined;
