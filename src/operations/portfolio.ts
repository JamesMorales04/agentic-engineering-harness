import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import type { OperationRecordV2, OperationStatus } from "./state.js";
import { activeOperationSupervisor } from "./state.js";

export interface OperationPortfolioEntry {
  operationId: string;
  kind: string;
  status: OperationStatus;
  phase: string;
  workspaceId?: string;
  supervisorAgentId?: string;
  supervisorGeneration?: number;
  revision: number;
  acknowledgedRevision: number;
  priority: number;
  updatedAt: string;
}

export interface OperationPortfolio {
  version: 1;
  project: string;
  leadAgentId?: string;
  leadGeneration: number;
  updatedAt: string;
  operations: Record<string, OperationPortfolioEntry>;
}

export interface OperationConcurrencyPolicy {
  maxActiveOperations: number;
  maxActiveAgents: number;
  maxAgentsPerOperation: number;
  maxProviderAgents: Record<string, number>;
}

interface OperationConfigExtension {
  operations?: {
    concurrency?: {
      maxActiveOperations?: number;
      maxActiveAgents?: number;
      maxAgentsPerOperation?: number;
      maxProviderAgents?: Record<string, number>;
    };
  };
}

const DEFAULT_POLICY: OperationConcurrencyPolicy = {
  maxActiveOperations: 5,
  maxActiveAgents: 16,
  maxAgentsPerOperation: 8,
  maxProviderAgents: { codex: 4, opencode: 8 }
};

export function operationPortfolioFile(root: string): string {
  return path.resolve(root, ".harness/operations/portfolio.json");
}

export async function loadOperationPortfolio(root: string, project = "unknown"): Promise<OperationPortfolio> {
  try {
    const value = JSON.parse(await fs.readFile(operationPortfolioFile(root), "utf8")) as OperationPortfolio;
    if (value.version !== 1 || !value.operations) throw new Error("invalid portfolio record");
    return value;
  } catch (error) {
    if (!isMissing(error)) throw error;
    return { version: 1, project, leadGeneration: 0, updatedAt: new Date().toISOString(), operations: {} };
  }
}

export async function syncOperationPortfolio(
  root: string,
  project: string,
  operation: OperationRecordV2
): Promise<OperationPortfolio> {
  const current = await loadOperationPortfolio(root, project);
  const supervisor = activeOperationSupervisor(operation);
  const next: OperationPortfolio = {
    ...current,
    project,
    leadAgentId: operation.lead?.agentId ?? current.leadAgentId,
    leadGeneration: Math.max(current.leadGeneration, operation.lead?.generation ?? 0),
    updatedAt: new Date().toISOString(),
    operations: {
      ...current.operations,
      [operation.id]: {
        operationId: operation.id,
        kind: operation.kind,
        status: operation.status,
        phase: operation.phase,
        workspaceId: operation.workspaceId,
        supervisorAgentId: supervisor?.agentId,
        supervisorGeneration: supervisor?.generation,
        revision: operation.revision,
        acknowledgedRevision: operation.lead?.acknowledgedRevision ?? operation.notification.lastLeadWakeRevision,
        priority: operation.intent?.priority ?? 50,
        updatedAt: operation.updatedAt
      }
    }
  };
  await persist(root, next);
  return next;
}

export async function bindPortfolioLead(
  root: string,
  project: string,
  agentId: string,
  generation?: number
): Promise<OperationPortfolio> {
  const current = await loadOperationPortfolio(root, project);
  const next: OperationPortfolio = {
    ...current,
    project,
    leadAgentId: agentId,
    leadGeneration: generation ?? current.leadGeneration + 1,
    updatedAt: new Date().toISOString()
  };
  await persist(root, next);
  return next;
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

export async function assertOperationCapacity(
  root: string,
  config: HarnessProjectConfig,
  requestedPriority = 50
): Promise<void> {
  const portfolio = await loadOperationPortfolio(root, config.project.name);
  const policy = operationConcurrencyPolicy(config);
  const active = Object.values(portfolio.operations).filter((item) => item.status === "QUEUED" || item.status === "RUNNING");
  if (active.length < policy.maxActiveOperations) return;
  const lowest = active.reduce((min, item) => Math.min(min, item.priority), Number.POSITIVE_INFINITY);
  throw new Error(
    `AEH_OPERATION_CAPACITY: ${active.length} active operations already consume the configured lead/project limit ${policy.maxActiveOperations}. ` +
      `Requested priority=${requestedPriority}; current lowest priority=${Number.isFinite(lowest) ? lowest : "n/a"}. Wait, cancel, or raise the configured orchestration.operations.concurrency.maxActiveOperations limit.`
  );
}

async function persist(root: string, portfolio: OperationPortfolio): Promise<void> {
  const file = operationPortfolioFile(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(portfolio, null, 2)}\n`);
  try { await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
