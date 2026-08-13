import type { AgentExecutionSelection } from "../agents/types.js";
import { outputJsonSchema } from "../agents/outputContracts.js";
import type { TaskContract } from "../core/types.js";

export interface AgentPromptPolicyOptions {
  outputContract?: string;
  phase?: string;
  operationKind?: string;
  transport: string;
}

export interface AgentPromptPolicy {
  skills: string[];
  outputContractContext?: string;
}

export function compileAgentPromptPolicy(
  selection: AgentExecutionSelection,
  contract: TaskContract,
  options: AgentPromptPolicyOptions
): AgentPromptPolicy {
  const skills = new Set((selection.skills ?? []).filter((skill) => skill !== "structured-output-delivery"));
  const contractRepair = options.phase?.endsWith("-contract-repair") ?? false;

  if (options.operationKind === "audit" && selection.role === "reviewer") {
    skills.add("audit-review-protocol");
    skills.delete("verification-planning");
    if (!hasTraceableAcceptance(contract)) skills.delete("acceptance-traceability");
  }

  if (contractRepair && selection.logicalAgent === "operation-supervisor") skills.clear();
  if (contractRepair) skills.add("structured-output-delivery");

  return {
    skills: [...skills],
    outputContractContext: options.outputContract
      ? outputContractContext(options.outputContract, nativeSchemaEnforced(selection, options.transport), contractRepair)
      : undefined
  };
}

export function hasTraceableAcceptance(contract: TaskContract): boolean {
  return Boolean(contract.requirements?.length || contract.quick?.acceptance?.length || contract.source?.acceptance);
}

export function nativeSchemaEnforced(selection: AgentExecutionSelection, transport: string): boolean {
  if (transport === "paseo") return true;
  return transport === "direct" && selection.runtimeAdapter === "codex";
}

export function outputContractContext(contractName: string, nativeSchema: boolean, repair = false): string {
  if (repair) {
    return [
      `AEH output contract: ${contractName}. This is a serialization-repair turn.`,
      "If the capability-scoped aeh_submit_result tool is available, submit the already-established contract payload through it; a successful durable submission is authoritative.",
      "Do not redo semantic work. If the result tool is unavailable, structured-output-delivery governs the compatibility marker fallback."
    ].join("\n");
  }
  if (nativeSchema) {
    return [
      `AEH output contract: ${contractName}.`,
      "The exact JSON Schema is supplied out-of-band and validated deterministically by the runtime.",
      "If aeh_submit_result is available, submit exactly the final contract payload through it before completing; that durable result is lifecycle-authoritative.",
      "A provider-required native structured final may repeat the same payload for transport compatibility, but must not represent a different semantic result."
    ].join("\n");
  }
  const schema = outputJsonSchema(contractName);
  return [
    `AEH output contract: ${contractName}. Runtime validation is authoritative.`,
    "If aeh_submit_result is available, submit exactly the final contract payload through it; the durable result is authoritative.",
    "Otherwise this transport cannot enforce the schema out-of-band, so match the compact schema below exactly and return no prose.",
    schema ? `Schema: ${JSON.stringify(schema)}` : undefined
  ].filter(Boolean).join("\n");
}
