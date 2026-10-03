import type { CanonicalRole } from "../participants/index.js";
import type { CapabilityEntryV1, CapabilityRegistryV1 } from "./registry.js";
import { sha256Canonical } from "../core/digest.js";

export interface SkillCertificationEvidenceV1 {
  capabilityId: string;
  capabilityVersion: string;
  procedureVersion: string;
  evidenceRef: string;
}

export interface OperationalSkillV1 {
  version: 1;
  id: string;
  skillVersion: string;
  name: string;
  description: string;
  applicableCapabilities: readonly string[];
  competencies: readonly string[];
  roles: readonly CanonicalRole[];
  preconditions: readonly string[];
  procedure: readonly string[];
  failureModes: readonly { failureClass: string; recovery: readonly string[] }[];
  evidenceRequirements: readonly string[];
  forbiddenUses: readonly string[];
  /** Controller guidance can explain controller-owned work but never materializes it as a participant tool. */
  guidanceOnly: boolean;
  procedureVersion: string;
  certificationEvidence: readonly SkillCertificationEvidenceV1[];
}

export type SkillCertificationStatusV1 = "CERTIFIED" | "UNCERTIFIED" | "VERSION_UNKNOWN" | "VERSION_MISMATCH" | "PROCEDURE_STALE";

export interface ProjectedOperationalSkillV1 {
  id: string;
  version: string;
  procedureVersion: string;
  name: string;
  preconditions: string[];
  procedure: string[];
  recovery: Array<{ failureClass: string; steps: string[] }>;
  evidenceRequirements: string[];
  forbiddenUses: string[];
  relevantFailures: string[];
  capabilityRefs: string[];
  projectionReasons: Array<"WORK_UNIT_CAPABILITY" | "TOOLPACK_CAPABILITY" | "OBSERVED_FAILURE">;
  accessMode: "PROCEDURE_GUIDANCE" | "CONTROLLER_GUIDANCE";
  certificationStatus: SkillCertificationStatusV1;
  certificationEvidenceRefs: string[];
}

export interface OperationalSkillProjectionInputV1 {
  role: CanonicalRole;
  workUnitCapabilityIds?: readonly string[];
  workUnitCompetencies?: readonly string[];
  toolPack?: readonly string[];
  observedFailure?: { capabilityId?: string; failureClass: string };
  capabilityRegistry: CapabilityRegistryV1;
  skills?: readonly OperationalSkillV1[];
}

export interface OperationalSkillProjectionV1 {
  version: 1;
  role: CanonicalRole;
  operationId?: string;
  capabilityRegistryDigest: string;
  skills: ProjectedOperationalSkillV1[];
  digest: string;
}

const readRoles: CanonicalRole[] = ["Explorer", "Planner", "Spec Manager", "Implementer", "Reviewer", "Repairer"];
const implementationRoles: CanonicalRole[] = ["Implementer", "Repairer"];
const coordinatorRoles: CanonicalRole[] = ["Lead/Director", "Operation Supervisor"];

