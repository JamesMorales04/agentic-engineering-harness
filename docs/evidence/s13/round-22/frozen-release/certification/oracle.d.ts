import type { CertificationCheck, CertificationOracleResult } from "./types.js";
/** Construct oracle output and make the deterministic acceptance rule explicit. */
export declare function createCertificationOracleResult(input: {
    oracleId: string;
    independent?: boolean;
    checks: CertificationCheck[];
    evidence?: Record<string, unknown>;
}): CertificationOracleResult;
export declare function oracleCanAccept(result: CertificationOracleResult, policy: {
    allowRequiredSkippedChecks: boolean;
}): boolean;
