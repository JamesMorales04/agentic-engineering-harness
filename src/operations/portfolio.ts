import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { sha256Canonical } from "../core/digest.js";
import type { OperationRecordV2, OperationStatus } from "./state.js";
import { activeOperationSupervisor, frozenOperationHardDeadlineAt, loadOperation } from "./state.js";

export interface OperationPortfolioEntry {
  operationId: string; kind: string; status: OperationStatus; phase: string; workspaceId?: string;
  supervisorAgentId?: string; supervisorGeneration?: number; revision: number; acknowledgedRevision: number;
  boundLeadAgentId?: string; originKind?: string; parentOperationId?: string; userTurnDigest?: string;
  deadlineDisposition?: "FROZEN_DEADLINE" | "UNFROZEN_UNSUPPORTED" | "NOT_APPLICABLE";
  deadlineDiagnosticCode?: "OPERATION_UNSUPPORTED_UNFROZEN_DEADLINE";
  ownerBoundaryKinds?: Array<"OWNER_ECONOMIC_BOUNDARY" | "OWNER_HARD_DEADLINE">;
  leadRelationship?: "BOUND_CURRENT_LEAD" | "BOUND_OTHER_LEAD" | "UNBOUND_HISTORICAL";
  lineageRelationship?: "CURRENT_ROOT" | "CONTINUATION_RELEVANT" | "HISTORICAL_UNRELATED";
  ownerAttention?: "NONE" | "CHAIN_SCOPED_BOUNDARY" | "PROJECT_OR_OWNER_GLOBAL_BOUNDARY";
  priority: number; updatedAt: string;
}
export interface OperationPortfolio {
  version: 1; project: string; leadAgentId?: string; leadGeneration: number; updatedAt: string;
  operations: Record<string, OperationPortfolioEntry>;
}
export interface OperationConcurrencyPolicy {
  maxActiveOperations: number; maxActiveAgents: number; maxAgentsPerOperation: number; maxProviderAgents: Record<string, number>;
}
export interface OperationPortfolioContextV1 {
  currentLeadAgentId?: string;
  currentUserTurnId?: string;
  ownerBoundaryScope?: "CHAIN_SCOPED_BOUNDARY" | "PROJECT_OR_OWNER_GLOBAL_BOUNDARY";
}
interface OperationConfigExtension {
  operations?: { concurrency?: { maxActiveOperations?: number; maxActiveAgents?: number; maxAgentsPerOperation?: number; maxProviderAgents?: Record<string, number>; }; };
}
const DEFAULT_POLICY: OperationConcurrencyPolicy = {
  maxActiveOperations: 5, maxActiveAgents: 16, maxAgentsPerOperation: 8, maxProviderAgents: { codex: 4, opencode: 8 }
};
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

export function operationPortfolioFile(root: string): string { return path.resolve(root, ".harness/operations/portfolio.json"); }
export async function loadOperationPortfolio(root: string, project = "unknown", context: OperationPortfolioContextV1 = {}): Promise<OperationPortfolio> {
  return enrichPortfolio(await hydratePortfolioOperations(root, await readPortfolio(operationPortfolioFile(root), project)), context);
}

export async function syncOperationPortfolio(root: string, project: string, operation: OperationRecordV2): Promise<OperationPortfolio> {
  return mutatePortfolio(root, project, (current) => {
    return {
      ...current,
      project,
      leadAgentId: operation.lead?.agentId ?? current.leadAgentId,
      leadGeneration: Math.max(current.leadGeneration, operation.lead?.generation ?? 0),
      updatedAt: new Date().toISOString(),
      operations: {
        ...current.operations,
        [operation.id]: portfolioEntryFromOperation(operation)
      }
    };
  });
}

export async function bindPortfolioLead(root: string, project: string, agentId: string, generation?: number): Promise<OperationPortfolio> {
  return mutatePortfolio(root, project, (current) => ({
    ...current, project, leadAgentId: agentId,
    leadGeneration: generation ?? current.leadGeneration + 1,
    updatedAt: new Date().toISOString()
  }));
}

export function operationConcurrencyPolicy(config: HarnessProjectConfig): OperationConcurrencyPolicy {
  const orchestration = config.orchestration as (HarnessProjectConfig["orchestration"] & OperationConfigExtension) | undefined;
  const configured = orchestration?.operations?.concurrency;
  return {
    maxActiveOperations: positive(configured?.maxActiveOperations, DEFAULT_POLICY.maxActiveOperations),
    maxActiveAgents: positive(configured?.maxActiveAgents, DEFAULT_POLICY.maxActiveAgents),
    maxAgentsPerOperation: positive(configured?.maxAgentsPerOperation, DEFAULT_POLICY.maxAgentsPerOperation),
    maxProviderAgents: { ...DEFAULT_POLICY.maxProviderAgents, ...(configured?.maxProviderAgents ?? {}) }
  };
}

