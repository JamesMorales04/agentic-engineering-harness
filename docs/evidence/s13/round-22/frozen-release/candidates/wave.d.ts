import { type ResourceClaimV1 } from "../architecture/workGraph.js";
import { type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { type CandidateImpactAssessmentRuntimeV1, type CandidateImpactV1, type ChangeSetV1 } from "./assembler.js";
/**
 * A wave base is the frozen candidate every worker in one parallel wave
 * actually observed. Sibling ChangeSets keep that base forever; when a later
 * sibling must be integrated on top of an earlier sibling the integration
 * produces an explicit derived ChangeSet instead of rewriting the original.
 */
export interface WaveBaseV1 {
    version: 1;
    operationId: string;
    taskId: string;
    waveIndex: number;
    candidate: CandidateRevisionV1;
    frozenAt: string;
}
export interface WaveChangeSetSubmissionV1 {
    workUnitId: string;
    changeSet: ChangeSetV1;
    allowedScope: readonly string[];
    forbiddenScope?: readonly string[];
    resourceClaims?: readonly ResourceClaimV1[];
}
export interface WaveIntegrationStepV1 {
    workUnitId: string;
    changeSet: ChangeSetV1;
    candidate: CandidateRevisionV1;
    impact: CandidateImpactV1;
    derived: boolean;
}
export interface WaveReconciliationRequirementV1 {
    workUnitId: string;
    reason: string;
    observedBaseRevision: number;
    observedBaseDigest: string;
}
export interface WaveIntegrationResultV1 {
    version: 1;
    wave: WaveBaseV1;
    integrated: WaveIntegrationStepV1[];
    reconciliationRequired: WaveReconciliationRequirementV1[];
    digest: string;
}
export declare function createWaveBase(input: {
    operationId: string;
    taskId: string;
    waveIndex: number;
    candidate: CandidateRevisionV1;
    now?: Date;
}): WaveBaseV1;
export declare function waveBaseDigest(wave: WaveBaseV1): string;
/**
 * Deterministically integrate one wave's ChangeSets on top of the frozen wave
 * base. Integration is a truthful prefix: steps already integrated remain
 * bound as candidate revisions, and units that cannot be integrated without an
 * explicit rebase are reported for re-execution against the new candidate.
 */
export declare function integrateWaveChangeSets(input: {
    root: string;
    stateRoot: string;
    operationId: string;
    taskId: string;
    wave: WaveBaseV1;
    submissions: readonly WaveChangeSetSubmissionV1[];
    semanticAssessment?: CandidateImpactAssessmentRuntimeV1;
    now?: Date;
}): Promise<WaveIntegrationResultV1>;
