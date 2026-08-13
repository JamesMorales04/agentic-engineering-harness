import fs from "node:fs/promises";
import readline from "node:readline";
import path from "node:path";
import process from "node:process";
import { loadProjectConfig } from "../core/config.js";
import { statusLeadContext } from "../paseo/context.js";
import { PASEO_BOOTSTRAP_VERSION } from "../paseo/start.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import { VERSION } from "../version.js";
import { cancelOperation, startDetachedOperation } from "./controller.js";
import { buildOperationDigest, operationDigestText, type OperationDigest } from "./digest.js";
import { rebindActiveOperationsToLead } from "./leadBinding.js";
import { spawnOperationMonitor } from "./monitorProcess.js";
import { loadOperationPortfolio } from "./portfolio.js";
import { acknowledgeOperationLead, loadOperation, type AuditOperationPayload, type ChangeOperationPayload, type OperationKind, type OperationPayload, type OperationRecordV2, type RunOperationPayload } from "./state.js";

interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; }
export type ContextAgentIdentitySource = "argument" | "environment" | "lead-state";
export interface ContextAgentIdentity { agentId: string; source: ContextAgentIdentitySource; }
export type OperationStatusDetail = "compact" | "full";

const tools = [
  {
    name: "aeh_operation_start_audit",
    description: "Start a detached supervised AEH AUDIT and return a compact operation digest. The lead should return idle after start; healthy progress is controller-owned and does not require polling.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string" }, files: { type: "array", items: { type: "string" } }, domains: { type: "array", items: { type: "string" } },
        risk: { type: "string", enum: ["low", "medium", "high"] }, reviewers: { type: "array", items: { type: "string" } }
      },
      required: ["request"], additionalProperties: false
    }
  },
  {
    name: "aeh_operation_start_run",
    description: "Start detached supervised execution of an already prepared/sealed AEH task and return a compact digest. Do not poll healthy progress from the lead.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, profile: { type: "string" }, priority: { type: "number", minimum: 0, maximum: 100 } },
      required: ["taskId"], additionalProperties: false
    }
  },
  {
    name: "aeh_operation_start_change",
    description: "Start a durable CHANGE operation and return a compact digest. The operation controller/supervisor own intermediate progress and recovery.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string" }, title: { type: "string" }, taskId: { type: "string" }, files: { type: "array", items: { type: "string" } },
        domains: { type: "array", items: { type: "string" } }, acceptance: { type: "array", items: { type: "string" } },
        risk: { type: "string", enum: ["low", "medium", "high"] }, profile: { type: "string" }, priority: { type: "number", minimum: 0, maximum: 100 }
      },
      required: ["request"], additionalProperties: false
    }
  },
  {
    name: "aeh_operation_digest",
    description: "Read a compact, read-only operation digest: status, phase, revision, participant counts, supervisor state, attention and result references. Use this for normal lead inspection instead of the full OperationRecord.",
    inputSchema: { type: "object", properties: { operationId: { type: "string" } }, required: ["operationId"], additionalProperties: false }
  },
  {
    name: "aeh_operation_status",
    description: "Read operation status without acknowledging it. Default detail=compact returns the same bounded digest as aeh_operation_digest. Use detail=full only for exceptional diagnostics or one-time terminal result inspection; it returns the authoritative OperationRecord.",
    inputSchema: {
      type: "object",
      properties: { operationId: { type: "string" }, detail: { type: "string", enum: ["compact", "full"] } },
      required: ["operationId"], additionalProperties: false
    }
  },
  {
    name: "aeh_operation_ack",
    description: "Acknowledge exactly one current durable operation revision as the bound interactive lead without reading the full OperationRecord. Use after consuming a blocked/terminal continuation event; never use as a progress poll.",
    inputSchema: {
      type: "object",
      properties: { operationId: { type: "string" }, revision: { type: "number", minimum: 1 } },
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
    inputSchema: { type: "object", properties: { operationId: { type: "string" } }, required: ["operationId"], additionalProperties: false }
  },
  {
    name: "aeh_context_status",
    description: "Read the managed lead's canonical Paseo AgentSnapshot context usage. No agentId is required for a normal managed lead; durable lead-session identity is used when the MCP host does not propagate PASEO_AGENT_ID.",
    inputSchema: { type: "object", properties: { agentId: { type: "string" } }, additionalProperties: false }
  }
] as const;