export async function assertOperationCapacity(root: string, config: HarnessProjectConfig, requestedPriority = 50): Promise<void> {
  const file = operationPortfolioFile(root);
  const policy = operationConcurrencyPolicy(config);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await withPortfolioLock(file, async () => {
    const portfolio = await hydratePortfolioOperations(root, await readPortfolio(file, config.project.name));
    const active = Object.values(portfolio.operations).filter((item) => (item.status === "QUEUED" || item.status === "RUNNING") && item.deadlineDisposition !== "UNFROZEN_UNSUPPORTED");
    if (active.length < policy.maxActiveOperations) return;
    const lowest = active.reduce((min, item) => Math.min(min, item.priority), Number.POSITIVE_INFINITY);
    throw new Error(`AEH_OPERATION_CAPACITY: ${active.length} active operations already consume the configured lead/project limit ${policy.maxActiveOperations}. Requested priority=${requestedPriority}; current lowest priority=${Number.isFinite(lowest) ? lowest : "n/a"}. Wait, cancel, or raise the configured orchestration.operations.concurrency.maxActiveOperations limit.`);
  });
}

function portfolioEntryFromOperation(operation: OperationRecordV2): OperationPortfolioEntry {
  const supervisor = activeOperationSupervisor(operation);
  const active = operation.status === "QUEUED" || operation.status === "RUNNING";
  const frozenDeadline = frozenOperationHardDeadlineAt(operation);
  return {
    operationId: operation.id, kind: operation.kind, status: operation.status, phase: operation.phase,
    workspaceId: operation.workspaceId, supervisorAgentId: supervisor?.agentId, supervisorGeneration: supervisor?.generation,
    revision: operation.revision,
    acknowledgedRevision: operation.lead?.acknowledgedRevision ?? operation.notification.lastLeadWakeRevision,
    boundLeadAgentId: operation.lead?.agentId,
    originKind: operation.origin?.kind,
    parentOperationId: operation.origin?.parentOperationId,
    userTurnDigest: operation.origin?.userTurnId ? sha256Canonical(operation.origin.userTurnId) : undefined,
    ownerBoundaryKinds: [
      ...(operation.ownerEconomicBoundary?.state === "WAITING" ? ["OWNER_ECONOMIC_BOUNDARY" as const] : []),
      ...(operation.ownerContinuationBoundary?.state === "WAITING" ? ["OWNER_HARD_DEADLINE" as const] : [])
    ],
    deadlineDisposition: !active ? "NOT_APPLICABLE" : frozenDeadline === undefined ? "UNFROZEN_UNSUPPORTED" : "FROZEN_DEADLINE",
    ...(active && frozenDeadline === undefined ? { deadlineDiagnosticCode: "OPERATION_UNSUPPORTED_UNFROZEN_DEADLINE" as const } : {}),
    priority: operation.intent?.priority ?? 50,
    updatedAt: operation.updatedAt
  };
}

async function hydratePortfolioOperations(root: string, portfolio: OperationPortfolio): Promise<OperationPortfolio> {
  const entries = await Promise.all(Object.entries(portfolio.operations).map(async ([operationId, entry]) => {
    const operation = await loadOperation(root, operationId).catch((error: unknown) => isMissing(error) ? undefined : Promise.reject(error));
    return [operationId, operation ? portfolioEntryFromOperation(operation) : entry] as const;
  }));
  return { ...portfolio, operations: Object.fromEntries(entries) };
}

async function mutatePortfolio(root: string, project: string, mutate: (current: OperationPortfolio) => OperationPortfolio): Promise<OperationPortfolio> {
  const file = operationPortfolioFile(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  return withPortfolioLock(file, async () => {
    // Atomic rename alone does not prevent lost updates: multiple operation
    // controllers must serialize the complete read-modify-write transaction.
    const current = await readPortfolio(file, project);
    const next = mutate(current);
    await persistUnlocked(file, next);
    return next;
  });
}
async function readPortfolio(file: string, project: string): Promise<OperationPortfolio> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as OperationPortfolio;
    if (value.version !== 1 || !value.operations) throw new Error("invalid portfolio record");
    return value;
  } catch (error) {
    if (!isMissing(error)) throw error;
    return { version: 1, project, leadGeneration: 0, updatedAt: new Date().toISOString(), operations: {} };
  }
}

