export interface BuildIdentityV1 {
    version: 1;
    packageVersion: string;
    gitSha: string;
    releaseId: string;
    buildDigest: string;
    dirty: boolean;
}
/** One immutable identity for the running AEH build. */
export declare function getBuildIdentity(): BuildIdentityV1;
export declare function isBuildIdentityV1(value: unknown): value is BuildIdentityV1;
