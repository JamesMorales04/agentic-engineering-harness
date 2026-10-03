import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import process from "node:process";
import { loadProjectConfig } from "../core/config.js";
import { sha256Canonical } from "../core/digest.js";
import { intentDecisionFromLeadOperationIntent, InvalidIntentDecisionError, leadOperationIntentV1JsonSchema } from "../audit/intentDecision.js";
import { answerInformationalRequest } from "../informational/answer.js";
import { retrieveInformationalEvidence } from "../informational/evidence.js";
import { statusLeadContext } from "../paseo/context.js";
import { inspectPaseoNativeAgent } from "../paseo/native.js";
import { PASEO_BOOTSTRAP_VERSION } from "../paseo/start.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import { VERSION } from "../version.js";
import { decideParticipantRecoveryV1, readExecutionActivityEventsV1 } from "./executionLiveness.js";
import { assertSameSessionResumeCompatibleV1 } from "./recoveryIdentity.js";
import { dispatchSameSessionResumeV1 } from "./supervisorMcp.js";
import { cancelOperation, startDetachedOperation } from "./controller.js";
import { buildOperationDigest, operationDigestText, type OperationDigest } from "./digest.js";
import { spawnOperationMonitor } from "./monitorProcess.js";
import { loadOperationPortfolio } from "./portfolio.js";
import { acknowledgeOperationLead, currentControllerEpoch, loadOperation, type AuditOperationPayload, type ChangeOperationPayload, type OperationKind, type OperationPayload, type OperationRecordV2, type RunOperationPayload } from "./state.js";
import { allowlistedOperationToolErrorCode, createTrustedOperationToolError, markTrustedOperationToolError, persistOperationToolDiagnosticV2, trustedOperationToolErrorRelatedId } from "./toolDiagnostics.js";

export interface OperationMcpRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; }
export type ContextAgentIdentitySource = "argument" | "environment" | "lead-state";
export interface ContextAgentIdentity { agentId: string; source: ContextAgentIdentitySource; }
export type OperationStatusDetail = "compact" | "full";

class OperationMcpInputError extends Error {
  constructor(readonly path: string, message: string) { super(`${path}: ${message}`); this.name = "OperationMcpInputError"; markTrustedOperationToolError(this, "OPERATION_INPUT_INVALID"); }
}

export interface OperationToolErrorV1 {
  version: 1;
  code: string;
  category: "INPUT_CONTRACT" | "CHAIN_LINEAGE" | "OWNER_BOUNDARY" | "AUTHORITY" | "CONTROLLER_STATE" | "CAPACITY" | "NOT_FOUND" | "INTERNAL";
  path?: string;
  operationCreated: boolean;
  recoverable: boolean;
  retryDisposition: "CORRECT_INPUT" | "CONTINUE_LINKED_OPERATION" | "WAIT_FOR_CAPACITY" | "RETRY_AFTER_CONTROLLER_RECOVERY" | "ESCALATE_TO_OWNER" | "DO_NOT_RETRY";
  requiresHuman: boolean;
  relatedOperationId?: string;
  relationship: "NONE" | "CURRENT_OPERATION" | "CONTINUATION_RELEVANT" | "BOUND_OTHER_LEAD" | "OWNER_ATTENTION" | "HISTORICAL_UNRELATED";
  nextActions: string[];
  skillRef: string;
  diagnosticRef?: string;
}