export async function serveOperationMcp(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request: JsonRpcRequest;
    try { request = JSON.parse(line) as JsonRpcRequest; } catch { continue; }
    if (request.id === undefined || request.id === null) continue;
    try { write({ jsonrpc: "2.0", id: request.id, result: await handle(request) }); }
    catch (error) { write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); }
  }
}

async function handle(request: JsonRpcRequest): Promise<Record<string, unknown>> {
  if (request.method === "initialize") {
    return {
      protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "aeh-operation-controller", version: "5" }
    };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools };
  if (request.method === "tools/call") return callTool(request.params ?? {});
  throw new Error(`Unsupported MCP method: ${request.method ?? "<missing>"}`);
}

async function callTool(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const name = string(params.name, "tool name");
  const args = object(params.arguments);
  const root = controlRoot();

  if (name === "aeh_operation_start_audit") {
    const payload: AuditOperationPayload = {
      request: string(args.request, "request"), files: stringArray(args.files), domains: stringArray(args.domains), risk: risk(args.risk), reviewers: stringArray(args.reviewers)
    };
    return digestToolResult(await startManagedOperation(root, "audit", payload));
  }
  if (name === "aeh_operation_start_run") {
    const payload: RunOperationPayload = {
      taskId: string(args.taskId, "taskId"), profile: optionalString(args.profile), priority: priority(args.priority)
    };
    return digestToolResult(await startManagedOperation(root, "run", payload));
  }
  if (name === "aeh_operation_start_change") {
    const payload: ChangeOperationPayload = {
      request: string(args.request, "request"), title: optionalString(args.title), taskId: optionalString(args.taskId), files: stringArray(args.files),
      domains: stringArray(args.domains), acceptance: stringArray(args.acceptance), risk: risk(args.risk), profile: optionalString(args.profile), priority: priority(args.priority)
    };
    return digestToolResult(await startManagedOperation(root, "change", payload));
  }
  if (name === "aeh_operation_digest") {
    const digest = await readOperationDigest(root, string(args.operationId, "operationId"));
    return operationToolResult(digest, operationDigestText(digest));
  }
  if (name === "aeh_operation_status") {
    const operationId = string(args.operationId, "operationId");
    const detail = statusDetail(args.detail);
    const status = await readOperationStatus(root, operationId, detail);
    if (detail === "full") return operationToolResult(status, `${operationId} full diagnostic OperationRecord available in structuredContent.`);
    return operationToolResult(status, operationDigestText(status as OperationDigest));
  }
  if (name === "aeh_operation_ack") {
    const acknowledgement = await acknowledgeOperationRevision(root, string(args.operationId, "operationId"), integer(args.revision, "revision"));
    return operationToolResult(acknowledgement, `${acknowledgement.operationId} acknowledged revision ${acknowledgement.acknowledgedRevision}.`);
  }
  if (name === "aeh_operation_portfolio") {
    const config = await loadProjectConfig(root);
    const portfolio = await loadOperationPortfolio(root, config.project.name);
    return operationToolResult(portfolio, `${portfolio.project} operation portfolio: ${Object.keys(portfolio.operations).length} tracked operation(s).`);
  }
  if (name === "aeh_operation_cancel") return digestToolResult(await cancelOperation(root, string(args.operationId, "operationId")));
  if (name === "aeh_context_status") {
    const identity = await resolveContextAgentIdentity(root, optionalString(args.agentId));
    await recordPaseoTrace(root, "context.identity", { agentId: identity.agentId, source: identity.source });
    const config = await loadProjectConfig(root);
    await rebindActiveOperationsToLead(root, config, identity.agentId, identity.source).catch(() => undefined);
    return operationToolResult(await statusLeadContext(root, config, identity.agentId), `Context status for ${identity.agentId} available in structuredContent.`);
  }
  throw new Error(`Unknown AEH operation tool '${name}'.`);
}

