import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { estimateTokens } from "./estimator.js";
import { sha256Canonical } from "../core/digest.js";
import { assertExecutionBindingV2, assertResolvedOperationPolicyV1, type ExecutionBindingV2 } from "../architecture/executionIdentity.js";
import { assertCurrentControllerOwner, currentControllerEpoch, loadOperation, resolveOperationStateRoot, withOperationCoordinationLock, type OperationRecordV2 } from "../operations/state.js";
import { assertExecutionAuthority, type ExecutionAuthorityV1 } from "../security/executionLease.js";
import { assertContextEnvelope, type ContextEnvelope, type ContextFragmentProjection } from "./types.js";
import { contextEnvelopePath } from "./gateway.js";
import { verifyContextEnvelope } from "./envelope.js";
import { sha256 as sha256Bytes } from "./provenance.js";
import {
  assertContextRefAuthorization,
  assertContinuationBinding,
  bindContinuation,
  compileContextRefAuthorization,
  compileContextRefAuthorizationReceipt,
  createContextRef,
  deliverContextPayload,
  digestText,
  rangeShardLocator,
  selectContextShard,
  type ContextContinuationInputV1,
  type ContextContinuationV1,
  type ContextRetrievalBudgetV1,
  type ContextRefAuthorizationEntryV1,
  type ContextRefAuthorizationExpectationV1,
  type ContextRefAuthorizationReceiptV1,
} from "./runtimeV2.js";

const AUTH_TTL_MS = 60 * 60 * 1000;

export interface ContextRetrievalReceiptV1 {
  version: 1;
  receiptId: string;
  requestId: string;
  operationId: string;
  projectId: string;
  operationExecutionRevision: number;
  candidateRevision: number;
  candidateRevisionDigest: string;
  participantId: string;
  participantGeneration: string;
  executionBindingDigest: string;
  controllerEpoch: number;
  sessionId: string;
  authorizationReceiptDigest: string;
  refId: string;
  fragmentId: string;
  artifactPath: string;
  sourceDigest: string;
  deliveredContentDigest: string;
  estimatedTokens: number;
  retrievedAt: string;
  receiptDigest: string;
}

export interface AuthorizedContextRetrievalRequestV1 {
  refId: string;
  requestId: string;
  maxTokens?: number;
}

export interface AuthorizedContextRetrievalResultV1 {
  fragmentId: string;
  content: string;
  artifact: string;
  sha256: string;
  estimatedTokens: number;
  repeated: boolean;
  receipt: ContextRetrievalReceiptV1;
}

export interface ContextRetrievalEvidenceV1 {
  version: 1;
  executionBindingDigest: string;
  contextManifestDigest: string;
  promptManifestDigest: string;
  receiptIds: string[];
  receiptDigests: string[];
  receiptsDigest: string;
  retrievalBudget: ContextRetrievalBudgetV1 | null;
  requests: number;
  totalTokens: number;
  retrievalStateDigest: string;
  progressiveManifestDigest: string;
  evidenceDigest: string;
}

interface DurableRetrievalStateV1 {
  version: 1;
  executionBindingDigest: string;
  sessionId: string;
  retrievalBudget: ContextRetrievalBudgetV1 | null;
  requests: number;
  totalTokens: number;
  closedAt?: string;
  requestIds: string[];
  receiptIds: string[];
  stateDigest: string;
}

interface DurableContinuationStateV1 {
  version: 1;
  executionBindingDigest: string;
  sessionId: string;
  sequence: number;
  lastTurnId: string;
  turnIds: string[];
  stateDigest: string;
}

export async function issueContextRefAuthorization(root: string, controlRoot: string, operationId: string, participantId: string, options: {
  logicalAgent: string;
  phase: string;
  retrievalBudget: ContextRetrievalBudgetV1;
  capabilityAuthority: ExecutionAuthorityV1;
  contextManifest: Readonly<Record<string, unknown>>;
  now?: Date;
}): Promise<ContextRefAuthorizationReceiptV1 | undefined> {
  const stateRoot = resolveOperationStateRoot(controlRoot);
  return withOperationCoordinationLock(stateRoot, operationId, async () => {
    const operation = await loadOperation(stateRoot, operationId);
    assertCurrentControllerOwner(operation, "issue ContextRefAuthorizationV1");
    const current = currentExecution(operation, participantId);
    if (operation.participants[participantId]?.logicalAgent !== options.logicalAgent) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: controller issuer logical participant does not match the current participant record.");
    assertCurrentReadAuthority(options.capabilityAuthority, current.binding, current.policy.projectId, options.now ?? new Date());
    const envelope = await readCurrentEnvelope(root, operationId, options.logicalAgent, options.phase);
    const launchRefs = assertLaunchManifestMatchesEnvelope(options.contextManifest, current.binding, envelope);
    if (!envelope.retrieval.available) {
      if (launchRefs.length) throw new Error("CONTEXT_RUNTIME_V2_MANIFEST_REJECTED: the launch manifest advertises refs but durable retrieval is unavailable.");
      return undefined;
    }
    if (!launchRefs.length) return undefined;
    const now = options.now ?? new Date();
    const entries: ContextRefAuthorizationEntryV1[] = [];
    for (const launchRef of launchRefs) {
      const fragmentId = launchRef.refId;
      const fragment = envelope.fragments.find((candidate) => candidate.id === fragmentId);
      if (!fragment || !fragment.source?.artifact || !fragment.source.sha256) throw new Error(`CONTEXT_RUNTIME_V2_ISSUE_REJECTED: retrievable fragment '${fragmentId}' lacks durable source provenance.`);
      const artifactPath = fragment.source.artifact;
      if (artifactPath !== launchRef.artifactPath || fragment.source.sha256 !== launchRef.sourceDigest) throw new Error(`CONTEXT_RUNTIME_V2_MANIFEST_REJECTED: retrievable fragment '${fragmentId}' no longer matches its frozen launch identity.`);
      const absolute = await safeArtifactPath(root, artifactPath);
      const raw = await fs.readFile(absolute, "utf8");
      const sourceDigest = sha256Bytes(raw);
      if (sourceDigest !== fragment.source.sha256) throw new Error(`CONTEXT_RUNTIME_V2_ISSUE_REJECTED: raw source digest changed for '${fragmentId}'.`);
      const sourceFile = fragment.source.file ?? artifactPath;
      const lineCount = Math.max(1, raw.split(/\r?\n/).length);
      entries.push({
        refId: fragmentId,
        fragmentId,
        shardId: fragmentId,
        artifactPath,
        sourceFile,
        sourceDigest,
        contentDigest: digestText(raw),
        locator: rangeShardLocator(sourceFile, { startLine: 1, endLine: lineCount }),
        estimatedTokens: estimateTokens(raw)
      });
    }
    const grant = compileContextRefAuthorization({
      grantId: `context-grant:${sha256Canonical({ executionBindingDigest: current.binding.digest, sessionId: current.binding.runtime.sessionId })}`,
      operationId,
      projectId: current.policy.projectId,
      operationExecutionRevision: current.binding.operationExecutionRevision,
      candidateRevision: current.binding.candidateRevision,
      candidateRevisionDigest: current.binding.candidateDigest,
      participantId,
      participantGeneration: current.binding.participantGeneration,
      executionBlueprintDigest: current.binding.executionBlueprintDigest,
      operationPolicyDigest: current.binding.operationPolicyDigest,
      controllerEpoch: current.binding.controllerEpoch,
      sessionId: current.binding.runtime.sessionId,
      retrievalBudget: options.retrievalBudget,
      allowedRefs: entries,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + AUTH_TTL_MS).toISOString()
    });
    const receipt = compileContextRefAuthorizationReceipt(grant, {
      executionBindingDigest: current.binding.digest,
      contextManifestDigest: current.binding.contextManifestDigest,
      promptManifestDigest: current.binding.promptManifestDigest
    });
    const stateFile = retrievalStateFile(stateRoot, operationId, participantId, current.binding.digest);
    const previous = await readRetrievalState(stateFile, current.binding, options.retrievalBudget);
    if (previous.closedAt || previous.requests || previous.receiptIds.length) throw new Error("CONTEXT_RUNTIME_V2_STATE_CLOSED: context authorization cannot be refreshed after retrieval or the result boundary.");
    await writeJsonAtomic(authorizationFile(stateRoot, operationId, participantId, current.binding.digest), receipt);
    if (!await exists(stateFile)) await writeJsonAtomic(stateFile, previous);
    return receipt;
  });
}

