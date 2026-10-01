import { type ManagedLeadAcceptanceEvidenceV1 } from "../architecture/acceptanceOracle.js";
import type { CandidateAssuranceCompilationV1 } from "../architecture/candidateAssurance.js";
import type { ValidationReport } from "../core/types.js";
export declare function requestManagedLeadAcceptance(input: {
    root: string;
    operationId: string;
    compilation: CandidateAssuranceCompilationV1;
    report: ValidationReport;
    implementationIdentity: string;
}): Promise<ManagedLeadAcceptanceEvidenceV1 | undefined>;
