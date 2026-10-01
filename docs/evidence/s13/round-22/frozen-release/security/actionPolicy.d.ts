import type { HarnessProjectConfig } from "../core/types.js";
import type { OperationKind } from "../operations/state.js";
import type { HumanDecisionRequirementV1 } from "../architecture/executionIdentity.js";
import type { ToolActionKindV1 } from "./actionKinds.js";
/** Deterministic allowlist for externally observable delivery effects. */
export declare function configuredExternalEffects(config: HarnessProjectConfig, kind: OperationKind): ToolActionKindV1[];
/** External publication and non-idempotent creation always need exact human action authorization. */
export declare function requiredHumanActionAuthorizations(effects: readonly ToolActionKindV1[]): HumanDecisionRequirementV1[];