export async function retrieveAuthorizedContext(root: string, controlRoot: string, operationId: string, participantId: string, actualSessionId: string | undefined, logicalAgent: string, phase: string, request: AuthorizedContextRetrievalRequestV1): Promise<AuthorizedContextRetrievalResultV1> {
  const stateRoot = resolveOperationStateRoot(controlRoot);
  return withOperationCoordinationLock(stateRoot, operationId, async () => {
    const operation = await loadOperation(stateRoot, operationId);
    const current = currentExecution(operation, participantId);
    if (!actualSessionId || actualSessionId !== current.binding.runtime.sessionId || actualSessionId.startsWith("launch:")) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: retrieval caller is not the actual session in the current ExecutionBinding.");
    if (operation.participants[participantId]?.logicalAgent !== logicalAgent) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: retrieval logical participant does not match the current participant record.");
    if (!request.requestId?.trim() || !request.refId?.trim()) throw new Error("CONTEXT_RUNTIME_V2_INVALID: refId and requestId are required.");
    const receipt = await readAuthorizationReceipt(stateRoot, operationId, participantId, current.binding);
    const expected = authorizationExpectation(current.binding, current.policy.projectId);
    assertContextRefAuthorization(receipt.grant, expected);
    if (receipt.executionBindingDigest !== current.binding.digest || receipt.contextManifestDigest !== current.binding.contextManifestDigest || receipt.promptManifestDigest !== current.binding.promptManifestDigest || receipt.receiptDigest !== authorizationReceiptDigest(receipt)) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: durable authorization receipt is not pinned to the current ExecutionBinding.");
    const entry = receipt.grant.allowedRefs.find((candidate) => candidate.refId === request.refId);
    if (!entry) throw new Error(`CONTEXT_RUNTIME_V2_UNAUTHORIZED: ref '${request.refId}' is not permitted by the current controller grant.`);
    const envelope = await readCurrentEnvelope(root, operationId, logicalAgent, phase);
    const fragment = envelope.fragments.find((candidate) => candidate.id === entry.fragmentId);
    if (!fragment || !envelope.retrieval.allowedFragmentIds.includes(entry.fragmentId) || fragment.source?.artifact !== entry.artifactPath || fragment.source.sha256 !== entry.sourceDigest) throw new Error("CONTEXT_RUNTIME_V2_SOURCE_STALE: authorized context fragment no longer matches its current envelope.");
    const sourcePath = await safeArtifactPath(root, entry.artifactPath);
    const sourceBytes = await fs.readFile(sourcePath);
    const sourceDigest = sha256Bytes(sourceBytes);
    if (sourceDigest !== entry.sourceDigest) throw new Error("CONTEXT_RUNTIME_V2_SOURCE_DIGEST_MISMATCH: authorized raw bytes changed after issue.");
    const sourceContent = sourceBytes.toString("utf8");
    const shard = {
      version: 1 as const,
      shardId: entry.shardId,
      file: entry.sourceFile ?? entry.artifactPath,
      content: sourceContent,
      sourceDigest,
      contentDigest: digestText(sourceContent),
      locator: entry.locator
    };
    const ref = createContextRef({ refId: entry.refId, authorizationReceipt: receipt, expected: { ...expected, executionBindingDigest: current.binding.digest, contextManifestDigest: current.binding.contextManifestDigest, promptManifestDigest: current.binding.promptManifestDigest } });
    const selected = deliverContextPayload(ref, shard, receipt, { ...expected, executionBindingDigest: current.binding.digest, contextManifestDigest: current.binding.contextManifestDigest, promptManifestDigest: current.binding.promptManifestDigest });
    const selectedPayload = selectContextShard(shard, selected.locator);
    if (selectedPayload.digest !== entry.contentDigest) throw new Error("CONTEXT_RUNTIME_V2_SOURCE_DIGEST_MISMATCH: delivered fragment does not match the controller-issued content digest.");
    const limits = receipt.grant.retrievalBudget;
    const maxRequestsPerTurn = limits.maxRequestsPerTurn;
    const maxTokensPerRequest = limits.maxTokensPerRequest;
    const maxTotalTokensPerTurn = limits.maxTotalTokensPerTurn;
    const stateFile = retrievalStateFile(stateRoot, operationId, participantId, current.binding.digest);
    const previous = await readRetrievalState(stateFile, current.binding, limits);
    if (previous.closedAt) throw new Error("CONTEXT_RUNTIME_V2_STATE_CLOSED: retrieval is closed after StructuredResult acceptance.");
    if (previous.requestIds.includes(request.requestId)) throw new Error("CONTEXT_RUNTIME_V2_REPLAY_REJECTED: retrieval request id was already consumed.");
    if (previous.requests >= maxRequestsPerTurn) throw new Error("CONTEXT_RETRIEVAL_BUDGET_EXCEEDED: maximum durable requests per execution reached.");
    const requestedMax = request.maxTokens ?? maxTokensPerRequest;
    if (!Number.isSafeInteger(requestedMax) || requestedMax < 1) throw new Error("CONTEXT_RUNTIME_V2_INVALID: maxTokens must be a positive integer.");
    const deliveredContent = boundRetrievedContent(selectedPayload.content, Math.min(requestedMax, maxTokensPerRequest));
    const estimatedTokens = estimateTokens(deliveredContent);
    const totalTokens = previous.totalTokens + estimatedTokens;
    if (totalTokens > maxTotalTokensPerTurn) throw new Error("CONTEXT_RETRIEVAL_BUDGET_EXCEEDED: maximum durable tokens per execution reached.");
    const priorReceipts = await loadContextRetrievalReceipts(stateRoot, operationId, participantId, current.binding);
    const receiptBody: Omit<ContextRetrievalReceiptV1, "receiptDigest"> = {
      version: 1,
      receiptId: `context-retrieval:${crypto.randomUUID()}`,
      requestId: request.requestId,
      operationId,
      projectId: current.policy.projectId,
      operationExecutionRevision: current.binding.operationExecutionRevision,
      candidateRevision: current.binding.candidateRevision,
      candidateRevisionDigest: current.binding.candidateDigest,
      participantId,
      participantGeneration: current.binding.participantGeneration,
      executionBindingDigest: current.binding.digest,
      controllerEpoch: current.binding.controllerEpoch,
      sessionId: current.binding.runtime.sessionId,
      authorizationReceiptDigest: receipt.receiptDigest,
      refId: entry.refId,
      fragmentId: entry.fragmentId,
      artifactPath: entry.artifactPath,
      sourceDigest,
      deliveredContentDigest: digestText(deliveredContent),
      estimatedTokens,
      retrievedAt: new Date().toISOString()
    };
    const retrievalReceipt: ContextRetrievalReceiptV1 = { ...receiptBody, receiptDigest: sha256Canonical(receiptBody) };
    const nextState = withStateDigest({
      version: 1 as const,
      executionBindingDigest: current.binding.digest,
      sessionId: current.binding.runtime.sessionId,
      retrievalBudget: limits,
      requests: previous.requests + 1,
      totalTokens,
      requestIds: [...previous.requestIds, request.requestId].sort(),
      receiptIds: [...previous.receiptIds, retrievalReceipt.receiptId].sort(),
      ...(previous.closedAt ? { closedAt: previous.closedAt } : {})
    });
    await writeJsonAtomic(stateFile, nextState);
    await writeJsonAtomic(retrievalReceiptFile(stateRoot, operationId, participantId, current.binding.digest, retrievalReceipt.receiptId), retrievalReceipt);
    return { fragmentId: entry.fragmentId, content: deliveredContent, artifact: entry.artifactPath, sha256: sourceDigest, estimatedTokens, repeated: priorReceipts.some((prior) => prior.refId === entry.refId), receipt: retrievalReceipt };
  });
}

