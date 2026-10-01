import type { RoleProfileV1 } from "./types.js";
export declare const DEFAULT_ROLE_PROFILES_V1: ({
    version: 1;
    role: "Lead/Director";
    purpose: string;
    validRoutes: readonly ["NO_AGENT", "DIRECT", "DELEGATED", "FORMAL_SDD"];
    validAssurance: readonly ["NONE", "STANDARD", "ELEVATED", "CRITICAL"];
    baseCapabilities: readonly ["read", "plan", "supervise", "delegate"];
    maxCapabilities: readonly ["read", "plan", "specify", "review", "validate", "supervise", "delegate"];
    specializations: readonly ["cross-cutting"];
    toolPack: {
        version: 1;
        required: readonly ["repository-read", "context-read", "task-coordination"];
        optional: readonly ["validation-read"];
        forbidden: readonly ["repository-write", "agent-spawn-by-name"];
    };
    context: {
        requiredKinds: readonly ["instruction", "normative", "operation", "repository-map"];
        retrieval: "authorized";
        preservation: "verbatim";
        budgetClass: "large";
    };
    delegation: {
        allowed: true;
        allowedRoles: readonly ["Operation Supervisor", "Explorer", "Librarian", "Planner", "Spec Manager", "Implementer", "Reviewer", "Repairer"];
        maxChildren: number;
        requiresSupervisorApproval: false;
    };
    authority: {
        canRead: true;
        canWrite: false;
        canExecute: false;
        canApprove: true;
        canSelfAccept: false;
        leaseRequired: true;
    };
    defaultSkills: string[];
    inputContract: string;
    outputContract: string;
    invocationConditions: string[];
} | {
    version: 1;
    role: "Operation Supervisor";
    purpose: string;
    validRoutes: readonly ["DELEGATED", "FORMAL_SDD"];
    validAssurance: readonly ["STANDARD", "ELEVATED", "CRITICAL"];
    baseCapabilities: readonly ["read", "supervise", "validate"];
    maxCapabilities: readonly ["read", "supervise", "validate", "delegate", "execute"];
    specializations: readonly ["cross-cutting"];
    toolPack: {
        version: 1;
        required: readonly ["repository-read", "context-read", "task-coordination"];
        optional: readonly ["validation-read", "operation-control"];
        forbidden: readonly ["repository-write", "agent-spawn-by-name"];
    };
    context: {
        requiredKinds: readonly ["normative", "operation", "validation", "handoff"];
        retrieval: "authorized";
        preservation: "verbatim";
        budgetClass: "large";
    };
    delegation: {
        allowed: true;
        allowedRoles: readonly ["Explorer", "Librarian", "Planner", "Spec Manager", "Implementer", "Reviewer", "Repairer"];
        maxChildren: number;
        requiresSupervisorApproval: false;
    };
    authority: {
        canRead: true;
        canWrite: false;
        canExecute: true;
        canApprove: false;
        canSelfAccept: false;
        leaseRequired: true;
    };
    defaultSkills: string[];
    inputContract: string;
    outputContract: string;
    invocationConditions: string[];
} | {
    version: 1;
    role: "Explorer";
    purpose: string;
    validRoutes: readonly ["DELEGATED", "FORMAL_SDD"];
    validAssurance: readonly ["STANDARD", "ELEVATED", "CRITICAL"];
    baseCapabilities: readonly ["read", "research"];
    maxCapabilities: readonly ["read", "research", "validate"];
    specializations: readonly ["cross-cutting"];
    toolPack: {
        version: 1;
        required: readonly ["repository-read", "context-read"];
        optional: readonly ["repository-map"];
        forbidden: readonly ["repository-write", "command-execute", "agent-spawn-by-name"];
    };
    context: {
        requiredKinds: readonly ["instruction", "repository-map", "source"];
        retrieval: "authorized";
        preservation: "projectable";
        budgetClass: "standard";
    };
    delegation: {
        allowed: false;
        allowedRoles: never[];
        maxChildren: number;
        requiresSupervisorApproval: true;
    };
    authority: {
        canRead: true;
        canWrite: false;
        canExecute: false;
        canApprove: false;
        canSelfAccept: false;
        leaseRequired: false;
    };
    defaultSkills: string[];
    inputContract: string;
    outputContract: string;
    invocationConditions: string[];
} | {
    version: 1;
    role: "Librarian";
    purpose: string;
    validRoutes: readonly ["DELEGATED", "FORMAL_SDD"];
    validAssurance: readonly ["STANDARD", "ELEVATED", "CRITICAL"];
    baseCapabilities: readonly ["read", "research"];
    maxCapabilities: readonly ["read", "research", "validate"];
    specializations: readonly ["cross-cutting"];
    toolPack: {
        version: 1;
        required: readonly ["context-read"];
        optional: readonly ["approved-research"];
        forbidden: readonly ["repository-write", "agent-spawn-by-name"];
    };
    context: {
        requiredKinds: readonly ["instruction", "normative", "raw-evidence"];
        retrieval: "authorized";
        preservation: "retrievable";
        budgetClass: "standard";
    };
    delegation: {
        allowed: false;
        allowedRoles: never[];
        maxChildren: number;
        requiresSupervisorApproval: true;
    };
    authority: {
        canRead: true;
        canWrite: false;
        canExecute: false;
        canApprove: false;
        canSelfAccept: false;
        leaseRequired: false;
    };
    defaultSkills: string[];
    inputContract: string;
    outputContract: string;
    invocationConditions: string[];
} | {
    version: 1;
    role: "Planner";
    purpose: string;
    validRoutes: readonly ["DELEGATED", "FORMAL_SDD"];
    validAssurance: readonly ["STANDARD", "ELEVATED", "CRITICAL"];
    baseCapabilities: readonly ["read", "plan"];
    maxCapabilities: readonly ["read", "plan", "validate"];
    specializations: readonly ["cross-cutting"];
    toolPack: {
        version: 1;
        required: readonly ["repository-read", "context-read", "task-coordination"];
        optional: readonly ["repository-map"];
        forbidden: readonly ["repository-write", "command-execute", "agent-spawn-by-name"];
    };
    context: {
        requiredKinds: readonly ["instruction", "normative", "repository-map", "operation"];
        retrieval: "authorized";
        preservation: "projectable";
        budgetClass: "large";
    };
    delegation: {
        allowed: false;
        allowedRoles: never[];
        maxChildren: number;
        requiresSupervisorApproval: true;
    };
    authority: {
        canRead: true;
        canWrite: false;
        canExecute: false;
        canApprove: false;
        canSelfAccept: false;
        leaseRequired: false;
    };
    defaultSkills: string[];
    inputContract: string;
    outputContract: string;
    invocationConditions: string[];
} | {
    version: 1;
    role: "Spec Manager";
    purpose: string;
    validRoutes: readonly ["FORMAL_SDD"];
    validAssurance: readonly ["ELEVATED", "CRITICAL"];
    baseCapabilities: readonly ["read", "specify", "validate"];
    maxCapabilities: readonly ["read", "specify", "validate"];
    specializations: readonly ["cross-cutting"];
    toolPack: {
        version: 1;
        required: readonly ["repository-read", "context-read", "spec-authoring"];
        optional: readonly ["validation-read"];
        forbidden: readonly ["repository-write", "command-execute", "agent-spawn-by-name"];
    };
    context: {
        requiredKinds: readonly ["instruction", "normative", "operation", "validation"];
        retrieval: "authorized";
        preservation: "verbatim";
        budgetClass: "large";
    };
    delegation: {
        allowed: false;
        allowedRoles: never[];
        maxChildren: number;
        requiresSupervisorApproval: true;
    };
    authority: {
        canRead: true;
        canWrite: false;
        canExecute: false;
        canApprove: false;
        canSelfAccept: false;
        leaseRequired: false;
    };
    defaultSkills: string[];
    inputContract: string;
    outputContract: string;
    invocationConditions: string[];
} | {
    version: 1;
    role: "Implementer";
    purpose: string;
    validRoutes: readonly ["DIRECT", "DELEGATED", "FORMAL_SDD"];
    validAssurance: readonly ["STANDARD", "ELEVATED", "CRITICAL"];
    baseCapabilities: readonly ["read", "write", "execute", "implement"];
    maxCapabilities: readonly ["read", "write", "execute", "implement", "validate"];
    specializations: readonly ["cross-cutting", "typescript-node", "dotnet-csharp", "postgresql"];
    toolPack: {
        version: 1;
        required: readonly ["repository-read", "repository-write", "command-execute", "context-read"];
        optional: readonly ["test-runner", "database-client"];
        forbidden: readonly ["agent-spawn-by-name"];
    };
    context: {
        requiredKinds: readonly ["instruction", "normative", "source", "diff", "validation"];
        retrieval: "authorized";
        preservation: "projectable";
        budgetClass: "standard";
    };
    delegation: {
        allowed: false;
        allowedRoles: never[];
        maxChildren: number;
        requiresSupervisorApproval: true;
    };
    authority: {
        canRead: true;
        canWrite: true;
        canExecute: true;
        canApprove: false;
        canSelfAccept: false;
        leaseRequired: true;
    };
    defaultSkills: string[];
    inputContract: string;
    outputContract: string;
    invocationConditions: string[];
} | {
    version: 1;
    role: "Reviewer";
    purpose: string;
    validRoutes: readonly ["DIRECT", "DELEGATED", "FORMAL_SDD"];
    validAssurance: readonly ["STANDARD", "ELEVATED", "CRITICAL"];
    baseCapabilities: readonly ["read", "review", "validate"];
    maxCapabilities: readonly ["read", "review", "validate", "research"];
    specializations: readonly ["cross-cutting", "typescript-node", "dotnet-csharp", "postgresql"];
    toolPack: {
        version: 1;
        required: readonly ["repository-read", "context-read"];
        optional: readonly ["test-runner", "validation-read"];
        forbidden: readonly ["repository-write", "command-execute", "agent-spawn-by-name"];
    };
    context: {
        requiredKinds: readonly ["instruction", "normative", "source", "diff", "validation", "evidence"];
        retrieval: "authorized";
        preservation: "verbatim";
        budgetClass: "standard";
    };
    delegation: {
        allowed: false;
        allowedRoles: never[];
        maxChildren: number;
        requiresSupervisorApproval: true;
    };
    authority: {
        canRead: true;
        canWrite: false;
        canExecute: false;
        canApprove: false;
        canSelfAccept: false;
        leaseRequired: false;
    };
    defaultSkills: string[];
    inputContract: string;
    outputContract: string;
    invocationConditions: string[];
} | {
    version: 1;
    role: "Repairer";
    purpose: string;
    validRoutes: readonly ["DIRECT", "DELEGATED", "FORMAL_SDD"];
    validAssurance: readonly ["STANDARD", "ELEVATED", "CRITICAL"];
    baseCapabilities: readonly ["read", "write", "execute", "repair"];
    maxCapabilities: readonly ["read", "write", "execute", "repair", "validate"];
    specializations: readonly ["cross-cutting", "typescript-node", "dotnet-csharp", "postgresql"];
    toolPack: {
        version: 1;
        required: readonly ["repository-read", "repository-write", "command-execute", "context-read"];
        optional: readonly ["test-runner", "database-client"];
        forbidden: readonly ["agent-spawn-by-name"];
    };
    context: {
        requiredKinds: readonly ["instruction", "normative", "failure-packet", "diff", "validation"];
        retrieval: "authorized";
        preservation: "projectable";
        budgetClass: "standard";
    };
    delegation: {
        allowed: false;
        allowedRoles: never[];
        maxChildren: number;
        requiresSupervisorApproval: true;
    };
    authority: {
        canRead: true;
        canWrite: true;
        canExecute: true;
        canApprove: false;
        canSelfAccept: false;
        leaseRequired: true;
    };
    defaultSkills: string[];
    inputContract: string;
    outputContract: string;
    invocationConditions: string[];
})[];
export declare function defaultRoleProfiles(): readonly RoleProfileV1[];
export declare function roleProfile(role: RoleProfileV1["role"]): RoleProfileV1;