const boundedStringArray = { type: "array", maxItems: 64, items: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" } } as const;
const requestSchema = { type: "string", minLength: 1, maxLength: 50_000, pattern: "\\S" } as const;
const operationIdSchema = { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._-]+$" } as const;
const shortStringSchema = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" } as const;
const operationIntentSchema = leadOperationIntentV1JsonSchema;

export const operationMcpTools = [
  {
    name: "aeh_operation_start_audit",
    description: "Start a detached supervised AEH AUDIT. Supply the original request and operationIntent.version=1 with requestedOutcome plus optional constraints/continuation; this tool fixes the route and controller-owned effects. Returns a compact digest; do not poll healthy progress.",
    inputSchema: {
      type: "object",
      properties: {
        request: requestSchema, operationIntent: operationIntentSchema,
        files: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" } }, domains: boundedStringArray,
        risk: { type: "string", enum: ["low", "medium", "high"] }, reviewers: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" } }
      },
      required: ["request", "operationIntent"], additionalProperties: false
    }
  },
  {
    name: "aeh_operation_start_run",
    description: "Start detached supervised execution of an already prepared/sealed AEH task. Supply taskId and version 1 operationIntent with requestedOutcome plus optional constraints/continuation; route effects and trusted user-turn identity are controller-derived. Do not poll healthy progress.",
    inputSchema: {
      type: "object",
      properties: { taskId: operationIdSchema, operationIntent: operationIntentSchema, profile: shortStringSchema, priority: { type: "integer", minimum: 0, maximum: 100 } },
      required: ["taskId", "operationIntent"], additionalProperties: false
    }
  },
  {
    name: "aeh_operation_start_change",
    description: "Start a durable CHANGE. Supply the original request and version 1 operationIntent with requestedOutcome plus optional constraints/continuation. Preserve commit/push/PR intent in the request; route effects and delivery authority are controller-owned. Returns a compact digest.",
    inputSchema: {
      type: "object",
      properties: {
        request: requestSchema, operationIntent: operationIntentSchema, title: shortStringSchema, taskId: operationIdSchema, files: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" } },
        domains: boundedStringArray, acceptance: boundedStringArray,
        risk: { type: "string", enum: ["low", "medium", "high"] }, profile: shortStringSchema, priority: { type: "integer", minimum: 0, maximum: 100 }
      },
      required: ["request", "operationIntent"], additionalProperties: false
    }
  },
  {
    name: "aeh_informational_context",
    description: "Answer a purely informational repository question with bounded read-only repository context. This never creates an operation, TaskContract, audit report, reviewer, or delivery artifact.",
    inputSchema: {
      type: "object",
      properties: { request: requestSchema },
      required: ["request"], additionalProperties: false
    }
  },
  {
    name: "aeh_informational_evidence",
    description: "Retrieve one explicitly referenced repository evidence range for an informational answer. New refs carry file identity and may add &read=<start>-<end> for a later bounded range. This is lazy, read-only, and operation-free; the compact informational context must be used first.",
    inputSchema: {
      type: "object",
      properties: { evidenceRef: { type: "string", minLength: 1, maxLength: 2_000, pattern: "^repo://.+#sha256=[a-f0-9]{64}(?:&file-sha256=[a-f0-9]{64})?(?:&range=\\d+-\\d+)?(?:&read=\\d+-\\d+)?$" }, maxTokens: { type: "integer", minimum: 1 } },
      required: ["evidenceRef"], additionalProperties: false
    }
  },
  {
    name: "aeh_operation_digest",
    description: "Read a compact, read-only operation digest: status, phase, revision, participant counts, supervisor state, attention and result references. Use this for normal lead inspection instead of the full OperationRecord.",
    inputSchema: { type: "object", properties: { operationId: operationIdSchema }, required: ["operationId"], additionalProperties: false }
  },
  {
    name: "aeh_operation_status",
    description: "Read operation status without acknowledging it. Default detail=compact returns the same bounded digest as aeh_operation_digest. Use detail=full only for exceptional diagnostics or one-time terminal result inspection; it returns the authoritative OperationRecord.",
    inputSchema: {
      type: "object",
      properties: { operationId: operationIdSchema, detail: { type: "string", enum: ["compact", "full"] } },
      required: ["operationId"], additionalProperties: false
    }
  },
  {
    name: "aeh_operation_recover_participant",
    description: "As the bound Lead, continue or resume one participant or request a controller-owned rotation/replan/split/reassignment under the frozen Owner policy. Requires an exact binding digest and current durable activity evidence; it cannot widen policy or exceed an Owner hard boundary.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["operationId", "participantId", "executionBindingDigest", "action", "evidenceIds", "reason"],
      properties: {
        operationId: operationIdSchema, participantId: operationIdSchema, executionBindingDigest: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" },
        action: { enum: ["CONTINUE", "RESUME_SAME_SESSION", "RETRY_PARTICIPANT", "ROTATE_SESSION", "REPLAN", "SPLIT_WORK", "REASSIGN", "FAIL"] }, evidenceIds: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" } },
        reason: { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" }
      }
    }
  },
  {
    name: "aeh_operation_ack",
    description: "Acknowledge exactly one current durable operation revision as the bound interactive lead without reading the full OperationRecord. Use after consuming a blocked/terminal continuation event; never use as a progress poll.",
    inputSchema: {
      type: "object",
      properties: { operationId: operationIdSchema, revision: { type: "integer", minimum: 1 } },
      required: ["operationId", "revision"], additionalProperties: false
    }
  },
  {
    name: "aeh_operation_portfolio",
    description: "Read the compact project operation portfolio used by the thin lead to manage multiple concurrent supervised operations without multiplexing child timelines.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "aeh_operation_cancel",
    description: "Cancel an AEH operation and return its compact terminal digest. The detached liveness monitor owns eventual lead continuation/recovery.",
    inputSchema: { type: "object", properties: { operationId: operationIdSchema }, required: ["operationId"], additionalProperties: false }
  },
  {
    name: "aeh_context_status",
    description: "Read the managed lead's canonical Paseo AgentSnapshot context usage. No agentId is required for a normal managed lead; durable lead-session identity is used when the MCP host does not propagate PASEO_AGENT_ID.",
    inputSchema: { type: "object", properties: { agentId: shortStringSchema }, additionalProperties: false }
  }
] as const;

export async function serveOperationMcp(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request: OperationMcpRequest;
    try { request = JSON.parse(line) as OperationMcpRequest; } catch { continue; }
    if (request.id === undefined || request.id === null) continue;
    try { write({ jsonrpc: "2.0", id: request.id, result: await handleOperationMcpRequest(request) }); }
    catch (error) { write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); }
  }
}

export async function handleOperationMcpRequest(request: OperationMcpRequest): Promise<Record<string, unknown>> {
  if (request.method === "initialize") {
    return {
      protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "aeh-operation-controller", version: "7" }
    };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools: operationMcpTools };
  if (request.method === "tools/call") {
    const params = request.params ?? {};
    const requestEventId = request.id === undefined || request.id === null ? undefined : randomUUID();
    try { return await callTool(params, requestEventId); }
    catch (error) { return operationToolError(error, params, requestEventId); }
  }
  throw new Error(`Unsupported MCP method: ${request.method ?? "<missing>"}`);
}

