import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type OperationKind = "audit" | "run" | "change";
export type OperationStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type OperationStageStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED" | "SKIPPED";
export type OperationParticipantStatus = "REGISTERED" | "IDLE" | "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED" | "CANCELLED";
export type SupervisorGenerationStatus = "ACTIVE" | "DRAINING" | "ARCHIVED" | "FAILED";

export interface AuditOperationPayload { request: string; files?: string[]; domains?: string[]; risk?: "low" | "medium" | "high"; reviewers?: string[]; }
export interface RunOperationPayload { taskId: string; profile?: string; priority?: number; }
export interface ChangeOperationPayload { request: string; title?: string; taskId?: string; files?: string[]; domains?: string[]; acceptance?: string[]; risk?: "low" | "medium" | "high"; profile?: string; priority?: number; }
export type OperationPayload = AuditOperationPayload | RunOperationPayload | ChangeOperationPayload;

export interface OperationAgentRecord { id: string; role?: string; phase?: string; workspaceId?: string; transport?: string; registeredAt: string; }
export interface OperationLeadBinding { agentId: string; source?: string; generation: number; boundAt: string; acknowledgedRevision: number; acknowledgedAt?: string; }
export interface OperationSupervisorGeneration { generation: number; agentId?: string; status: SupervisorGenerationStatus; createdAt: string; activatedAt?: string; drainingAt?: string; archivedAt?: string; checkpointArtifact?: string; contextRatio?: number; error?: string; }
export interface OperationSupervisionState { required: boolean; materialized: boolean; activeGeneration?: number; generations: OperationSupervisorGeneration[]; latestConsolidationRevision?: number; latestConsolidationArtifact?: string; }
export interface OperationStageRecord { name: string; status: OperationStageStatus; revision: number; startedAt?: string; finishedAt?: string; message?: string; artifact?: string; }
export interface OperationParticipantRecord { id: string; logicalAgent?: string; role?: string; stage?: string; phase?: string; parentSupervisorGeneration?: number; parentAgentId?: string; workspaceId?: string; transport?: string; status: OperationParticipantStatus; registeredAt: string; startedAt?: string; finishedAt?: string; resultArtifact?: string; error?: string; }
export interface OperationProgress { expected: number; registered: number; running: number; completed: number; failed: number; blocked: number; }
export interface OperationNotificationState { lastLeadWakeRevision: number; lastLeadWakeAt?: string; lastLeadWakeReason?: string; terminalDelivered: boolean; attempts: number; lastError?: string; }
export interface OperationIntentState { request?: string; classification?: "AUDIT" | "CHANGE" | "RUN"; mode?: "quick" | "spec"; risk?: "low" | "medium" | "high"; priority?: number; }

export interface OperationRecordV1 {
  version: 1; id: string; kind: "audit" | "run"; status: OperationStatus; phase: string; root: string;
  payload: AuditOperationPayload | RunOperationPayload; createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string;
  pid?: number; workspaceId?: string; workspaceWarning?: string; agents?: OperationAgentRecord[]; cleanupWarnings?: string[]; result?: Record<string, unknown>; error?: string;
}
export interface OperationRecordV2 {
  version: 2; id: string; kind: OperationKind; status: OperationStatus; phase: string; root: string; workspaceRoot?: string;
  payload: OperationPayload; revision: number; createdAt: string; updatedAt: string; lastProgressAt: string; startedAt?: string; finishedAt?: string;
  pid?: number; workspaceId?: string; workspaceWarning?: string; intent?: OperationIntentState; lead?: OperationLeadBinding;
  supervision: OperationSupervisionState; stages: Record<string, OperationStageRecord>; participants: Record<string, OperationParticipantRecord>;
  progress: OperationProgress; notification: OperationNotificationState; agents?: OperationAgentRecord[]; cleanupWarnings?: string[]; result?: Record<string, unknown>; error?: string;
}
export type OperationRecord = OperationRecordV1 | OperationRecordV2;
export interface TerminalOperationTransition { record: OperationRecordV2; transitioned: boolean; }
export interface OperationEvent { version: 1; operationId: string; revision: number; at: string; type: string; status: OperationStatus; phase: string; changed?: string[]; details?: Record<string, unknown>; }

const OPERATIONS_DIR = ".harness/operations";
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

