import { assuranceLevelValues, implementationRouteValues } from "../architecture/contracts.js";
import type { RoleProfileV1 } from "./types.js";

const readOnlyTools = ["repository-read", "context-read"] as const;
const implementationTools = ["repository-read", "repository-write", "command-execute", "context-read"] as const;
const coordinationTools = ["repository-read", "context-read", "task-coordination"] as const;

const allRoutes = [...implementationRouteValues] as const;
const changeRoutes = ["DIRECT", "DELEGATED", "FORMAL_SDD"] as const;
const orchestrationRoutes = ["DELEGATED", "FORMAL_SDD"] as const;
const allAssurance = [...assuranceLevelValues] as const;
const changeAssurance = ["STANDARD", "ELEVATED", "CRITICAL"] as const;

export const DEFAULT_ROLE_PROFILES_V1 = [
  {
    version: 1,
    role: "Lead/Director",
    purpose: "Own the bounded operation decision, preserve intent, and coordinate canonical participants.",
    validRoutes: allRoutes,
    validAssurance: allAssurance,
    baseCapabilities: ["read", "plan", "supervise", "delegate"] as const,
    maxCapabilities: ["read", "plan", "specify", "review", "validate", "supervise", "delegate"] as const,
    specializations: ["cross-cutting"] as const,
    toolPack: { version: 1, required: coordinationTools, optional: ["validation-read"] as const, forbidden: ["repository-write", "agent-spawn-by-name"] as const },
    context: { requiredKinds: ["instruction", "normative", "operation", "repository-map"] as const, retrieval: "authorized", preservation: "verbatim", budgetClass: "large" },
    delegation: { allowed: true, allowedRoles: ["Operation Supervisor", "Explorer", "Librarian", "Planner", "Spec Manager", "Implementer", "Reviewer", "Repairer"] as const, maxChildren: 32, requiresSupervisorApproval: false },
    authority: { canRead: true, canWrite: false, canExecute: false, canApprove: true, canSelfAccept: false, leaseRequired: true },
    defaultSkills: ["intent-analysis", "semantic-decision", "human-exception-handling", "acceptance-reasoning"],
    inputContract: "user-intent-and-operation-state",
    outputContract: "semantic-decision",
    invocationConditions: ["top-level-operation", "human-exception"]
  },
  {
    version: 1,
    role: "Operation Supervisor",
    purpose: "Supervise lifecycle, budgets, barriers, leases, and participant evidence for one operation.",
    validRoutes: orchestrationRoutes,
    validAssurance: changeAssurance,
    baseCapabilities: ["read", "supervise", "validate"] as const,
    maxCapabilities: ["read", "supervise", "validate", "delegate", "execute"] as const,
    specializations: ["cross-cutting"] as const,
    toolPack: { version: 1, required: coordinationTools, optional: ["validation-read", "operation-control"] as const, forbidden: ["repository-write", "agent-spawn-by-name"] as const },
    context: { requiredKinds: ["normative", "operation", "validation", "handoff"] as const, retrieval: "authorized", preservation: "verbatim", budgetClass: "large" },
    delegation: { allowed: true, allowedRoles: ["Explorer", "Librarian", "Planner", "Spec Manager", "Implementer", "Reviewer", "Repairer"] as const, maxChildren: 32, requiresSupervisorApproval: false },
    authority: { canRead: true, canWrite: false, canExecute: true, canApprove: false, canSelfAccept: false, leaseRequired: true },
    defaultSkills: ["operation-coordination", "progress-reconciliation", "conflict-consolidation", "bounded-replanning"],
    inputContract: "operation-state-and-participant-evidence",
    outputContract: "operation-supervision",
    invocationConditions: ["managed-operation"]
  },
  {
    version: 1,
    role: "Explorer",
    purpose: "Build bounded repository and change-scope evidence without proposing implementation identity.",
    validRoutes: orchestrationRoutes,
    validAssurance: changeAssurance,
    baseCapabilities: ["read", "research"] as const,
    maxCapabilities: ["read", "research", "validate"] as const,
    specializations: ["cross-cutting"] as const,
    toolPack: { version: 1, required: readOnlyTools, optional: ["repository-map"] as const, forbidden: ["repository-write", "command-execute", "agent-spawn-by-name"] as const },
    context: { requiredKinds: ["instruction", "repository-map", "source"] as const, retrieval: "authorized", preservation: "projectable", budgetClass: "standard" },
    delegation: { allowed: false, allowedRoles: [], maxChildren: 0, requiresSupervisorApproval: true },
    authority: { canRead: true, canWrite: false, canExecute: false, canApprove: false, canSelfAccept: false, leaseRequired: false },
    defaultSkills: ["repository-discovery", "symbol-impact-analysis", "repository-evidence-grounding"],
    inputContract: "repository-discovery-request",
    outputContract: "exploration-evidence",
    invocationConditions: ["discovery-needed"]
  },
  {
    version: 1,
    role: "Librarian",
    purpose: "Locate and summarize trusted external or repository knowledge after a deterministic knowledge gap.",
    validRoutes: orchestrationRoutes,
    validAssurance: changeAssurance,
    baseCapabilities: ["read", "research"] as const,
    maxCapabilities: ["read", "research", "validate"] as const,
    specializations: ["cross-cutting"] as const,
    toolPack: { version: 1, required: ["context-read"] as const, optional: ["approved-research"] as const, forbidden: ["repository-write", "agent-spawn-by-name"] as const },
    context: { requiredKinds: ["instruction", "normative", "raw-evidence"] as const, retrieval: "authorized", preservation: "retrievable", budgetClass: "standard" },
    delegation: { allowed: false, allowedRoles: [], maxChildren: 0, requiresSupervisorApproval: true },
    authority: { canRead: true, canWrite: false, canExecute: false, canApprove: false, canSelfAccept: false, leaseRequired: false },
    defaultSkills: ["authoritative-research", "source-quality-ranking", "version-aware-research", "public-code-research", "knowledge-pack-authoring"],
    inputContract: "knowledge-gap-request",
    outputContract: "knowledge-pack",
    invocationConditions: ["knowledge-gap"]
  },
  {
    version: 1,
    role: "Planner",
    purpose: "Decompose a frozen objective into dependency-aware bounded work units.",
    validRoutes: orchestrationRoutes,
    validAssurance: changeAssurance,
    baseCapabilities: ["read", "plan"] as const,
    maxCapabilities: ["read", "plan", "validate"] as const,
    specializations: ["cross-cutting"] as const,
    toolPack: { version: 1, required: coordinationTools, optional: ["repository-map"] as const, forbidden: ["repository-write", "command-execute", "agent-spawn-by-name"] as const },
    context: { requiredKinds: ["instruction", "normative", "repository-map", "operation"] as const, retrieval: "authorized", preservation: "projectable", budgetClass: "large" },
    delegation: { allowed: false, allowedRoles: [], maxChildren: 0, requiresSupervisorApproval: true },
    authority: { canRead: true, canWrite: false, canExecute: false, canApprove: false, canSelfAccept: false, leaseRequired: false },
    defaultSkills: ["work-decomposition", "dependency-analysis", "competency-identification", "resource-conflict-analysis"],
    inputContract: "frozen-objective-and-discovery-evidence",
    outputContract: "work-graph",
    invocationConditions: ["non-trivial-decomposition"]
  },
  {
    version: 1,
    role: "Spec Manager",
    purpose: "Author and validate formal requirements, design, tasks, and traceability before freeze.",
    validRoutes: ["FORMAL_SDD"] as const,
    validAssurance: ["ELEVATED", "CRITICAL"] as const,
    baseCapabilities: ["read", "specify", "validate"] as const,
    maxCapabilities: ["read", "specify", "validate"] as const,
    specializations: ["cross-cutting"] as const,
    toolPack: { version: 1, required: ["repository-read", "context-read", "spec-authoring"] as const, optional: ["validation-read"] as const, forbidden: ["repository-write", "command-execute", "agent-spawn-by-name"] as const },
    context: { requiredKinds: ["instruction", "normative", "operation", "validation"] as const, retrieval: "authorized", preservation: "verbatim", budgetClass: "large" },
    delegation: { allowed: false, allowedRoles: [], maxChildren: 0, requiresSupervisorApproval: true },
    authority: { canRead: true, canWrite: false, canExecute: false, canApprove: false, canSelfAccept: false, leaseRequired: false },
    defaultSkills: ["requirement-authoring", "semantic-consistency", "acceptance-traceability", "openspec-authoring"],
    inputContract: "change-intent-and-authoring-evidence",
    outputContract: "compiled-formal-contract",
    invocationConditions: ["formal-sdd-route"]
  },
  {
    version: 1,
    role: "Implementer",
    purpose: "Make only the frozen, task-scoped product changes and return reproducible evidence.",
    validRoutes: changeRoutes,
    validAssurance: changeAssurance,
    baseCapabilities: ["read", "write", "execute", "implement"] as const,
    maxCapabilities: ["read", "write", "execute", "implement", "validate"] as const,
    specializations: ["cross-cutting", "typescript-node", "dotnet-csharp", "postgresql"] as const,
    toolPack: { version: 1, required: implementationTools, optional: ["test-runner", "database-client"] as const, forbidden: ["agent-spawn-by-name"] as const },
    context: { requiredKinds: ["instruction", "normative", "source", "diff", "validation"] as const, retrieval: "authorized", preservation: "projectable", budgetClass: "standard" },
    delegation: { allowed: false, allowedRoles: [], maxChildren: 0, requiresSupervisorApproval: true },
    authority: { canRead: true, canWrite: true, canExecute: true, canApprove: false, canSelfAccept: false, leaseRequired: true },
    defaultSkills: ["implementation-discipline", "scope-discipline", "focused-regression-testing", "implementation-evidence"],
    inputContract: "assigned-work-units-and-frozen-blueprint",
    outputContract: "work-unit-result",
    invocationConditions: ["direct-or-delegated-change"]
  },
  {
    version: 1,
    role: "Reviewer",
    purpose: "Independently assess scope, correctness, security, and evidence without changing the candidate.",
    validRoutes: changeRoutes,
    validAssurance: changeAssurance,
    baseCapabilities: ["read", "review", "validate"] as const,
    maxCapabilities: ["read", "review", "validate", "research"] as const,
    specializations: ["cross-cutting", "typescript-node", "dotnet-csharp", "postgresql"] as const,
    toolPack: { version: 1, required: readOnlyTools, optional: ["test-runner", "validation-read"] as const, forbidden: ["repository-write", "command-execute", "agent-spawn-by-name"] as const },
    context: { requiredKinds: ["instruction", "normative", "source", "diff", "validation", "evidence"] as const, retrieval: "authorized", preservation: "verbatim", budgetClass: "standard" },
    delegation: { allowed: false, allowedRoles: [], maxChildren: 0, requiresSupervisorApproval: true },
    authority: { canRead: true, canWrite: false, canExecute: false, canApprove: false, canSelfAccept: false, leaseRequired: false },
    defaultSkills: ["independent-review", "evidence-based-findings", "review-scope-discipline", "finding-quality"],
    inputContract: "candidate-and-review-dimensions",
    outputContract: "review-result",
    invocationConditions: ["independent-review-required"]
  },
  {
    version: 1,
    role: "Repairer",
    purpose: "Apply bounded repairs to a failed candidate while preserving frozen scope and independent re-validation.",
    validRoutes: changeRoutes,
    validAssurance: changeAssurance,
    baseCapabilities: ["read", "write", "execute", "repair"] as const,
    maxCapabilities: ["read", "write", "execute", "repair", "validate"] as const,
    specializations: ["cross-cutting", "typescript-node", "dotnet-csharp", "postgresql"] as const,
    toolPack: { version: 1, required: implementationTools, optional: ["test-runner", "database-client"] as const, forbidden: ["agent-spawn-by-name"] as const },
    context: { requiredKinds: ["instruction", "normative", "failure-packet", "diff", "validation"] as const, retrieval: "authorized", preservation: "projectable", budgetClass: "standard" },
    delegation: { allowed: false, allowedRoles: [], maxChildren: 0, requiresSupervisorApproval: true },
    authority: { canRead: true, canWrite: true, canExecute: true, canApprove: false, canSelfAccept: false, leaseRequired: true },
    defaultSkills: ["root-cause-remediation", "minimal-repair", "regression-preservation", "failure-classification"],
    inputContract: "failure-packet-and-frozen-scope",
    outputContract: "repair-result",
    invocationConditions: ["repair-required"]
  }
] satisfies readonly RoleProfileV1[];

export function defaultRoleProfiles(): readonly RoleProfileV1[] {
  return DEFAULT_ROLE_PROFILES_V1;
}

export function roleProfile(role: RoleProfileV1["role"]): RoleProfileV1 {
  const profile = DEFAULT_ROLE_PROFILES_V1.find((candidate) => candidate.role === role);
  if (!profile) throw new Error(`No default profile exists for canonical role: ${role}`);
  return profile;
}
