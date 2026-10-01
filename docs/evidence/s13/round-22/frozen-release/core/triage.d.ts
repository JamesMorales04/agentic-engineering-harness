import type { HarnessProjectConfig } from "./types.js";
import { type AssuranceLevel, type ImplementationRoute, type RouteEvidence } from "../architecture/contracts.js";
import { SemanticAssessmentServiceV1, type DecisionMechanismV1, type SemanticAssessmentBindingV1 } from "../semantic/assessment.js";
import { z } from "zod";
export type TriageFlag = "architecture" | "security" | "authentication" | "authorization" | "schema" | "migration" | "public-api" | "breaking-change" | "new-dependency" | "cross-module" | "ambiguous";
export interface TriageEvidence {
    request: string;
    files?: string[];
    domains?: string[];
    risk?: "low" | "medium" | "high";
    flags?: TriageFlag[];
}
export interface TriageDecision {
    route: ImplementationRoute;
    assurance: AssuranceLevel;
    mechanism: DecisionMechanismV1;
    assessmentDigest?: string;
    routeEvidence: RouteEvidence[];
    reasons: string[];
    unknowns?: string[];
    evidence: Required<Pick<TriageEvidence, "request">> & {
        files: string[];
        domains: string[];
        risk: "low" | "medium" | "high";
        flags: TriageFlag[];
    };
}
export declare const triageDecisionV1Schema: z.ZodObject<{
    route: z.ZodEnum<{
        NO_AGENT: "NO_AGENT";
        DIRECT: "DIRECT";
        DELEGATED: "DELEGATED";
        FORMAL_SDD: "FORMAL_SDD";
    }>;
    assurance: z.ZodEnum<{
        NONE: "NONE";
        STANDARD: "STANDARD";
        ELEVATED: "ELEVATED";
        CRITICAL: "CRITICAL";
    }>;
    mechanism: z.ZodEnum<{
        MODEL: "MODEL";
        DETERMINISTIC: "DETERMINISTIC";
        HYBRID: "HYBRID";
    }>;
    assessmentDigest: z.ZodString;
    routeEvidence: z.ZodArray<z.ZodObject<{
        route: z.ZodEnum<{
            NO_AGENT: "NO_AGENT";
            DIRECT: "DIRECT";
            DELEGATED: "DELEGATED";
            FORMAL_SDD: "FORMAL_SDD";
        }>;
        source: z.ZodString;
        statement: z.ZodString;
    }, z.core.$strict>>;
    reasons: z.ZodArray<z.ZodString>;
    unknowns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    evidence: z.ZodObject<{
        request: z.ZodString;
        files: z.ZodArray<z.ZodString>;
        domains: z.ZodArray<z.ZodString>;
        risk: z.ZodEnum<{
            high: "high";
            medium: "medium";
            low: "low";
        }>;
        flags: z.ZodArray<z.ZodEnum<{
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
        }>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export interface ChangePreflightV1 {
    version: 1;
    triage: TriageDecision;
    binding: SemanticAssessmentBindingV1;
}
export declare const changePreflightV1Schema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    triage: z.ZodObject<{
        route: z.ZodEnum<{
            NO_AGENT: "NO_AGENT";
            DIRECT: "DIRECT";
            DELEGATED: "DELEGATED";
            FORMAL_SDD: "FORMAL_SDD";
        }>;
        assurance: z.ZodEnum<{
            NONE: "NONE";
            STANDARD: "STANDARD";
            ELEVATED: "ELEVATED";
            CRITICAL: "CRITICAL";
        }>;
        mechanism: z.ZodEnum<{
            MODEL: "MODEL";
            DETERMINISTIC: "DETERMINISTIC";
            HYBRID: "HYBRID";
        }>;
        assessmentDigest: z.ZodString;
        routeEvidence: z.ZodArray<z.ZodObject<{
            route: z.ZodEnum<{
                NO_AGENT: "NO_AGENT";
                DIRECT: "DIRECT";
                DELEGATED: "DELEGATED";
                FORMAL_SDD: "FORMAL_SDD";
            }>;
            source: z.ZodString;
            statement: z.ZodString;
        }, z.core.$strict>>;
        reasons: z.ZodArray<z.ZodString>;
        unknowns: z.ZodOptional<z.ZodArray<z.ZodString>>;
        evidence: z.ZodObject<{
            request: z.ZodString;
            files: z.ZodArray<z.ZodString>;
            domains: z.ZodArray<z.ZodString>;
            risk: z.ZodEnum<{
                high: "high";
                medium: "medium";
                low: "low";
            }>;
            flags: z.ZodArray<z.ZodEnum<{
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
            }>>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    binding: z.ZodObject<{
        projectId: z.ZodString;
        repositoryDigest: z.ZodString;
        repositoryRootDigest: z.ZodOptional<z.ZodString>;
        operationId: z.ZodOptional<z.ZodString>;
        candidateId: z.ZodOptional<z.ZodString>;
        candidateRevision: z.ZodOptional<z.ZodNumber>;
        candidateDigest: z.ZodOptional<z.ZodString>;
        intentDigest: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare function assertChangePreflightV1(value: unknown, expected: {
    binding: SemanticAssessmentBindingV1;
    evidence: TriageEvidence;
}): ChangePreflightV1;
export declare function normalizeTriageEvidence(input: TriageEvidence): Required<Pick<TriageEvidence, "request">> & {
    files: string[];
    domains: string[];
    risk: "low" | "medium" | "high";
    flags: TriageFlag[];
};
export declare function triageChange(config: HarnessProjectConfig, input: TriageEvidence): TriageDecision;
export declare function triageChangeWithSemanticAssessment(config: HarnessProjectConfig, input: TriageEvidence, options: {
    service: SemanticAssessmentServiceV1;
    binding: SemanticAssessmentBindingV1;
    policyRevision: string;
}): Promise<TriageDecision>;
export declare function formatTriageDecision(decision: TriageDecision): string;