async function callTool(params: Record<string, unknown>, requestEventId?: string): Promise<Record<string, unknown>> {
  const name = string(params.name, "tool name");
  const args = object(params.arguments);
  const root = controlRoot();

  if (name === "aeh_operation_start_audit") {
    const payload: AuditOperationPayload = {
      request: string(args.request, "request", 50_000), files: stringArray(args.files, "files", { maxItems: 100, maxLength: 500 }), domains: stringArray(args.domains, "domains"), risk: risk(args.risk), reviewers: stringArray(args.reviewers, "reviewers", { maxItems: 32, maxLength: 200 })
    };
    return digestToolResult(await startManagedOperation(root, "audit", payload, args.operationIntent, requestEventId));
  }
  if (name === "aeh_operation_start_run") {
    const payload: RunOperationPayload = {
      taskId: string(args.taskId, "taskId", 200), profile: optionalString(args.profile, "profile", 200), priority: priority(args.priority)
    };
    return digestToolResult(await startManagedOperation(root, "run", payload, args.operationIntent, requestEventId));
  }
  if (name === "aeh_operation_start_change") {
    const payload: ChangeOperationPayload = {
      request: string(args.request, "request", 50_000), title: optionalString(args.title, "title", 200), taskId: optionalString(args.taskId, "taskId", 200), files: stringArray(args.files, "files", { maxItems: 100, maxLength: 500 }),
      domains: stringArray(args.domains, "domains"), acceptance: stringArray(args.acceptance, "acceptance"), risk: risk(args.risk), profile: optionalString(args.profile, "profile", 200), priority: priority(args.priority)
    };
    return digestToolResult(await startManagedOperation(root, "change", payload, args.operationIntent, requestEventId));
  }
  if (name === "aeh_informational_context") {
    const request = string(args.request, "request", 50_000);
    const config = await loadProjectConfig(root);
    const answer = await answerInformationalRequest(root, config, request);
    return operationToolResult(answer, "Bounded repository-grounded informational answer available in structuredContent.");
  }
  if (name === "aeh_informational_evidence") {
    const result = await retrieveInformationalEvidence(root, string(args.evidenceRef, "evidenceRef", 2_000), args.maxTokens === undefined ? undefined : integer(args.maxTokens, "maxTokens"));
    // The raw excerpt belongs in MCP text only when explicitly requested. The
    // structured side carries metadata and never repeats the excerpt.
    return { content: [{ type: "text", text: result.content }], structuredContent: { status: "OK", ref: result.ref, path: result.path, sha256: result.sha256, ...(result.fileSha256 ? { fileSha256: result.fileSha256 } : {}), estimatedTokens: result.estimatedTokens, truncated: result.truncated, ...(result.range ? { range: result.range } : {}), ...(result.selectedRange ? { selectedRange: result.selectedRange } : {}) } };
  }
  if (name === "aeh_operation_digest") {
    const digest = await readOperationDigest(root, string(args.operationId, "operationId", 200));
    return operationToolResult(digest, operationDigestText(digest));
  }
  if (name === "aeh_operation_status") {
    const operationId = string(args.operationId, "operationId", 200);
    const detail = statusDetail(args.detail);
    const status = await readOperationStatus(root, operationId, detail);
    if (detail === "full") return operationToolResult(status, `${operationId} full diagnostic OperationRecord available in structuredContent.`);
    return operationToolResult(status, operationDigestText(status as OperationDigest));
  }
  if (name === "aeh_operation_recover_participant") {
    const operationId = string(args.operationId, "operationId", 200);
    const participantId = string(args.participantId, "participantId", 200);
    const expectedBindingDigest = string(args.executionBindingDigest, "executionBindingDigest", 64);
    if (!/^[a-f0-9]{64}$/.test(expectedBindingDigest)) throw new OperationMcpInputError("executionBindingDigest", "must be a SHA-256 digest.");
    const action = string(args.action, "action", 100);
    const allowedLeadRecoveryActions = ["CONTINUE", "RESUME_SAME_SESSION", "RETRY_PARTICIPANT", "ROTATE_SESSION", "REPLAN", "SPLIT_WORK", "REASSIGN", "FAIL"] as const;
    if (!allowedLeadRecoveryActions.includes(action as (typeof allowedLeadRecoveryActions)[number])) throw createTrustedOperationToolError("LEAD_RECOVERY_ACTION_INVALID", "action is not in the bounded Lead recovery contract.");
    const reason = string(args.reason, "reason", 2_000);
    if (reason.length > 2_000) throw createTrustedOperationToolError("LEAD_RECOVERY_REASON_INVALID", "reason exceeds 2000 characters.");
    const evidenceIds = stringArray(args.evidenceIds, "evidenceIds", { minItems: 1, maxItems: 12, maxLength: 500 });
    if (!evidenceIds) throw new OperationMcpInputError("evidenceIds", "is required.");
    if (evidenceIds.length === 0 || evidenceIds.length > 12) throw createTrustedOperationToolError("LEAD_RECOVERY_EVIDENCE_REQUIRED", "cite between 1 and 12 current activity events.");
    const operation = await loadOperationForTool(root, operationId);
    const actor = await resolveContextAgentIdentity(root);
    if (!operation.lead?.agentId || actor.agentId !== operation.lead.agentId) throw createTrustedOperationToolError("LEAD_RECOVERY_AUTHORITY_DENIED", "Only the current bound Lead may recover a participant at Lead authority.", undefined, operation.id);
    const participant = operation.participants[participantId];
    const binding = participant?.executionBinding;
    if (!participant || !binding || binding.digest !== expectedBindingDigest) throw createTrustedOperationToolError("LEAD_RECOVERY_BINDING_STALE", "participant binding differs from the cited execution identity.", undefined, operation.id);
    if (action === "RESUME_SAME_SESSION" || action === "RETRY_PARTICIPANT") await assertSameSessionResumeCompatibleV1(root, operation, participantId);
    const cited = (await readExecutionActivityEventsV1(root, operationId)).filter((event) => evidenceIds.includes(event.eventId));
    if (cited.length !== new Set(evidenceIds).size || cited.some((event) => event.participantId !== participantId || event.participantGeneration !== binding.participantGeneration || event.executionBindingDigest !== binding.digest || event.candidateDigest !== binding.candidateDigest || event.policyDigest !== binding.operationPolicyDigest || event.controllerEpoch !== binding.controllerEpoch || event.sessionId !== binding.runtime.sessionId)) throw createTrustedOperationToolError("LEAD_RECOVERY_EVIDENCE_STALE", "cited evidence does not match the current participant binding.", undefined, operation.id);
    const decision = await decideParticipantRecoveryV1(root, {
      operationId, participantId, actorRole: "LEAD", actorSessionId: actor.agentId, action: action as (typeof allowedLeadRecoveryActions)[number],
      expectedBindingDigest, evidenceIds, reason
    });
    const participantTurn = action === "RESUME_SAME_SESSION" || action === "RETRY_PARTICIPANT"
      ? await dispatchSameSessionResumeV1(root, operationId, participantId, expectedBindingDigest, [], {}, action, { role: "LEAD", sessionId: actor.agentId })
      : "NOT_REQUESTED" as const;
    await recordPaseoTrace(root, "operation.participant.lead-recovery", { operationId, participantId, action, bindingDigest: binding.digest, evidenceDigest: sha256Canonical([...new Set(evidenceIds)].sort()), decisionDigest: decision.digest, reasonDigest: sha256Canonical(reason) });
    return operationToolResult({ operationId, participantId, action, decision, participantTurn, application: decision.application }, `${action} recorded by the bound Lead under the frozen economic and liveness envelope; controller applies any replan or rotation request.`);
  }
  if (name === "aeh_operation_ack") {
    const acknowledgement = await acknowledgeOperationRevision(root, string(args.operationId, "operationId", 200), integer(args.revision, "revision"));
    return operationToolResult(acknowledgement, `${acknowledgement.operationId} acknowledged revision ${acknowledgement.acknowledgedRevision}.`);
  }
  if (name === "aeh_operation_portfolio") {
    const config = await loadProjectConfig(root);
    const identity = await resolveContextAgentIdentity(root).catch(() => undefined);
    const currentUserTurnId = identity ? await readPaseoUserTurnId(root, identity.agentId).catch(() => undefined) : undefined;
    const portfolio = await loadOperationPortfolio(root, config.project.name, {
      ...(identity ? { currentLeadAgentId: identity.agentId } : {}),
      ...(currentUserTurnId ? { currentUserTurnId } : {}),
      ownerBoundaryScope: config.orchestration?.operations?.ownerBoundaryScope ?? "CHAIN_SCOPED_BOUNDARY"
    });
    return operationToolResult(portfolio, `${portfolio.project} operation portfolio: ${Object.keys(portfolio.operations).length} tracked operation(s).`);
  }
  if (name === "aeh_operation_cancel") {
    const operationId = string(args.operationId, "operationId", 200);
    await loadOperationForTool(root, operationId);
    return digestToolResult(await cancelOperation(root, operationId));
  }
  if (name === "aeh_context_status") {
    const identity = await resolveContextAgentIdentity(root, optionalString(args.agentId, "agentId", 200));
    await recordPaseoTrace(root, "context.identity", { agentId: identity.agentId, source: identity.source });
    const config = await loadProjectConfig(root);
    return operationToolResult(await statusLeadContext(root, config, identity.agentId), `Context status for ${identity.agentId} available in structuredContent.`);
  }
  throw new Error(`Unknown AEH operation tool '${name}'.`);
}

