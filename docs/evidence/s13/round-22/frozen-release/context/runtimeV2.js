import { canonicalSerialize, sha256Canonical, sha256Utf8 } from "../core/digest.js";
const HEX_DIGEST = /^[a-f0-9]{64}$/;
export function stableJsonV1(value) {
    return canonicalSerialize(value);
}
export function digestV1(value) {
    return sha256Canonical(value);
}
function requireText(value, name) {
    if (!value.trim())
        throw new Error(`CONTEXT_RUNTIME_V2_INVALID: ${name} must not be empty.`);
}
function assertRetrievalBudget(value) {
    const keys = ["maxRequestsPerTurn", "maxTokensPerRequest", "maxTotalTokensPerTurn"].sort();
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== keys.join("\0")
        || keys.some((key) => !Number.isSafeInteger(value[key]) || (value[key] ?? 0) < 1)) {
        throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: retrieval budget must have exact positive integer limits.");
    }
}
function pathIsUnsafe(value) {
    const normalized = value.replaceAll("\\", "/");
    return !normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === ".") || /^[A-Za-z]:/.test(normalized);
}
function assertLineRange(range) {
    if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine) || range.startLine < 1 || range.endLine < range.startLine) {
        throw new Error("CONTEXT_RUNTIME_V2_INVALID: line ranges must be positive, inclusive, and ordered.");
    }
}
function normalizeFile(file) {
    requireText(file, "file");
    return file.replaceAll("\\", "/");
}
function assertLocator(locator) {
    const file = normalizeFile(locator.file);
    if (file.startsWith("/") || file.split("/").includes(".."))
        throw new Error("CONTEXT_RUNTIME_V2_INVALID: locator file must be repository-relative.");
    if (locator.kind === "range")
        assertLineRange(locator.range);
    else {
        requireText(locator.symbol, "symbol");
        if (locator.range)
            assertLineRange(locator.range);
        if (locator.symbolPath && (!locator.symbolPath.length || locator.symbolPath.some((part) => !part.trim())))
            throw new Error("CONTEXT_RUNTIME_V2_INVALID: symbolPath must contain non-empty names.");
    }
}
function normalizeLocator(locator) {
    assertLocator(locator);
    if (locator.kind === "range")
        return { kind: "range", file: normalizeFile(locator.file), range: { ...locator.range } };
    return {
        kind: "symbol",
        file: normalizeFile(locator.file),
        symbol: locator.symbol,
        ...(locator.range ? { range: { ...locator.range } } : {}),
        ...(locator.symbolPath ? { symbolPath: [...locator.symbolPath] } : {})
    };
}
function estimateTokens(value) {
    return value.length === 0 ? 0 : Math.ceil(value.trim().split(/\s+/).filter(Boolean).length * 1.25);
}
export function createContextShard(input) {
    requireText(input.shardId, "shardId");
    const file = normalizeFile(input.file);
    const locator = normalizeLocator(input.locator);
    if (locator.file !== file)
        throw new Error("CONTEXT_RUNTIME_V2_INVALID: shard locator file must match shard file.");
    const contentDigest = input.contentDigest ?? digestText(input.content);
    if (!HEX_DIGEST.test(contentDigest))
        throw new Error("CONTEXT_RUNTIME_V2_INVALID: contentDigest must be a SHA-256 digest.");
    return { version: 1, shardId: input.shardId, file, content: input.content, ...(input.sourceDigest ? { sourceDigest: input.sourceDigest } : {}), contentDigest, locator, ...(input.symbols ? { symbols: input.symbols.map((symbol) => ({ ...symbol, range: { ...symbol.range }, ...(symbol.symbolPath ? { symbolPath: [...symbol.symbolPath] } : {}) })) } : {}) };
}
export function digestText(value) {
    return sha256Utf8(value);
}
export function rangeShardLocator(file, range) {
    const locator = { kind: "range", file: normalizeFile(file), range: { ...range } };
    assertLocator(locator);
    return locator;
}
export function symbolShardLocator(file, symbol, range, symbolPath) {
    const locator = { kind: "symbol", file: normalizeFile(file), symbol, ...(range ? { range: { ...range } } : {}), ...(symbolPath ? { symbolPath: [...symbolPath] } : {}) };
    assertLocator(locator);
    return locator;
}
function locatorRange(locator, shard) {
    if (locator.kind === "range")
        return locator.range;
    if (locator.range)
        return locator.range;
    const requestedPath = locator.symbolPath?.join(".") ?? locator.symbol;
    const candidates = (shard.symbols ?? []).filter((candidate) => {
        const path = candidate.symbolPath?.join(".") ?? candidate.symbol;
        return path === requestedPath || (!candidate.symbolPath && candidate.symbol === locator.symbol);
    });
    if (candidates.length) {
        // Prefer the most specific (deepest/smallest) exact match deterministically.
        candidates.sort((left, right) => (right.symbolPath?.length ?? 0) - (left.symbolPath?.length ?? 0) || (left.range.endLine - left.range.startLine) - (right.range.endLine - right.range.startLine) || left.range.startLine - right.range.startLine);
        return candidates[0].range;
    }
    if (shard.locator.kind === "symbol") {
        const shardPath = shard.locator.symbolPath?.join(".") ?? shard.locator.symbol;
        if (shardPath === requestedPath && shard.locator.range)
            return shard.locator.range;
    }
    throw new Error(`CONTEXT_RUNTIME_V2_SYMBOL_NOT_FOUND: '${locator.symbol}'.`);
}
function intersectRange(requested, available) {
    const range = { startLine: Math.max(requested.startLine, available.startLine), endLine: Math.min(requested.endLine, available.endLine) };
    if (range.startLine > range.endLine)
        throw new Error("CONTEXT_RUNTIME_V2_RANGE_UNAVAILABLE: requested range is outside the shard.");
    return range;
}
export function selectContextShard(shard, locator) {
    const normalized = normalizeLocator(locator);
    if (normalized.file !== normalizeFile(shard.file))
        throw new Error("CONTEXT_RUNTIME_V2_RANGE_UNAVAILABLE: locator file does not match shard.");
    const requested = locatorRange(normalized, shard);
    const available = shard.locator.kind === "range" || shard.locator.range
        ? shard.locator.range
        : { startLine: 1, endLine: Math.max(1, shard.content.split(/\r?\n/).length) };
    const selected = intersectRange(requested, available);
    const sourceStart = available.startLine;
    const lines = shard.content.split(/\r?\n/);
    const start = selected.startLine - sourceStart;
    const end = selected.endLine - sourceStart + 1;
    if (start < 0 || end > lines.length)
        throw new Error("CONTEXT_RUNTIME_V2_RANGE_UNAVAILABLE: requested range is not present in shard content.");
    const content = lines.slice(start, end).join("\n");
    return { shardId: shard.shardId, file: shard.file, locator: normalized, range: selected, content, digest: digestText(content), ...(shard.sourceDigest ? { sourceDigest: shard.sourceDigest } : {}), estimatedTokens: estimateTokens(content) };
}
export const selectShardRange = selectContextShard;
function authorizationGrantValue(grant) {
    return {
        version: grant.version,
        grantId: grant.grantId,
        operationId: grant.operationId,
        projectId: grant.projectId,
        operationExecutionRevision: grant.operationExecutionRevision,
        candidateRevision: grant.candidateRevision,
        candidateRevisionDigest: grant.candidateRevisionDigest,
        participantId: grant.participantId,
        participantGeneration: grant.participantGeneration,
        executionBlueprintDigest: grant.executionBlueprintDigest,
        operationPolicyDigest: grant.operationPolicyDigest,
        controllerEpoch: grant.controllerEpoch,
        sessionId: grant.sessionId,
        retrievalBudget: grant.retrievalBudget,
        allowedRefs: [...grant.allowedRefs].map((ref) => ({ ...ref, locator: normalizeLocator(ref.locator) })).sort((left, right) => left.refId.localeCompare(right.refId)),
        issuedAt: grant.issuedAt,
        expiresAt: grant.expiresAt
    };
}
export function compileContextRefAuthorization(input) {
    for (const [value, name] of [[input.grantId, "grantId"], [input.operationId, "operationId"], [input.projectId, "projectId"], [input.candidateRevisionDigest, "candidateRevisionDigest"], [input.participantId, "participantId"], [input.participantGeneration, "participantGeneration"], [input.executionBlueprintDigest, "executionBlueprintDigest"], [input.operationPolicyDigest, "operationPolicyDigest"], [input.sessionId, "sessionId"]])
        requireText(value, `authorization.${name}`);
    if (input.sessionId.startsWith("launch:"))
        throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: authorization requires an actual runtime session id.");
    for (const [value, name, minimum] of [[input.operationExecutionRevision, "operationExecutionRevision", 1], [input.candidateRevision, "candidateRevision", 1], [input.controllerEpoch, "controllerEpoch", 0]]) {
        if (!Number.isSafeInteger(value) || value < minimum)
            throw new Error(`CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: ${name} is outside its valid range.`);
    }
    if (!HEX_DIGEST.test(input.candidateRevisionDigest) || !HEX_DIGEST.test(input.executionBlueprintDigest) || !HEX_DIGEST.test(input.operationPolicyDigest))
        throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: candidate, blueprint, and policy identities must be SHA-256 digests.");
    assertRetrievalBudget(input.retrievalBudget);
    if (!input.allowedRefs.length)
        throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_REQUIRED: allowedRefs must not be empty.");
    const refIds = new Set();
    for (const ref of input.allowedRefs) {
        requireText(ref.refId, "authorization.ref.refId");
        requireText(ref.fragmentId, "authorization.ref.fragmentId");
        requireText(ref.shardId, "authorization.ref.shardId");
        requireText(ref.artifactPath, "authorization.ref.artifactPath");
        if (pathIsUnsafe(ref.artifactPath) || !HEX_DIGEST.test(ref.sourceDigest) || !HEX_DIGEST.test(ref.contentDigest) || !Number.isSafeInteger(ref.estimatedTokens) || ref.estimatedTokens < 0 || (ref.sourceFile !== undefined && (!ref.sourceFile.trim() || pathIsUnsafe(ref.sourceFile))))
            throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: ref source, digest, path, or budget is invalid.");
        if (refIds.has(ref.refId))
            throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: ref ids must be unique.");
        refIds.add(ref.refId);
        assertLocator(ref.locator);
        if (normalizeFile(ref.locator.file) !== normalizeFile(ref.sourceFile ?? ref.artifactPath))
            throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: ref locator does not match the authorized source file.");
    }
    const issued = new Date(input.issuedAt).getTime();
    const expires = new Date(input.expiresAt).getTime();
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued)
        throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: grant interval is invalid.");
    const unsigned = { version: 1, ...input, allowedRefs: [...input.allowedRefs].map((ref) => ({ ...ref, locator: normalizeLocator(ref.locator) })).sort((left, right) => left.refId.localeCompare(right.refId)) };
    return { ...unsigned, grantDigest: digestV1(authorizationGrantValue(unsigned)) };
}
function authorizationReceiptValue(receipt) {
    return { version: receipt.version, grantDigest: receipt.grant.grantDigest, executionBindingDigest: receipt.executionBindingDigest, contextManifestDigest: receipt.contextManifestDigest, promptManifestDigest: receipt.promptManifestDigest };
}
export function compileContextRefAuthorizationReceipt(grant, binding) {
    const unsigned = { version: 1, grant, executionBindingDigest: binding.executionBindingDigest, contextManifestDigest: binding.contextManifestDigest, promptManifestDigest: binding.promptManifestDigest };
    return { ...unsigned, receiptDigest: digestV1(authorizationReceiptValue(unsigned)) };
}
export function assertContextRefAuthorization(grant, expected, now = new Date()) {
    const grantKeys = ["version", "grantId", "operationId", "projectId", "operationExecutionRevision", "candidateRevision", "candidateRevisionDigest", "participantId", "participantGeneration", "executionBlueprintDigest", "operationPolicyDigest", "controllerEpoch", "sessionId", "retrievalBudget", "allowedRefs", "issuedAt", "expiresAt", "grantDigest"].sort();
    if (!grant || typeof grant !== "object" || Object.keys(grant).sort().join("\0") !== grantKeys.join("\0") || grant.version !== 1 || !Array.isArray(grant.allowedRefs) || !grant.allowedRefs.length || typeof grant.grantDigest !== "string" || grant.grantDigest !== digestV1(authorizationGrantValue(grant)))
        throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: grant shape or digest is invalid.");
    assertRetrievalBudget(grant.retrievalBudget);
    if (typeof grant.sessionId !== "string" || grant.sessionId.startsWith("launch:"))
        throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: grant does not name an actual runtime session.");
    const issued = new Date(grant.issuedAt).getTime();
    const expires = new Date(grant.expiresAt).getTime();
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued)
        throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: grant issue interval is malformed.");
    if (issued > now.getTime())
        throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_NOT_YET_VALID: controller grant is not active yet.");
    if (expires <= now.getTime())
        throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_EXPIRED: controller grant has expired.");
    const refIds = new Set();
    for (const ref of grant.allowedRefs) {
        if (!ref || typeof ref.refId !== "string" || !ref.refId.trim() || refIds.has(ref.refId) || typeof ref.fragmentId !== "string" || !ref.fragmentId.trim() || typeof ref.shardId !== "string" || !ref.shardId.trim() || typeof ref.artifactPath !== "string" || pathIsUnsafe(ref.artifactPath) || !HEX_DIGEST.test(ref.sourceDigest) || !HEX_DIGEST.test(ref.contentDigest) || !Number.isSafeInteger(ref.estimatedTokens) || ref.estimatedTokens < 0)
            throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: permitted ref identity or provenance is malformed.");
        refIds.add(ref.refId);
        assertLocator(ref.locator);
        if (normalizeFile(ref.locator.file) !== normalizeFile(ref.sourceFile ?? ref.artifactPath))
            throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: permitted ref locator does not match its source file.");
    }
    for (const key of ["operationId", "projectId", "operationExecutionRevision", "candidateRevision", "candidateRevisionDigest", "participantId", "participantGeneration", "executionBlueprintDigest", "operationPolicyDigest", "controllerEpoch", "sessionId"]) {
        if (grant[key] !== expected[key])
            throw new Error(`CONTEXT_RUNTIME_V2_BINDING_REJECTED: authorization ${key} does not match current execution identity.`);
    }
}
export function createContextRef(input) {
    assertContextRefAuthorization(input.authorizationReceipt.grant, input.expected);
    assertAuthorizationReceipt(input.authorizationReceipt);
    for (const key of ["executionBindingDigest", "contextManifestDigest", "promptManifestDigest"]) {
        if (input.authorizationReceipt[key] !== input.expected[key])
            throw new Error(`CONTEXT_RUNTIME_V2_BINDING_REJECTED: authorization receipt ${key} does not match current execution identity.`);
    }
    const grant = input.authorizationReceipt.grant;
    const entry = grant.allowedRefs.find((ref) => ref.refId === input.refId);
    if (!entry)
        throw new Error(`CONTEXT_RUNTIME_V2_UNAUTHORIZED: ref '${input.refId}' is not authorized by the controller grant.`);
    return {
        version: 1,
        refId: entry.refId,
        operationId: grant.operationId,
        projectId: grant.projectId,
        operationExecutionRevision: grant.operationExecutionRevision,
        candidateRevision: grant.candidateRevision,
        candidateRevisionDigest: grant.candidateRevisionDigest,
        participantId: grant.participantId,
        participantGeneration: grant.participantGeneration,
        executionBlueprintDigest: grant.executionBlueprintDigest,
        operationPolicyDigest: grant.operationPolicyDigest,
        controllerEpoch: grant.controllerEpoch,
        sessionId: grant.sessionId,
        shardId: entry.shardId,
        fragmentId: entry.fragmentId,
        artifactPath: entry.artifactPath,
        ...(entry.sourceFile ? { sourceFile: entry.sourceFile } : {}),
        sourceDigest: entry.sourceDigest,
        contentDigest: entry.contentDigest,
        locator: normalizeLocator(entry.locator),
        authorized: true,
        addressable: true,
        delivered: false,
        delivery: "addressable",
        authorizationGrantId: grant.grantId,
        authorizationDigest: input.authorizationReceipt.receiptDigest
    };
}
export function deliverContextPayload(ref, shard, receipt, expected, now = new Date()) {
    const { executionBindingDigest: _bindingDigest, contextManifestDigest: _contextDigest, promptManifestDigest: _promptDigest, ...grantExpected } = expected;
    assertContextRefAuthorization(receipt.grant, grantExpected, now);
    assertAuthorizationReceipt(receipt);
    if (receipt.executionBindingDigest !== expected.executionBindingDigest || receipt.contextManifestDigest !== expected.contextManifestDigest || receipt.promptManifestDigest !== expected.promptManifestDigest)
        throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: durable controller issue receipt is invalid or stale.");
    if (!ref.authorized || !ref.addressable)
        throw new Error("CONTEXT_RUNTIME_V2_UNAUTHORIZED: context ref is not addressable.");
    const grant = receipt.grant;
    const entry = grant.allowedRefs.find((candidate) => candidate.refId === ref.refId);
    if (!entry || ref.authorizationGrantId !== grant.grantId || ref.authorizationDigest !== receipt.receiptDigest || ref.operationId !== grant.operationId || ref.projectId !== grant.projectId || ref.operationExecutionRevision !== grant.operationExecutionRevision || ref.candidateRevision !== grant.candidateRevision || ref.candidateRevisionDigest !== grant.candidateRevisionDigest || ref.participantId !== grant.participantId || ref.participantGeneration !== grant.participantGeneration || ref.executionBlueprintDigest !== grant.executionBlueprintDigest || ref.operationPolicyDigest !== grant.operationPolicyDigest || ref.controllerEpoch !== grant.controllerEpoch || ref.sessionId !== grant.sessionId || ref.fragmentId !== entry.fragmentId || ref.locator.kind !== entry.locator.kind || digestV1(ref.locator) !== digestV1(entry.locator))
        throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: ref does not match its current controller grant.");
    if (ref.shardId !== shard.shardId || entry.shardId !== shard.shardId || ref.artifactPath !== entry.artifactPath || ref.sourceFile !== entry.sourceFile || ref.sourceDigest !== entry.sourceDigest || ref.contentDigest !== entry.contentDigest || digestText(shard.content) !== shard.contentDigest || shard.sourceDigest !== entry.sourceDigest)
        throw new Error("CONTEXT_RUNTIME_V2_REF_MISMATCH: source shard, digest, or path does not match the authorized ref.");
    const selected = selectContextShard(shard, ref.locator);
    if (selected.digest !== entry.contentDigest)
        throw new Error("CONTEXT_RUNTIME_V2_SOURCE_DIGEST_MISMATCH: selected payload does not match the controller-authorized content digest.");
    const payload = { content: selected.content, digest: selected.digest, locator: selected.locator, range: selected.range, estimatedTokens: selected.estimatedTokens };
    return { ...ref, delivered: true, delivery: "delivered", payload };
}
function assertAuthorizationReceipt(receipt) {
    const keys = ["version", "grant", "executionBindingDigest", "contextManifestDigest", "promptManifestDigest", "receiptDigest"].sort();
    if (!receipt || typeof receipt !== "object" || Object.keys(receipt).sort().join("\0") !== keys.join("\0") || receipt.version !== 1 || !HEX_DIGEST.test(receipt.executionBindingDigest) || !HEX_DIGEST.test(receipt.contextManifestDigest) || !HEX_DIGEST.test(receipt.promptManifestDigest) || typeof receipt.receiptDigest !== "string" || receipt.receiptDigest !== digestV1(authorizationReceiptValue(receipt)))
        throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: durable controller issue receipt shape or digest is invalid.");
}
function continuationBindingValue(value) {
    return {
        version: value.version,
        continuationId: value.continuationId,
        operationId: value.operationId,
        projectId: value.projectId,
        operationExecutionRevision: value.operationExecutionRevision,
        candidateRevision: value.candidateRevision,
        candidateRevisionDigest: value.candidateRevisionDigest,
        participantId: value.participantId,
        participantGeneration: value.participantGeneration,
        executionBindingDigest: value.executionBindingDigest,
        controllerEpoch: value.controllerEpoch,
        contextManifestDigest: value.contextManifestDigest,
        promptManifestDigest: value.promptManifestDigest,
        previousSessionId: value.previousSessionId,
        nextSessionId: value.nextSessionId,
        previousTurnId: value.previousTurnId,
        nextTurnId: value.nextTurnId,
        sequence: value.sequence,
        contextRefIds: [...value.contextRefIds].sort(),
        retrievalReceiptIds: [...value.retrievalReceiptIds].sort()
    };
}
export function bindContinuation(input) {
    for (const [value, name] of [[input.operationId, "operationId"], [input.projectId, "projectId"], [input.candidateRevisionDigest, "candidateRevisionDigest"], [input.participantId, "participantId"], [input.participantGeneration, "participantGeneration"], [input.executionBindingDigest, "executionBindingDigest"], [input.contextManifestDigest, "contextManifestDigest"], [input.promptManifestDigest, "promptManifestDigest"], [input.previousSessionId, "previousSessionId"], [input.nextSessionId, "nextSessionId"], [input.previousTurnId, "previousTurnId"]])
        requireText(value, name);
    for (const [value, name, minimum] of [[input.operationExecutionRevision, "operationExecutionRevision", 1], [input.candidateRevision, "candidateRevision", 1], [input.controllerEpoch, "controllerEpoch", 0]])
        if (!Number.isSafeInteger(value) || value < minimum)
            throw new Error(`CONTEXT_RUNTIME_V2_INVALID: continuation ${name} is outside its valid range.`);
    for (const digest of [input.candidateRevisionDigest, input.executionBindingDigest, input.contextManifestDigest, input.promptManifestDigest])
        if (!HEX_DIGEST.test(digest))
            throw new Error("CONTEXT_RUNTIME_V2_INVALID: continuation identity fields must be SHA-256 digests.");
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1)
        throw new Error("CONTEXT_RUNTIME_V2_INVALID: continuation sequence must be a positive safe integer.");
    const continuation = {
        version: 1,
        continuationId: input.continuationId ?? `${input.operationId}:${input.participantId}:${input.nextSessionId}:${input.sequence}`,
        operationId: input.operationId,
        projectId: input.projectId,
        operationExecutionRevision: input.operationExecutionRevision,
        candidateRevision: input.candidateRevision,
        candidateRevisionDigest: input.candidateRevisionDigest,
        participantId: input.participantId,
        participantGeneration: input.participantGeneration,
        executionBindingDigest: input.executionBindingDigest,
        controllerEpoch: input.controllerEpoch,
        contextManifestDigest: input.contextManifestDigest,
        promptManifestDigest: input.promptManifestDigest,
        previousSessionId: input.previousSessionId,
        nextSessionId: input.nextSessionId,
        previousTurnId: input.previousTurnId,
        ...(input.nextTurnId ? { nextTurnId: input.nextTurnId } : {}),
        sequence: input.sequence,
        contextRefIds: [...new Set(input.contextRefIds ?? [])].sort(),
        retrievalReceiptIds: [...new Set(input.retrievalReceiptIds ?? [])].sort()
    };
    return { ...continuation, bindingDigest: digestV1(continuationBindingValue(continuation)) };
}
export function assertContinuationBinding(continuation, expected) {
    const keys = ["version", "continuationId", "operationId", "projectId", "operationExecutionRevision", "candidateRevision", "candidateRevisionDigest", "participantId", "participantGeneration", "executionBindingDigest", "controllerEpoch", "contextManifestDigest", "promptManifestDigest", "previousSessionId", "nextSessionId", "previousTurnId", ...(Object.hasOwn(continuation ?? {}, "nextTurnId") ? ["nextTurnId"] : []), "sequence", "contextRefIds", "retrievalReceiptIds", "bindingDigest"].sort();
    if (!continuation || typeof continuation !== "object" || Object.keys(continuation).sort().join("\0") !== keys.join("\0") || continuation.version !== 1 || !Array.isArray(continuation.contextRefIds) || !Array.isArray(continuation.retrievalReceiptIds))
        throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: continuation shape is invalid.");
    const { bindingDigest, ...unsigned } = continuation;
    if (bindingDigest !== digestV1(continuationBindingValue(unsigned)))
        throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: continuation binding digest is invalid.");
    for (const [key, expectedValue] of Object.entries(expected)) {
        if (key === "availableRefs" || key === "availableReceiptIds")
            continue;
        if (continuation[key] !== expectedValue)
            throw new Error(`CONTEXT_RUNTIME_V2_BINDING_REJECTED: continuation ${key} does not match.`);
    }
    if (expected.availableRefs) {
        const refs = new Map(expected.availableRefs.map((ref) => [ref.refId, ref]));
        for (const refId of continuation.contextRefIds) {
            const ref = refs.get(refId);
            if (!ref || !ref.addressable || ref.operationId !== continuation.operationId || ref.projectId !== continuation.projectId || ref.candidateRevisionDigest !== continuation.candidateRevisionDigest || ref.participantId !== continuation.participantId || ref.participantGeneration !== continuation.participantGeneration || ref.sessionId !== continuation.previousSessionId || ref.controllerEpoch !== continuation.controllerEpoch)
                throw new Error(`CONTEXT_RUNTIME_V2_BINDING_REJECTED: context ref '${refId}' is not bound to the continuation.`);
        }
    }
    if (expected.availableReceiptIds) {
        const receiptIds = new Set(expected.availableReceiptIds);
        for (const receiptId of continuation.retrievalReceiptIds)
            if (!receiptIds.has(receiptId))
                throw new Error(`CONTEXT_RUNTIME_V2_BINDING_REJECTED: retrieval receipt '${receiptId}' is not current for the continuation.`);
    }
}
export function isContinuationBindingValid(continuation, expected) {
    try {
        assertContinuationBinding(continuation, expected);
        return true;
    }
    catch {
        return false;
    }
}
export function createExecutionBudget(operationId, maxTokens, identity = {}) {
    requireText(operationId, "operationId");
    if (!Number.isInteger(maxTokens) || maxTokens < 0)
        throw new Error("CONTEXT_RUNTIME_V2_INVALID: maxTokens must be a non-negative integer.");
    return { version: 1, operationId, ...(identity.projectId ? { projectId: identity.projectId } : {}), ...(identity.candidateRevisionDigest ? { candidateRevisionDigest: identity.candidateRevisionDigest } : {}), maxTokens, consumedTokens: 0, remainingTokens: maxTokens, sessionUsage: {} };
}
export function startBudgetSession(budget, sessionId) {
    requireText(sessionId, "sessionId");
    return { ...budget, sessionUsage: { ...budget.sessionUsage, [sessionId]: budget.sessionUsage[sessionId] ?? 0 } };
}
export function consumeExecutionBudget(budget, sessionId, tokens) {
    requireText(sessionId, "sessionId");
    if (!Number.isInteger(tokens) || tokens < 0)
        throw new Error("CONTEXT_RUNTIME_V2_INVALID: consumed tokens must be a non-negative integer.");
    if (tokens > budget.remainingTokens)
        throw new Error("CONTEXT_RUNTIME_V2_BUDGET_EXCEEDED: operation-wide execution budget exhausted.");
    return { ...budget, consumedTokens: budget.consumedTokens + tokens, remainingTokens: budget.remainingTokens - tokens, sessionUsage: { ...budget.sessionUsage, [sessionId]: (budget.sessionUsage[sessionId] ?? 0) + tokens } };
}
export const recordExecutionUsage = consumeExecutionBudget;
export function assertBudgetAvailable(budget, tokens) {
    if (!Number.isInteger(tokens) || tokens < 0 || tokens > budget.remainingTokens)
        throw new Error("CONTEXT_RUNTIME_V2_BUDGET_EXCEEDED: operation-wide execution budget exhausted.");
}
function normalizePromptEntry(entry) {
    requireText(entry.id, "prompt entry id");
    const contentDigest = entry.digest ?? digestText(entry.content ?? "");
    if (!HEX_DIGEST.test(contentDigest))
        throw new Error(`CONTEXT_RUNTIME_V2_INVALID: prompt entry '${entry.id}' has an invalid digest.`);
    return { id: entry.id, contentDigest, ...(entry.role ? { role: entry.role } : {}), ...(entry.source ? { source: entry.source } : {}) };
}
export function stablePrefixDigest(prefix) {
    if (typeof prefix === "string")
        return digestV1({ kind: "prompt-prefix", content: prefix });
    if (!Array.isArray(prefix))
        return prefix.prefixDigest;
    return digestV1({ kind: "prompt-prefix", entries: prefix.map(normalizePromptEntry) });
}
export function computeStaticPromptDigest(entries) {
    return stablePrefixDigest(entries);
}
export function computeDynamicPromptDigest(entries) {
    return digestV1({ kind: "prompt-dynamic", entries: entries.map(normalizePromptEntry) });
}
export function computePromptManifestDigest(manifest) {
    return digestV1({ kind: "prompt-manifest", staticDigest: manifest.staticDigest, dynamicDigest: manifest.dynamicDigest });
}
export function createPromptManifest(input = {}) {
    const staticPrefix = [...(input.staticPrefix ?? input.staticEntries ?? [])].map((entry) => ({ ...entry }));
    const dynamic = [...(input.dynamic ?? input.dynamicEntries ?? [])].map((entry) => ({ ...entry }));
    const staticDigest = computeStaticPromptDigest(staticPrefix);
    const dynamicDigest = computeDynamicPromptDigest(dynamic);
    return { version: 1, staticPrefix, dynamic, staticDigest, dynamicDigest, prefixDigest: staticDigest, digest: computePromptManifestDigest({ staticDigest, dynamicDigest }) };
}
export function verifyPromptManifestDigest(manifest) {
    return manifest.staticDigest === computeStaticPromptDigest(manifest.staticPrefix)
        && manifest.dynamicDigest === computeDynamicPromptDigest(manifest.dynamic)
        && manifest.prefixDigest === manifest.staticDigest
        && manifest.digest === computePromptManifestDigest(manifest);
}
//# sourceMappingURL=runtimeV2.js.map