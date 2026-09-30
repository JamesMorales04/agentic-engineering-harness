import { z } from "zod";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import type { ProjectStackProfileV1 } from "../participants/stack.js";
import type { ToolAvailabilityV1 } from "../participants/toolRegistry.js";
export declare const validationRequirementKindValues: readonly ["unit-test", "integration-test", "bdd", "contract-test", "browser-test", "visual-test", "static-security", "dependency-security", "architecture", "policy", "command"];
export type ValidationRequirementKindV1 = (typeof validationRequirementKindValues)[number];
export interface ValidationRequirementV1 {
    version: 1;
    id: string;
    property: string;
    kind: ValidationRequirementKindV1;
    scope: string[];
    evidenceNeeded: string[];
    requirementRefs: string[];
    acceptanceRefs: string[];
}
export declare const validationRequirementSchema: z.ZodObject<{
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
}, z.core.$strict>;
/**
 * Deterministic check-id → validation-kind mapping for the frozen contract requirement →
 * configured validation traceability convention: configured commands persist as `command.<id>`
 * (src/validators/commands.ts) and configured validators persist under their own id, which is
 * what the requirement evidence graph matches against (src/evidence/graph.ts). A check id with
 * no configured command/validator behind it has no deterministic kind and is never fabricated.
 */
export declare function configuredValidationKindForCheckV1(checkId: string, input?: {
    commands?: readonly {
        id: string;
    }[];
    validators?: readonly {
        id: string;
        adapter: string;
    }[];
}): ValidationRequirementKindV1 | undefined;
/**
 * Compile the frozen contract requirements' bound validators into explicit candidate-bound
 * ValidationRequirements. Each distinct validator check id becomes exactly one requirement whose
 * id is the deterministic validation check id and whose `requirementRefs`/`acceptanceRefs` name
 * every contract requirement that declared it, so `resolveVerificationRequirementsV1` binds the
 * assertion to the exact evidence path. Validators without a configured deterministic kind are
 * skipped; the AcceptanceOracle then fails closed with no fabricated correspondence.
 */
export declare function contractValidationRequirementsV1(input: {
    requirements: readonly {
        id: string;
        validators?: readonly string[];
    }[];
    scope: readonly string[];
    commands?: readonly {
        id: string;
    }[];
    validators?: readonly {
        id: string;
        adapter: string;
    }[];
}): ValidationRequirementV1[];
/**
 * Merge frozen-contract-derived validation requirements into the plan-declared base set. A plan
 * requirement that names the same deterministic validation check id as a contract-derived
 * requirement is the same validation need (the compiled plan is allowed to name the configured
 * validator ids it observes); the contract-derived requirement is normative and replaces it when
 * the declared kind agrees. An incompatible same-id declaration is a genuine deterministic
 * conflict and fails closed instead of silently dropping a requirement.
 */
export declare function mergeContractValidationRequirementsV1(base: readonly ValidationRequirementV1[], contractDerived: readonly ValidationRequirementV1[]): ValidationRequirementV1[];
/**
 * Split plan-declared validation requirements into the resolvable set and the advisory set that no
 * approved project script, configured command, validator, or provider resolves. Only the resolvable
 * set may compile into the participant plan; the frozen contract's own validators are compiled and
 * enforced independently, so an unresolvable advisory requirement is recorded and dropped instead
 * of rejecting the entire implementation plan before any work runs (AEH-V2-0118).
 */
export declare function dropUnresolvablePlanValidationRequirementsV1(requirements: readonly ValidationRequirementV1[], resolution: ValidationResolutionV1): {
    kept: ValidationRequirementV1[];
    dropped: ValidationRequirementV1[];
};
export interface ResolvedValidationActionV1 {
    version: 1;
    requirementId: string;
    kind: ValidationRequirementKindV1;
    source: "project-script" | "configured-command" | "configured-validator" | "approved-provider";
    selector: string;
    command?: string;
    provider?: string;
    scope: string[];
    evidenceNeeded: string[];
}
export interface ValidationResolutionV1 {
    version: 1;
    requirements: ValidationRequirementV1[];
    actions: ResolvedValidationActionV1[];
    blocked: Array<{
        requirementId: string;
        reason: string;
    }>;
    digest: string;
}
export interface ValidationResolverOptionsV1 {
    root: string;
    requirements: readonly ValidationRequirementV1[];
    config?: HarnessProjectConfig;
    contract?: TaskContract;
    projectStack?: ProjectStackProfileV1;
    availableTools?: readonly ToolAvailabilityV1[];
    allowedKinds?: readonly ValidationRequirementKindV1[];
}
/**
 * Resolves semantic validation needs to project/configured actions. The model
 * supplies only the requirement; it cannot select an executable command,
 * provider, tool or credential.
 */
export declare function resolveValidationRequirements(input: ValidationResolverOptionsV1): Promise<ValidationResolutionV1>;
