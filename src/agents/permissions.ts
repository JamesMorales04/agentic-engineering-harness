import type { AgentExecutionSelection } from "./types.js";

export function validateExecutionCapabilities(selection: AgentExecutionSelection, transport: string): string[] {
  const issues: string[] = [];
  if (selection.nativeAgent && selection.runtimeCapabilities.nativeAgent === false) issues.push(`Runtime ${selection.runtimeName} cannot select native agent ${selection.nativeAgent}.`);
  if (selection.nativeAgent && transport === "paseo" && selection.runtimeCapabilities.nativeAgentViaPaseo !== true) issues.push(`Agent ${selection.logicalAgent} requires nativeAgent=${selection.nativeAgent}, but runtime ${selection.runtimeName} does not declare nativeAgentViaPaseo. Use transport=direct/podman or configure a Paseo provider that exposes this native agent.`);
  if (selection.variant && selection.runtimeCapabilities.variantSelection === false) issues.push(`Runtime ${selection.runtimeName} cannot select variant ${selection.variant}.`);
  if (selection.role === "implementer" && selection.permissions.write === "deny") issues.push(`Implementer ${selection.logicalAgent} denies write permission.`);
  if ((selection.role === "reviewer" || selection.role === "validator") && selection.permissions.write === "allow") issues.push(`${selection.role} ${selection.logicalAgent} explicitly allows writes; read-only roles should use write=deny unless intentionally mutating.`);
  if (selection.role === "orchestrator" && selection.permissions.delegate === "deny") issues.push(`Orchestrator ${selection.logicalAgent} denies delegation.`);
  return issues;
}

export function permissionSummary(selection: AgentExecutionSelection): string { return Object.entries(selection.permissions).map(([key, value]) => `${key}=${value}`).join(", ") || "unspecified"; }
