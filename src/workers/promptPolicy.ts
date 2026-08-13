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
    return `AEH output contract: ${contractName}. This is a serialization-repair turn; structured-output-delivery governs the exact marker format.`;
  }
  if (nativeSchema) {
    return [
      `AEH output contract: ${contractName}.`,
      "The exact JSON Schema is supplied out-of-band and validated deterministically by the runtime.",
      "Return only the contract result; do not add prose or Markdown around it."
    ].join("\n");
  }
  const schema = outputJsonSchema(contractName);
  return [
    `AEH output contract: ${contractName}. Runtime validation is authoritative.`,
    "This transport cannot enforce the schema out-of-band, so match the compact schema below exactly and return no prose.",
    schema ? `Schema: ${JSON.stringify(schema)}` : undefined
  ].filter(Boolean).join("\n");
}
