import type { OperationRecordV2 } from "./state.js";

export type UserFacingClaimSource =
  | "operation-result"
  | "audit-report"
  | "validation-report"
  | "task-contract"
  | "control-plane-context"
  | "repository-context"
  | "inference";

export interface UserFacingClaim {
  text: string;
  source: UserFacingClaimSource;
  verified: boolean;
  artifact?: string;
}

export interface OperationEvidenceSummary {
  operationId: string;
  status: OperationRecordV2["status"];
  resultAvailable: boolean;
  auditReportAvailable: boolean;
  findingsAvailable: boolean;
  repositoryInspection: "not-started" | "started" | "completed";
  authoritativeSources: UserFacingClaimSource[];
}

export function summarizeOperationEvidence(operation: OperationRecordV2): OperationEvidenceSummary {
  const resultAvailable = Boolean(operation.result && Object.keys(operation.result).length);
  const auditReportAvailable = typeof operation.result?.report === "string" && operation.result.report.trim().length > 0;
  const findingsAvailable = Array.isArray(operation.result?.findings) && operation.result.findings.length > 0;
  const stages = Object.values(operation.stages ?? {});
  const inspectedStages = stages.filter((stage) => ["materializing-reviewers", "validating", "reviewing", "consolidating"].includes(stage.name));
  const completed = inspectedStages.some((stage) => stage.status === "COMPLETED");
  const started = inspectedStages.some((stage) => ["RUNNING", "COMPLETED", "FAILED", "BLOCKED"].includes(stage.status));
  const authoritativeSources: UserFacingClaimSource[] = [];
  if (resultAvailable) authoritativeSources.push("operation-result");
  if (auditReportAvailable) authoritativeSources.push("audit-report");
  if (findingsAvailable) authoritativeSources.push("validation-report");
  return {
    operationId: operation.id,
    status: operation.status,
    resultAvailable,
    auditReportAvailable,
    findingsAvailable,
    repositoryInspection: completed ? "completed" : started ? "started" : "not-started",
    authoritativeSources
  };
}

export function evidenceDisciplineInstruction(operation: OperationRecordV2): string {
  const evidence = summarizeOperationEvidence(operation);
  if (evidence.resultAvailable) {
    return `Evidence discipline: claims verified by this operation must cite only durable sources ${evidence.authoritativeSources.join(", ") || "operation-result"}; distinguish any control-plane context or inference from operation-produced evidence.`;
  }
  return `Evidence discipline: this ${operation.status} operation has no durable result artifact, audit report, or findings. Repository inspection state is '${evidence.repositoryInspection}'. Do not claim that this operation verified repository behavior, findings, validation, or inspection. Any pre-existing control-plane knowledge must be labeled separately, and uncertainty must remain explicit.`;
}

export function claimFromOperation(text: string, operation: OperationRecordV2, artifact?: string): UserFacingClaim {
  const evidence = summarizeOperationEvidence(operation);
  const source: UserFacingClaimSource = artifact?.includes("audit") || evidence.auditReportAvailable ? "audit-report" : "operation-result";
  return { text, source, verified: evidence.resultAvailable && evidence.repositoryInspection === "completed", artifact };
}
