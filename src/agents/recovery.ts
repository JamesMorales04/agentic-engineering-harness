import type { ValidationReport, WorkerSession } from "../core/types.js";
import type { FailureType, RecoveryStep, ResolvedAgentTopology } from "./types.js";

export interface FailureEvidence { report?: ValidationReport; worker?: WorkerSession; conflicting?: boolean; wrongAgent?: boolean; missingContext?: boolean; reviewFailure?: boolean; }

export function classifyFailure(evidence: FailureEvidence): FailureType {
  if (evidence.conflicting) return "CONFLICTING_RESULTS";
  if (evidence.wrongAgent) return "WRONG_AGENT";
  if (evidence.missingContext) return "MISSING_CONTEXT";
  if (evidence.reviewFailure) return "REVIEW_FAILURE";
  const output = `${evidence.worker?.stderr ?? ""}\n${evidence.worker?.stdout ?? ""}`.toLowerCase();
  if (/hunk|patch.*(failed|context)|context.*mismatch|expected lines.*not found/.test(output)) return "PATCH_CONTEXT_MISMATCH";
  if (/timeout|timed out|econnreset|rate limit|\b429\b|\b503\b|tool.*fail/.test(output) || (evidence.worker && evidence.worker.exitCode !== 0)) return "TOOL_FAILURE";
  if (evidence.report?.checks.some((check) => check.status === "FAIL")) return "VALIDATION_FAILURE";
  if (!output.trim()) return "AMBIGUOUS_OUTPUT";
  return "AMBIGUOUS_OUTPUT";
}

export function resolveRecoveryStep(topology: ResolvedAgentTopology, failureType: FailureType, attempt: number): RecoveryStep {
  const policy = topology.recovery[failureType] ?? [{ action: "same-agent" }, { action: "lead" }];
  const index = Math.min(Math.max(attempt - 1, 0), policy.length - 1);
  return policy[index] ?? { action: "stop" };
}

export function formatRecoveryAction(step: RecoveryStep, currentAgent: string): string {
  switch (step.action) {
    case "same-agent": return `retry:${currentAgent}`;
    case "agent": return `agent:${step.agent ?? "unspecified"}`;
    case "reroute": return "reroute";
    case "lead": return "escalate:lead";
    case "stop": return "stop";
  }
}
