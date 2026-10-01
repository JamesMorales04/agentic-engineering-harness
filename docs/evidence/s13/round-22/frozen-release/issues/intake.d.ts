import { z } from "zod";
import { type TriageEvidence } from "../core/triage.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import type { AssuranceLevel, ImplementationRoute } from "../architecture/contracts.js";
import { type SemanticAssessmentV1 } from "../semantic/assessment.js";
import { type SemanticAssessmentRuntimeV1 } from "../semantic/runtime.js";
export interface GithubIssueSnapshot {
    version: 1;
    provider: "github";
    repository: string;
    number: number;
    url: string;
    title: string;
    body: string;
    state: string;
    labels: string[];
    createdAt: string;
    updatedAt: string;
    fetchedAt: string;
    contentSha256: string;
}
export interface IssueInspection {
    snapshot: GithubIssueSnapshot;
    evidence: TriageEvidence;
}
export interface IssuePreparationResult {
    taskId: string;
    route: ImplementationRoute;
    contract: TaskContract;
    snapshot: GithubIssueSnapshot;
    normalizedBy: "planner+semantic-assessment";
    semanticAssessment?: SemanticAssessmentV1;
    traceability?: string;
    plannerParticipantId?: string;
    plannerSessionId?: string;
}
export interface IssuePlannerV1 {
    plan(input: {
        root: string;
        config: HarnessProjectConfig;
        snapshot: GithubIssueSnapshot;
        semanticAssessment: SemanticAssessmentV1;
    }): Promise<unknown>;
}
declare const issuePlanSchema: z.ZodObject<{
    classification: z.ZodEnum<{
        ready: "ready";
        requires_product_decision: "requires_product_decision";
        spec_contradiction: "spec_contradiction";
    }>;
    rationale: z.ZodString;
    problem: z.ZodString;
    desiredOutcome: z.ZodString;
    requirements: z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        source: z.ZodDefault<z.ZodEnum<{
            explicit: "explicit";
            "repository-derived": "repository-derived";
        }>>;
        validators: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    acceptance: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        requirementIndexes: z.ZodArray<z.ZodNumber>;
        given: z.ZodString;
        when: z.ZodString;
        then: z.ZodString;
    }, z.core.$strip>>;
    scope: z.ZodObject<{
        allowed: z.ZodDefault<z.ZodArray<z.ZodString>>;
        forbidden: z.ZodDefault<z.ZodArray<z.ZodString>>;
        domains: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>;
    risk: z.ZodEnum<{
        high: "high";
        medium: "medium";
        low: "low";
    }>;
    flags: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        architecture: "architecture";
        schema: "schema";
        security: "security";
        ambiguous: "ambiguous";
        authentication: "authentication";
        authorization: "authorization";
        migration: "migration";
        "public-api": "public-api";
        "breaking-change": "breaking-change";
        "new-dependency": "new-dependency";
        "cross-module": "cross-module";
    }>>>;
    constraints: z.ZodObject<{
        breakingApiChanges: z.ZodBoolean;
        newDependencies: z.ZodBoolean;
        schemaChanges: z.ZodBoolean;
    }, z.core.$strip>;
    design: z.ZodObject<{
        currentState: z.ZodString;
        proposedDesign: z.ZodString;
        risks: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>;
    tasks: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        requirementIndexes: z.ZodArray<z.ZodNumber>;
        scope: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    nonGoals: z.ZodDefault<z.ZodArray<z.ZodString>>;
    unresolved: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type IssueIntakePlan = z.infer<typeof issuePlanSchema>;
export declare function inspectGithubIssue(root: string, config: HarnessProjectConfig, issueNumber: number): Promise<IssueInspection>;
export declare function prepareGithubIssueTask(root: string, config: HarnessProjectConfig, issueNumber: number, options?: {
    refresh?: boolean;
    force?: boolean;
    semanticRuntime?: SemanticAssessmentRuntimeV1;
    planner?: IssuePlannerV1;
    authoringPolicy?: {
        route: ImplementationRoute;
        assurance: AssuranceLevel;
    };
}): Promise<IssuePreparationResult>;
export declare function verifyGithubIssueDrift(root: string, config: HarnessProjectConfig, contract: TaskContract): Promise<{
    ok: boolean;
    message: string;
    remote?: GithubIssueSnapshot;
}>;
export declare function taskIdForIssue(issueNumber: number): string;
export declare function issueContentSha256(title: string, body: string): string;
export {};
