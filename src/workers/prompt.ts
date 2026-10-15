import type { AgentExecutionSelection } from "../agents/types.js";
import { permissionSummary } from "../agents/permissions.js";
import type { RepairPacket, TaskContract } from "../core/types.js";
export function buildWorkerPrompt(contract: TaskContract, selection?: AgentExecutionSelection): string { const sources = Object.entries(contract.source ?? {}).filter(([, value]) => Boolean(value)).map(([key, value]) => `- ${key}: ${value}`).join("\n"); const requirements = (contract.requirements ?? []).map((item) => `- ${item.id}: ${item.description ?? "see spec"}`).join("\n"); const identity = selection ? `Logical agent: ${selection.logicalAgent}\nRole: ${selection.role}\nDomains: ${selection.domains.join(", ") || "generic"}\nAgent charter: ${selection.description ?? "Follow the role/domain boundaries in the TaskContract."}\nRuntime: ${selection.runtimeName}\nModel alias: @${selection.modelAlias}\nNative agent: ${selection.nativeAgent ?? "none"}\nSkills: ${selection.skills.join(", ") || "none"}\nMCPs: ${selection.mcps.join(", ") || "none"}\nPermissions: ${permissionSummary(selection)}\nOutput contract: ${selection.outputContract ?? "none"}` : "Legacy worker configuration."; return `You are the implementation worker for task ${contract.task.id}: ${contract.task.title}.\n\n${identity}\n\nThe lead agent owns architecture and requirements. Implement only the approved task contract.\n\nRead these authoritative artifacts before editing:\n${sources || "- TaskContract only"}\n\nRequirements:\n${requirements || "- See TaskContract/spec"}\n\nRules:\n- Do not modify the TaskContract, its seal, or SDD/acceptance artifacts.\n- Do not expand scope or redesign unrelated architecture.\n- Respect allowed/forbidden paths and dependency/schema constraints.\n- Do not exceed the configured permission/capability envelope.\n- Add or update implementation-level tests as needed; do not weaken frozen acceptance criteria.\n- Run focused checks before reporting completion.\n- Report files changed, tests run, results, deviations and remaining concerns.\n\nOut-of-scope blocker path (report, don't expand): if the implementation needs files outside the frozen scope (including lockfiles such as package-lock.json, acceptance, validators, or policy), do NOT edit them. Return no file changes and declare the needed files via AEH_RESULT_JSON with filesNeededOutsideScope[{path, reason}] (one reason per file). Silent scope expansion is rejected; only a lead-approved scope amendment with reseal can authorize the retry.\n`; }
/**
 * Bounded per-failure evidence excerpt (DETERMINISTIC): failure id, category
 * and message are always complete; details render whole when small, otherwise
 * as head+tail around an omission marker so unbounded session transcripts
 * can never inflate a repair prompt past participant context budgets (the
 * context gateway fails closed with CONTEXT_BUDGET_EXCEEDED on required
 * fragments that do not fit). Full evidence stays in the durable validation
 * report artifact, which the repairer reads in-workspace — the excerpt is a
 * locator, never a substitute. Slicing is code-point safe (astral Unicode
 * characters are never split).
 */
const REPAIR_EVIDENCE_BUDGET_CHARS = 1_500;
const REPAIR_EVIDENCE_HEAD_CHARS = 800;
const REPAIR_EVIDENCE_TAIL_CHARS = 600;
const REPAIR_MAX_LISTED_FAILURES = 10;
const REPAIR_MAX_MESSAGE_CHARS = 500;
function sliceCodePoints(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}
function truncateMessage(message: string): string {
  if (Array.from(message).length <= REPAIR_MAX_MESSAGE_CHARS) return message;
  return `${sliceCodePoints(message, 0, REPAIR_MAX_MESSAGE_CHARS)}\n  [… message truncated; see the validation report artifact …]`;
}
export function projectRepairFailureEvidence(details: unknown): string {
  const rendered = JSON.stringify(details);
  if (Array.from(rendered).length <= REPAIR_EVIDENCE_BUDGET_CHARS) return rendered;
  const head = sliceCodePoints(rendered, 0, REPAIR_EVIDENCE_HEAD_CHARS);
  const tail = sliceCodePoints(rendered, -REPAIR_EVIDENCE_TAIL_CHARS);
  return `${head}\n  [… ${(Array.from(rendered).length - REPAIR_EVIDENCE_HEAD_CHARS - REPAIR_EVIDENCE_TAIL_CHARS).toLocaleString("en-US")} characters of evidence omitted; read the full validation report artifact …]\n${tail}`;
}
export function buildRepairPrompt(packet: RepairPacket): string {
  const listed = packet.failures.slice(0, REPAIR_MAX_LISTED_FAILURES);
  const omitted = packet.failures.length - listed.length;
  const failures = listed.map((failure) => `- ${failure.id} [${failure.category}]: ${truncateMessage(failure.message)}${failure.details ? `\n  evidence: ${projectRepairFailureEvidence(failure.details)}` : ""}`).join("\n");
  const evidencePointer = packet.reportArtifact ? `\nFull failure evidence: read ${packet.reportArtifact} in the workspace (validation report for ${packet.taskId}, attempt ${packet.attempt}); the excerpts above locate failures, they do not replace the report.` : "";
  const omissionNote = omitted > 0 ? `\n… and ${omitted} more failure(s) not listed here; see ${packet.reportArtifact ?? "the validation report artifact"}.` : "";
  return `Repair attempt ${packet.attempt} for ${packet.taskId}.\nFailure type: ${packet.failureType ?? "unspecified"}\nRecovery action: ${packet.recoveryAction ?? "same-agent"}${evidencePointer}\n\nThe deterministic harness rejected the implementation for these reasons:\n${failures}${omissionNote}\n\nMake the smallest targeted changes needed to satisfy these failures. Do not modify frozen contracts/specs/acceptance artifacts and do not broaden scope. Re-run the focused failing checks before reporting completion.\n\nOut-of-scope blocker path (report, don't expand): if the required fix needs files outside the frozen scope (including lockfiles such as package-lock.json, acceptance, validators, or policy), do NOT edit them. Return no file changes and declare the needed files via AEH_RESULT_JSON with filesNeededOutsideScope[{path, reason}] (one reason per file). Silent scope expansion is rejected; only a lead-approved scope amendment with reseal can authorize the retry.`; }