export async function validateCurrentContextAuthorization(controlRoot: string, operationId: string, participantId: string, actualSessionId: string | undefined): Promise<ContextRefAuthorizationReceiptV1> {
  const stateRoot = resolveOperationStateRoot(controlRoot);
  const operation = await loadOperation(stateRoot, operationId);
  const current = currentExecution(operation, participantId);
  if (!actualSessionId || actualSessionId !== current.binding.runtime.sessionId || actualSessionId.startsWith("launch:")) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: participant is not the actual session in the current ExecutionBinding.");
  const receipt = await readAuthorizationReceipt(stateRoot, operationId, participantId, current.binding);
  assertContextRefAuthorization(receipt.grant, authorizationExpectation(current.binding, current.policy.projectId));
  if (receipt.receiptDigest !== authorizationReceiptDigest(receipt)) throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: durable issue receipt digest is invalid.");
  return receipt;
}

export async function loadContextRetrievalReceipts(controlRoot: string, operationId: string, participantId: string, binding: ExecutionBindingV2): Promise<ContextRetrievalReceiptV1[]> {
  const stateRoot = resolveOperationStateRoot(controlRoot);
  const directory = retrievalReceiptsDirectory(stateRoot, operationId, participantId, binding.digest);
  const names = await fs.readdir(directory).catch((error) => isNotFound(error) ? [] : Promise.reject(error));
  const receipts: ContextRetrievalReceiptV1[] = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    const value = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as ContextRetrievalReceiptV1;
    assertRetrievalReceipt(value, binding);
    receipts.push(value);
  }
  if (receipts.length) {
    const authorization = await readAuthorizationReceipt(stateRoot, operationId, participantId, binding);
    assertContextRefAuthorization(authorization.grant, authorizationExpectation(binding, authorization.grant.projectId), new Date(authorization.grant.issuedAt));
    for (const receipt of receipts) {
      const entry = authorization.grant.allowedRefs.find((candidate) => candidate.refId === receipt.refId);
      if (receipt.authorizationReceiptDigest !== authorization.receiptDigest || receipt.projectId !== authorization.grant.projectId || receipt.operationExecutionRevision !== binding.operationExecutionRevision || !entry || entry.fragmentId !== receipt.fragmentId || entry.artifactPath !== receipt.artifactPath || entry.sourceDigest !== receipt.sourceDigest) throw new Error("CONTEXT_RUNTIME_V2_RECEIPT_INVALID: retrieval receipt is not authorized by the durable controller issue record.");
    }
  }
  return receipts;
}