function enrichPortfolio(portfolio: OperationPortfolio, context: OperationPortfolioContextV1): OperationPortfolio {
  const entries = Object.values(portfolio.operations);
  const byId = new Map(entries.map((entry) => [entry.operationId, entry]));
  const children = new Map<string, OperationPortfolioEntry[]>();
  for (const entry of entries) if (entry.parentOperationId) children.set(entry.parentOperationId, [...(children.get(entry.parentOperationId) ?? []), entry]);
  const rootId = (entry: OperationPortfolioEntry): string => {
    let current = entry;
    const seen = new Set<string>();
    while (current.parentOperationId && byId.has(current.parentOperationId) && !seen.has(current.operationId)) {
      seen.add(current.operationId);
      current = byId.get(current.parentOperationId)!;
    }
    return current.operationId;
  };
  const unresolvedFailedRoots = new Set<string>();
  for (const entry of entries) {
    if ((entry.status !== "FAILED" && entry.status !== "CANCELLED") || entry.parentOperationId) continue;
    const chain = [entry];
    const seen = new Set<string>([entry.operationId]);
    for (let index = 0; index < chain.length; index += 1) {
      for (const child of children.get(chain[index]!.operationId) ?? []) {
        if (!seen.has(child.operationId)) { seen.add(child.operationId); chain.push(child); }
      }
    }
    const leaves = chain.filter((item) => !(children.get(item.operationId)?.length));
    if (leaves.some((leaf) => leaf.status !== "SUCCEEDED")) unresolvedFailedRoots.add(entry.operationId);
  }
  const currentTurnDigest = context.currentUserTurnId ? sha256Canonical(context.currentUserTurnId) : undefined;
  const relevantRoots = new Set(entries.filter((entry) => currentTurnDigest && entry.userTurnDigest === currentTurnDigest).map(rootId));
  const globalScope = context.ownerBoundaryScope === "PROJECT_OR_OWNER_GLOBAL_BOUNDARY";
  const operations = Object.fromEntries(entries.map((entry) => {
    const leadRelationship: NonNullable<OperationPortfolioEntry["leadRelationship"]> = !entry.boundLeadAgentId ? "UNBOUND_HISTORICAL"
      : entry.boundLeadAgentId === context.currentLeadAgentId ? "BOUND_CURRENT_LEAD" : "BOUND_OTHER_LEAD";
    const root = rootId(entry);
    const lineageRelationship: NonNullable<OperationPortfolioEntry["lineageRelationship"]> = entry.userTurnDigest && currentTurnDigest && entry.userTurnDigest === currentTurnDigest
      ? entry.parentOperationId ? "CONTINUATION_RELEVANT" : "CURRENT_ROOT"
      : relevantRoots.has(root) ? "CONTINUATION_RELEVANT" : "HISTORICAL_UNRELATED";
    const hasGlobalCandidateBoundary = Boolean(entry.ownerBoundaryKinds?.length);
    const ownerAttention: NonNullable<OperationPortfolioEntry["ownerAttention"]> = hasGlobalCandidateBoundary
      ? globalScope ? "PROJECT_OR_OWNER_GLOBAL_BOUNDARY" : "CHAIN_SCOPED_BOUNDARY"
      : unresolvedFailedRoots.has(root) ? "CHAIN_SCOPED_BOUNDARY" : "NONE";
    return [entry.operationId, { ...entry, leadRelationship, lineageRelationship, ownerAttention }];
  }));
  return { ...portfolio, operations };
}
async function persistUnlocked(file: string, portfolio: OperationPortfolio): Promise<void> {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(portfolio, null, 2)}\n`);
  try { await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}
async function withPortfolioLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(lock, "wx");
      try { await handle.writeFile(`${process.pid}\n`); return await action(); }
      finally { await handle.close().catch(() => undefined); await fs.rm(lock, { force: true }).catch(() => undefined); }
    } catch (error) {
      if (handle) { await handle.close().catch(() => undefined); await fs.rm(lock, { force: true }).catch(() => undefined); throw error; }
      if (!isAlreadyExists(error)) throw error;
      if (await canRecoverLock(lock)) { await fs.rm(lock, { force: true }).catch(() => undefined); continue; }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring operation portfolio lock for ${path.basename(file)}.`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}
async function canRecoverLock(lock: string): Promise<boolean> {
  try {
    const [rawPid, stat] = await Promise.all([fs.readFile(lock, "utf8").catch(() => ""), fs.stat(lock)]);
    const ownerPid = Number.parseInt(rawPid.trim(), 10);
    if (Number.isInteger(ownerPid) && ownerPid > 0) return !processAlive(ownerPid);
    return Date.now() - stat.mtimeMs > STALE_LOCK_MS;
  } catch { return true; }
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function positive(value: number | undefined, fallback: number): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
function isMissing(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"); }
function isAlreadyExists(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST"); }