export function resolveOperationStateRoot(root: string): string {
  const configured = process.env.AEH_OPERATION_ID?.trim() ? process.env.AEH_CONTROL_ROOT?.trim() : undefined;
  return path.resolve(configured || root);
}
export function operationFile(root: string, operationId: string): string { return path.resolve(resolveOperationStateRoot(root), OPERATIONS_DIR, `${safeId(operationId)}.json`); }
export function operationArtifactDir(root: string, operationId: string): string { return path.resolve(resolveOperationStateRoot(root), OPERATIONS_DIR, safeId(operationId)); }
export function operationEventsFile(root: string, operationId: string): string { return path.join(operationArtifactDir(root, operationId), "events.ndjson"); }

export async function loadOperation(root: string, operationId: string): Promise<OperationRecordV2> {
  return normalizeOperationRecord(JSON.parse(await fs.readFile(operationFile(root, operationId), "utf8")) as OperationRecord);
}
export async function saveOperation(root: string, record: OperationRecord): Promise<void> {
  const normalized = normalizeOperationRecord(record);
  const stateRoot = resolveOperationStateRoot(root);
  const file = operationFile(stateRoot, normalized.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await withOperationLock(file, async () => { await writeRecord(file, normalized); await appendOperationEvent(stateRoot, normalized, "operation.created", ["status", "phase"]); });
}
export async function patchOperation(root: string, operationId: string, patch: Partial<OperationRecordV2>): Promise<OperationRecordV2> { return mutateOperation(root, operationId, patch, true, "operation.updated"); }
export async function patchOperationMetadata(root: string, operationId: string, patch: Partial<OperationRecordV2>): Promise<OperationRecordV2> { return mutateOperation(root, operationId, patch, false, "operation.metadata"); }

export async function transitionOperationToTerminal(root: string, operationId: string, patch: Partial<OperationRecordV2> & { status: "SUCCEEDED" | "FAILED" | "CANCELLED" }): Promise<TerminalOperationTransition> {
  const stateRoot = resolveOperationStateRoot(root); const file = operationFile(stateRoot, operationId); await fs.mkdir(path.dirname(file), { recursive: true });
  return withOperationLock(file, async () => {
    const current = normalizeOperationRecord(JSON.parse(await fs.readFile(file, "utf8")) as OperationRecord);
    if (isTerminal(current.status)) return { record: current, transitioned: false };
    const now = new Date().toISOString(); const revision = current.revision + 1;
    const next = normalizeOperationRecord({ ...current, ...patch, version: 2, id: current.id, kind: current.kind, revision, updatedAt: now, lastProgressAt: now, stages: { ...current.stages, finished: { name: "finished", status: terminalStageStatus(patch.status), revision, startedAt: now, finishedAt: now } } } as OperationRecordV2);
    await writeRecord(file, next); await appendOperationEvent(stateRoot, next, "operation.terminal", ["status", "phase"]); return { record: next, transitioned: true };
  });
}

export async function bindOperationLead(root: string, operationId: string, agentId: string, source?: string): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, true, "operation.lead.bound", (current, revision, now) => ({ ...current, revision, updatedAt: now, lastProgressAt: now, lead: { agentId: requiredId(agentId), source, generation: (current.lead?.generation ?? 0) + 1, boundAt: now, acknowledgedRevision: revision, acknowledgedAt: now }, notification: { ...current.notification, lastLeadWakeRevision: revision, lastLeadWakeAt: now, lastLeadWakeReason: "operation-started" } }));
}
export async function acknowledgeOperationLead(root: string, operationId: string, revision: number, reason?: string): Promise<OperationRecordV2> {
  const current = await loadOperation(root, operationId); const now = new Date().toISOString();
  return patchOperationMetadata(root, operationId, { lead: current.lead ? { ...current.lead, acknowledgedRevision: Math.max(current.lead.acknowledgedRevision, revision), acknowledgedAt: now } : undefined, notification: { ...current.notification, lastLeadWakeRevision: Math.max(current.notification.lastLeadWakeRevision, revision), lastLeadWakeAt: now, lastLeadWakeReason: reason ?? current.notification.lastLeadWakeReason } });
}
export async function markTerminalDelivered(root: string, operationId: string, attempts: number, error?: string): Promise<OperationRecordV2> {
  const current = await loadOperation(root, operationId);
  return patchOperationMetadata(root, operationId, { notification: { ...current.notification, lastLeadWakeRevision: error ? current.notification.lastLeadWakeRevision : current.revision, lastLeadWakeAt: error ? current.notification.lastLeadWakeAt : new Date().toISOString(), lastLeadWakeReason: error ? current.notification.lastLeadWakeReason : "terminal", terminalDelivered: !error, attempts, lastError: error } });
}

