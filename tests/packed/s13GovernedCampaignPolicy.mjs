const TERMINAL_OPERATION_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/** Deterministic archive gate: both durable terminality and controller exit are required. */
export function workspaceArchiveDecision(status, controllerAlive) {
  const operationTerminal = TERMINAL_OPERATION_STATUSES.has(status);
  const controllerExited = !controllerAlive;
  return { eligible: operationTerminal && controllerExited, operationTerminal, controllerExited };
}

/**
 * R18-F2 deterministic workspace accounting: every inventory entry must end as either
 * archived-by-this-lane (exitCode 0) or explicitly remaining-after (with or without a
 * leave reason). Anything else is unaccounted and must fail the accounting, so a lane can
 * never report `remaining: []` while entries are unaccounted.
 */
export function accountWorkspaceCleanupV1(inventory, archived, remainingAfter) {
  const inventoryIds = inventory.map((workspace) => typeof workspace === "string" ? workspace : workspace.workspaceId).filter(Boolean);
  const archivedIds = new Set((archived ?? []).filter((entry) => entry.exitCode === 0).map((entry) => entry.workspaceId));
  const remainingIds = new Set((remainingAfter ?? []).map((workspace) => typeof workspace === "string" ? workspace : workspace.workspaceId));
  const unaccounted = inventoryIds.filter((id) => !archivedIds.has(id) && !remainingIds.has(id));
  return {
    inventoryCount: inventoryIds.length,
    archivedCount: [...archivedIds].filter((id) => inventoryIds.includes(id)).length,
    remainingCount: [...remainingIds].filter((id) => inventoryIds.includes(id)).length,
    unaccounted,
    accounted: unaccounted.length === 0
  };
}
