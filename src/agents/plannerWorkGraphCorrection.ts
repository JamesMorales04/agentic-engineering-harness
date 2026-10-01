import type { TaskContract } from "../core/types.js";
import { createWorkGraph, type WorkGraphV1 } from "../architecture/workGraph.js";
import { plannerOutputSchema, type PlannerOutput } from "./outputContracts.js";

const MAX_CORRECTION_PAYLOAD_BYTES = 24_000;

export class PlannerWorkGraphCorrectionError extends Error {
  constructor(message: string, readonly validationIssues: string[], readonly correctionAttempts: 0 | 1) {
    super(message);
    this.name = "PlannerWorkGraphCorrectionError";
  }
}

export function compilePlannerWorkGraph(contract: TaskContract, plan: PlannerOutput): WorkGraphV1 {
  return createWorkGraph({
    taskId: contract.task.id,
    objective: contract.task.title,
    route: contract.routing?.route ?? "DELEGATED",
    assurance: contract.routing?.assurance ?? "STANDARD",
    requirementRefs: (contract.requirements ?? []).map((item) => item.id),
    acceptanceRefs: plan.workUnits.flatMap((unit) => unit.acceptanceRefs),
    units: plan.workUnits.map((unit) => ({ ...unit, version: 1 as const, status: "PENDING" as const }))
  });
}

/** Validate a model Planner result at the WorkGraph boundary and permit one compact correction. */
export async function compilePlannerWorkGraphWithOneCorrection(input: {
  contract: TaskContract;
  plan: PlannerOutput;
  requestCorrection?: (prompt: string) => Promise<unknown>;
}): Promise<{ plan: PlannerOutput; graph: WorkGraphV1; correctionAttempts: 0 | 1 }> {
  try {
    return { plan: input.plan, graph: compilePlannerWorkGraph(input.contract, input.plan), correctionAttempts: 0 };
  } catch (firstError) {
    const firstIssues = plannerWorkGraphValidationIssues(firstError, input.plan);
    if (!input.requestCorrection) {
      throw new PlannerWorkGraphCorrectionError(`Planner WorkGraph rejected; corrective retry unavailable: ${firstIssues.join("; ")}`, firstIssues, 0);
    }

    const correctionPrompt = buildPlannerWorkGraphCorrectionPrompt(input.plan, firstIssues);
    let corrected: PlannerOutput;
    try {
      corrected = plannerOutputSchema.parse(await input.requestCorrection(correctionPrompt));
    } catch (error) {
      const issues = [`corrective Planner output did not satisfy plannerOutputSchema: ${errorMessage(error)}`];
      throw new PlannerWorkGraphCorrectionError(`Planner WorkGraph correction failed closed: ${issues.join("; ")}`, issues, 1);
    }

    try {
      return { plan: corrected, graph: compilePlannerWorkGraph(input.contract, corrected), correctionAttempts: 1 };
    } catch (secondError) {
      const issues = plannerWorkGraphValidationIssues(secondError, corrected);
      throw new PlannerWorkGraphCorrectionError(`Planner WorkGraph remained invalid after one corrective retry: ${issues.join("; ")}`, issues, 1);
    }
  }
}

export function plannerWorkGraphValidationIssues(error: unknown, plan: PlannerOutput): string[] {
  const issues = error && typeof error === "object" && Array.isArray((error as { issues?: unknown }).issues)
    ? (error as { issues: Array<{ path?: unknown; message?: unknown; maximum?: unknown }> }).issues
    : undefined;
  if (!issues?.length) return [errorMessage(error)];
  return issues.map((issue) => {
    const path = Array.isArray(issue.path) ? issue.path : [];
    const unitIndex = path[0] === "units" && typeof path[1] === "number" ? path[1] : undefined;
    if (unitIndex !== undefined && path[2] === "objective" && issue.maximum === 500) {
      const unit = plan.workUnits[unitIndex];
      const length = typeof unit?.objective === "string" ? unit.objective.length : undefined;
      return `workUnits[${unitIndex}]${unit?.id ? ` (${unit.id})` : ""}.objective exceeds maximum 500 characters${length === undefined ? "" : ` (received ${length})`}.`;
    }
    const pathText = path.length ? path.join(".") : "root";
    return `${pathText}: ${typeof issue.message === "string" ? issue.message : "invalid value"}`;
  });
}

export function buildPlannerWorkGraphCorrectionPrompt(plan: PlannerOutput, issues: readonly string[]): string {
  const prior = JSON.stringify(plan);
  if (Buffer.byteLength(prior, "utf8") > MAX_CORRECTION_PAYLOAD_BYTES) {
    throw new PlannerWorkGraphCorrectionError("Planner WorkGraph correction failed closed: prior structured result exceeds the 24000-byte correction bound.", ["prior structured result exceeds 24000 bytes"], 0);
  }
  return [
    "Correct this structured Planner result. It passed plannerOutputSchema but deterministic WorkGraph validation rejected it.",
    "Fix only the listed validation errors. Preserve all other fields, IDs, dependencies, requirement references, acceptance references, scope and meaning. Do not truncate strings, widen scope, add requirements, or select agents, tools, validators or commands.",
    "Return the complete Planner object in the existing schema. No repository discovery or request context is needed.",
    "Deterministic validation errors:",
    ...issues.map((issue) => `- ${issue}`),
    "Prior structured Planner result:",
    prior,
    "Final line: AEH_RESULT_JSON=<corrected planner object>"
  ].join("\n\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
