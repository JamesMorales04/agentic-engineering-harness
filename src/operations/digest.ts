import { activeOperationSupervisor, isTerminalOperation, type OperationRecordV2 } from "./state.js";

export type OperationLeadAttention = "none" | "blocked" | "terminal";

export interface OperationDigest {
  version: 1;
  operationId: string;
  kind: string;
  status: OperationRecordV2["status"];
  phase: string;
  revision: number;
  updatedAt: string;
  lastProgressAt: string;
  progress: {
    expected: number;
    running: number;
    completed: number;
    failed: number;
    blocked: number;
  };
  supervisor?: {
    generation: number;
    status: string;
  };
  lead: {
    acknowledgedRevision: number;
    currentRevisionAcknowledged: boolean;
  };
  attention: OperationLeadAttention;
  requiresLeadAction: boolean;
  result: {
    available: boolean;
    report?: string;
    keys: string[];
  };
  error?: string;
}

export function buildOperationDigest(operation: OperationRecordV2): OperationDigest {
  const supervisor = activeOperationSupervisor(operation);
  const terminal = isTerminalOperation(operation.status);
  const blocked = operation.progress.blocked > 0 || Object.values(operation.stages).some((stage) => stage.status === "BLOCKED");
  const attention: OperationLeadAttention = terminal ? "terminal" : blocked ? "blocked" : "none";
  const resultKeys = Object.keys(operation.result ?? {}).sort();
  const report = typeof operation.result?.report === "string" && operation.result.report.trim()
    ? operation.result.report.trim()
    : undefined;
  const acknowledgedRevision = operation.lead?.acknowledgedRevision ?? 0;

  return {
    version: 1,
    operationId: operation.id,
    kind: operation.kind,
    status: operation.status,
    phase: operation.phase,
    revision: operation.revision,
    updatedAt: operation.updatedAt,
    lastProgressAt: operation.lastProgressAt,
    progress: {
      expected: operation.progress.expected,
      running: operation.progress.running,
      completed: operation.progress.completed,
      failed: operation.progress.failed,
      blocked: operation.progress.blocked
    },
    supervisor: supervisor ? { generation: supervisor.generation, status: supervisor.status } : undefined,
    lead: {
      acknowledgedRevision,
      currentRevisionAcknowledged: acknowledgedRevision >= operation.revision
    },
    attention,
    requiresLeadAction: attention !== "none",
    result: {
      available: Boolean(operation.result),
      report,
      keys: resultKeys
    },
    error: operation.error?.split("\n", 1)[0]
  };
}

export function operationDigestText(digest: OperationDigest): string {
  const progress = digest.progress;
  const supervisor = digest.supervisor ? `${digest.supervisor.status}#${digest.supervisor.generation}` : "none";
  const result = digest.result.report ? ` result=${digest.result.report}` : digest.result.available ? " result=available" : "";
  return `${digest.operationId} ${digest.status}/${digest.phase} rev=${digest.revision} progress=${progress.completed}/${progress.expected} running=${progress.running} failed=${progress.failed} blocked=${progress.blocked} supervisor=${supervisor} attention=${digest.attention}${result}`;
}