export async function contextRetrievalEvidenceForResult(controlRoot: string, binding: ExecutionBindingV2): Promise<ContextRetrievalEvidenceV1> {
  const receipts = await loadContextRetrievalReceipts(controlRoot, binding.operationId, binding.participantId, binding);
  const stateRoot = resolveOperationStateRoot(controlRoot);
  const authPath = authorizationFile(stateRoot, binding.operationId, binding.participantId, binding.digest);
  const auth = await exists(authPath) ? await readAuthorizationReceipt(stateRoot, binding.operationId, binding.participantId, binding) : undefined;
  if (auth) assertContextRefAuthorization(auth.grant, authorizationExpectation(binding, auth.grant.projectId), new Date(auth.grant.issuedAt));
  const stateFile = retrievalStateFile(stateRoot, binding.operationId, binding.participantId, binding.digest);
  const state = await readRetrievalState(stateFile, binding, auth?.grant.retrievalBudget ?? null);
  if (!state.closedAt) throw new Error("CONTEXT_RUNTIME_V2_STATE_OPEN: StructuredResult context evidence requires retrieval to be closed at the result boundary.");
  return contextEvidenceValue(binding, receipts, state);
}

export function assertContextRetrievalEvidence(evidence: ContextRetrievalEvidenceV1, binding: ExecutionBindingV2): void {
  const { evidenceDigest, progressiveManifestDigest, ...value } = evidence;
  const expectedProgressiveManifestDigest = sha256Canonical({ kind: "ProgressiveContextManifestV1", ...value });
  if (evidence.version !== 1 || evidenceDigest !== sha256Canonical({ ...value, progressiveManifestDigest }) || progressiveManifestDigest !== expectedProgressiveManifestDigest || evidence.executionBindingDigest !== binding.digest || evidence.contextManifestDigest !== binding.contextManifestDigest || evidence.promptManifestDigest !== binding.promptManifestDigest || evidence.receiptIds.length !== evidence.receiptDigests.length || evidence.receiptIds.some((id, index) => !id || !/^[a-f0-9]{64}$/.test(evidence.receiptDigests[index] ?? "")) || evidence.receiptsDigest !== sha256Canonical({ receiptIds: evidence.receiptIds, receiptDigests: evidence.receiptDigests }) || !Number.isSafeInteger(evidence.requests) || evidence.requests < 0 || !Number.isSafeInteger(evidence.totalTokens) || evidence.totalTokens < 0 || !/^[a-f0-9]{64}$/.test(evidence.retrievalStateDigest)) throw new Error("CONTEXT_RUNTIME_V2_RECEIPT_INVALID: StructuredResult context evidence is invalid or does not match its ExecutionBinding.");
}

/** Freeze the candidate/session retrieval receipt set atomically before accepting a StructuredResult. */
export async function closeContextRetrievalForResult(controlRoot: string, binding: ExecutionBindingV2): Promise<ContextRetrievalEvidenceV1> {
  const stateRoot = resolveOperationStateRoot(controlRoot);
  return withOperationCoordinationLock(stateRoot, binding.operationId, async () => {
    const operation = await loadOperation(stateRoot, binding.operationId);
    const current = currentExecution(operation, binding.participantId);
    if (current.binding.digest !== binding.digest) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: result boundary does not match the current execution binding.");
    const authorizationPath = authorizationFile(stateRoot, binding.operationId, binding.participantId, binding.digest);
    const authorization = await exists(authorizationPath) ? await readAuthorizationReceipt(stateRoot, binding.operationId, binding.participantId, binding) : undefined;
    if (authorization) assertContextRefAuthorization(authorization.grant, authorizationExpectation(current.binding, current.policy.projectId), new Date(authorization.grant.issuedAt));
    const budget = authorization?.grant.retrievalBudget ?? null;
    const stateFile = retrievalStateFile(stateRoot, binding.operationId, binding.participantId, binding.digest);
    const previous = await readRetrievalState(stateFile, binding, budget);
    if (!previous.closedAt) {
      const { stateDigest: _stateDigest, ...body } = previous;
      await writeJsonAtomic(stateFile, withStateDigest({ ...body, closedAt: new Date().toISOString() }));
    }
    const receipts = await loadContextRetrievalReceipts(stateRoot, binding.operationId, binding.participantId, binding);
    return contextEvidenceValue(binding, receipts, await readRetrievalState(stateFile, binding, budget));
  });
}

