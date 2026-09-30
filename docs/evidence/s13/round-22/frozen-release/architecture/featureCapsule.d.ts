import { type AssuranceLevel, type FeatureCapsuleV1, type RouteEvidence } from "./contracts.js";
export interface DelegatedFeatureCapsuleInput {
    taskId: string;
    objective: string;
    scope: {
        allowed: string[];
        forbidden?: string[];
    };
    constraints?: Record<string, unknown>;
    acceptance?: string[];
    contextRefs?: string[];
    candidateRevision?: Record<string, unknown>;
    assurance: AssuranceLevel;
    routeEvidence: RouteEvidence[];
}
export declare function createDelegatedFeatureCapsule(input: DelegatedFeatureCapsuleInput): FeatureCapsuleV1;
export declare function persistFeatureCapsule(root: string, capsule: FeatureCapsuleV1): Promise<string>;
