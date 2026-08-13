import type { HarnessProjectConfig } from "../core/types.js";
import { registerOperationCompletionTarget } from "./completion.js";
import { loadOperationPortfolio, syncOperationPortfolio } from "./portfolio.js";
import { bindOperationLead, isTerminalOperation, loadOperation } from "./state.js";

export async function rebindActiveOperationsToLead(
  root: string,
  config: HarnessProjectConfig,
  agentId: string,
  source = "lead-rotation"
): Promise<string[]> {
  const portfolio = await loadOperationPortfolio(root, config.project.name);
  const rebound: string[] = [];
  for (const entry of Object.values(portfolio.operations)) {
    if (entry.status !== "QUEUED" && entry.status !== "RUNNING") continue;
    const operation = await loadOperation(root, entry.operationId).catch(() => undefined);
    if (!operation || isTerminalOperation(operation.status)) continue;
    if (operation.lead?.agentId === agentId) continue;
    await registerOperationCompletionTarget(root, operation.id, agentId, source);
    const bound = await bindOperationLead(root, operation.id, agentId, source);
    await syncOperationPortfolio(root, config.project.name, bound);
    rebound.push(operation.id);
  }
  return rebound;
}
