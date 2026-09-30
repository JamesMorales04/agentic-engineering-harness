import { sha256Canonical } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { loadOperation } from "../operations/state.js";
import { deterministicParticipantId } from "../security/executionLease.js";
import { recordEvent } from "../telemetry/events.js";
import path from "node:path";
import { assembleCandidateChangeSet } from "./assembler.js";
import { captureInverseCandidateChangeSet, executeIsolatedCandidateMutation } from "./direct.js";
import { bindAssembledCandidate } from "./binding.js";
export function assertCompiledRepairer(selection, catalog) {
    if (!selection || selection.role !== "Repairer")
        throw new AehError("PARTICIPANT_PLAN_INVALID", "A frozen Repairer selection is required for candidate repair.");
    if (selection.permissions.review === "allow" || selection.permissions.delegate === "allow" || selection.permissions.gitWrite === "allow" || selection.outputContract === "reviewer") {
        throw new AehError("PARTICIPANT_PLAN_INVALID", "Repairer authority cannot include review, delegation, Git delivery, or reviewer output capability.");
    }
    if (!catalog)
        throw new AehError("PARTICIPANT_PLAN_INVALID", "A compiled ExecutionCatalog is required for candidate repair.");
    const { digest, ...catalogBody } = catalog;
    if (sha256Canonical(catalogBody) !== digest)
        throw new AehError("PARTICIPANT_PLAN_INVALID", "Repairer ExecutionCatalog digest is invalid.");
    const binding = catalog.roleBindings.Repairer;
    if (!binding)
        throw new AehError("PARTICIPANT_PLAN_INVALID", "The compiled ExecutionCatalog has no Repairer role binding.");
    const matches = binding.runtimeId === selection.runtimeName &&
        binding.modelAlias === selection.modelAlias &&
        binding.transport === selection.transport &&
        binding.profile === selection.profile &&
        binding.variant === selection.variant &&
        binding.nativeAgent === selection.nativeAgent &&
        binding.outputContract === selection.outputContract;
    if (!matches)
        throw new AehError("PARTICIPANT_PLAN_INVALID", "Repairer selection does not match its frozen ExecutionCatalog role binding.");
}
export async function executeRepairerCandidateMutation(input) {
    assertCompiledRepairer(input.selection, input.executionCatalog);
    const operation = await loadOperation(input.stateRoot, input.operationId);
    const currentCandidate = operation.candidateRevision;
    if (!currentCandidate)
        throw new AehError("CANDIDATE_STALE", `Operation ${input.operationId} has no current CandidateRevision for Repairer execution.`);
    if (currentCandidate.taskId && currentCandidate.taskId !== input.taskId)
        throw new AehError("CANDIDATE_STALE", "Repairer candidate belongs to another task.");
    const participantId = deterministicParticipantId(input.operationId, input.selection.logicalAgent, `${input.phase}:${input.workUnitId}`);
    const isolated = await executeIsolatedCandidateMutation({
        root: input.root,
        operationId: input.operationId,
        taskId: input.taskId,
        workUnitId: input.workUnitId,
        candidate: currentCandidate,
        config: input.config,
        contract: input.contract,
        execute: (isolatedRoot) => input.execute(isolatedRoot, participantId),
        prepareWorkspace: input.prepareWorkspace
    });
    if (isolated.session.exitCode !== 0 || !isolated.changeSet)
        return { session: isolated.session };
    const assembled = await assembleCandidateChangeSet({
        root: input.root,
        operationId: input.operationId,
        projectId: currentCandidate.projectId,
        taskId: input.taskId,
        currentCandidate,
        changeSet: isolated.changeSet,
        allowedScope: input.allowedScope,
        forbiddenScope: [...input.forbiddenScope, ...repairProtectedPaths(input.config, input.contract)],
        candidateId: `candidate:${input.operationId}:r${currentCandidate.revision + 1}`,
        workspace: currentCandidate.workspace,
        worktree: input.root,
        semanticAssessment: input.semanticAssessment
    });
    await bindAssembledCandidate({ root: input.root, stateRoot: input.stateRoot, operationId: input.operationId, baseCandidate: currentCandidate, candidate: assembled.candidate, changeSet: isolated.changeSet });
    await recordEvent(input.stateRoot, input.config, "harness.candidate.repair-assembled", {
        taskId: input.taskId,
        workUnitId: isolated.changeSet.workUnitId,
        participantId: isolated.changeSet.participantId,
        role: input.selection.role,
        candidateRevision: assembled.candidate.revision,
        candidateDigest: assembled.candidate.sourceDigest,
        impactDigest: assembled.impact.digest
    });
    return { session: isolated.session, changeSet: isolated.changeSet, candidate: assembled.candidate, impact: assembled.impact };
}
export async function rejectRepairCandidateChangeSet(input) {
    const operation = await loadOperation(input.stateRoot, input.operationId);
    const currentCandidate = operation.candidateRevision;
    if (!currentCandidate || currentCandidate.revision !== input.rejectedChangeSet.baseCandidateRevision + 1) {
        throw new AehError("CANDIDATE_STALE", "Rejected repair no longer matches the current CandidateRevision.");
    }
    const inverse = await captureInverseCandidateChangeSet({
        root: input.root,
        operationId: input.operationId,
        taskId: input.taskId,
        workUnitId: input.workUnitId,
        candidate: currentCandidate,
        config: input.config,
        contract: input.contract,
        rejectedChangeSet: input.rejectedChangeSet,
        prepareWorkspace: input.prepareWorkspace
    });
    if (!inverse)
        throw new AehError("CANDIDATE_STALE", "Rejected repair has no reversible source changes.");
    const assembled = await assembleCandidateChangeSet({
        root: input.root,
        operationId: input.operationId,
        projectId: currentCandidate.projectId,
        taskId: input.taskId,
        currentCandidate,
        changeSet: inverse,
        allowedScope: input.allowedScope,
        forbiddenScope: [...input.forbiddenScope, ...repairProtectedPaths(input.config, input.contract)],
        candidateId: `candidate:${input.operationId}:r${currentCandidate.revision + 1}`,
        workspace: currentCandidate.workspace,
        worktree: input.root,
        semanticAssessment: input.semanticAssessment
    });
    await bindAssembledCandidate({ root: input.root, stateRoot: input.stateRoot, operationId: input.operationId, baseCandidate: currentCandidate, candidate: assembled.candidate, changeSet: inverse });
    await recordEvent(input.stateRoot, input.config, "harness.candidate.repair-rejected", {
        taskId: input.taskId,
        workUnitId: input.workUnitId,
        rejectedCandidateRevision: currentCandidate.revision,
        rollbackCandidateRevision: assembled.candidate.revision,
        candidateDigest: assembled.candidate.sourceDigest
    });
    return { candidate: assembled.candidate, impact: assembled.impact };
}
/** Files that define the frozen task, validation policy, or runtime policy cannot be changed by repair. */
export function repairProtectedPaths(config, contract) {
    const paths = new Set([
        `${config.sdd?.contractsDir ?? ".harness/contracts"}/${contract.task.id}.yaml`,
        `.harness/seals/${contract.task.id}.json`,
        ".harness/project.yaml",
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "tests",
        "test",
        "specs",
        "acceptance",
        "features",
        "src/validators",
        ...(contract.scope?.frozen ?? []),
        ...(config.validation?.frozenPaths ?? []),
        ...configuredValidatorSourcePaths(config, contract),
        ...Object.values(contract.source ?? {}).filter((value) => Boolean(value)),
        ...(contract.issue?.snapshotPath ? [contract.issue.snapshotPath] : []),
        ...(config.agents?.configPath ? [config.agents.configPath] : []),
        ...(config.agents?.generatedPath ? [config.agents.generatedPath] : []),
        ...(config.toolchain?.configPath ? [config.toolchain.configPath] : []),
        ...(config.toolchain?.lockPath ? [config.toolchain.lockPath] : []),
        ...(config.validation?.opa?.policyDirs ?? []),
        ...(config.organization?.policyBundles?.cacheDir ? [config.organization.policyBundles.cacheDir] : []),
        ...(config.controlPlane?.include ?? [])
    ]);
    const normalized = new Set();
    for (const raw of paths) {
        const value = raw.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
        if (!value || path.isAbsolute(value) || value.split("/").includes(".."))
            continue;
        normalized.add(value);
        normalized.add(`${value}/**`);
    }
    return [...normalized].sort();
}
function configuredValidatorSourcePaths(config, contract) {
    const commands = [
        ...(config.validation?.commands ?? []),
        ...(config.validation?.validators ?? []),
        ...(config.validation?.providers ?? []),
        ...(contract.verification?.commands ?? []),
        ...(contract.verification?.validators ?? [])
    ];
    const references = new Set();
    const sourceArgument = /(?:^|[\s"'=])((?:\/|\.{1,2}\/)?(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.(?:[cm]?[jt]sx?|py|sh|bash|ps1|rb|pl|rego|feature|json|ya?ml|toml))(?=$|[\s"'#])/g;
    for (const command of commands) {
        if (!command.command)
            continue;
        sourceArgument.lastIndex = 0;
        for (const match of command.command.matchAll(sourceArgument)) {
            const value = match[1];
            if (!value || path.posix.isAbsolute(value))
                continue;
            const reference = path.posix.normalize(path.posix.join(command.workingDirectory ?? ".", value)).replace(/^\.\//, "");
            if (reference !== ".." && !reference.startsWith("../"))
                references.add(reference);
        }
    }
    return [...references];
}
//# sourceMappingURL=repair.js.map