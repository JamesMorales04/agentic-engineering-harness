import type { HarnessProjectConfig } from "../core/types.js";
import { runShell } from "../utils/process.js";
export interface OpenSpecAuthoringConfig {
    provider?: "openspec" | "native" | string;
    schema?: string;
    managerAgent?: string;
}
export interface OpenSpecPreparedChange {
    taskId: string;
    changeName: string;
    directory: string;
    schema: string;
    managerAgent: string;
}
export interface OpenSpecCompileResult {
    taskId: string;
    changeName: string;
    sddDirectory: string;
    contractPath: string;
    requirements: string[];
    sourceSha256: string;
    validatorId: string;
}
export interface OpenSpecPreflightResult {
    version: string;
    schema: string;
    managerAgent: string;
}
/** One capability's canonical OpenSpec change spec delta (`specs/<capability>/spec.md`). */
export interface OpenSpecSpecDeltaV1 {
    capability: string;
    content: string;
}
export interface OpenSpecAuthoringContentV1 {
    proposal: string;
    design?: string;
    tasks: string;
    specs: readonly OpenSpecSpecDeltaV1[];
}
export declare function openSpecAuthoringConfig(config: HarnessProjectConfig): Required<Pick<OpenSpecAuthoringConfig, "provider" | "schema" | "managerAgent">>;
export declare function openSpecChangeName(taskId: string): string;
export declare function preflightOpenSpec(root: string, config: HarnessProjectConfig, run?: typeof runShell): Promise<OpenSpecPreflightResult>;
export declare function prepareOpenSpecChange(root: string, config: HarnessProjectConfig, taskId: string): Promise<OpenSpecPreparedChange>;
export declare const OPENSPEC_CAPABILITY_NAME_PATTERN: RegExp;
/**
 * DETERMINISTIC pre-persistence canonicality gate for a READY Spec Manager result. OpenSpec
 * compilation (`openspec validate --strict`) requires a canonical change layout; accepting a
 * typed-but-non-canonical READY result would persist unusable content and fail later inside the
 * compiler with a generic error. This gate rejects the result before any controller-owned write,
 * with a typed `SPEC_MANAGER_CONTENT_NOT_CANONICAL` error naming the exact artifact.
 */
export declare function validateOpenSpecSpecDeltaCanonicalityV1(changeName: string, index: number, spec: OpenSpecSpecDeltaV1): void;
export declare function validateOpenSpecAuthoringContentCanonicalityV1(changeName: string, content: Pick<OpenSpecAuthoringContentV1, "specs">): void;
/** Persist the validated Spec Manager's structured authoring content using controller-owned writes. */
export declare function persistOpenSpecAuthoringContentV1(root: string, changeName: string, content: OpenSpecAuthoringContentV1): Promise<string[]>;
export declare function compileOpenSpecChange(root: string, config: HarnessProjectConfig, taskId: string, title: string, changeName?: string, run?: typeof runShell): Promise<OpenSpecCompileResult>;
