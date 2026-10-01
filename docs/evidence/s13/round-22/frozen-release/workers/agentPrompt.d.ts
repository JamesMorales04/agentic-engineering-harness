import type { AgentExecutionSelection } from "../agents/types.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import { loadOperation } from "../operations/state.js";
import { type StructuredResultProvenanceV1 } from "./resultGateway.js";
import { type EffectiveContextCapabilities } from "../context/transport.js";
import type { ContextFragment } from "../context/types.js";
import { type DirectWorkerHome } from "./directProcess.js";
import { type ExecutionAuthorityV1 } from "../security/executionLease.js";
import { type ExecutionBindingV2, type ExecutionBlueprintV2, type RoleInvocationPolicyV1, type SkillManifestV1 } from "../architecture/executionIdentity.js";
export interface AgentPromptOptions {
    outputContract?: string;
    resumeSessionId?: string;
    /**
     * Explicit continuation of an already-bound participant generation on its exact durable session.
     * A continuation turn may deliver a new event prompt/context to the same session; all other
     * binding identity (operation, candidate, execution revision, blueprint, policy, controller
     * epoch, participant generation, runtime session) must still match exactly. Used by the
     * persistent Operation Supervisor for per-event semantic turns (initialization, consolidation,
     * watchdog coordination) where the session binding is generation-scoped and each turn is
     * activated as its own structured-result turn. Never set by participant launch paths.
     */
    continueBoundSession?: boolean;
    /** Actual runtime session observed or reserved before dispatching this turn. */
    executionSessionId?: string;
    /** Shared isolated home that owns a prepared direct-runtime session. */
    directWorkerHome?: DirectWorkerHome;
    /** Idle Paseo provider session materialized before its first semantic turn. */
    materializedPaseoSession?: WorkerSession;
    phase?: string;
    operationKind?: string;
    parentAgentId?: string;
    supervisorAgent?: boolean;
    contextCapabilities?: EffectiveContextCapabilities;
    participantId?: string;
    capabilityAuthority?: ExecutionAuthorityV1;
    requireExecutionAuthority?: boolean;
    executionBlueprintDigest?: string;
    resolvedOperationPolicyDigest?: string;
    executionBinding?: ExecutionBindingV2;
    executionBlueprint?: ExecutionBlueprintV2;
    roleInvocationPolicy?: RoleInvocationPolicyV1;
    skillManifest?: SkillManifestV1;
    contextManifest?: Readonly<Record<string, unknown>>;
    contextManifestDigest?: string;
    promptManifestDigest?: string;
    preparedPrompt?: string;
    structuredResultProvenance?: StructuredResultProvenanceV1;
}
export interface CapturedContractValidation {
    ok: boolean;
    failure?: string;
}
export declare function executeAgentPrompt(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, prompt: string, options?: AgentPromptOptions): Promise<WorkerSession>;
export declare function materializeAgentPrompt(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, options?: AgentPromptOptions): Promise<WorkerSession | undefined>;
export declare function prepareAgentExecutionBinding(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, prompt: string, options: AgentPromptOptions): Promise<{
    binding: ExecutionBindingV2;
    authority: ExecutionAuthorityV1;
    prompt: string;
    contextManifest: Readonly<Record<string, unknown>>;
    executionBlueprint: ExecutionBlueprintV2;
    roleInvocationPolicy: RoleInvocationPolicyV1;
    skillManifest: SkillManifestV1;
}>;
export interface PreparedAgentExecutionIdentity {
    authority: ExecutionAuthorityV1;
    prompt: string;
    contextManifest: Readonly<Record<string, unknown>>;
    contextManifestDigest: string;
    promptManifestDigest: string;
    executionBlueprint: ExecutionBlueprintV2;
    roleInvocationPolicy: RoleInvocationPolicyV1;
    skillManifest: SkillManifestV1;
}
/** Compile all controller-owned identity needed for a remote worker before it acquires its actual runtime session. */
export declare function prepareAgentExecutionIdentity(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, prompt: string, options: AgentPromptOptions): Promise<PreparedAgentExecutionIdentity>;
export declare function dispatchMaterializedAgentPrompt(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, materialized: WorkerSession | undefined, prompt: string, options?: AgentPromptOptions): Promise<WorkerSession>;
export declare function resumeAgentPrompt(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, previous: WorkerSession, prompt: string, options?: Omit<AgentPromptOptions, "resumeSessionId">): Promise<WorkerSession>;
export declare function validateCapturedAgentContract(contractName: string, stdout: string, stderr?: string): CapturedContractValidation;
export declare function buildAgentContextFragments(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, prompt: string, options?: AgentPromptOptions): Promise<{
    fragments: ContextFragment[];
    capabilities: {
        authorizedRetrieval: boolean;
        semanticRetrieval: boolean;
    };
}>;
export declare function buildEffectivePrompt(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, prompt: string, options?: AgentPromptOptions): Promise<string>;
export declare function buildEffectivePromptIdentity(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, prompt: string, options?: AgentPromptOptions): Promise<{
    prompt: string;
    contextManifest: Readonly<Record<string, unknown>>;
    contextManifestDigest: string;
    promptManifestDigest: string;
}>;
/**
 * The durable operation state root that owns transcripts, accepted structured results, and
 * receipts. Isolated candidate-mutation runs execute in a disposable worktree but must still
 * persist and resolve operation artifacts under the operation's control root.
 */
export declare function operationArtifactRoot(root: string): string;
/**
 * Reserve the provider's durable session before freezing ExecutionBinding.
 * OpenCode and Codex have idle-session APIs. Paseo uses the separate managed
 * idle-agent materialization path before binding and first-turn dispatch.
 * Podman prepares the same OpenCode home that is mounted into the hardened
 * execution container.
 */
export declare function prepareRuntimeSession(root: string, config: HarnessProjectConfig, selection: AgentExecutionSelection, options: AgentPromptOptions, authority: ExecutionAuthorityV1 | undefined, transport: string, onHome?: (home: DirectWorkerHome) => void): Promise<string>;
export declare function assertResultProvenanceMatchesExecution(provenance: StructuredResultProvenanceV1, operation: Awaited<ReturnType<typeof loadOperation>> | undefined, contract: TaskContract, selection: AgentExecutionSelection, options: AgentPromptOptions, continuation?: boolean): void;