export async function readOperationDigest(root: string, operationId: string): Promise<OperationDigest> {
  return buildOperationDigest(await loadOperationForTool(root, operationId));
}

export async function readOperationStatus(root: string, operationId: string, detail: OperationStatusDetail = "compact"): Promise<OperationDigest | OperationRecordV2> {
  const operation = await loadOperationForTool(root, operationId);
  return detail === "full" ? operation : buildOperationDigest(operation);
}

async function loadOperationForTool(root: string, operationId: string): Promise<OperationRecordV2> {
  if (!/^[A-Za-z0-9._-]+$/.test(operationId)) throw new OperationMcpInputError("operationId", "must contain only letters, numbers, dots, underscores, or hyphens.");
  const file = path.resolve(root, ".harness", "operations", `${operationId}.json`);
  try {
    await fs.stat(file);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      throw createTrustedOperationToolError("OPERATION_NOT_FOUND", "The requested operation does not exist.");
    }
    throw error;
  }
  return loadOperation(root, operationId);
}

export async function acknowledgeOperationRevision(
  root: string,
  operationId: string,
  revision: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ operationId: string; acknowledgedRevision: number; currentRevision: number; currentRevisionAcknowledged: boolean }> {
  const operation = await loadOperationForTool(root, operationId);
  const boundedAgent = env.AEH_MANAGED_AGENT === "1" && env.AEH_INTERACTIVE_LEAD !== "1";
  if (boundedAgent) throw createTrustedOperationToolError("OPERATION_ACK_WRONG_LEAD", "Only the bound interactive lead may acknowledge an operation revision.", undefined, operation.id);
  const identity = await resolveContextAgentIdentity(root, undefined, env);
  if (!operation.lead?.agentId || identity.agentId !== operation.lead.agentId) {
    throw createTrustedOperationToolError("OPERATION_ACK_WRONG_LEAD", "The caller is not the bound Lead for this operation.", undefined, operation.id);
  }
  if (revision !== operation.revision) {
    throw createTrustedOperationToolError("AEH_OPERATION_ACK_REVISION_MISMATCH", "The requested revision is not current.", undefined, operation.id);
  }
  const acknowledged = await acknowledgeOperationLead(root, operationId, revision, identity.agentId, currentControllerEpoch(operation), "operation-ack");
  const acknowledgedRevision = acknowledged.lead?.acknowledgedRevision ?? 0;
  return {
    operationId,
    acknowledgedRevision,
    currentRevision: acknowledged.revision,
    currentRevisionAcknowledged: acknowledgedRevision >= acknowledged.revision
  };
}

