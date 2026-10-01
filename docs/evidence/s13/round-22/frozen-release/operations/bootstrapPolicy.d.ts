import type { AssuranceLevel, ImplementationRoute } from "../architecture/contracts.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { type OperationRecordV2 } from "./state.js";
/**
 * DETERMINISTIC provisional bootstrap policy for a fresh candidate. It carries the
 * `knowledgePolicy.bootstrap` marker, so the first real execution-semantics bind replaces it and
 * advances the operation execution revision instead of treating it as a frozen baseline. The
 * controller binds it after every candidate bind (workspace candidate, controller-owned authoring
 * advance) because binding a candidate clears the frozen policy.
 */
export declare function bindBootstrapOperationPolicy(root: string, config: HarnessProjectConfig, operation: OperationRecordV2, route: ImplementationRoute, minimumAssurance: AssuranceLevel, contract?: TaskContract): Promise<OperationRecordV2>;
