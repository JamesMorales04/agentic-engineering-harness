import { canonicalSerialize, sha256Canonical, sha256Utf8 } from "../core/digest.js";
export const V2_CONTRACT_VERSION = 1;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
function sha256(value) {
    return sha256Utf8(value);
}
function requiredString(value, field) {
    if (typeof value !== "string" || value.trim().length === 0)
        throw new Error(`V2_CONTRACT_INVALID: ${field} must be a non-empty string.`);
}
function validDigest(value, field) {
    requiredString(value, field);
    if (!DIGEST_PATTERN.test(value))
        throw new Error(`V2_CONTRACT_INVALID: ${field} must be a lowercase SHA-256 digest.`);
}
function isoTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
        throw new Error("V2_CONTRACT_INVALID: timestamp is not a valid instant.");
    return date.toISOString();
}
function candidateIdentity(input) {
    return {
        version: V2_CONTRACT_VERSION,
        operationId: input.operationId,
        candidateId: input.candidateId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        revision: input.revision,
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.worktree ? { worktree: input.worktree } : {}),
        ...(input.parentCandidateId ? { parentCandidateId: input.parentCandidateId } : {}),
        sourceDigest: input.sourceDigest,
        ...(input.createdAt ? { createdAt: isoTime(input.createdAt) } : {}),
    };
}
export function canonicalCandidateIdentity(input) {
    assertCandidateRevisionInputV1(input);
    return canonicalSerialize(candidateIdentity(input));
}
export function candidateIdentityDigest(input) {
    return sha256(canonicalCandidateIdentity(input));
}
export const canonicalCandidateDigest = candidateIdentityDigest;
export function createCandidateRevisionV1(input) {
    assertCandidateRevisionInputV1(input);
    const canonical = canonicalSerialize(candidateIdentity(input));
    return {
        ...input,
        version: V2_CONTRACT_VERSION,
        canonicalIdentity: canonical,
        identityDigest: sha256(canonical),
    };
}
export function assertCandidateRevisionInputV1(value) {
    if (!value || typeof value !== "object")
        throw new Error("V2_CONTRACT_INVALID: candidate input must be an object.");
    const input = value;
    requiredString(input.operationId, "candidate.operationId");
    requiredString(input.candidateId, "candidate.candidateId");
    if (!Number.isSafeInteger(input.revision) || input.revision < 0)
        throw new Error("V2_CONTRACT_INVALID: candidate.revision must be a non-negative integer.");
    validDigest(input.sourceDigest, "candidate.sourceDigest");
}
export function assertCandidateRevisionV1(value) {
    assertCandidateRevisionInputV1(value);
    const candidate = value;
    if (candidate.version !== V2_CONTRACT_VERSION)
        throw new Error("V2_CONTRACT_INVALID: unsupported candidate version.");
    const supportedFields = new Set(["version", "operationId", "candidateId", "projectId", "taskId", "revision", "workspace", "worktree", "parentCandidateId", "sourceDigest", "createdAt", "canonicalIdentity", "identityDigest"]);
    const unsupportedFields = Object.keys(candidate).filter((field) => !supportedFields.has(field));
    if (unsupportedFields.length)
        throw new Error(`V2_CONTRACT_INVALID: unsupported CandidateRevision fields: ${unsupportedFields.sort().join(", ")}.`);
    const canonical = canonicalCandidateIdentity(candidate);
    if (candidate.canonicalIdentity !== canonical || candidate.identityDigest !== sha256(canonical))
        throw new Error("V2_CONTRACT_INVALID: candidate canonical identity or digest is inconsistent.");
}
export function candidateRevisionsEqual(left, right) {
    try {
        assertCandidateRevisionV1(left);
        assertCandidateRevisionV1(right);
    }
    catch {
        return false;
    }
    return left.identityDigest === right.identityDigest && left.canonicalIdentity === right.canonicalIdentity;
}
export function isStaleCandidateBinding(bound, current) {
    return !candidateRevisionsEqual(bound, current);
}
export const isCandidateRevisionStale = isStaleCandidateBinding;
export function assertCurrentCandidateBinding(bound, current) {
    assertCandidateRevisionV1(bound);
    assertCandidateRevisionV1(current);
    if (bound.operationId !== current.operationId)
        throw new Error("V2_CANDIDATE_BINDING_REJECTED: candidate belongs to a different operation.");
    if (isStaleCandidateBinding(bound, current))
        throw new Error("V2_CANDIDATE_BINDING_REJECTED: candidate binding is stale.");
}
function terminalContext(value) {
    return "candidate" in value ? value : { candidate: value };
}
function isValidTimestamp(value, now) {
    const timestamp = new Date(value).getTime();
    return !Number.isNaN(timestamp) && timestamp <= new Date(now).getTime();
}
export function evaluateTerminalGate(receipt, expected) {
    const failures = [];
    if (!receipt || typeof receipt !== "object")
        return { allowed: false, reasons: [{ code: "INVALID_RECEIPT", message: "participant receipt must be an object." }] };
    const value = receipt;
    let context;
    try {
        context = terminalContext(expected);
        assertCandidateRevisionV1(context.candidate);
    }
    catch {
        return { allowed: false, reasons: [{ code: "CANDIDATE_MISMATCH", message: "terminal gate context has no valid current candidate." }] };
    }
    if (value.version !== V2_CONTRACT_VERSION || !value.receiptId || !value.participantId || !value.operationId)
        failures.push({ code: "INVALID_RECEIPT", message: "receipt identity is incomplete or uses an unsupported version." });
    if (context.operationId && value.operationId !== context.operationId)
        failures.push({ code: "OPERATION_MISMATCH", message: "receipt belongs to a different operation." });
    const boundCandidate = value.candidateBinding ?? value.candidate;
    if (!boundCandidate || !candidateRevisionsEqual(boundCandidate, context.candidate) || value.operationId !== context.candidate.operationId)
        failures.push({ code: "CANDIDATE_MISMATCH", message: "receipt is not bound to the current candidate revision." });
    const terminal = value.runtimeTerminalEvidence ?? value.runtimeTerminal;
    const now = isoTime(context.now ?? new Date());
    if (!terminal || terminal.kind !== "runtime-terminal" || terminal.terminal !== true || !terminal.eventId || !isValidTimestamp(terminal.observedAt, now) || terminal.status !== value.outcome)
        failures.push({ code: "RUNTIME_TERMINAL_EVIDENCE_REQUIRED", message: "completion requires matching, observed runtime terminal evidence." });
    if (!value.contract || value.contract.valid !== true || !value.contract.contractId || !DIGEST_PATTERN.test(value.contract.contractDigest))
        failures.push({ code: "CONTRACT_INVALID", message: "a valid persisted contract evidence record is required." });
    const artifact = value.persistedArtifact ?? value.artifact;
    if (!artifact || artifact.persisted !== true || !artifact.artifactId || !DIGEST_PATTERN.test(artifact.artifactDigest) || !isValidTimestamp(artifact.persistedAt, now))
        failures.push({ code: "PERSISTED_ARTIFACT_REQUIRED", message: "a persisted artifact with a valid digest is required before completion." });
    if (!value.provenance || value.provenance.valid !== true || !value.provenance.provenanceId || !value.provenance.source || !DIGEST_PATTERN.test(value.provenance.provenanceDigest))
        failures.push({ code: "PROVENANCE_INVALID", message: "valid provenance evidence is required before completion." });
    return { allowed: failures.length === 0, reasons: failures };
}
export const evaluateTerminalGateV1 = evaluateTerminalGate;
export function assertParticipantReceiptV1(value) {
    const decision = evaluateTerminalGate(value, {
        candidate: value?.candidateBinding ?? value?.candidate,
        operationId: value?.operationId,
    });
    if (!decision.allowed)
        throw new Error(`V2_RECEIPT_REJECTED: ${decision.reasons.map((reason) => reason.code).join(",")}`);
}
export function candidateAssemblyReceiptIdV1(operationId, candidateId) {
    return `assembly:${operationId}:${candidateId}`;
}
function candidateAssemblyReceiptBodyV1(receipt) {
    const { digest: _digest, ...body } = receipt;
    return body;
}
export function candidateAssemblyReceiptDigestV1(receipt) {
    return sha256(canonicalSerialize(candidateAssemblyReceiptBodyV1(receipt)));
}
export function createCandidateAssemblyReceiptV1(input) {
    const body = { ...input, version: V2_CONTRACT_VERSION, assemblyId: candidateAssemblyReceiptIdV1(input.operationId, input.candidateId) };
    const receipt = { ...body, digest: candidateAssemblyReceiptDigestV1(body) };
    assertCandidateAssemblyReceiptV1(receipt);
    return receipt;
}
export function assertCandidateAssemblyReceiptV1(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("V2_ASSEMBLY_RECEIPT_INVALID: assembly receipt must be an object.");
    const receipt = value;
    if (receipt.version !== V2_CONTRACT_VERSION)
        throw new Error("V2_ASSEMBLY_RECEIPT_INVALID: unsupported assembly receipt version.");
    for (const field of ["assemblyId", "operationId", "taskId", "workUnitId", "participantId", "baseCandidateId", "candidateId", "createdAt"])
        requiredString(receipt[field], `assembly.${field}`);
    validDigest(receipt.baseIdentityDigest, "assembly.baseIdentityDigest");
    validDigest(receipt.sourceBaseIdentityDigest, "assembly.sourceBaseIdentityDigest");
    validDigest(receipt.identityDigest, "assembly.identityDigest");
    validDigest(receipt.sourceChangeSetDigest, "assembly.sourceChangeSetDigest");
    validDigest(receipt.changeSetDigest, "assembly.changeSetDigest");
    validDigest(receipt.patchDigest, "assembly.patchDigest");
    validDigest(receipt.digest, "assembly.digest");
    for (const field of ["baseRevision", "sourceBaseRevision", "revision", "operationExecutionRevision", "controllerEpoch"]) {
        if (!Number.isSafeInteger(receipt[field]) || receipt[field] < 0)
            throw new Error(`V2_ASSEMBLY_RECEIPT_INVALID: assembly.${field} must be a non-negative safe integer.`);
    }
    if (receipt.assemblyId !== candidateAssemblyReceiptIdV1(receipt.operationId, receipt.candidateId))
        throw new Error("V2_ASSEMBLY_RECEIPT_INVALID: assemblyId does not match its operation and candidate.");
    if (receipt.revision !== receipt.baseRevision + 1)
        throw new Error("V2_ASSEMBLY_RECEIPT_INVALID: an assembly receipt must advance exactly one candidate revision.");
    if (receipt.sourceBaseRevision > receipt.baseRevision)
        throw new Error("V2_ASSEMBLY_RECEIPT_INVALID: the source candidate cannot follow the assembly base.");
    if (Date.parse(receipt.createdAt) === 0 || Number.isNaN(Date.parse(receipt.createdAt)))
        throw new Error("V2_ASSEMBLY_RECEIPT_INVALID: createdAt is not a valid instant.");
    if ((receipt.sourceReceiptId === undefined) !== (receipt.sourceReceiptDigest === undefined))
        throw new Error("V2_ASSEMBLY_RECEIPT_INVALID: a source receipt reference requires id and digest together.");
    if (receipt.sourceReceiptId !== undefined)
        requiredString(receipt.sourceReceiptId, "assembly.sourceReceiptId");
    if (receipt.sourceReceiptDigest !== undefined)
        validDigest(receipt.sourceReceiptDigest, "assembly.sourceReceiptDigest");
    if (receipt.digest !== candidateAssemblyReceiptDigestV1(receipt))
        throw new Error("V2_ASSEMBLY_RECEIPT_INVALID: assembly receipt digest is inconsistent.");
}
/**
 * DETERMINISTIC receipt lineage resolution. A receipt is accepted for the current candidate when
 * it is bound to it directly, or when the durable assembly-receipt chain proves the receipt's
 * settled bounded work produced an assembly on the current candidate's ancestry, with the source
 * receipt id and digest recorded at the assembly boundary. No receipt field is rewritten.
 */