async function startManagedOperation(root: string, kind: OperationKind, payload: OperationPayload, operationIntent: unknown, requestEventId?: string) {
  const route = kind === "audit" ? "audit" : kind === "change" ? "change" : "run";
  // Validate caller-owned semantic fields before querying runtime state or creating any operation.
  intentDecisionFromLeadOperationIntent(route, operationIntent);
  const identity = await resolveContextAgentIdentity(root);
  const userTurnId = await trustedLeadUserTurnId(root, identity.agentId);
  const decision = intentDecisionFromLeadOperationIntent(route, operationIntent, userTurnId);
  const operationPayload = { ...payload, intentDecision: decision } as OperationPayload;
  await recordPaseoTrace(root, "operation.lead.target", { kind, agentId: identity.agentId, source: identity.source });
  const record = await startDetachedOperation(root, kind, operationPayload, {
    nodeExecutable: process.execPath,
    entryFile: path.resolve(process.argv[1]),
    completionAgentId: identity.agentId,
    completionSource: identity.source,
    initiator: { kind: "LEAD", agentId: identity.agentId, userTurnId, ...(requestEventId ? { requestEventId: `${identity.agentId}:jsonrpc:${requestEventId}` } : {}) }
  });
  await spawnOperationMonitor(root, record, {
    nodeExecutable: process.execPath,
    entryFile: path.resolve(process.argv[1])
  });
  return record;
}

async function trustedLeadUserTurnId(root: string, agentId: string): Promise<string> {
  const timestamp = await readPaseoUserTurnId(root, agentId);
  if (!timestamp) {
    throw createTrustedOperationToolError("OPERATION_LEAD_USER_TURN_UNAVAILABLE", "Paseo did not provide a host-owned lastUserMessageAt for this Lead session.");
  }
  return timestamp;
}

async function readPaseoUserTurnId(root: string, agentId: string): Promise<string | undefined> {
  const snapshot = await inspectPaseoNativeAgent(root, agentId);
  const timestamp = snapshot?.lastUserMessageAt;
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return undefined;
  return `paseo-user-turn:${agentId}:${timestamp}`;
}

export async function resolveContextAgentIdentity(
  root: string,
  explicitAgentId?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ContextAgentIdentity> {
  const explicit = safeOptionalString(explicitAgentId);
  if (explicit) return { agentId: explicit, source: "argument" };
  const environment = safeOptionalString(env.PASEO_AGENT_ID);
  if (environment) return { agentId: environment, source: "environment" };

  const absoluteRoot = path.resolve(root);
  const config = await loadProjectConfig(absoluteRoot);
  const stateDir = path.resolve(absoluteRoot, config.orchestration?.interactive?.stateDir ?? ".harness/paseo");
  const stateFile = path.join(stateDir, "lead-session.json");
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(stateFile, "utf8")); }
  catch (error) {
    throw new Error(`AEH could not resolve the current managed lead agent: neither an explicit agentId nor PASEO_AGENT_ID is available, and ${stateFile} could not be read as durable lead state. Start a fresh managed lead with aeh start or pass agentId explicitly for diagnostics. (${error instanceof Error ? error.message : String(error)})`);
  }

  const state = object(value);
  const agentId = safeOptionalString(state.agentId);
  const projectRoot = safeOptionalString(state.projectRoot);
  const projectName = safeOptionalString(state.projectName);
  const aehVersion = safeOptionalString(state.aehVersion);
  const version = typeof state.version === "number" ? state.version : undefined;
  const bootstrapVersion = typeof state.bootstrapVersion === "number" ? state.bootstrapVersion : undefined;
  const mismatches: string[] = [];
  if (version !== 2) mismatches.push(`state version ${String(version ?? "missing")} != 2`);
  if (bootstrapVersion !== PASEO_BOOTSTRAP_VERSION) mismatches.push(`bootstrap ${String(bootstrapVersion ?? "missing")} != ${PASEO_BOOTSTRAP_VERSION}`);
  if (aehVersion !== VERSION) mismatches.push(`AEH ${aehVersion ?? "missing"} != ${VERSION}`);
  if (!projectRoot || path.resolve(projectRoot) !== absoluteRoot) mismatches.push("project root does not match AEH_CONTROL_ROOT");
  if (projectName !== config.project.name) mismatches.push(`project ${projectName ?? "missing"} != ${config.project.name}`);
  if (!agentId) mismatches.push("agentId is missing");
  if (mismatches.length) throw new Error(`AEH refused incompatible durable lead state at ${stateFile}: ${mismatches.join("; ")}. Start a fresh managed lead with aeh start or pass agentId explicitly for diagnostics.`);
  return { agentId: agentId!, source: "lead-state" };
}

