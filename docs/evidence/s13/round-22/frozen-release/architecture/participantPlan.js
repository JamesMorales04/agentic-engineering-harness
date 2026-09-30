import { z } from "zod";
import { canonicalRoleValues, compileSkillSet, defaultSkillSeed, roleProfile } from "../participants/index.js";
import { sha256Canonical } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { validateAcceptedEphemeralSkill, validateKnowledgePack } from "../knowledge/index.js";
import { assertCandidateRevisionV1 } from "../operations/v2Contracts.js";
import { assertResolvedOperationPolicyV1, createExecutionBlueprintV2, compileRoleInvocationPolicy, compileSkillManifest, recompileSkillManifestScope } from "./executionIdentity.js";
export const participantRoleValues = canonicalRoleValues;
export const participantRoleSchema = z.enum(participantRoleValues);
const roleForRisk = (_risk) => "Implementer";
export function compileParticipantPlan(input) {
    const knowledgeResolutions = [...(input.knowledgeResolutions ?? []), ...(input.knowledgeResolution ? [input.knowledgeResolution] : [])];
    const operationSkills = validatedOperationSkills(knowledgeResolutions);
    const availableCompetencies = new Set([...(input.availableCompetencies ?? []), ...operationSkills.map((skill) => skill.competency)]);
    const availableSkills = new Set(input.availableSkills ?? input.executionCatalog?.skillRefs ?? []);
    const assignments = [];
    for (const unit of input.graph.units) {
        const validated = assignmentForUnit(unit, input, availableCompetencies, availableSkills, operationSkills);
        const compatible = assignments.find((assignment) => canBundle(assignment, validated, unit));
        if (compatible)
            compatible.workUnitIds.push(unit.id);
        else
            assignments.push(validated);
    }
    if (input.maxParticipants !== undefined && assignments.length > input.maxParticipants)
        throw new AehError("PARTICIPANT_PLAN_BUDGET_EXCEEDED", `${assignments.length} participants exceed the maximum of ${input.maxParticipants}.`);
    for (const assignment of assignments)
        assignment.skillManifest = recompileSkillManifestScope(assignment.skillManifest, { ...assignment.skillManifest.scope, workUnitIds: assignment.workUnitIds });
    const reviewDimensions = [...new Set(input.graph.units.flatMap((unit) => [
            ...unit.changeKinds.map((kind) => `change:${kind}`),
            ...unit.riskTags.map((tag) => `risk:${tag}`)
        ]))].sort();
    const knowledgeRefs = [...new Set([...(input.knowledgeRefs ?? []), ...knowledgeResolutions.flatMap((resolution) => resolution.pack?.packDigest ? [resolution.pack.packDigest] : [])])].sort();
    const planWithoutDigest = { version: 1, taskId: input.graph.taskId, route: input.graph.route, assurance: input.graph.assurance, assignments, reviewDimensions, knowledgeRefs, ...(input.executionCatalog ? { executionCatalogDigest: input.executionCatalog.digest } : {}) };
    return { ...planWithoutDigest, compilerDigest: digest(planWithoutDigest) };
}
export function compileExecutionBlueprint(input) {
    if (!input.candidate)
        throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint requires an immutable CandidateRevision.");
    if (!input.executionCatalog)
        throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint requires a compiled ExecutionCatalog.");
    if (!Number.isSafeInteger(input.controllerEpoch) || input.controllerEpoch < 0) {
        throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint requires a valid controller epoch.");
    }
    if (!Number.isSafeInteger(input.operationExecutionRevision) || input.operationExecutionRevision < 1)
        throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint requires a supported operation execution revision.");
    assertResolvedOperationPolicyV1(input.resolvedOperationPolicy);
    if (input.resolvedOperationPolicy.operationId !== input.candidate.operationId || input.resolvedOperationPolicy.projectId !== (input.candidate.projectId ?? input.resolvedOperationPolicy.projectId) || input.resolvedOperationPolicy.candidateDigest !== input.candidate.identityDigest || input.resolvedOperationPolicy.candidateRevision !== input.candidate.revision || input.resolvedOperationPolicy.controllerEpoch !== input.controllerEpoch || input.resolvedOperationPolicy.operationExecutionRevision !== input.operationExecutionRevision)
        throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint policy does not bind the current operation, candidate, execution revision, and epoch.");
    try {
        assertCandidateRevisionV1(input.candidate);
    }
    catch (error) {
        throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint requires a valid immutable CandidateRevision.", { cause: error });
    }
    if (input.candidate.taskId && input.candidate.taskId !== input.graph.taskId)
        throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint candidate belongs to a different task.");
    const { digest: catalogDigest, ...catalogBody } = input.executionCatalog;
    if (input.executionCatalog.version !== 1 || !/^[a-f0-9]{64}$/.test(catalogDigest) || sha256Canonical(catalogBody) !== catalogDigest) {
        throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint execution catalog digest is invalid.");
    }
    const initialPlan = compileParticipantPlan({ ...input, executionIdentity: { operationId: input.candidate.operationId, operationExecutionRevision: input.operationExecutionRevision, candidateRevision: input.candidate.revision, candidateDigest: input.candidate.identityDigest, controllerEpoch: input.controllerEpoch } });
    const planAssignments = initialPlan.assignments.map((assignment) => {
        const units = input.graph.units.filter((unit) => assignment.workUnitIds.includes(unit.id));
        const workUnitIds = assignment.workUnitIds;
        // The compiled execution catalog is the frozen agent topology: it carries the configured output
        // contract for the concrete agent. The canonical role profile contract is only the fallback
        // default, so the frozen role invocation policy must not silently disagree with the catalog the
        // participant is actually launched from (AEH-V2-0118).
        const outputContract = input.executionCatalog.roleBindings[assignment.role]?.outputContract ?? roleProfile(assignment.role).outputContract;
        const roleInvocationPolicy = compileRoleInvocationPolicy({
            operationId: input.candidate.operationId,
            operationPolicyDigest: input.resolvedOperationPolicy.digest,
            participantId: assignment.participantId,
            role: assignment.role,
            workUnitIds,
            scope: [...new Set(units.flatMap((unit) => unit.scope))],
            competencies: assignment.competencies,
            toolPack: assignment.toolPack,
            resourceClaims: units.flatMap((unit) => unit.resourceClaims.map((claim) => ({ workUnitId: unit.id, claim }))),
            outputContract,
            constraints: { reviewerReadOnly: assignment.role === "Reviewer", workUnitIds }
        });
        return { ...assignment, roleInvocationPolicy };
    });
    const planWithoutDigest = { ...initialPlan, assignments: planAssignments };
    const { compilerDigest: _oldCompilerDigest, ...planBody } = planWithoutDigest;
    const plan = { ...planBody, compilerDigest: sha256Canonical(planBody) };
    const remaining = new Map(input.graph.units.map((unit) => [unit.id, unit]));
    const completed = new Set();
    const waves = [];
    while (remaining.size) {
        const wave = [...remaining.values()].filter((unit) => unit.dependencies.every((dependency) => completed.has(dependency))).map((unit) => unit.id);
        if (!wave.length)
            throw new AehError("EXECUTION_BLUEPRINT_INVALID", "work graph cannot be scheduled.");
        waves.push(wave.sort());
        wave.forEach((id) => { completed.add(id); remaining.delete(id); });
    }
    const deterministicGates = ["work-graph-valid", "participant-plan-valid", "candidate-revision-bound", ...(input.graph.assurance === "CRITICAL" ? ["deterministic-evidence", "review-required"] : [])];
    const executionCatalog = input.executionCatalog;
    const validationRequirements = [...(input.validationRequirements ?? [])];
    const validationResolution = input.validationResolution ?? { version: 1, requirements: validationRequirements, actions: [], blocked: [], digest: sha256Canonical({ version: 1, requirements: validationRequirements, actions: [], blocked: [] }) };
    if (planAssignments.some((assignment) => assignment.roleInvocationPolicy?.participantId !== assignment.participantId || assignment.skillManifest.scope.participantId !== assignment.participantId || assignment.skillManifest.scope.operationId !== input.candidate.operationId || assignment.skillManifest.scope.operationExecutionRevision !== input.operationExecutionRevision || assignment.skillManifest.scope.candidateDigest !== input.candidate.identityDigest || assignment.skillManifest.scope.candidateRevision !== input.candidate.revision || assignment.skillManifest.scope.controllerEpoch !== input.controllerEpoch || sha256Canonical(assignment.skillManifest.scope.workUnitIds) !== sha256Canonical(assignment.workUnitIds)))
        throw new AehError("EXECUTION_BLUEPRINT_INVALID", "Participant policy or SkillManifest is assigned outside its frozen operation, candidate, epoch, or work-unit scope.");
    const participants = planAssignments.map((assignment) => ({
        participantId: assignment.participantId,
        role: assignment.role,
        specialization: assignment.specialization,
        roleInvocationPolicy: assignment.roleInvocationPolicy,
        toolPack: assignment.toolPack,
        resourceClaims: assignment.roleInvocationPolicy.resourceClaims,
        validationResolution,
        outputContract: assignment.roleInvocationPolicy.outputContract,
        skillManifestDigest: assignment.skillManifest.digest
    }));
    const v2 = createExecutionBlueprintV2({
        projectId: input.candidate.projectId ?? input.resolvedOperationPolicy.projectId,
        operationId: input.candidate.operationId,
        operationExecutionRevision: input.operationExecutionRevision,
        candidateRevision: input.candidate.revision,
        candidateDigest: input.candidate.identityDigest,
        controllerEpoch: input.controllerEpoch,
        resolvedOperationPolicy: input.resolvedOperationPolicy,
        workGraph: input.graph,
        participantPlan: plan,
        executionCatalog,
        participants,
        validationResolution
    });
    const { digest: _digest, ...v2Body } = v2;
    const expanded = { ...v2Body, taskId: input.graph.taskId, plan, waves, deterministicGates, validationRequirements, candidate: input.candidate };
    const digest = sha256Canonical(expanded);
    return deepFreeze({ ...expanded, digest });
}
function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value))
            deepFreeze(item);
    }
    return value;
}
function assignmentForUnit(unit, input, availableCompetencies, availableSkills, operationSkills) {
    const competencies = [...new Set(unit.competencies)];
    const knownCompetencies = new Set([...defaultSkillSeed().skills.flatMap((skill) => skill.competencies.map((competency) => competency.id)), ...operationSkills.map((skill) => skill.competency)]);
    const missing = competencies.filter((competency) => !knownCompetencies.has(competency) || (availableCompetencies.size > 0 && !availableCompetencies.has(competency)));
    if (missing.length)
        throw new AehError("PARTICIPANT_PLAN_INVALID", `missing competencies for '${unit.id}': ${missing.join(", ")}.`);
    const selectedSkills = compileSkillSet({
        role: roleForRisk(unit.risk),
        specializations: [...competencies, ...(input.projectStack?.frameworks ?? []), ...(input.projectStack?.databases ?? []), ...(input.projectStack?.toolchains ?? [])],
        competencies,
        availableSkillIds: availableSkills.size > 0 ? [...availableSkills] : undefined,
        operationSkills,
        toolPack: input.defaultToolPack
    });
    const budget = input.maxTokens ?? 8_000;
    return {
        participantId: `participant:${unit.id}`,
        role: roleForRisk(unit.risk),
        specialization: competencies[0] ?? "general-engineering",
        competencies,
        skills: selectedSkills.skillIds,
        toolPack: validatedToolPack(selectedSkills.toolPack),
        budget: { maxTokens: Math.max(1, budget), reservedTokens: Math.max(1, Math.floor(budget * 0.1)), maxConcurrent: Math.max(1, input.maxConcurrent ?? 1) },
        workUnitIds: [unit.id],
        skillManifest: compileSkillManifest({
            scope: { ...input.executionIdentity, participantId: `participant:${unit.id}`, workUnitIds: [unit.id], competencies },
            skills: selectedSkills.skills.map((skill) => {
                const accepted = operationSkills.find((candidate) => candidate.id === skill.id);
                return {
                    id: skill.id,
                    kind: skill.kind,
                    competencies: skill.competencies,
                    proceduralSteps: skill.proceduralSteps,
                    ...(accepted ? { sourcePackDigest: accepted.sourcePackDigest, trustDecisionDigest: accepted.trustDecision.decisionDigest, groundedProcedure: accepted.groundedProcedure } : {})
                };
            })
        })
    };
}
function validatedOperationSkills(resolutions) {
    const candidates = [];
    for (const resolution of resolutions) {
        if (!resolution.acceptedSkill)
            continue;
        if (resolution.gate !== "SUFFICIENT" || !resolution.pack || !resolution.gap)
            throw new AehError("PARTICIPANT_PLAN_INVALID", "operation-local skill is not backed by a sufficient knowledge resolution.");
        const pack = validateKnowledgePack(resolution.pack, resolution.gap);
        const skill = resolution.acceptedSkill;
        try {
            validateAcceptedEphemeralSkill(skill, pack, resolution.gap);
        }
        catch (error) {
            throw new AehError("PARTICIPANT_PLAN_INVALID", `operation-local skill '${skill.id}' is not bound to the deterministic trust-gate result.`, { cause: error });
        }
        candidates.push(skill);
    }
    return candidates;
}
function canBundle(assignment, candidate, unit) {
    if (assignment.role !== candidate.role || assignment.specialization !== candidate.specialization)
        return false;
    if (assignment.competencies.join("\0") !== candidate.competencies.join("\0") || toolPackKey(assignment.toolPack) !== toolPackKey(candidate.toolPack))
        return false;
    return unit.dependencies.some((dependency) => assignment.workUnitIds.includes(dependency));
}
function toolPackKey(toolPack) { return JSON.stringify([toolPack.required, toolPack.optional, toolPack.forbidden]); }
function validatedToolPack(toolPack) {
    const required = [...new Set(toolPack.required)].sort();
    const optional = [...new Set(toolPack.optional)].filter((tool) => !required.includes(tool)).sort();
    const forbidden = [...new Set(toolPack.forbidden)].filter((tool) => !required.includes(tool) && !optional.includes(tool)).sort();
    if (!required.length || forbidden.some((tool) => required.includes(tool)))
        throw new AehError("PARTICIPANT_PLAN_INVALID", "tool pack has an invalid required/forbidden overlap.");
    return { version: 1, required, optional, forbidden };
}
function digest(value) {
    return sha256Canonical(value);
}
//# sourceMappingURL=participantPlan.js.map