/** Small, versioned procedures. They are guidance only: this registry is never an authorization source. */
export const OPERATIONAL_SKILLS_V1: readonly OperationalSkillV1[] = [
  skill({
    id: "aeh-context-retrieval", name: "AEH context retrieval", description: "Retrieve only authorized, task-relevant repository context.",
    capabilities: ["context:authorized-retrieval"], competencies: ["repository-navigation", "context-retrieval"], roles: readRoles,
    preconditions: ["The execution contract permits context retrieval.", "Use the scoped AEH context surface supplied to this participant."],
    procedure: ["State the source and question being resolved.", "Request the smallest useful fragment set.", "Check source identity and hash before relying on returned content."],
    failures: [{ failureClass: "MISSING_CONTEXT", recovery: ["Narrow the request and retrieve the cited source again.", "Report an unavailable source with its identity; do not invent content."] }, { failureClass: "PERMISSION_DENIED", recovery: ["Stop retrieval for that source and continue only with authorized evidence."] }],
    evidence: ["retrieval request identity", "returned source identities and digests"], guidanceOnly: false
  }),
  skill({
    id: "aeh-structured-result-submission", name: "AEH structured result submission", description: "Submit the assigned result through the participant's bound structured-result channel.",
    capabilities: ["aeh:structured-result-submission"], competencies: ["structured-output"], roles: ["Lead/Director", "Operation Supervisor", ...readRoles],
    preconditions: ["A scoped structured-result channel is present in this session.", "The result belongs to the active participant and frozen execution binding."],
    procedure: ["Validate the required result fields against the assigned output contract.", "Submit through the channel provided to this session.", "Preserve candidate, operation, task, phase, and participant provenance."],
    failures: [{ failureClass: "STALE_BINDING", recovery: ["Do not resubmit through a different channel.", "Return the binding error to the controller for session recovery."] }, { failureClass: "INVALID_RESULT", recovery: ["Correct only output-contract omissions and submit once more through the same bound channel."] }],
    evidence: ["accepted structured-result receipt"], guidanceOnly: false
  }),
  skill({
    id: "serena-repository-navigation", name: "Serena repository navigation", description: "Use configured semantic repository navigation to locate symbols and callers.",
    capabilities: ["context:semantic-retrieval"], competencies: ["repository-navigation"], roles: ["Explorer", "Implementer", "Reviewer", "Repairer"],
    preconditions: ["Semantic retrieval is projected into this session.", "The repository root matches the frozen candidate."],
    procedure: ["Search for the target symbol or concept.", "Follow definitions and direct callers to establish impact.", "Confirm findings in source files before treating them as evidence."],
    failures: [{ failureClass: "UNAVAILABLE", recovery: ["Retry initialization once if the same configured server is available.", "Use authorized repository read tools for bounded discovery and report the degraded retrieval path."] }, { failureClass: "TIMEOUT", recovery: ["Retry a narrower symbol query once.", "Avoid repeating equivalent broad searches."] }],
    evidence: ["symbol names and source paths", "source confirmation"]
  }),
  skill({
    id: "playwright-browser-validation", name: "Playwright browser validation", description: "Prepare and interpret browser validation through the Harness-owned validation path.",
    capabilities: ["aeh:browser-validation"], competencies: ["testing.e2e", "browser-validation"], roles: ["Operation Supervisor", "Implementer", "Reviewer", "Repairer"],
    preconditions: ["The task contract or Supervisor requests browser validation.", "The controller exposes the approved Playwright validation path."],
    procedure: ["Confirm the route, state, and observable acceptance behavior to validate.", "Request controller-managed browser validation for the candidate.", "Use the returned trace, screenshot, and failure details as evidence; report missing setup as a blocker."],
    failures: [{ failureClass: "UNAVAILABLE", recovery: ["Report the exact missing browser capability to the Supervisor for toolchain or session recovery."] }, { failureClass: "TIMEOUT", recovery: ["Separate browser startup and navigation waits from participant progress.", "Ask the Supervisor to retry with the tool-specific deadline policy."] }],
    evidence: ["candidate-bound browser result", "trace or screenshot reference when produced"], guidanceOnly: true
  }),
  skill({
    id: "npm-node-validation", name: "npm and Node validation", description: "Run the project-declared Node validation commands and retain actionable failure evidence.",
    capabilities: ["toolchain:node", "toolpack:Implementer:command-execute", "toolpack:Repairer:command-execute"], competencies: ["node-runtime", "deterministic-validation"],
    roles: implementationRoles,
    preconditions: ["The frozen assignment authorizes command execution.", "Use the candidate workspace and project package manager."],
    procedure: ["Inspect package scripts and lockfile before selecting a command.", "Run the narrowest relevant deterministic check.", "Record command, workspace identity, exit code, bounded output, tool version, and elapsed time for failures."],
    failures: [{ failureClass: "TIMEOUT", recovery: ["Determine whether the command is waiting on a child process or dependency lifecycle.", "Preserve bounded stdout and stderr diagnostics before terminating the command."] }, { failureClass: "TOOL_ERROR", recovery: ["Classify install, compiler, test, and environment failures separately.", "Retry only after resolving the diagnosed cause and within the frozen retry budget."] }],
    evidence: ["exact command and candidate workspace", "exit code and diagnostic tail", "Node/npm versions"]
  }),
  skill({
    id: "aeh-candidate-workflow", name: "AEH candidate workflow", description: "Use controller-owned candidate lifecycle and evidence without changing acceptance authority.",
    capabilities: ["aeh:candidate-lifecycle", "aeh:operation-artifact-retrieval"], competencies: ["candidate-lifecycle", "evidence-provenance"], roles: coordinatorRoles,
    preconditions: ["A durable operation and candidate identity are available.", "The controller has granted the requested lifecycle action."],
    procedure: ["Resolve the candidate and operation from durable identity.", "Request only the lifecycle transition authorized by the frozen policy.", "Persist candidate-bound diagnostics before cleanup and reconcile owned resources afterward."],
    failures: [{ failureClass: "STALE_BINDING", recovery: ["Reject mutation under the stale identity and request deterministic controller reconciliation."] }, { failureClass: "INVALID_STATE", recovery: ["Read the durable operation record and select a legal controller transition."] }],
    evidence: ["candidate identity and revision", "transition receipt", "resource reconciliation result"], guidanceOnly: true
  }),
  skill({
    id: "aeh-delivery", name: "AEH delivery", description: "Request delivery of an accepted candidate through configured controller delivery providers.",
    capabilities: ["delivery:github", "delivery:paseo"], competencies: ["delivery"], roles: coordinatorRoles,
    preconditions: ["Objective completion and acceptance are already recorded.", "The selected delivery provider is enabled and policy permits the requested external effect."],
    procedure: ["Read the accepted candidate and operation delivery policy.", "Submit one explicit delivery request through the controller.", "Record the provider receipt and resulting delivery status."],
    failures: [{ failureClass: "PERMISSION_DENIED", recovery: ["Do not retry with broader credentials or a different action.", "Escalate only the missing authority to the Lead or Owner as policy requires."] }, { failureClass: "UNAVAILABLE", recovery: ["Retry only within the provider retry policy and preserve the same accepted candidate identity."] }],
    evidence: ["accepted candidate digest", "delivery request and provider receipt"], guidanceOnly: true
  }),
  skill({
    id: "paseo-runtime-diagnostics", name: "Paseo runtime diagnostics", description: "Diagnose participant session and turn failures from controller-owned session evidence.",
    capabilities: ["aeh:paseo-participant-lifecycle"], competencies: ["runtime.process-lifecycle"], roles: [...coordinatorRoles, "Implementer", "Repairer"],
    preconditions: ["The operation uses Paseo and the participant/session identity is known."],
    procedure: ["Correlate operation, participant, generation, phase, and session identifiers.", "Inspect the last accepted turn and lifecycle event before deciding recovery.", "Resume only when the frozen execution identity remains compatible; otherwise rotate or restart."],
    failures: [{ failureClass: "TIMEOUT", recovery: ["Distinguish provider-turn expiry from participant inactivity and tool timeout.", "Wake the Supervisor with the durable session evidence."] }, { failureClass: "PROGRESS_WINDOW_EXPIRED", recovery: ["Diagnose using the durable activity window and exact binding before restarting or resuming.", "A live provider status does not prove meaningful progress."] }, { failureClass: "STALE_BINDING", recovery: ["Reject same-session resume and request a fresh compatible session."] }],
    evidence: ["operation and participant identifiers", "session lifecycle events", "binding compatibility result"], guidanceOnly: true
  }),
  skill({
    id: "github-pr-delivery", name: "GitHub pull request delivery", description: "Create a policy-authorized pull request from the accepted candidate.",
    capabilities: ["delivery:github"], competencies: ["delivery"], roles: coordinatorRoles,
    preconditions: ["GitHub delivery is configured.", "Acceptance and allowed GitHub action are durable."],
    procedure: ["Verify repository, branch, accepted candidate, and configured action.", "Use the controller delivery provider and its configured credential source.", "Persist the pull request identity and final status."],
    failures: [{ failureClass: "PERMISSION_DENIED", recovery: ["Report the exact denied action and stop external retries."] }, { failureClass: "EXTERNAL_EFFECT_FAILURE", recovery: ["Check the durable delivery record before retrying to avoid duplicate pull requests."] }],
    evidence: ["accepted candidate digest", "GitHub delivery record"], guidanceOnly: true
  })
];