export async function setOperationStage(root: string, operationId: string, name: string, status: OperationStageStatus, options: { message?: string; artifact?: string } = {}): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, true, "operation.stage", (current, revision, now) => {
    const previous = current.stages[name]; const terminal = ["COMPLETED", "FAILED", "BLOCKED", "SKIPPED"].includes(status);
    const stage: OperationStageRecord = { name, status, revision, startedAt: previous?.startedAt ?? (status === "RUNNING" ? now : undefined), finishedAt: terminal ? now : undefined, message: options.message ?? previous?.message, artifact: options.artifact ?? previous?.artifact };
    return { ...current, revision, updatedAt: now, lastProgressAt: now, phase: name, stages: { ...current.stages, [name]: stage } };
  });
}

export async function registerSupervisorGeneration(root: string, operationId: string, input: { agentId?: string; materialized: boolean; checkpointArtifact?: string }): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, true, "operation.supervisor.registered", (current, revision, now) => {
    const generations = current.supervision.generations.map((item) => item.status === "ACTIVE" ? { ...item, status: "DRAINING" as const, drainingAt: item.drainingAt ?? now } : item);
    const generation = Math.max(0, ...generations.map((item) => item.generation)) + 1;
    generations.push({ generation, agentId: input.agentId, status: "ACTIVE", createdAt: now, activatedAt: now, checkpointArtifact: input.checkpointArtifact });
    return { ...current, revision, updatedAt: now, lastProgressAt: now, supervision: { ...current.supervision, required: true, materialized: current.supervision.materialized || input.materialized, activeGeneration: generation, generations } };
  });
}
export async function updateSupervisorGeneration(root: string, operationId: string, generation: number, patch: Partial<OperationSupervisorGeneration>): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, true, "operation.supervisor.updated", (current, revision, now) => {
    const generations = current.supervision.generations.map((item) => item.generation === generation ? { ...item, ...patch } : item); const active = generations.find((item) => item.status === "ACTIVE");
    return { ...current, revision, updatedAt: now, lastProgressAt: now, supervision: { ...current.supervision, activeGeneration: active?.generation, generations } };
  });
}
export function activeOperationSupervisor(record: OperationRecordV2): OperationSupervisorGeneration | undefined { const generation = record.supervision.activeGeneration; return generation === undefined ? undefined : record.supervision.generations.find((item) => item.generation === generation && item.status === "ACTIVE"); }

export async function registerOperationAgent(root: string, operationId: string, agent: Omit<OperationAgentRecord, "registeredAt"> & { logicalAgent?: string; parentAgentId?: string; parentSupervisorGeneration?: number }): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, true, "operation.participant.registered", (current, revision, now) => {
    const existingAgents = current.agents ?? []; const previousAgent = existingAgents.find((item) => item.id === agent.id);
    const compatibility: OperationAgentRecord = { ...previousAgent, id: agent.id, role: agent.role ?? previousAgent?.role, phase: agent.phase ?? previousAgent?.phase, workspaceId: agent.workspaceId ?? previousAgent?.workspaceId, transport: agent.transport ?? previousAgent?.transport, registeredAt: previousAgent?.registeredAt ?? now };
    const agents = [...existingAgents.filter((item) => item.id !== agent.id), compatibility]; const logicalAgent = agent.logicalAgent ?? agent.role;
    if (logicalAgent === "operation-supervisor") return { ...current, revision, updatedAt: now, lastProgressAt: now, agents };
    const previous = current.participants[agent.id];
    const participant: OperationParticipantRecord = { ...previous, id: agent.id, logicalAgent: logicalAgent ?? previous?.logicalAgent, role: agent.role ?? previous?.role, stage: agent.phase ?? previous?.stage, phase: agent.phase ?? previous?.phase, parentSupervisorGeneration: agent.parentSupervisorGeneration ?? previous?.parentSupervisorGeneration ?? current.supervision.activeGeneration, parentAgentId: agent.parentAgentId ?? previous?.parentAgentId ?? activeOperationSupervisor(current)?.agentId, workspaceId: agent.workspaceId ?? previous?.workspaceId, transport: agent.transport ?? previous?.transport, status: previous?.status ?? "REGISTERED", registeredAt: previous?.registeredAt ?? now };
    const participants = { ...current.participants, [agent.id]: participant };
    return { ...current, revision, updatedAt: now, lastProgressAt: now, agents, participants, progress: deriveProgress(participants) };
  });
}
export async function updateOperationParticipant(root: string, operationId: string, agentId: string, patch: Partial<Omit<OperationParticipantRecord, "id" | "registeredAt">>): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, true, "operation.participant.updated", (current, revision, now) => {
    const previous = current.participants[agentId] ?? { id: agentId, status: "REGISTERED" as const, registeredAt: now };
    const next: OperationParticipantRecord = { ...previous, ...patch, id: agentId, registeredAt: previous.registeredAt, startedAt: patch.status === "RUNNING" ? previous.startedAt ?? now : patch.startedAt ?? previous.startedAt, finishedAt: ["COMPLETED", "FAILED", "CANCELLED"].includes(patch.status ?? "") ? patch.finishedAt ?? now : patch.finishedAt ?? previous.finishedAt };
    const participants = { ...current.participants, [agentId]: next };
    return { ...current, revision, updatedAt: now, lastProgressAt: now, participants, progress: deriveProgress(participants) };
  });
}
export async function registerCurrentOperationAgent(root: string, agent: Omit<OperationAgentRecord, "registeredAt"> & { logicalAgent?: string; parentAgentId?: string; parentSupervisorGeneration?: number }): Promise<void> { const operationId = currentOperationContext().id; if (!operationId) return; try { await registerOperationAgent(resolveOperationStateRoot(root), operationId, agent); } catch { /* stale direct execution metadata is non-authoritative */ } }
export function currentOperationContext(): { id?: string; kind?: string; workspaceId?: string; controlRoot?: string } { return { id: process.env.AEH_OPERATION_ID?.trim() || undefined, kind: process.env.AEH_OPERATION_KIND?.trim() || undefined, workspaceId: process.env.AEH_OPERATION_WORKSPACE_ID?.trim() || undefined, controlRoot: process.env.AEH_CONTROL_ROOT?.trim() || undefined }; }
export async function updateCurrentOperationPhase(root: string, phase: string): Promise<void> { const operationId = currentOperationContext().id; if (!operationId) return; try { await setOperationStage(resolveOperationStateRoot(root), operationId, phase, "RUNNING"); } catch { /* direct/non-controller */ } }