function digestToolResult(operation: OperationRecordV2): Record<string, unknown> {
  const digest = buildOperationDigest(operation);
  return operationToolResult(digest, operationDigestText(digest));
}
export function operationToolResult(value: unknown, text = "AEH tool result available in structuredContent."): Record<string, unknown> {
  const structuredContent = value && typeof value === "object" && !Array.isArray(value) ? value : { value };
  return { content: [{ type: "text", text }], structuredContent };
}

async function operationToolError(error: unknown, params: Record<string, unknown>, requestEventId?: string): Promise<Record<string, unknown>> {
  const name = typeof params.name === "string" ? params.name : "";
  const args = object(params.arguments);
  if (error instanceof InvalidIntentDecisionError) markTrustedOperationToolError(error, "INVALID_INTENT_DECISION");
  const extractedCode = allowlistedOperationToolErrorCode(error);
  let code = extractedCode ?? "OPERATION_TOOL_CALL_FAILED";
  const controlRootPath = controlRoot();
  const callerAgentId = isOperationStartTool(name) && requestEventId
    ? safeOptionalString(process.env.PASEO_AGENT_ID) ?? (await resolveContextAgentIdentity(controlRootPath).catch(() => undefined))?.agentId
    : undefined;
  const createdOperationId = callerAgentId && requestEventId
    ? await operationCreatedForRequest(controlRootPath, callerAgentId, requestEventId)
    : undefined;
  if (createdOperationId && isOperationStartTool(name) && !extractedCode) code = "OPERATION_START_FAILED_AFTER_CREATE";
  const diagnosticError = code === "OPERATION_START_FAILED_AFTER_CREATE" && !extractedCode
    ? createTrustedOperationToolError(code, "Operation start failed after durable creation.", error)
    : error;
  const relatedOperationId = createdOperationId ?? trustedOperationToolErrorRelatedId(error);
  const operationCreated = createdOperationId !== undefined;
  const publicCode = code;
  const errorPath = error instanceof OperationMcpInputError
    ? safeInputPath(error.path)
    : undefined;
  const structuredRelatedOperationId = isOperationStartTool(name) && createdOperationId ? createdOperationId : relatedOperationId;
  const baseMetadata = structuredOperationError(publicCode, structuredRelatedOperationId, operationCreated);
  const operationMetadata = operationCreated && isOperationStartTool(name)
    ? { ...baseMetadata, relationship: "CURRENT_OPERATION" as const }
    : baseMetadata;
  const diagnosticRef = requestEventId
    ? await persistOperationToolDiagnosticV2({ root: controlRootPath, requestCorrelationId: requestEventId, tool: name, error: diagnosticError }).catch(() => undefined)
    : undefined;
  const metadata = {
    ...(operationMetadata.category === "INPUT_CONTRACT" && errorPath ? { ...operationMetadata, path: errorPath } : operationMetadata),
    ...(diagnosticRef ? { diagnosticRef } : {})
  };
  const humanText = operationErrorText(metadata);
  return { content: [{ type: "text", text: humanText }], structuredContent: metadata, isError: true };
}

