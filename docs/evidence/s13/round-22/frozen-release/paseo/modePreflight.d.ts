export interface PaseoProviderModePreflightResult {
    ok: boolean;
    provider: string;
    modeId: string;
    availableModes: string[];
    source: "paseo-provider-modes";
    message: string;
}
/**
 * Validate an externally-authored provider mode before AEH dispatches work.
 * This is intentionally fail-closed: an explicit nativeAgent is part of the
 * frozen execution contract, so silently falling back to an ambient default
 * would execute a different agent than the one AEH selected.
 */
export declare function preflightPaseoProviderMode(root: string, provider: string, modeId: string, cwd?: string): Promise<PaseoProviderModePreflightResult>;