export function normalizeOperationRecord(record: OperationRecord): OperationRecordV2 {
  if (record.version === 2) { const participants = record.participants ?? {}; return { ...record, version: 2, revision: Math.max(1, record.revision || 1), lastProgressAt: record.lastProgressAt || record.updatedAt, supervision: record.supervision ?? defaultSupervision(record.kind), stages: record.stages ?? {}, participants, progress: record.progress ?? deriveProgress(participants), notification: record.notification ?? defaultNotification() }; }
  const participants: Record<string, OperationParticipantRecord> = {};
  for (const agent of record.agents ?? []) { if (agent.role === "operation-supervisor") continue; participants[agent.id] = { id: agent.id, logicalAgent: agent.role, role: agent.role, stage: agent.phase, phase: agent.phase, workspaceId: agent.workspaceId, transport: agent.transport, status: "REGISTERED", registeredAt: agent.registeredAt }; }
  return { ...record, version: 2, kind: record.kind, payload: record.payload, revision: 1, lastProgressAt: record.updatedAt, intent: inferIntent(record.kind, record.payload), supervision: defaultSupervision(record.kind), stages: record.phase ? { [record.phase]: { name: record.phase, status: isTerminal(record.status) ? terminalStageStatus(record.status) : "RUNNING", revision: 1, startedAt: record.startedAt, finishedAt: record.finishedAt } } : {}, participants, progress: deriveProgress(participants), notification: defaultNotification() };
}

