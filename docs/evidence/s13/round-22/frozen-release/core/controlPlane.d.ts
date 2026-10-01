import type { HarnessProjectConfig } from "./types.js";
export interface ControlPlaneFile {
    path: string;
    sha256: string;
    size: number;
}
export interface ControlPlaneSnapshot {
    version: 1;
    taskId: string;
    createdAt: string;
    aehVersion?: string;
    gitCommit?: string;
    sourceRoot: string;
    materializedRoot: string;
    includeRoots: string[];
    files: ControlPlaneFile[];
    compositeSha256: string;
}
export interface ControlPlaneDrift {
    changed: string[];
    missing: string[];
    added: string[];
    drifted: boolean;
}
export declare function createControlPlaneSnapshot(root: string, config: HarnessProjectConfig, taskId: string): Promise<ControlPlaneSnapshot>;
export declare function materializeControlPlaneSnapshot(snapshot: ControlPlaneSnapshot, targetRoot: string, config: HarnessProjectConfig): Promise<ControlPlaneSnapshot>;
export declare function materializeControlPlaneRuntimeSurface(snapshot: ControlPlaneSnapshot, targetRoot: string): Promise<void>;
export declare function detectControlPlaneDrift(root: string, snapshot: ControlPlaneSnapshot): Promise<ControlPlaneDrift>;
export declare function loadFrozenSkillContext(root: string, config: HarnessProjectConfig, taskId: string, skills: string[]): Promise<string | undefined>;
export declare function controlPlanePolicyRoot(snapshot: ControlPlaneSnapshot): string;
export declare function loadControlPlaneSnapshot(root: string, config: HarnessProjectConfig, taskId: string): Promise<ControlPlaneSnapshot | undefined>;
