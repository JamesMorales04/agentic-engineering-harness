import { z } from "zod";
declare const workUnitOutputSchema: z.ZodObject<{
    id: z.ZodString;
    objective: z.ZodString;
    scope: z.ZodArray<z.ZodString>;
    dependencies: z.ZodArray<z.ZodString>;
    requirementRefs: z.ZodArray<z.ZodString>;
    acceptanceRefs: z.ZodArray<z.ZodString>;
    competencies: z.ZodArray<z.ZodString>;
    riskTags: z.ZodArray<z.ZodString>;
    changeKinds: z.ZodArray<z.ZodEnum<{
        source: "source";
        test: "test";
        schema: "schema";
        config: "config";
        docs: "docs";
        dependency: "dependency";
        infrastructure: "infrastructure";
        security: "security";
    }>>;
    risk: z.ZodEnum<{
        high: "high";
        medium: "medium";
        low: "low";
        critical: "critical";
    }>;
    resourceClaims: z.ZodDefault<z.ZodArray<z.ZodObject<{
        version: z.ZodLiteral<1>;
        resource: z.ZodString;
        mode: z.ZodEnum<{
            SHARED_READ: "SHARED_READ";
            EXCLUSIVE_WRITE: "EXCLUSIVE_WRITE";
            ORDERED_SEQUENCE: "ORDERED_SEQUENCE";
        }>;
        order: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export declare const plannerOutputSchema: z.ZodObject<{
    workUnits: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        objective: z.ZodString;
        scope: z.ZodArray<z.ZodString>;
        dependencies: z.ZodArray<z.ZodString>;
        requirementRefs: z.ZodArray<z.ZodString>;
        acceptanceRefs: z.ZodArray<z.ZodString>;
        competencies: z.ZodArray<z.ZodString>;
        riskTags: z.ZodArray<z.ZodString>;
        changeKinds: z.ZodArray<z.ZodEnum<{
            source: "source";
            test: "test";
            schema: "schema";
            config: "config";
            docs: "docs";
            dependency: "dependency";
            infrastructure: "infrastructure";
            security: "security";
        }>>;
        risk: z.ZodEnum<{
            high: "high";
            medium: "medium";
            low: "low";
            critical: "critical";
        }>;
        resourceClaims: z.ZodDefault<z.ZodArray<z.ZodObject<{
            version: z.ZodLiteral<1>;
            resource: z.ZodString;
            mode: z.ZodEnum<{
                SHARED_READ: "SHARED_READ";
                EXCLUSIVE_WRITE: "EXCLUSIVE_WRITE";
                ORDERED_SEQUENCE: "ORDERED_SEQUENCE";
            }>;
            order: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    affectedAreas: z.ZodDefault<z.ZodArray<z.ZodString>>;
    reviewDimensions: z.ZodDefault<z.ZodArray<z.ZodString>>;
    validationRequirements: z.ZodDefault<z.ZodArray<z.ZodObject<{
        version: z.ZodLiteral<1>;
        id: z.ZodString;
        property: z.ZodString;
        kind: z.ZodEnum<{
            architecture: "architecture";
            command: "command";
            "unit-test": "unit-test";
            "integration-test": "integration-test";
            bdd: "bdd";
            "contract-test": "contract-test";
            "browser-test": "browser-test";
            "static-security": "static-security";
            "dependency-security": "dependency-security";
            policy: "policy";
            "visual-test": "visual-test";
        }>;
        scope: z.ZodArray<z.ZodString>;
        evidenceNeeded: z.ZodArray<z.ZodString>;
        requirementRefs: z.ZodArray<z.ZodString>;
        acceptanceRefs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>>;
    outOfScopeImprovements: z.ZodDefault<z.ZodArray<z.ZodString>>;
    formalizationNeed: z.ZodOptional<z.ZodEnum<{
        NONE: "NONE";
        REQUIRED: "REQUIRED";
        RECOMMENDED: "RECOMMENDED";
    }>>;
    formalizationReason: z.ZodOptional<z.ZodEnum<{
        PRODUCT_UNCERTAINTY: "PRODUCT_UNCERTAINTY";
        ARCHITECTURE_UNCERTAINTY: "ARCHITECTURE_UNCERTAINTY";
        REQUIREMENT_CONTRADICTION: "REQUIREMENT_CONTRADICTION";
        CROSS_COMPONENT_DESIGN: "CROSS_COMPONENT_DESIGN";
        OTHER: "OTHER";
    }>>;
    formalizationEvidenceRefs: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const knowledgePackOutputSchema: z.ZodObject<{
    pack: z.ZodObject<{
        version: z.ZodLiteral<1>;
        cacheKey: z.ZodString;
        topic: z.ZodString;
        claims: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            statement: z.ZodString;
            competency: z.ZodString;
            confidence: z.ZodEnum<{
                high: "high";
                medium: "medium";
                low: "low";
            }>;
        }, z.core.$strict>>;
        sources: z.ZodArray<z.ZodObject<{
            uri: z.ZodString;
            kind: z.ZodEnum<{
                unknown: "unknown";
                official: "official";
                repository: "repository";
                "public-code": "public-code";
            }>;
            version: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        retrievedAt: z.ZodString;
        packDigest: z.ZodString;
    }, z.core.$strict>;
    skillCandidate: z.ZodOptional<z.ZodObject<{
        version: z.ZodLiteral<1>;
        id: z.ZodString;
        competency: z.ZodString;
        procedure: z.ZodArray<z.ZodString>;
        sourcePackDigest: z.ZodString;
        procedureEvidence: z.ZodArray<z.ZodObject<{
            stepIndex: z.ZodNumber;
            claimIds: z.ZodArray<z.ZodString>;
            sourceUris: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type KnowledgePackOutput = z.infer<typeof knowledgePackOutputSchema>;
export declare const explorerOutputSchema: z.ZodObject<{
    summary: z.ZodString;
    relevantFiles: z.ZodDefault<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        symbols: z.ZodDefault<z.ZodArray<z.ZodString>>;
        reason: z.ZodString;
    }, z.core.$strip>>>;
    findings: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        status: z.ZodEnum<{
            BLOCKED: "BLOCKED";
            PARTIAL: "PARTIAL";
            CONFIRMED: "CONFIRMED";
            NOT_REPRODUCED: "NOT_REPRODUCED";
        }>;
        evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
        notes: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    moduleBoundaries: z.ZodDefault<z.ZodArray<z.ZodString>>;
    tests: z.ZodDefault<z.ZodArray<z.ZodString>>;
    dependencies: z.ZodDefault<z.ZodArray<z.ZodString>>;
    risks: z.ZodDefault<z.ZodArray<z.ZodString>>;
    openQuestions: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare const specAuthoringOutputSchema: z.ZodObject<{
    change: z.ZodString;
    status: z.ZodEnum<{
        BLOCKED: "BLOCKED";
        READY: "READY";
    }>;
    artifacts: z.ZodObject<{
        proposal: z.ZodOptional<z.ZodString>;
        design: z.ZodOptional<z.ZodString>;
        tasks: z.ZodOptional<z.ZodString>;
        specs: z.ZodDefault<z.ZodArray<z.ZodObject<{
            capability: z.ZodString;
            content: z.ZodString;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
    requirements: z.ZodDefault<z.ZodArray<z.ZodString>>;
    unresolvedDecisions: z.ZodDefault<z.ZodArray<z.ZodString>>;
    decisionRequests: z.ZodArray<z.ZodObject<{
        issue: z.ZodString;
        whatTried: z.ZodArray<z.ZodString>;
        whyUnresolvable: z.ZodString;
        choices: z.ZodArray<z.ZodObject<{
            choiceId: z.ZodString;
            label: z.ZodString;
            description: z.ZodString;
            consequences: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        workThatCanContinue: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    validationReady: z.ZodBoolean;
}, z.core.$strict>;
export declare const implementerOutputSchema: z.ZodObject<{
    filesChanged: z.ZodArray<z.ZodString>;
    behaviorImplemented: z.ZodArray<z.ZodString>;
    decisions: z.ZodDefault<z.ZodArray<z.ZodString>>;
    assumptions: z.ZodDefault<z.ZodArray<z.ZodString>>;
    risks: z.ZodDefault<z.ZodArray<z.ZodString>>;
    validationCommands: z.ZodDefault<z.ZodArray<z.ZodString>>;
    followUp: z.ZodDefault<z.ZodArray<z.ZodString>>;
    contractSync: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare const findingSchema: z.ZodObject<{
    id: z.ZodString;
    severity: z.ZodEnum<{
        high: "high";
        medium: "medium";
        low: "low";
        critical: "critical";
        note: "note";
    }>;
    category: z.ZodString;
    location: z.ZodObject<{
        file: z.ZodString;
        startLine: z.ZodOptional<z.ZodNumber>;
        endLine: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    evidence: z.ZodString;
    impact: z.ZodString;
    recommendedFix: z.ZodString;
    requiredCompetencies: z.ZodArray<z.ZodString>;
    reviewDimensions: z.ZodDefault<z.ZodArray<z.ZodString>>;
    exceptionType: z.ZodOptional<z.ZodEnum<{
        IMPLEMENTATION_DEFECT: "IMPLEMENTATION_DEFECT";
        SPEC_CONTRADICTION: "SPEC_CONTRADICTION";
        REQUIRES_PRODUCT_DECISION: "REQUIRES_PRODUCT_DECISION";
        BLOCKED_EXTERNAL: "BLOCKED_EXTERNAL";
        SYSTEM_FAILURE: "SYSTEM_FAILURE";
    }>>;
}, z.core.$strip>;
export declare const reviewerOutputSchema: z.ZodObject<{
    verdict: z.ZodEnum<{
        PASS: "PASS";
        FAIL: "FAIL";
        PASS_WITH_WARNINGS: "PASS_WITH_WARNINGS";
    }>;
    findings: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        severity: z.ZodEnum<{
            high: "high";
            medium: "medium";
            low: "low";
            critical: "critical";
            note: "note";
        }>;
        category: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            startLine: z.ZodOptional<z.ZodNumber>;
            endLine: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        evidence: z.ZodString;
        impact: z.ZodString;
        recommendedFix: z.ZodString;
        requiredCompetencies: z.ZodArray<z.ZodString>;
        reviewDimensions: z.ZodDefault<z.ZodArray<z.ZodString>>;
        exceptionType: z.ZodOptional<z.ZodEnum<{
            IMPLEMENTATION_DEFECT: "IMPLEMENTATION_DEFECT";
            SPEC_CONTRADICTION: "SPEC_CONTRADICTION";
            REQUIRES_PRODUCT_DECISION: "REQUIRES_PRODUCT_DECISION";
            BLOCKED_EXTERNAL: "BLOCKED_EXTERNAL";
            SYSTEM_FAILURE: "SYSTEM_FAILURE";
        }>>;
    }, z.core.$strip>>;
    finalizationSafety: z.ZodEnum<{
        BLOCKED: "BLOCKED";
        SAFE: "SAFE";
        RISK_KNOWN: "RISK_KNOWN";
    }>;
    confidence: z.ZodOptional<z.ZodString>;
    followUp: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare const validatorOutputSchema: z.ZodObject<{
    verdict: z.ZodEnum<{
        PASS: "PASS";
        FAIL: "FAIL";
        WARN: "WARN";
    }>;
    checks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        status: z.ZodEnum<{
            PASS: "PASS";
            FAIL: "FAIL";
            SKIP: "SKIP";
            WARN: "WARN";
        }>;
        evidence: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const recoveryOutputSchema: z.ZodObject<{
    failureType: z.ZodEnum<{
        PATCH_CONTEXT_MISMATCH: "PATCH_CONTEXT_MISMATCH";
        TOOL_FAILURE: "TOOL_FAILURE";
        MISSING_CONTEXT: "MISSING_CONTEXT";
        WRONG_AGENT: "WRONG_AGENT";
        VALIDATION_FAILURE: "VALIDATION_FAILURE";
        REVIEW_FAILURE: "REVIEW_FAILURE";
        AMBIGUOUS_OUTPUT: "AMBIGUOUS_OUTPUT";
        CONFLICTING_RESULTS: "CONFLICTING_RESULTS";
    }>;
    rationale: z.ZodString;
    nextAction: z.ZodString;
}, z.core.$strip>;
export declare const orchestratorOutputSchema: z.ZodObject<{
    summary: z.ZodString;
    delegatedAgents: z.ZodDefault<z.ZodArray<z.ZodString>>;
    validationStatus: z.ZodOptional<z.ZodString>;
    unresolved: z.ZodDefault<z.ZodArray<z.ZodString>>;
    finalizationSafe: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const supervisorOutputSchema: z.ZodObject<{
    summary: z.ZodString;
    consolidatedFindings: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        severity: z.ZodEnum<{
            high: "high";
            medium: "medium";
            low: "low";
            critical: "critical";
            note: "note";
        }>;
        category: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            startLine: z.ZodOptional<z.ZodNumber>;
            endLine: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        evidence: z.ZodString;
        impact: z.ZodString;
        recommendedFix: z.ZodString;
        requiredCompetencies: z.ZodArray<z.ZodString>;
        reviewDimensions: z.ZodDefault<z.ZodArray<z.ZodString>>;
        exceptionType: z.ZodOptional<z.ZodEnum<{
            IMPLEMENTATION_DEFECT: "IMPLEMENTATION_DEFECT";
            SPEC_CONTRADICTION: "SPEC_CONTRADICTION";
            REQUIRES_PRODUCT_DECISION: "REQUIRES_PRODUCT_DECISION";
            BLOCKED_EXTERNAL: "BLOCKED_EXTERNAL";
            SYSTEM_FAILURE: "SYSTEM_FAILURE";
        }>>;
    }, z.core.$strip>>>;
    sourceFindingIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    conflicts: z.ZodDefault<z.ZodArray<z.ZodObject<{
        summary: z.ZodString;
        sources: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>>;
    missingEvidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
    unresolved: z.ZodDefault<z.ZodArray<z.ZodString>>;
    roadmap: z.ZodDefault<z.ZodArray<z.ZodObject<{
        phase: z.ZodString;
        priority: z.ZodEnum<{
            P0: "P0";
            P1: "P1";
            P2: "P2";
            P3: "P3";
        }>;
        actions: z.ZodArray<z.ZodString>;
        findingIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    finalizationSafety: z.ZodEnum<{
        BLOCKED: "BLOCKED";
        SAFE: "SAFE";
        RISK_KNOWN: "RISK_KNOWN";
    }>;
}, z.core.$strip>;
export type WorkUnitOutput = z.infer<typeof workUnitOutputSchema>;
export type PlannerOutput = z.infer<typeof plannerOutputSchema>;
export type ExplorerOutput = z.infer<typeof explorerOutputSchema>;
export type SpecAuthoringOutput = z.infer<typeof specAuthoringOutputSchema>;
export type NormalizedFinding = z.infer<typeof findingSchema>;
export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;
export type SupervisorOutput = z.infer<typeof supervisorOutputSchema>;
export declare function validateAgentOutput(contractName: string, value: unknown): {
    ok: boolean;
    value?: unknown;
    issues: string[];
};
export declare function knownOutputContracts(): string[];
export declare function outputJsonSchema(contractName: string): Record<string, unknown> | undefined;
export {};
