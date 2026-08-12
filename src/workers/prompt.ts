import type { RepairPacket, TaskContract } from "../core/types.js";

export function buildWorkerPrompt(contract: TaskContract): string {
  const sources = Object.entries(contract.source ?? {}).filter(([, value]) => Boolean(value)).map(([key, value]) => `- ${key}: ${value}`).join("\n");
  const requirements = (contract.requirements ?? []).map((item) => `- ${item.id}: ${item.description ?? "see spec"}`).join("\n");
  return `You are the implementation worker for task ${contract.task.id}: ${contract.task.title}.

The lead agent owns architecture and requirements. Implement only the approved task contract.

Read these authoritative artifacts before editing:
${sources || "- TaskContract only"}

Requirements:
${requirements || "- See TaskContract/spec"}

Rules:
- Do not modify the TaskContract, its seal, or SDD/acceptance artifacts.
- Do not expand scope or redesign unrelated architecture.
- Respect allowed/forbidden paths and dependency/schema constraints.
- Add or update implementation-level tests as needed; do not weaken frozen acceptance criteria.
- Run focused checks before reporting completion.
- If a Graphify skill is available, refresh the graph after implementation so structural validation can compare before/after state.
- Report files changed, tests run, results, deviations and remaining concerns.
`;
}

export function buildRepairPrompt(packet: RepairPacket): string {
  const failures = packet.failures.map((failure) => {
    const details = failure.details ? `\n  evidence: ${JSON.stringify(failure.details)}` : "";
    return `- ${failure.id} [${failure.category}]: ${failure.message}${details}`;
  }).join("\n");
  return `Repair attempt ${packet.attempt} for ${packet.taskId}.

The deterministic harness rejected the implementation for these reasons:
${failures}

Make the smallest targeted changes needed to satisfy these failures. Do not modify frozen contracts/specs/acceptance artifacts and do not broaden scope. Re-run the focused failing checks before reporting completion.`;
}