async function mutateOperation(root: string, operationId: string, patch: Partial<OperationRecordV2>, touchRevision: boolean, eventType: string, custom?: (current: OperationRecordV2, revision: number, now: string) => OperationRecordV2): Promise<OperationRecordV2> {
  const stateRoot = resolveOperationStateRoot(root); const file = operationFile(stateRoot, operationId); await fs.mkdir(path.dirname(file), { recursive: true });
  return withOperationLock(file, async () => {
    const current = normalizeOperationRecord(JSON.parse(await fs.readFile(file, "utf8")) as OperationRecord); const guardedPatch = guardTerminalTransition(current, patch); const now = new Date().toISOString(); const revision = touchRevision ? current.revision + 1 : current.revision;
    const candidate = custom ? custom(current, revision, now) : ({ ...current, ...guardedPatch, version: 2, id: current.id, kind: current.kind, revision, updatedAt: now, lastProgressAt: touchRevision ? now : current.lastProgressAt } as OperationRecordV2);
    const next = normalizeOperationRecord(candidate); await writeRecord(file, next); await appendOperationEvent(stateRoot, next, eventType, Object.keys(patch)); return next;
  });
}
async function appendOperationEvent(root: string, record: OperationRecordV2, type: string, changed?: string[], details?: Record<string, unknown>): Promise<void> { const file = operationEventsFile(root, record.id); await fs.mkdir(path.dirname(file), { recursive: true }); const event: OperationEvent = { version: 1, operationId: record.id, revision: record.revision, at: new Date().toISOString(), type, status: record.status, phase: record.phase, changed, details }; await fs.appendFile(file, `${JSON.stringify(event)}\n`); }
async function writeRecord(file: string, record: OperationRecordV2): Promise<void> { const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`); try { await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }).catch(() => undefined); } }
async function withOperationLock<T>(file: string, action: () => Promise<T>): Promise<T> { const lock = `${file}.lock`; const deadline = Date.now() + LOCK_TIMEOUT_MS; for (;;) { let handle: Awaited<ReturnType<typeof fs.open>> | undefined; try { handle = await fs.open(lock, "wx"); try { await handle.writeFile(`${process.pid}\n`); return await action(); } finally { await handle.close().catch(() => undefined); await fs.rm(lock, { force: true }).catch(() => undefined); } } catch (error) { if (handle) { await handle.close().catch(() => undefined); await fs.rm(lock, { force: true }).catch(() => undefined); throw error; } if (!isAlreadyExists(error)) throw error; if (await canRecoverLock(lock)) { await fs.rm(lock, { force: true }).catch(() => undefined); continue; } if (Date.now() >= deadline) throw new Error(`Timed out acquiring operation state lock for ${path.basename(file)}.`); await delay(LOCK_RETRY_MS); } } }
async function canRecoverLock(lock: string): Promise<boolean> { try { const [rawPid, stat] = await Promise.all([fs.readFile(lock, "utf8").catch(() => ""), fs.stat(lock)]); const ownerPid = Number.parseInt(rawPid.trim(), 10); if (Number.isInteger(ownerPid) && ownerPid > 0 && !processAlive(ownerPid)) return true; return Date.now() - stat.mtimeMs > STALE_LOCK_MS; } catch { return true; } }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

function guardTerminalTransition(current: OperationRecordV2, patch: Partial<OperationRecordV2>): Partial<OperationRecordV2> {
  if (!isTerminal(current.status)) return patch;
  // Once one controller owns terminalization, late execution/cancellation paths
  // may still append cleanup/notification metadata but cannot rewrite the
  // terminal outcome, phase, result, error or finish timestamp.
  const { status: _status, phase: _phase, result: _result, error: _error, finishedAt: _finishedAt, ...metadata } = patch;
  return metadata;
}
function deriveProgress(participants: Record<string, OperationParticipantRecord>): OperationProgress { const values = Object.values(participants); return { expected: values.length, registered: values.filter((item) => item.status === "REGISTERED" || item.status === "IDLE").length, running: values.filter((item) => item.status === "RUNNING").length, completed: values.filter((item) => item.status === "COMPLETED").length, failed: values.filter((item) => item.status === "FAILED" || item.status === "CANCELLED").length, blocked: values.filter((item) => item.status === "BLOCKED").length }; }
function defaultSupervision(kind: OperationKind): OperationSupervisionState { return { required: kind === "audit" || kind === "change", materialized: false, generations: [] }; }
function defaultNotification(): OperationNotificationState { return { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }; }
function inferIntent(kind: OperationKind, payload: OperationPayload): OperationIntentState { if (kind === "audit") { const audit = payload as AuditOperationPayload; return { request: audit.request, classification: "AUDIT", risk: audit.risk }; } if (kind === "change") { const change = payload as ChangeOperationPayload; return { request: change.request, classification: "CHANGE", risk: change.risk, priority: change.priority }; } return { classification: "RUN", priority: (payload as RunOperationPayload).priority }; }
function terminalStageStatus(status: OperationStatus): OperationStageStatus { return status === "SUCCEEDED" ? "COMPLETED" : status === "CANCELLED" ? "SKIPPED" : "FAILED"; }
export function isTerminalOperation(status: OperationStatus): boolean { return isTerminal(status); }
function isTerminal(status: OperationStatus): boolean { return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED"; }
function requiredId(value: string): string { const trimmed = value.trim(); if (!trimmed) throw new Error("agent id is required"); return trimmed; }
function safeId(value: string): string { if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid operation id '${value}'.`); return value; }
function isAlreadyExists(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST"); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