export async function readOperationDigest(root: string, operationId: string): Promise<OperationDigest> {
  return buildOperationDigest(await loadOperation(root, operationId));
}

export async function readOperationStatus(root: string, operationId: string, detail: OperationStatusDetail = "compact"): Promise<OperationDigest | OperationRecordV2> {
  const operation = await loadOperation(root, operationId);
  return detail === "full" ? operation : buildOperationDigest(operation);
}

export async function acknowledgeOperationRevision(
  root: string,
  operationId: string,
  revision: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ operationId: string; acknowledgedRevision: number; currentRevision: number; currentRevisionAcknowledged: boolean }> {
  const operation = await loadOperation(root, operationId);
  const boundedAgent = env.AEH_MANAGED_AGENT === "1" && env.AEH_INTERACTIVE_LEAD !== "1";
  if (boundedAgent) throw new Error("Only the bound interactive lead may acknowledge an operation revision.");
  const identity = await resolveContextAgentIdentity(root, undefined, env);
  if (!operation.lead?.agentId || identity.agentId !== operation.lead.agentId) {
    throw new Error(`Agent ${identity.agentId} is not the bound lead for operation ${operationId}.`);
  }
  if (revision !== operation.revision) {
    throw new Error(`AEH_OPERATION_ACK_REVISION_MISMATCH: requested revision ${revision}, current revision ${operation.revision}. Read the compact digest and acknowledge the exact current revision.`);
  }
  const acknowledged = await acknowledgeOperationLead(root, operationId, revision, "operation-ack");
  const acknowledgedRevision = acknowledged.lead?.acknowledgedRevision ?? 0;
  return {
    operationId,
    acknowledgedRevision,
    currentRevision: acknowledged.revision,
    currentRevisionAcknowledged: acknowledgedRevision >= acknowledged.revision
  };
}

async function startManagedOperation(root: string, kind: OperationKind, payload: OperationPayload) {
  const identity = await resolveContextAgentIdentity(root);
  const config = await loadProjectConfig(root);
  await rebindActiveOperationsToLead(root, config, identity.agentId, identity.source);
  await recordPaseoTrace(root, "operation.lead.target", { kind, agentId: identity.agentId, source: identity.source });
  const record = await startDetachedOperation(root, kind, payload, {
    nodeExecutable: process.execPath,
    entryFile: path.resolve(process.argv[1]),
    completionAgentId: identity.agentId,
    completionSource: identity.source
  });
  await spawnOperationMonitor(root, record, {
    nodeExecutable: process.execPath,
    entryFile: path.resolve(process.argv[1])
  });
  return record;
}

export async function resolveContextAgentIdentity(
  root: string,
  explicitAgentId?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ContextAgentIdentity> {
  const explicit = optionalString(explicitAgentId);
  if (explicit) return { agentId: explicit, source: "argument" };
  const environment = optionalString(env.PASEO_AGENT_ID);
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
  const agentId = optionalString(state.agentId);
  const projectRoot = optionalString(state.projectRoot);
  const projectName = optionalString(state.projectName);
  const aehVersion = optionalString(state.aehVersion);
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
function controlRoot(): string { return path.resolve(process.env.AEH_CONTROL_ROOT?.trim() || process.cwd()); }
function write(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`); return value.trim(); }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function stringArray(value: unknown): string[] | undefined { if (value === undefined) return undefined; if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Expected an array of strings."); return value as string[]; }
function risk(value: unknown): "low" | "medium" | "high" | undefined { if (value === undefined) return undefined; if (value === "low" || value === "medium" || value === "high") return value; throw new Error("risk must be low, medium or high."); }
function priority(value: unknown): number | undefined { if (value === undefined) return undefined; if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) throw new Error("priority must be a number from 0 to 100."); return Math.round(value); }
function integer(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`); return value; }
function statusDetail(value: unknown): OperationStatusDetail { if (value === undefined) return "compact"; if (value === "compact" || value === "full") return value; throw new Error("detail must be compact or full."); }