export async function recordContextContinuation(controlRoot: string, operationId: string, participantId: string, input: Omit<ContextContinuationInputV1, "sequence" | "previousSessionId" | "nextSessionId" | "previousTurnId" | "nextTurnId" | "contextRefIds" | "retrievalReceiptIds"> & { previousSessionId?: string }): Promise<ContextContinuationV1> {
  const stateRoot = resolveOperationStateRoot(controlRoot);
  return withOperationCoordinationLock(stateRoot, operationId, async () => {
    const operation = await loadOperation(stateRoot, operationId);
    assertCurrentControllerOwner(operation, "persist ContextContinuationV1");
    const current = currentExecution(operation, participantId);
    const sessionId = current.binding.runtime.sessionId;
    if (input.executionBindingDigest !== current.binding.digest || (input.previousSessionId && input.previousSessionId !== sessionId)) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: continuation does not target the current durable session binding.");
    const expected = authorizationExpectation(current.binding, current.policy.projectId);
    const authFile = authorizationFile(stateRoot, operationId, participantId, current.binding.digest);
    const auth = await exists(authFile) ? await readAuthorizationReceipt(stateRoot, operationId, participantId, current.binding) : undefined;
    if (auth) {
      const participant = operation.participants[participantId];
      const logicalAgent = participant?.logicalAgent;
      if (!logicalAgent) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: continuation participant has no registered logical agent.");
      const projectRoot = operation.root ?? stateRoot;
      const envelope = await readCurrentEnvelope(projectRoot, operationId, logicalAgent, participant?.phase ?? participant?.stage ?? "work");
      for (const entry of auth.grant.allowedRefs) {
        const fragment = envelope.fragments.find((candidate) => candidate.id === entry.fragmentId);
        if (!fragment || !envelope.retrieval.allowedFragmentIds.includes(entry.fragmentId) || fragment.source?.artifact !== entry.artifactPath || fragment.source.sha256 !== entry.sourceDigest) throw new Error("CONTEXT_RUNTIME_V2_SOURCE_STALE: continuation references a fragment outside the current context envelope.");
        const currentBytes = await fs.readFile(await safeArtifactPath(projectRoot, entry.artifactPath));
        const sourceDigest = sha256Bytes(currentBytes);
        const sourceContent = currentBytes.toString("utf8");
        const shard = { version: 1 as const, shardId: entry.shardId, file: entry.sourceFile ?? entry.artifactPath, content: sourceContent, sourceDigest, contentDigest: digestText(sourceContent), locator: entry.locator };
        if (sourceDigest !== entry.sourceDigest || selectContextShard(shard, entry.locator).digest !== entry.contentDigest) throw new Error("CONTEXT_RUNTIME_V2_SOURCE_DIGEST_MISMATCH: continuation source bytes changed after authorization.");
      }
    }
    const availableRefs = auth ? auth.grant.allowedRefs.map((entry) => createContextRef({ refId: entry.refId, authorizationReceipt: auth, expected: { ...expected, executionBindingDigest: current.binding.digest, contextManifestDigest: current.binding.contextManifestDigest, promptManifestDigest: current.binding.promptManifestDigest } })) : [];
    const retrieved = await loadContextRetrievalReceipts(stateRoot, operationId, participantId, current.binding);
    if (auth && retrieved.some((receipt) => receipt.authorizationReceiptDigest !== auth.receiptDigest)) throw new Error("CONTEXT_RUNTIME_V2_RECEIPT_INVALID: continuation contains a retrieval receipt from a different authorization grant.");
    const stateFile = continuationStateFile(stateRoot, operationId, participantId, current.binding.digest);
    const previous = await readContinuationState(stateFile, current.binding);
    const sequence = previous.sequence + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error("CONTEXT_RUNTIME_V2_STATE_INVALID: continuation sequence exceeded its safe integer range.");
    const turnId = `context-turn:${current.binding.digest}:${sequence}:${crypto.randomUUID()}`;
    if (previous.turnIds.includes(turnId)) throw new Error("CONTEXT_RUNTIME_V2_REPLAY_REJECTED: continuation turn id has already been used.");
    const continuation = bindContinuation({
      ...input,
      operationId,
      projectId: current.policy.projectId,
      operationExecutionRevision: current.binding.operationExecutionRevision,
      candidateRevision: current.binding.candidateRevision,
      candidateRevisionDigest: current.binding.candidateDigest,
      participantId,
      participantGeneration: current.binding.participantGeneration,
      executionBindingDigest: current.binding.digest,
      controllerEpoch: current.binding.controllerEpoch,
      contextManifestDigest: current.binding.contextManifestDigest,
      promptManifestDigest: current.binding.promptManifestDigest,
      previousSessionId: previous.sessionId || sessionId,
      nextSessionId: sessionId,
      previousTurnId: previous.lastTurnId || `context-turn:${current.binding.digest}:1`,
      nextTurnId: turnId,
      sequence,
      contextRefIds: availableRefs.map((ref) => ref.refId),
      retrievalReceiptIds: retrieved.map((receipt) => receipt.receiptId)
    });
    assertContinuationCurrent(continuation, current.binding, current.policy.projectId, availableRefs, retrieved.map((receipt) => receipt.receiptId));
    const file = continuationFile(stateRoot, operationId, participantId, current.binding.digest, continuation.continuationId);
    if (await exists(file)) throw new Error("CONTEXT_RUNTIME_V2_REPLAY_REJECTED: continuation id already exists.");
    await writeJsonAtomic(file, continuation);
    await writeJsonAtomic(stateFile, withStateDigest({
      version: 1 as const,
      executionBindingDigest: current.binding.digest,
      sessionId,
      sequence,
      lastTurnId: turnId,
      turnIds: [...previous.turnIds, turnId]
    }));
    return continuation;
  });
}

function currentExecution(operation: OperationRecordV2, participantId: string): { binding: ExecutionBindingV2; policy: NonNullable<OperationRecordV2["resolvedOperationPolicy"]> } {
  if (operation.version !== 2 || !operation.resolvedOperationPolicy || !operation.candidateRevision || !operation.operationExecutionRevision) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: current operation candidate, policy, and execution revision are required.");
  const participant = operation.participants[participantId];
  const agent = operation.agents?.find((item) => item.id === participantId);
  const binding = participant?.executionBinding ?? agent?.executionBinding;
  if (!binding) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: participant has no current durable ExecutionBinding.");
  if (participant && ["COMPLETED", "FAILED", "BLOCKED", "CANCELLED"].includes(participant.status)) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: context access is closed for a terminal participant execution.");
  assertExecutionBindingV2(binding);
  const policy = operation.resolvedOperationPolicy;
  assertResolvedOperationPolicyV1(policy);
  if (binding.operationId !== operation.id || binding.operationExecutionRevision !== operation.operationExecutionRevision || binding.candidateRevision !== operation.candidateRevision.revision || binding.candidateDigest !== operation.candidateRevision.identityDigest || binding.operationPolicyDigest !== policy.digest || binding.controllerEpoch !== currentControllerEpoch(operation) || policy.operationId !== operation.id || policy.operationExecutionRevision !== operation.operationExecutionRevision || policy.candidateRevision !== operation.candidateRevision.revision || policy.candidateDigest !== operation.candidateRevision.identityDigest || policy.controllerEpoch !== currentControllerEpoch(operation)) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: participant binding is stale for the current candidate, policy, execution revision, or controller epoch.");
  if (!binding.runtime.sessionId.trim() || binding.runtime.sessionId.startsWith("launch:")) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: context authorization requires an actual runtime session identity.");
  return { binding, policy };
}

