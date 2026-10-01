import type { HarnessProjectConfig } from "../core/types.js";
export interface PolicyBundleFile {
    path: string;
    sha256: string;
}
export interface OrganizationPolicyBundleManifest {
    version: 1;
    name: string;
    extends?: string[];
    policyDirs?: string[];
    files: PolicyBundleFile[];
}
export interface ResolvedPolicyBundle {
    name: string;
    root: string;
    manifestSha256: string;
    verifiedSignature: boolean;
    policyDirs: string[];
    extends: string[];
}
export interface PolicyBundleResolution {
    bundles: ResolvedPolicyBundle[];
    policyDirs: string[];
    issues: string[];
}
export declare function resolveOrganizationPolicyBundles(root: string, config: HarnessProjectConfig): Promise<PolicyBundleResolution>;
export declare function withOrganizationPolicies(config: HarnessProjectConfig, resolution: PolicyBundleResolution): HarnessProjectConfig;
