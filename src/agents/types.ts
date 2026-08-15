export type AgentRole = "orchestrator" | "planner" | "implementer" | "reviewer" | "validator" | "explorer" | "librarian" | "coordinator" | "escalation" | string;
export type AgentRisk = "low" | "medium" | "high";
export type PermissionDecision = "allow" | "ask" | "deny";
export type AgentTransport = "inherit" | "paseo" | "direct" | "podman";
export type ContextCapabilityRequirement = "REQUIRED" | "OPTIONAL" | "FORBIDDEN";
export interface ContextCapabilityRequirements {
  repositoryMap?: ContextCapabilityRequirement;
  semanticRetrieval?: ContextCapabilityRequirement;
  rawRetrieval?: ContextCapabilityRequirement;
  compression?: ContextCapabilityRequirement;
}
export interface RuntimeCapabilities {
  nativeAgent?: boolean;
  nativeAgentViaPaseo?: boolean;
  modelSelection?: boolean;
  variantSelection?: boolean;
  sessions?: boolean;
  structuredOutput?: boolean;
  mcp?: boolean;
  stdioMcp?: boolean;
  runtimeConfigInjection?: boolean;
  nativeToolProjection?: boolean;
  localMcp?: boolean;
}
export interface RuntimeDefinition { adapter: "codex" | "opencode" | string; paseoProvider?: string; command?: string; defaultArgs?: string[]; capabilities?: RuntimeCapabilities; }
export interface RuntimeOverride extends Partial<Omit<RuntimeDefinition, "capabilities">> { capabilities?: Partial<RuntimeCapabilities>; }
export interface ModelDefinition { runtime: string; provider?: string; model: string; variant?: string; temperature?: number; options?: Record<string, unknown>; }
export interface ModelOverride extends Partial<Omit<ModelDefinition, "options">> { options?: Record<string, unknown>; }
export interface AgentPermissions { read?: PermissionDecision; write?: PermissionDecision; shell?: PermissionDecision; network?: PermissionDecision; delegate?: PermissionDecision; review?: PermissionDecision; validate?: PermissionDecision; gitWrite?: PermissionDecision; }
export interface AgentExecutionDefinition { model: string; runtime?: string; nativeAgent?: string; variant?: string; args?: string[]; transport?: AgentTransport; }
export interface AgentDefinition { role: AgentRole; domains?: string[]; description?: string; execution: AgentExecutionDefinition; temperature?: number; skills?: string[]; mcps?: string[]; promptPath?: string; orchestratorPromptPath?: string; outputContract?: string; permissions?: AgentPermissions; capabilities?: string[]; contextRequirements?: ContextCapabilityRequirements; disabled?: boolean; }
export interface AgentOverride { role?: AgentRole; domains?: string[]; execution?: Partial<AgentExecutionDefinition>; temperature?: number; skills?: string[]; mcps?: string[]; promptPath?: string; orchestratorPromptPath?: string; outputContract?: string; permissions?: AgentPermissions; capabilities?: string[]; contextRequirements?: Partial<ContextCapabilityRequirements>; disabled?: boolean; description?: string; }
export interface AgentProfile { description?: string; models?: Record<string, ModelOverride>; agents?: Record<string, AgentOverride>; }
export interface RoutingCondition { intent?: string | string[]; domains?: string[]; files?: string[]; risk?: AgentRisk | AgentRisk[]; }
export interface RoutingRule { id: string; priority?: number; when: RoutingCondition; use?: string; reviewers?: string[]; validators?: string[]; }
export type FailureType = "PATCH_CONTEXT_MISMATCH" | "TOOL_FAILURE" | "MISSING_CONTEXT" | "WRONG_AGENT" | "VALIDATION_FAILURE" | "REVIEW_FAILURE" | "AMBIGUOUS_OUTPUT" | "CONFLICTING_RESULTS";
export interface RecoveryStep { action: "same-agent" | "reroute" | "agent" | "lead" | "stop"; agent?: string; }
export type RecoveryMap = Partial<Record<FailureType, RecoveryStep[]>> & Record<string, RecoveryStep[] | undefined>;
export interface CouncilDefinition { members: Array<{ model: string; agent?: string }>; executionMode?: "parallel" | "sequential"; }
export interface AgentTopologyRemove { runtimes?: string[]; models?: string[]; agents?: string[]; profiles?: string[]; routing?: string[]; councils?: string[]; }
export interface AgentTopologyLayer {
  version: 1;
  extends?: string[];
  activeProfile?: string;
  skillRoots?: string[];
  runtimes?: Record<string, RuntimeOverride>;
  models?: Record<string, ModelOverride>;
  agents?: Record<string, AgentOverride>;
  profiles?: Record<string, AgentProfile>;
  routing?: RoutingRule[];
  recovery?: RecoveryMap;
  councils?: Record<string, CouncilDefinition>;
  remove?: AgentTopologyRemove;
}
export interface AgentTopologySource { version: 1; activeProfile?: string; skillRoots?: string[]; runtimes: Record<string, RuntimeDefinition>; models: Record<string, ModelDefinition>; agents: Record<string, AgentDefinition>; profiles?: Record<string, AgentProfile>; routing?: RoutingRule[]; recovery?: RecoveryMap; councils?: Record<string, CouncilDefinition>; }
export interface ResolvedModelDefinition extends ModelDefinition { alias: string; id: string; }
export interface ResolvedAgentDefinition extends Omit<AgentDefinition, "execution"> { name: string; execution: AgentExecutionDefinition; runtime: RuntimeDefinition & { name: string }; model: ResolvedModelDefinition; }
export interface ResolvedAgentTopology { version: 1; profile?: string; skillRoots: string[]; runtimes: Record<string, RuntimeDefinition>; models: Record<string, ResolvedModelDefinition>; agents: Record<string, ResolvedAgentDefinition>; routing: RoutingRule[]; recovery: RecoveryMap; councils: Record<string, CouncilDefinition>; }
export interface AgentRouteContext { intent: string; domains?: string[]; files?: string[]; risk?: AgentRisk; }
export interface ResolvedRoute { ruleIds: string[]; agent?: string; reviewers: string[]; validators: string[]; reasons: string[]; }
export interface AgentExecutionSelection { profile?: string; logicalAgent: string; role: AgentRole; domains: string[]; description?: string; contextRequirements?: ContextCapabilityRequirements; runtimeName: string; runtimeAdapter: string; paseoProvider: string; modelAlias: string; modelId: string; modelName: string; modelProvider?: string; variant?: string; nativeAgent?: string; transport: AgentTransport; temperature?: number; skills: string[]; mcps: string[]; permissions: AgentPermissions; outputContract?: string; args: string[]; runtimeCapabilities: RuntimeCapabilities; }
