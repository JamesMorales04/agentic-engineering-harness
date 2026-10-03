import type { OperationRecordV2 } from "./state.js";
import { loadPaseoSessionBinding, resolveReusablePaseoSession } from "../paseo/sessionBinding.js";
import { createTrustedOperationToolError } from "./toolDiagnostics.js";

/** Same-session recovery requires the exact active Paseo identity recorded at launch. */
export async function assertSameSessionResumeCompatibleV1(root: string, operation: OperationRecordV2, participantId: string): Promise<void> {
  const participant = operation.participants[participantId];
  const binding = participant?.executionBinding;
  if (!participant || !binding || binding.runtime.sessionId.startsWith("launch:")) throw createTrustedOperationToolError("SAME_SESSION_RESUME_REJECTED", "a current actual participant session identity is required.", undefined, operation.id);
  if (["COMPLETED", "CANCELLED", "BLOCKED"].includes(participant.status)) throw createTrustedOperationToolError("SAME_SESSION_RESUME_REJECTED", "completed, cancelled, or blocked participant work cannot be resumed.", undefined, operation.id);
  if (!participant.transport?.startsWith("paseo")) return;
  const stored = await loadPaseoSessionBinding(root, operation.id, participantId);
  const expected = {
    projectId: operation.candidateRevision?.projectId ?? operation.resolvedOperationPolicy?.projectId ?? "",
    operationId: operation.id,
    operationExecutionRevision: binding.operationExecutionRevision,
    participantId,
    participantGeneration: binding.participantGeneration,
    candidateRevision: binding.candidateRevision,
    candidateDigest: binding.candidateDigest,
    executionBlueprintDigest: binding.executionBlueprintDigest,
    operationPolicyDigest: binding.operationPolicyDigest,
    contextManifestDigest: binding.contextManifestDigest,
    promptManifestDigest: binding.promptManifestDigest,
    controllerEpoch: binding.controllerEpoch
  };
  const reusable = resolveReusablePaseoSession(stored, expected);
  if (!reusable || reusable.paseoAgentId !== binding.runtime.sessionId) throw createTrustedOperationToolError("SAME_SESSION_RESUME_REJECTED", "Paseo session binding is missing, archived, lost, or incompatible with the current candidate, policy, epoch, participant generation, context, or prompt.", undefined, operation.id);
}
