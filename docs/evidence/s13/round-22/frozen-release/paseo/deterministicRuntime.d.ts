import type { PaseoRuntimeDeps } from "./runtimeCore.js";
/**
 * File-scripted deterministic implementation of the existing Paseo runtime
 * boundary. It replaces only the external model conversation for fixture
 * journeys selected by AEH_DETERMINISTIC_PASEO_RUNTIME=1; controller state,
 * execution bindings, provider leases, context authorization, and structured
 * result provenance all run unchanged. It is not a REAL_PROVIDER capability.
 */
export declare const DETERMINISTIC_RUNTIME_ENV = "AEH_DETERMINISTIC_PASEO_RUNTIME";
export declare function isDeterministicPaseoRuntimeEnabled(): boolean;
/**
 * Scripted fixture sessions have no external process. The prefix is unambiguous,
 * so lifecycle owners without the runtime environment (for example the paired
 * Control Center performing cancellation) can still skip them safely.
 */
export declare function isDeterministicPaseoSessionId(agentId: string | undefined): boolean;
export declare function deterministicPaseoRuntimeDeps(): PaseoRuntimeDeps;