function structuredOperationError(code: string, relatedOperationId: string | undefined, operationCreated: boolean): OperationToolErrorV1 {
  const common = { version: 1 as const, code, operationCreated, ...(relatedOperationId ? { relatedOperationId } : {}) };
  if (code === "INVALID_INTENT_DECISION" || code === "OPERATION_INPUT_INVALID") {
    return { ...common, category: "INPUT_CONTRACT", ...(code === "INVALID_INTENT_DECISION" ? { path: "operationIntent" } : {}), recoverable: true, retryDisposition: "CORRECT_INPUT", requiresHuman: false, relationship: "NONE", nextActions: ["Correct only the reported Lead-owned input field, then retry this call."], skillRef: "aeh-operation-control#START" };
  }
  if (code === "OPERATION_RECOVERY_PARENT_REQUIRED" || code === "OPERATION_RECOVERY_PARENT_NOT_LEAF" || code === "OPERATION_RECOVERY_PARENT_NOT_FAILED") {
    return { ...common, category: "CHAIN_LINEAGE", path: "operationIntent.continuation.operationId", recoverable: true, retryDisposition: "CONTINUE_LINKED_OPERATION", requiresHuman: false, relationship: "CONTINUATION_RELEVANT", nextActions: ["If this is the same failed task, retry with its exact current failed-leaf operationId in operationIntent.continuation.operationId.", "If this is a new Owner request, confirm it is a distinct user turn with a distinct task identity and do not acknowledge unrelated history."], skillRef: "aeh-operation-control#CONTINUATION" };
  }
  if (code === "OPERATION_RECOVERY_OWNER_BOUNDARY" || code === "OPERATION_RECOVERY_OWNER_BOUNDARY_REQUIRED" || code === "OPERATION_RECOVERY_BUDGET_EXHAUSTED" || code === "OPERATION_RECOVERY_AUTHORITY_MISSING" || code === "PROJECT_OR_OWNER_GLOBAL_BOUNDARY_STILL_WAITING" || code === "OPERATION_OWNER_BOUNDARY_STILL_WAITING") {
    return { ...common, category: "OWNER_BOUNDARY", recoverable: false, retryDisposition: "ESCALATE_TO_OWNER", requiresHuman: true, relationship: "OWNER_ATTENTION", nextActions: ["Do not retry the same chain or widen its budget/deadline.", "Present the exact related boundary and wait for the required Owner decision."], skillRef: "aeh-operation-control#OWNER_BOUNDARIES" };
  }
  if (code === "OPERATION_HARD_DEADLINE_NOT_REACHED" || code === "OPERATION_LEAD_USER_TURN_UNAVAILABLE") {
    return { ...common, category: "CONTROLLER_STATE", recoverable: code === "OPERATION_LEAD_USER_TURN_UNAVAILABLE", retryDisposition: code === "OPERATION_LEAD_USER_TURN_UNAVAILABLE" ? "RETRY_AFTER_CONTROLLER_RECOVERY" : "DO_NOT_RETRY", requiresHuman: false, relationship: "HISTORICAL_UNRELATED", nextActions: ["Do not repeat the start call as a debugging loop.", "Inspect the compact portfolio and report this controller-state failure for deterministic recovery."], skillRef: "aeh-operation-control#RECOVERY" };
  }
  if (code === "OPERATION_START_FAILED_AFTER_CREATE") {
    return { ...common, category: "CONTROLLER_STATE", path: "operationId", recoverable: false, retryDisposition: "DO_NOT_RETRY", requiresHuman: false, relationship: "CURRENT_OPERATION", nextActions: ["Do not repeat start; inspect the related operation's compact status and recover from its durable state."], skillRef: "aeh-operation-control#RECOVERY" };
  }
  if (code === "OPERATION_NOT_FOUND") {
    return { ...common, category: "NOT_FOUND", path: "operationId", recoverable: false, retryDisposition: "DO_NOT_RETRY", requiresHuman: false, relationship: "NONE", nextActions: ["Check the operationId in the compact portfolio before retrying."], skillRef: "aeh-operation-control#STATUS" };
  }
  if (code === "OPERATION_ACK_WRONG_LEAD") {
    return { ...common, code: "OPERATION_ACK_WRONG_LEAD", category: "AUTHORITY", recoverable: false, retryDisposition: "DO_NOT_RETRY", requiresHuman: false, relationship: "BOUND_OTHER_LEAD", nextActions: ["Do not retry ACK from this Lead.", "Treat an unbound historical operation as unrelated unless the Owner request explicitly continues it."], skillRef: "aeh-operation-control#ACK" };
  }
  if (code === "AEH_OPERATION_CAPACITY") {
    return { ...common, category: "CAPACITY", recoverable: true, retryDisposition: "WAIT_FOR_CAPACITY", requiresHuman: false, relationship: "NONE", nextActions: ["Inspect the compact portfolio and retry after configured capacity is available."], skillRef: "aeh-operation-control#PORTFOLIO" };
  }
  if (code === "AEH_OPERATION_ACK_REVISION_MISMATCH") {
    return { ...common, category: "CONTROLLER_STATE", path: "revision", recoverable: true, retryDisposition: "RETRY_AFTER_CONTROLLER_RECOVERY", requiresHuman: false, relationship: "CONTINUATION_RELEVANT", nextActions: ["Read the compact digest and retry ACK with its exact current revision."], skillRef: "aeh-operation-control#ACK" };
  }
  if (code === "LEAD_RECOVERY_AUTHORITY_DENIED") {
    return { ...common, category: "AUTHORITY", recoverable: false, retryDisposition: "DO_NOT_RETRY", requiresHuman: false, relationship: "BOUND_OTHER_LEAD", nextActions: ["Do not retry recovery from this Lead; use the bound Lead session or treat the operation as historical."], skillRef: "aeh-operation-control#RECOVERY" };
  }
  if (["LEAD_RECOVERY_ACTION_INVALID", "LEAD_RECOVERY_REASON_INVALID", "LEAD_RECOVERY_EVIDENCE_REQUIRED", "SUPERVISOR_RECOVERY_ACTION_REQUIRED", "SUPERVISOR_RECOVERY_EVIDENCE_REQUIRED"].includes(code)) {
    return { ...common, category: "INPUT_CONTRACT", recoverable: true, retryDisposition: "CORRECT_INPUT", requiresHuman: false, relationship: relatedOperationId ? "CURRENT_OPERATION" : "NONE", nextActions: ["Correct the recovery action, reason, or cited current evidence, then retry against the same operation."], skillRef: "aeh-operation-control#RECOVERY" };
  }
  if (["LEAD_RECOVERY_BINDING_STALE", "LEAD_RECOVERY_EVIDENCE_STALE", "SAME_SESSION_RESUME_REJECTED", "SUPERVISOR_RECOVERY_STATE_STALE", "SUPERVISOR_RECOVERY_BINDING_STALE", "SUPERVISOR_RECOVERY_EVIDENCE_STALE", "AEH_OPERATION_ACK_EPOCH_MISMATCH"].includes(code)) {
    return { ...common, category: "CONTROLLER_STATE", recoverable: true, retryDisposition: "RETRY_AFTER_CONTROLLER_RECOVERY", requiresHuman: false, relationship: relatedOperationId ? "CURRENT_OPERATION" : "NONE", nextActions: ["Re-read the operation digest and current participant or controller binding; retry only after deterministic recovery with current evidence."], skillRef: "aeh-operation-control#RECOVERY" };
  }
  if (code === "AEH_OPERATION_ACK_ACTOR_MISMATCH") {
    return { ...common, category: "AUTHORITY", recoverable: false, retryDisposition: "DO_NOT_RETRY", requiresHuman: false, relationship: relatedOperationId ? "BOUND_OTHER_LEAD" : "NONE", nextActions: ["Do not retry ACK from this Lead; use the currently bound Lead session."], skillRef: "aeh-operation-control#ACK" };
  }
  return { ...common, category: "INTERNAL", recoverable: false, retryDisposition: "DO_NOT_RETRY", requiresHuman: false, relationship: relatedOperationId ? "CONTINUATION_RELEVANT" : "NONE", nextActions: ["Do not repeat the operation start automatically.", "Read the compact operation status or portfolio and surface the error code for deterministic repair."], skillRef: "aeh-operation-control#RECOVERY" };
}

