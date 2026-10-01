export interface HarnessAssetReconcileResult {
    manifestPath: string;
    created: string[];
    updated: string[];
    removed: string[];
    preservedOverrides: string[];
    unchanged: string[];
}
export interface HarnessAssetReconcileOptions {
    packageRoot?: string;
    aehVersion?: string;
}
export declare function reconcileHarnessAssets(root: string, options?: HarnessAssetReconcileOptions): Promise<HarnessAssetReconcileResult>;
