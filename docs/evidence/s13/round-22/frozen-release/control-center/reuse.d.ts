import type { RuntimeSnapshotV1 } from "../runtime/supervisorV2.js";
export interface ReusableControlCenterV1 {
    url: string;
}
/** Select a project-owned Control Center only when it supports current-session Lead routing. */
export declare function reusableControlCenterFromSnapshot(root: string, snapshot: RuntimeSnapshotV1): ReusableControlCenterV1 | undefined;
export declare function controlCenterHealthCheck(url: string): Promise<boolean>;