export function resolveCandidateLineageReceiptV1(input) {
    const bound = input.receipt.candidateBinding ?? input.receipt.candidate;
    if (!bound)
        return undefined;
    try {
        assertCandidateRevisionV1(bound);
        assertCandidateRevisionV1(input.current);
    }
    catch {
        return undefined;
    }
    if (candidateRevisionsEqual(bound, input.current))
        return { kind: "DIRECT" };
    if (input.receipt.settled !== true || input.receipt.outcome !== "SUCCEEDED")
        return undefined;
    if (input.receipt.operationId !== input.current.operationId)
        return undefined;
    const valid = [];
    for (const assembly of input.assemblies) {
        try {
            assertCandidateAssemblyReceiptV1(assembly);
            valid.push(assembly);
        }
        catch { /* an invalid lineage entry is never usable evidence */ }
    }
    const receiptDigest = sha256Canonical(input.receipt);
    const ancestry = [];
    let match;
    let cursor = { candidateId: input.current.candidateId, revision: input.current.revision, identityDigest: input.current.identityDigest };
    for (let hop = 0; hop <= input.current.revision; hop += 1) {
        const assembly = valid.find((entry) => entry.candidateId === cursor.candidateId && entry.revision === cursor.revision && entry.identityDigest === cursor.identityDigest);
        if (!assembly)
            break;
        if (assembly.sourceReceiptId === input.receipt.receiptId && assembly.sourceReceiptDigest === receiptDigest)
            match = assembly;
        cursor = { candidateId: assembly.baseCandidateId, revision: assembly.baseRevision, identityDigest: assembly.baseIdentityDigest };
        ancestry.push(cursor);
    }
    const onAncestry = ancestry.some((entry) => entry.revision === bound.revision && entry.identityDigest === bound.identityDigest);
    if (!match) {
        // Non-producing bounded work (Explorer, Planner, Reviewer, Spec Manager, and other read-only or
        // authoring participants) completes against the candidate it observed. When that candidate is a
        // deterministic ancestor of the current candidate through the verified assembly chain, the
        // settled SUCCEEDED receipt proves its bounded work completed even though it produced no
        // ChangeSet, so it is not named as an assembly source. Producers (Implementer/Repairer) stay
        // strict: a superseded producer receipt that no assembly names is never completion evidence.
        return onAncestry && nonProducingCandidateRoles.has(String(input.receipt.role ?? "")) ? { kind: "ANCESTOR" } : undefined;
    }
    // The source the producer observed must itself be a candidate on this ancestry (the assembly
    // base for a direct ChangeSet, an earlier wave base for an explicit rebase).
    if (!onAncestry)
        return undefined;
    if (match.sourceBaseRevision !== bound.revision || match.sourceBaseIdentityDigest !== bound.identityDigest)
        return undefined;
    return { kind: "ASSEMBLY", assembly: match };
}
/**
 * Bounded roles with no ChangeSet authority whose settled work is lineage-proven by an ancestor
 * binding (AEH-V2-0124). Every other or absent role is treated as a producer and stays strict.
 */
const nonProducingCandidateRoles = new Set(["Explorer", "Planner", "Reviewer", "Librarian", "Spec Manager"]);
//# sourceMappingURL=v2Contracts.js.map