function authorizationExpectation(binding: ExecutionBindingV2, projectId: string): Omit<ContextRefAuthorizationExpectationV1, "executionBindingDigest" | "contextManifestDigest" | "promptManifestDigest"> {
  return {
    operationId: binding.operationId,
    projectId,
    operationExecutionRevision: binding.operationExecutionRevision,
    candidateRevision: binding.candidateRevision,
    candidateRevisionDigest: binding.candidateDigest,
    participantId: binding.participantId,
    participantGeneration: binding.participantGeneration,
    executionBlueprintDigest: binding.executionBlueprintDigest,
    operationPolicyDigest: binding.operationPolicyDigest,
    controllerEpoch: binding.controllerEpoch,
    sessionId: binding.runtime.sessionId
  };
}

function assertCurrentReadAuthority(authority: ExecutionAuthorityV1, binding: ExecutionBindingV2, projectId: string, now: Date): void {
  assertExecutionAuthority(authority, now);
  const authorityLeaseIds = authority.leases.map((lease) => lease.leaseId).sort();
  if (authority.operationId !== binding.operationId || authority.participantId !== binding.participantId || authority.projectId !== projectId || authority.candidateDigest !== binding.candidateDigest || authority.controllerEpoch !== binding.controllerEpoch || authorityLeaseIds.join("\0") !== binding.leaseIdentities.join("\0")) throw new Error("CONTEXT_RUNTIME_V2_AUTHORITY_REJECTED: controller read authority does not match the current execution binding.");
  const readLease = authority.leases.find((lease) => lease.capability === "read" && lease.operationId === binding.operationId && lease.participantId === binding.participantId && lease.projectId === projectId && lease.candidate.identityDigest === binding.candidateDigest && lease.candidate.revision === binding.candidateRevision && new Date(lease.issuedAt).getTime() <= now.getTime() && new Date(lease.expiresAt).getTime() > now.getTime());
  if (!readLease) throw new Error("CONTEXT_RUNTIME_V2_AUTHORITY_REJECTED: current participant read lease is required to issue addressable context refs.");
}

async function readCurrentEnvelope(root: string, operationId: string, logicalAgent: string, phase: string): Promise<ContextEnvelope> {
  const file = contextEnvelopePath(root, operationId, logicalAgent, phase);
  const envelope = assertContextEnvelope(JSON.parse(await fs.readFile(file, "utf8")));
  if (!verifyContextEnvelope(envelope) || envelope.operationId !== operationId || envelope.logicalAgent !== logicalAgent || envelope.phase !== phase) throw new Error("CONTEXT_RUNTIME_V2_ENVELOPE_STALE: durable context envelope is corrupt or belongs to a different invocation.");
  return envelope;
}

interface LaunchAddressableRefV1 {
  refId: string;
  artifactPath: string;
  sourceDigest: string;
}

/** Prove that the current durable envelope still describes the exact refs frozen into S1 identity. */
function assertLaunchManifestMatchesEnvelope(manifest: Readonly<Record<string, unknown>>, binding: ExecutionBindingV2, envelope: ContextEnvelope): LaunchAddressableRefV1[] {
  if (sha256Canonical(manifest) !== binding.contextManifestDigest) throw new Error("CONTEXT_RUNTIME_V2_MANIFEST_REJECTED: launch ContextManifest does not match the current ExecutionBinding digest.");
  if (manifest.envelopeDigest !== envelope.provenance.sha256) throw new Error("CONTEXT_RUNTIME_V2_MANIFEST_REJECTED: durable ContextEnvelope digest does not match the frozen launch manifest.");
  if (!Array.isArray(manifest.addressableRefs)) throw new Error("CONTEXT_RUNTIME_V2_MANIFEST_REJECTED: launch ContextManifest has no addressable-ref set.");

  const manifestRefs = new Map<string, LaunchAddressableRefV1>();
  const refKeys = ["artifactPath", "refId", "sourceDigest"];
  for (const value of manifest.addressableRefs) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== refKeys.join("\0")) throw new Error("CONTEXT_RUNTIME_V2_MANIFEST_REJECTED: launch ContextManifest contains an invalid addressable ref.");
    const ref = value as LaunchAddressableRefV1;
    if (typeof ref.refId !== "string" || !ref.refId.trim() || typeof ref.artifactPath !== "string" || !ref.artifactPath.trim() || typeof ref.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(ref.sourceDigest) || manifestRefs.has(ref.refId)) throw new Error("CONTEXT_RUNTIME_V2_MANIFEST_REJECTED: launch ContextManifest refs must be complete, valid, and unique.");
    manifestRefs.set(ref.refId, ref);
  }

  const envelopeIds = envelope.retrieval.allowedFragmentIds;
  if (new Set(envelopeIds).size !== envelopeIds.length) throw new Error("CONTEXT_RUNTIME_V2_MANIFEST_REJECTED: durable ContextEnvelope retrieval refs must be unique.");
  const envelopeRefs: LaunchAddressableRefV1[] = [];
  for (const refId of envelopeIds) {
    const matches = envelope.fragments.filter((candidate) => candidate.id === refId);
    if (matches.length !== 1) throw new Error(`CONTEXT_RUNTIME_V2_MANIFEST_REJECTED: durable ref '${refId}' must identify exactly one envelope fragment.`);
    const source = matches[0]!.source;
    if (!source?.artifact || !source.sha256) throw new Error(`CONTEXT_RUNTIME_V2_MANIFEST_REJECTED: durable ref '${refId}' lacks artifact-path or source-digest evidence.`);
    envelopeRefs.push({ refId, artifactPath: source.artifact, sourceDigest: source.sha256 });
  }

  if (manifestRefs.size !== envelopeRefs.length || envelopeRefs.some((ref) => {
    const launchRef = manifestRefs.get(ref.refId);
    return !launchRef || launchRef.artifactPath !== ref.artifactPath || launchRef.sourceDigest !== ref.sourceDigest;
  })) throw new Error("CONTEXT_RUNTIME_V2_MANIFEST_REJECTED: addressable refs do not exactly match the verified durable ContextEnvelope.");
  return envelopeRefs.sort((left, right) => left.refId.localeCompare(right.refId));
}

