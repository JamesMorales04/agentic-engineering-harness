import { type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import type { ChangeSetV1 } from "./assembler.js";
/**
 * Bind an assembled tree, record the deterministic ASSEMBLING receipt (ChangeSet lineage and its
 * settled source receipt), and restore the prior bound tree if the bind is rejected. Recording the
 * assembly receipt after a durable bind failure is not attempted: the candidate did not advance.
 */
export declare function bindAssembledCandidate(input: {
    root: string;
    stateRoot: string;
    operationId: string;
    baseCandidate: CandidateRevisionV1;
    candidate: CandidateRevisionV1;
    changeSet: ChangeSetV1;
}): Promise<CandidateRevisionV1>;
