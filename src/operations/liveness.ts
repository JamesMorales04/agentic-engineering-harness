import type { HarnessProjectConfig } from "../core/types.js";
import { loadFrozenSkillContext } from "../core/controlPlane.js";
import { dispatchManagedPaseoAgent } from "../paseo/runtime.js";
import { loadOperation } from "./state.js";
import { supervisorEventSkills } from "./supervisorEventPolicy.js";
import { monitorOperationLiveness as monitorV2, runOperationLivenessCheck as checkV2, startOperationWatchdog as startV2, type OperationLivenessDeps, type OperationWakeDecision } from "./livenessV2.js";

export * from "./livenessV2.js";

export async function runOperationLivenessCheck(root: string, config: HarnessProjectConfig, operationId: string, deps: OperationLivenessDeps = {}): Promise<OperationWakeDecision> {
  return checkV2(root, config, operationId, scopedDispatch(root, config, operationId, deps));
}
export async function monitorOperationLiveness(root: string, config: HarnessProjectConfig, operationId: string, deps: OperationLivenessDeps = {}): Promise<void> {
  return monitorV2(root, config, operationId, scopedDispatch(root, config, operationId, deps));
}
export function startOperationWatchdog(root: string, config: HarnessProjectConfig, operationId: string, deps: OperationLivenessDeps = {}): () => void {
  return startV2(root, config, operationId, scopedDispatch(root, config, operationId, deps));
}

function scopedDispatch(root: string, config: HarnessProjectConfig, operationId: string, deps: OperationLivenessDeps): OperationLivenessDeps {
  const dispatch = deps.dispatch ?? dispatchManagedPaseoAgent;
  return { ...deps, dispatch: async (dispatchRoot, agentId, prompt, timeoutSeconds) => {
    if (!prompt.includes("[AEH_OPERATION_WATCHDOG]")) return dispatch(dispatchRoot, agentId, prompt, timeoutSeconds);
    const operation = await loadOperation(root, operationId).catch(() => undefined);
    if (!operation) return dispatch(dispatchRoot, agentId, prompt, timeoutSeconds);
    const skillContext = await loadFrozenSkillContext(root, config, operation.id, supervisorEventSkills("recover", operation.kind)).catch(() => undefined);
    const effective = skillContext ? `${prompt}\n\nFrozen semantic skill context for this wake:\n${skillContext}` : prompt;
    return dispatch(dispatchRoot, agentId, effective, timeoutSeconds);
  } };
}