async function readAuthorizationReceipt(stateRoot: string, operationId: string, participantId: string, binding: ExecutionBindingV2): Promise<ContextRefAuthorizationReceiptV1> {
  const file = authorizationFile(stateRoot, operationId, participantId, binding.digest);
  const receipt = JSON.parse(await fs.readFile(file, "utf8")) as ContextRefAuthorizationReceiptV1;
  const receiptKeys = ["version", "grant", "executionBindingDigest", "contextManifestDigest", "promptManifestDigest", "receiptDigest"].sort();
  if (!receipt || typeof receipt !== "object" || Object.keys(receipt).sort().join("\0") !== receiptKeys.join("\0") || receipt.version !== 1 || receipt.receiptDigest !== authorizationReceiptDigest(receipt)) throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: durable controller issue record is malformed or corrupt.");
  if (receipt.executionBindingDigest !== binding.digest || receipt.contextManifestDigest !== binding.contextManifestDigest || receipt.promptManifestDigest !== binding.promptManifestDigest) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: authorization issue record is stale for the current ExecutionBinding.");
  return receipt;
}

function authorizationReceiptDigest(receipt: ContextRefAuthorizationReceiptV1): string {
  return sha256Canonical({ version: receipt.version, grantDigest: receipt.grant.grantDigest, executionBindingDigest: receipt.executionBindingDigest, contextManifestDigest: receipt.contextManifestDigest, promptManifestDigest: receipt.promptManifestDigest });
}

function assertRetrievalReceipt(receipt: ContextRetrievalReceiptV1, binding: ExecutionBindingV2): void {
  const keys = ["version", "receiptId", "requestId", "operationId", "projectId", "operationExecutionRevision", "candidateRevision", "candidateRevisionDigest", "participantId", "participantGeneration", "executionBindingDigest", "controllerEpoch", "sessionId", "authorizationReceiptDigest", "refId", "fragmentId", "artifactPath", "sourceDigest", "deliveredContentDigest", "estimatedTokens", "retrievedAt", "receiptDigest"].sort();
  if (!receipt || typeof receipt !== "object" || Object.keys(receipt).sort().join("\0") !== keys.join("\0")) throw new Error("CONTEXT_RUNTIME_V2_RECEIPT_INVALID: retrieval receipt shape is invalid.");
  const { receiptDigest, ...body } = receipt;
  if (receipt.version !== 1 || typeof receipt.receiptId !== "string" || !receipt.receiptId.trim() || typeof receipt.requestId !== "string" || !receipt.requestId.trim() || typeof receipt.projectId !== "string" || !receipt.projectId.trim() || typeof receipt.refId !== "string" || !receipt.refId.trim() || typeof receipt.fragmentId !== "string" || !receipt.fragmentId.trim() || typeof receipt.artifactPath !== "string" || !receipt.artifactPath.trim() || !Number.isSafeInteger(receipt.estimatedTokens) || receipt.estimatedTokens < 0 || !Number.isFinite(Date.parse(receipt.retrievedAt)) || receiptDigest !== sha256Canonical(body) || receipt.executionBindingDigest !== binding.digest || receipt.operationId !== binding.operationId || receipt.operationExecutionRevision !== binding.operationExecutionRevision || receipt.participantId !== binding.participantId || receipt.participantGeneration !== binding.participantGeneration || receipt.candidateRevision !== binding.candidateRevision || receipt.candidateRevisionDigest !== binding.candidateDigest || receipt.controllerEpoch !== binding.controllerEpoch || receipt.sessionId !== binding.runtime.sessionId) {
    throw new Error("CONTEXT_RUNTIME_V2_RECEIPT_INVALID: retrieval receipt is corrupt or bound to a stale execution.");
  }
  for (const digest of [receipt.sourceDigest, receipt.deliveredContentDigest, receipt.authorizationReceiptDigest]) if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("CONTEXT_RUNTIME_V2_RECEIPT_INVALID: retrieval receipt contains a malformed digest.");
}

function assertContinuationCurrent(continuation: ContextContinuationV1, binding: ExecutionBindingV2, projectId: string, refs: ReturnType<typeof createContextRef>[], receiptIds: string[]): void {
  assertContinuationBinding(continuation, {
    operationId: binding.operationId,
    projectId,
    operationExecutionRevision: binding.operationExecutionRevision,
    candidateRevision: binding.candidateRevision,
    candidateRevisionDigest: binding.candidateDigest,
    participantId: binding.participantId,
    participantGeneration: binding.participantGeneration,
    executionBindingDigest: binding.digest,
    controllerEpoch: binding.controllerEpoch,
    contextManifestDigest: binding.contextManifestDigest,
    promptManifestDigest: binding.promptManifestDigest,
    previousSessionId: continuation.previousSessionId,
    nextSessionId: continuation.nextSessionId,
    previousTurnId: continuation.previousTurnId,
    sequence: continuation.sequence,
    availableRefs: refs,
    availableReceiptIds: receiptIds
  });
}

function baseDir(root: string, operationId: string, participantId: string, bindingDigest: string): string {
  return path.join(resolveOperationStateRoot(root), ".harness", "context", "runtime-v2", safeSegment(operationId), safeSegment(participantId), bindingDigest);
}
function authorizationFile(root: string, operationId: string, participantId: string, bindingDigest: string): string { return path.join(baseDir(root, operationId, participantId, bindingDigest), "authorization.json"); }
function retrievalStateFile(root: string, operationId: string, participantId: string, bindingDigest: string): string { return path.join(baseDir(root, operationId, participantId, bindingDigest), "retrieval-state.json"); }
function retrievalReceiptsDirectory(root: string, operationId: string, participantId: string, bindingDigest: string): string { return path.join(baseDir(root, operationId, participantId, bindingDigest), "retrieval-receipts"); }
function retrievalReceiptFile(root: string, operationId: string, participantId: string, bindingDigest: string, receiptId: string): string { return path.join(retrievalReceiptsDirectory(root, operationId, participantId, bindingDigest), `${safeSegment(receiptId)}.json`); }
function continuationStateFile(root: string, operationId: string, participantId: string, bindingDigest: string): string { return path.join(baseDir(root, operationId, participantId, bindingDigest), "continuation-state.json"); }
function continuationFile(root: string, operationId: string, participantId: string, bindingDigest: string, continuationId: string): string { return path.join(baseDir(root, operationId, participantId, bindingDigest), "continuations", `${safeSegment(continuationId)}.json`); }