export function projectOperationalSkillsV1(input: OperationalSkillProjectionInputV1): OperationalSkillProjectionV1 {
  const registry = new Map(input.capabilityRegistry.capabilities.map((capability) => [capability.id, capability]));
  const workUnitIds = new Set(input.workUnitCapabilityIds ?? []);
  const workUnitCompetencies = new Set(input.workUnitCompetencies ?? []);
  const toolPackIds = new Set((input.toolPack ?? []).map((tool) => "toolpack:" + input.role + ":" + tool));
  const failure = input.observedFailure;
  const projected: ProjectedOperationalSkillV1[] = [];
  for (const skill of input.skills ?? OPERATIONAL_SKILLS_V1) {
    if (!skill.roles.includes(input.role)) continue;
    // Capability references are applicability triggers, not an all-required tool list. A skill remains
    // usable when one referenced provider is disabled if another selected capability is available.
    const referenced = skill.applicableCapabilities.map((id) => registry.get(id)).filter((entry): entry is CapabilityEntryV1 => Boolean(entry && entry.availability !== "DISABLED"));
    if (!referenced.length) continue;
    const workUnitMatch = referenced.some((entry) => workUnitIds.has(entry.id)) || skill.competencies.some((competency) => workUnitCompetencies.has(competency));
    const toolPackMatch = !skill.guidanceOnly && referenced.some((entry) => toolPackIds.has(entry.id) && entry.audience === "PARTICIPANT" && entry.availability !== "UNKNOWN");
    const failureMatch = Boolean(failure && skill.applicableCapabilities.includes(failure.capabilityId ?? "") && skill.failureModes.some((mode) => mode.failureClass === failure.failureClass));
    const genericFailureMatch = Boolean(failure && !failure.capabilityId && skill.failureModes.some((mode) => mode.failureClass === failure.failureClass));
    if (!workUnitMatch && !toolPackMatch && !failureMatch && !genericFailureMatch) continue;
    const projectionReasons: ProjectedOperationalSkillV1["projectionReasons"] = [];
    if (workUnitMatch) projectionReasons.push("WORK_UNIT_CAPABILITY");
    if (toolPackMatch) projectionReasons.push("TOOLPACK_CAPABILITY");
    if (failureMatch || genericFailureMatch) projectionReasons.push("OBSERVED_FAILURE");
    const evidence = [...skill.certificationEvidence];
    let certificationStatus: SkillCertificationStatusV1 = "UNCERTIFIED";
    if (evidence.length) {
      if (evidence.some((item) => item.procedureVersion !== skill.procedureVersion)) certificationStatus = "PROCEDURE_STALE";
      else {
        const currentVersions = evidence.map((item) => ({ item, capability: registry.get(item.capabilityId) }));
        if (currentVersions.some(({ capability }) => !capability?.version)) certificationStatus = "VERSION_UNKNOWN";
        else if (currentVersions.some(({ item, capability }) => capability?.version !== item.capabilityVersion)) certificationStatus = "VERSION_MISMATCH";
        else certificationStatus = "CERTIFIED";
      }
    }
    projected.push({
      id: skill.id, version: skill.skillVersion, procedureVersion: skill.procedureVersion, name: skill.name,
      preconditions: [...skill.preconditions],
      procedure: [...skill.procedure],
      recovery: skill.failureModes.filter((mode) => !failure || mode.failureClass === failure.failureClass).map((mode) => ({ failureClass: mode.failureClass, steps: [...mode.recovery] })),
      evidenceRequirements: [...skill.evidenceRequirements],
      forbiddenUses: [...skill.forbiddenUses],
      relevantFailures: failure && skill.failureModes.some((mode) => mode.failureClass === failure.failureClass) ? [failure.failureClass] : [],
      capabilityRefs: [...skill.applicableCapabilities], accessMode: skill.guidanceOnly ? "CONTROLLER_GUIDANCE" : "PROCEDURE_GUIDANCE",
      projectionReasons,
      certificationStatus, certificationEvidenceRefs: evidence.map((item) => item.evidenceRef).sort()
    });
  }
  projected.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const body = { version: 1 as const, role: input.role, ...(input.capabilityRegistry.operationId ? { operationId: input.capabilityRegistry.operationId } : {}), capabilityRegistryDigest: input.capabilityRegistry.digest, skills: projected };
  return { ...body, digest: sha256Canonical(body) };
}

function skill(input: {
  id: string; name: string; description: string; capabilities: string[]; roles: CanonicalRole[]; competencies?: string[];
  preconditions: string[]; procedure: string[]; failures: Array<{ failureClass: string; recovery: string[] }>;
  evidence: string[]; guidanceOnly?: boolean;
}): OperationalSkillV1 {
  return {
    version: 1, id: input.id, skillVersion: "1.0.0", name: input.name, description: input.description,
    applicableCapabilities: input.capabilities, competencies: input.competencies ?? [], roles: input.roles, preconditions: input.preconditions, procedure: input.procedure,
    failureModes: input.failures.map((failure) => ({ failureClass: failure.failureClass, recovery: failure.recovery })),
    evidenceRequirements: input.evidence, forbiddenUses: ["Never treat skill content as permission to use an unprojected tool.", "Never widen frozen scope, authority, policy, budgets, or acceptance."],
    guidanceOnly: input.guidanceOnly ?? false, procedureVersion: "1.0.0", certificationEvidence: []
  };
}