function operationErrorText(error: OperationToolErrorV1): string {
  const summaries: Record<OperationToolErrorV1["category"], string> = {
    INPUT_CONTRACT: "The operation intent does not match the tool contract.",
    CHAIN_LINEAGE: "The request is related to a failed operation chain.",
    OWNER_BOUNDARY: "An Owner boundary requires an explicit decision.",
    AUTHORITY: "This Lead does not own the requested operation action.",
    CONTROLLER_STATE: "The controller could not safely validate its current operation state.",
    CAPACITY: "Configured operation capacity is currently exhausted.",
    NOT_FOUND: "The requested operation was not found.",
    INTERNAL: "The operation tool failed; diagnostic details were omitted."
  };
  return `AEH operation error ${error.code}: ${summaries[error.category]} ${error.nextActions[0] ?? ""}`.trim();
}

function isOperationStartTool(name: string): boolean {
  return name === "aeh_operation_start_audit" || name === "aeh_operation_start_change" || name === "aeh_operation_start_run";
}

function safeInputPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const knownPaths = new Set([
    "executionBindingDigest", "evidenceIds", "request", "taskId", "operationId", "operationIntent", "files", "domains",
    "risk", "reviewers", "title", "acceptance", "profile", "priority", "revision", "agentId", "detail", "limit",
    "since", "runId", "name", "evidenceId"
  ]);
  if (knownPaths.has(value)) return value;
  return /^(?:files|domains|reviewers|acceptance)\[[0-9]+\]$/.test(value) ? value : undefined;
}

async function operationCreatedForRequest(root: string, callerAgentId: string, requestEventId: string): Promise<string | undefined> {
  const directory = path.resolve(root, ".harness", "operations");
  const entries = await fs.readdir(directory).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!/^[A-Z][A-Za-z0-9_-]+\.json$/.test(entry) || entry === "portfolio.json") continue;
    const id = entry.slice(0, -5);
    const operation = await loadOperation(root, id).catch(() => undefined);
    if (operation?.origin?.requestEventId === `${callerAgentId}:jsonrpc:${requestEventId}`) return operation.id;
  }
  return undefined;
}

function controlRoot(): string { return path.resolve(process.env.AEH_CONTROL_ROOT?.trim() || process.cwd()); }
function write(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown, name: string, maxLength = 50_000): string {
  if (typeof value !== "string" || !value.trim()) throw new OperationMcpInputError(name, "must be a non-empty string.");
  if (value.length > maxLength) throw new OperationMcpInputError(name, `must be at most ${maxLength} characters.`);
  return value.trim();
}
function optionalString(value: unknown, name = "value", maxLength = 200): string | undefined {
  return value === undefined ? undefined : string(value, name, maxLength);
}
function safeOptionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }

function stringArray(value: unknown, name: string, limits: { minItems?: number; maxItems?: number; maxLength?: number } = {}): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new OperationMcpInputError(name, "must be an array of strings.");
  const minItems = limits.minItems ?? 0;
  const maxItems = limits.maxItems ?? 64;
  const maxLength = limits.maxLength ?? 500;
  if (value.length < minItems || value.length > maxItems) throw new OperationMcpInputError(name, `must contain between ${minItems} and ${maxItems} items.`);
  return value.map((item, index) => string(item, `${name}[${index}]`, maxLength));
}
function risk(value: unknown): "low" | "medium" | "high" | undefined {
  if (value === undefined) return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new OperationMcpInputError("risk", "must be low, medium, or high.");
}
function priority(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) throw new OperationMcpInputError("priority", "must be an integer from 0 to 100.");
  return value;
}
function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new OperationMcpInputError(name, "must be a positive integer.");
  return value;
}
function statusDetail(value: unknown): OperationStatusDetail { if (value === undefined) return "compact"; if (value === "compact" || value === "full") return value; throw new OperationMcpInputError("detail", "must be compact or full."); }