async function readRetrievalState(file: string, binding: ExecutionBindingV2, retrievalBudget: ContextRetrievalBudgetV1 | null): Promise<DurableRetrievalStateV1> {
  const value = await readOptionalJson<DurableRetrievalStateV1>(file);
  if (!value) return withStateDigest({ version: 1 as const, executionBindingDigest: binding.digest, sessionId: binding.runtime.sessionId, retrievalBudget, requests: 0, totalTokens: 0, requestIds: [], receiptIds: [] });
  assertState(value, binding);
  if (sha256Canonical(value.retrievalBudget) !== sha256Canonical(retrievalBudget) || !Number.isSafeInteger(value.requests) || value.requests < 0 || !Number.isSafeInteger(value.totalTokens) || value.totalTokens < 0 || !Array.isArray(value.requestIds) || !Array.isArray(value.receiptIds) || (value.closedAt !== undefined && !Number.isFinite(Date.parse(value.closedAt)))) throw new Error("CONTEXT_RUNTIME_V2_STATE_INVALID: durable retrieval state has malformed budget, usage, or result closure.");
  return value;
}

async function readContinuationState(file: string, binding: ExecutionBindingV2): Promise<DurableContinuationStateV1> {
  const value = await readOptionalJson<DurableContinuationStateV1>(file);
  if (!value) return withStateDigest({ version: 1 as const, executionBindingDigest: binding.digest, sessionId: binding.runtime.sessionId, sequence: 1, lastTurnId: `context-turn:${binding.digest}:1`, turnIds: [`context-turn:${binding.digest}:1`] });
  assertState(value, binding);
  return value;
}

function assertState<T extends { version: 1; executionBindingDigest: string; sessionId: string; stateDigest: string }>(value: T, binding: ExecutionBindingV2): void {
  const { stateDigest, ...body } = value;
  if (stateDigest !== sha256Canonical(body) || value.executionBindingDigest !== binding.digest || value.sessionId !== binding.runtime.sessionId) throw new Error("CONTEXT_RUNTIME_V2_STATE_INVALID: durable runtime state is corrupt or stale.");
}

function withStateDigest<T extends Record<string, unknown>>(body: T): T & { stateDigest: string } { return { ...body, stateDigest: sha256Canonical(body) }; }

function contextEvidenceValue(binding: ExecutionBindingV2, receipts: ContextRetrievalReceiptV1[], state: DurableRetrievalStateV1): ContextRetrievalEvidenceV1 {
  const receiptIds = receipts.map((receipt) => receipt.receiptId).sort();
  const receiptDigests = receipts.map((receipt) => receipt.receiptDigest).sort();
  const receiptsDigest = sha256Canonical({ receiptIds, receiptDigests });
  const manifestValue = {
    version: 1 as const,
    executionBindingDigest: binding.digest,
    contextManifestDigest: binding.contextManifestDigest,
    promptManifestDigest: binding.promptManifestDigest,
    receiptIds,
    receiptDigests,
    receiptsDigest,
    retrievalBudget: state.retrievalBudget,
    requests: state.requests,
    totalTokens: state.totalTokens,
    retrievalStateDigest: state.stateDigest
  };
  if (state.receiptIds.slice().sort().join("\0") !== receiptIds.join("\0") || state.requests !== state.requestIds.length || state.requests !== receiptIds.length || state.totalTokens !== receipts.reduce((sum, receipt) => sum + receipt.estimatedTokens, 0)) throw new Error("CONTEXT_RUNTIME_V2_STATE_INVALID: durable retrieval state does not match its immutable receipt set.");
  const progressiveManifestDigest = sha256Canonical({ kind: "ProgressiveContextManifestV1", ...manifestValue });
  const evidenceValue = { ...manifestValue, progressiveManifestDigest };
  return { ...evidenceValue, evidenceDigest: sha256Canonical(evidenceValue) };
}

function boundRetrievedContent(content: string, maxTokens: number): string {
  if (estimateTokens(content) <= maxTokens) return content;
  const selected: string[] = [];
  let used = 0;
  for (const line of content.split(/\r?\n/)) {
    const next = estimateTokens(`${line}\n`);
    if (used + next > maxTokens) break;
    selected.push(line);
    used += next;
  }
  const excerpt = selected.join("\n");
  const marker = "\n[bounded authorized context excerpt]";
  return estimateTokens(`${excerpt}${marker}`) <= maxTokens ? `${excerpt}${marker}` : excerpt;
}

async function safeArtifactPath(root: string, artifact: string): Promise<string> {
  if (!artifact || path.isAbsolute(artifact) || artifact.replaceAll("\\", "/").split("/").some((part) => part === ".." || part === ".")) throw new Error("CONTEXT_RUNTIME_V2_PATH_REJECTED: artifact path must be normalized and relative.");
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, artifact);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error("CONTEXT_RUNTIME_V2_PATH_REJECTED: artifact escapes the context root.");
  let cursor = absolute;
  while (cursor !== absoluteRoot && cursor.startsWith(`${absoluteRoot}${path.sep}`)) {
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error("CONTEXT_RUNTIME_V2_PATH_REJECTED: symlink traversal is forbidden."); }
    catch (error) { if (error instanceof Error && error.message.includes("symlink traversal")) throw error; if (!isNotFound(error)) throw error; }
    cursor = path.dirname(cursor);
  }
  return absolute;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}

async function readOptionalJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (error) { if (isNotFound(error)) return undefined; throw error; }
}

async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch (error) { if (isNotFound(error)) return false; throw error; } }
function isNotFound(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"); }
function safeSegment(value: string): string { return `${value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "context"}-${sha256Canonical(value).slice(0, 16)}`; }
