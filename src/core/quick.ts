import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { HarnessProjectConfig, TaskContract } from "./types.js";
import { triageChange, type TriageEvidence, type TriageFlag } from "./triage.js";

export interface CreateQuickContractInput {
  title: string;
  request: string;
  scope: string[];
  acceptance: string[];
  domains?: string[];
  risk?: "low" | "medium" | "high";
  flags?: TriageFlag[];
  profile?: string;
}

export async function createQuickContract(root: string, config: HarnessProjectConfig, taskId: string, input: CreateQuickContractInput): Promise<{ file: string; contract: TaskContract }> {
  const decision = triageChange(config, { request: input.request, files: input.scope, domains: input.domains, risk: input.risk, flags: input.flags });
  if (!decision.quickEligible) throw new Error(`QUICK_MODE_REJECTED: ${decision.reasons.join("; ")}. Create an SDD change instead.`);
  if (!input.acceptance.length) throw new Error("QUICK_MODE_REJECTED: at least one observable acceptance statement is required.");
  const contract: TaskContract = {
    version: 1,
    mode: "quick",
    task: { id: taskId, title: input.title },
    quick: { request: input.request, acceptance: input.acceptance, triage: { mode: decision.mode, reasons: decision.reasons, evaluatedAt: new Date().toISOString() } },
    git: { baseRef: config.validation?.baseRef ?? "main" },
    scope: { allowed: [...new Set(input.scope)], forbidden: [], frozen: [] },
    routing: { intent: "implement", domains: [...new Set(input.domains ?? [])], risk: "low", profile: input.profile },
    constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false, maxFilesChanged: config.workflow?.quick?.maxFiles ?? 5 },
    repair: { maxAttempts: config.orchestration?.worker?.maxRepairAttempts ?? 2 }
  };
  const contractsDir = path.resolve(root, config.sdd?.contractsDir ?? ".harness/contracts");
  await fs.mkdir(contractsDir, { recursive: true });
  const file = path.join(contractsDir, `${taskId}.yaml`);
  await fs.writeFile(file, YAML.stringify(contract));
  return { file, contract };
}

export function validateQuickTaskContract(config: HarnessProjectConfig, contract: TaskContract): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (contract.mode !== "quick") return { ok: true, issues };
  if (!contract.quick?.request?.trim()) issues.push("quick.request is required");
  if (!contract.quick?.acceptance?.length) issues.push("quick.acceptance must contain at least one observable statement");
  const scope = contract.scope?.allowed ?? [];
  const evidence: TriageEvidence = { request: contract.quick?.request ?? "", files: scope, domains: contract.routing?.domains, risk: contract.routing?.risk ?? "low" };
  const decision = triageChange(config, evidence);
  if (!decision.quickEligible) issues.push(...decision.reasons.map((reason) => `quick triage no longer qualifies: ${reason}`));
  if (contract.constraints?.breakingApiChanges !== false) issues.push("quick mode requires breakingApiChanges=false");
  if (contract.constraints?.newDependencies !== false) issues.push("quick mode requires newDependencies=false");
  if (contract.constraints?.schemaChanges !== false) issues.push("quick mode requires schemaChanges=false");
  return { ok: issues.length === 0, issues };
}
