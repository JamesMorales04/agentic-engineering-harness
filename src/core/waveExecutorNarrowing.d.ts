import type { AgentExecutionSelection } from "../agents/types.js";
import type { PlannerWaveResult } from "../agents/waveExecutor.js";
import type { ControlPlaneSnapshot } from "./controlPlane.js";
import type { HarnessProjectConfig, TaskContract, ValidationReport } from "./types.js";
import type { ResolvedAgentTopology } from "../agents/types.js";

/**
 * TypeScript cannot retain narrowing of the mutable `selection` variable in
 * core/run.ts through the derived `planningEnabled` boolean because selection
 * may later be reassigned by recovery routing. Runtime execution of this
 * overload is still guarded by `planningEnabled`, which requires a concrete
 * selection before executePlannerWaves is called.
 *
 * This overload is intentionally local to the core caller; it does not alter
 * the runtime implementation or make undefined a valid planner selection.
 */
declare module "../agents/waveExecutor.js" {
  export function executePlannerWaves(input: {
    root: string;
    stateRoot: string;
    config: HarnessProjectConfig;
    contract: TaskContract;
    topology: ResolvedAgentTopology;
    implementationSelection: AgentExecutionSelection | undefined;
    controller?: ControlPlaneSnapshot;
    revalidate: () => Promise<ValidationReport>;
  }): Promise<PlannerWaveResult>;
}
