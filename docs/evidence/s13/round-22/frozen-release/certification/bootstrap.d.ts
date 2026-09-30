import type { AgentProvider } from "./core.js";
import type { AgentProviderRequest, CertificationOracle, CertificationPolicy, CertificationReport } from "./types.js";
export interface BootstrapFixture {
    sourceDir: string;
    setup?: Array<{
        command: string;
        args: string[];
        timeoutMs?: number;
    }>;
}
export interface ExternalSelfDogfoodRequest {
    root: string;
    fixture: BootstrapFixture;
    oracle: CertificationOracle;
    policy?: CertificationPolicy;
    provider?: AgentProvider;
    actor?: (candidateRoot: string) => AgentProviderRequest;
    capability?: import("./types.js").CertificationCapability;
    requireModelE2E?: boolean;
    persistRoot?: string;
    persistDirectory?: string;
}
export interface CommandOracleOptions {
    command: string;
    args?: string[];
    timeoutMs?: number;
    maxOutputBytes?: number;
    requireModelEvidence?: boolean;
}
/** Deterministic black-box oracle for a fixture command; model output is never consulted. */
export declare function createCommandOracle(options: CommandOracleOptions): CertificationOracle;
/** Pack the checkout and run it only inside a disposable fixture. */
export declare function runExternalSelfDogfood(input: ExternalSelfDogfoodRequest): Promise<CertificationReport>;
/** Extract the npm pack JSON payload; npm 10 may emit a package `prepare` build before the JSON array. */
export declare function parsePackFilename(stdout: string): string;
