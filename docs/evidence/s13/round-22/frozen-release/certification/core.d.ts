import type { AgentProviderRequest, AgentProviderResult, CandidateRevision, CertificationOracle, CertificationPolicy, CertificationReport, CertificationRequest } from "./types.js";
export interface AgentProvider {
    readonly name: string;
    /** The provider must explicitly prove OS-level network isolation before denied-network requests run. */
    readonly networkIsolation: "enforced" | "unavailable";
    execute(request: AgentProviderRequest): Promise<AgentProviderResult>;
}
export declare class CertificationCore {
    private readonly oracle;
    private readonly provider?;
    constructor(oracle: CertificationOracle, provider?: AgentProvider | undefined);
    certify(input: CertificationRequest): Promise<CertificationReport>;
}
export declare function assertCertificationEntryAllowed(policy: Pick<CertificationPolicy, "security">): void;
export declare function assertProviderRequest(request: AgentProviderRequest, candidate: CandidateRevision, policy: CertificationPolicy): void;
