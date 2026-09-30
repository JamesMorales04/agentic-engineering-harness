import type { ContextFragment, ContextFragmentProjection } from "../types.js";
export type OperationProjectionPhase = "INITIALIZE" | "COORDINATE" | "CONSOLIDATE" | "RECOVER" | "HANDOFF";
export declare function projectOperation(fragment: ContextFragment, phase?: OperationProjectionPhase): ContextFragmentProjection;
