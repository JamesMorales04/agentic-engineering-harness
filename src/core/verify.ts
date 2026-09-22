import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig, TaskContract, ValidationCheck, ValidationReport } from "./types.js";
import { loadTaskContract } from "./config.js";
import { generatedArtifactPaths, getChangedFiles, getDiffStats } from "./git.js";
import { deliveryWorkspacePath } from "../delivery/handoff.js";
import { validateDiffScope } from "../validators/diffScope.js";
import { validateDiffBudget } from "../validators/constraints.js";
import { runValidationCommand } from "../validators/commands.js";
import { recordEvent } from "../telemetry/events.js";
import { runOpaPolicies, type OpaExecutionIdentity } from "../validators/opa.js";
import { verifyTaskSeal } from "./seal.js";
import { runConfiguredValidators } from "../validators/registry.js";
import { collectPolicyEvidence } from "../validators/evidence.js";
import { currentOperationContext, loadOperation } from "../operations/state.js";
import { assertWorkspaceMatchesCandidate } from "../candidates/identity.js";

export interface VerifyTaskOptions { stateRoot?: string; policyRoot?: string; executionIdentity?: OpaExecutionIdentity; }

export async function verifyTask(root: string, config: HarnessProjectConfig, contract: TaskContract, options: VerifyTaskOptions = {}): Promise<ValidationReport> {
  const executionRoot = path.resolve(root);
  if (!options.stateRoot) {
    const deliveryRoot = await deliveryWorkspacePath(executionRoot, config, contract.task.id);
    if (deliveryRoot && path.resolve(deliveryRoot) !== executionRoot) {
      const workspaceContract = await loadTaskContract(deliveryRoot, contract.task.id, config);
      return verifyTask(deliveryRoot, config, workspaceContract, { stateRoot: executionRoot, policyRoot: executionRoot });
    }
  }
  const stateRoot = path.resolve(options.stateRoot ?? executionRoot);
  const policyRoot = path.resolve(options.policyRoot ?? stateRoot);
  const candidate = await currentCandidate(stateRoot);
  const candidateWorkspaceIdentity = candidate ? await assertWorkspaceMatchesCandidate(executionRoot, candidate) : undefined;
  const startedAt = new Date().toISOString(); const baseRef = contract.git?.baseRef ?? config.validation?.baseRef ?? "HEAD";
  await recordEvent(stateRoot, config, "harness.verify.start", { taskId: contract.task.id, baseRef, workspaceRoot: executionRoot === stateRoot ? undefined : executionRoot });
  const gitOptions = { ignoredPaths: generatedArtifactPaths(config) };
  const changedFiles = await getChangedFiles(executionRoot, baseRef, gitOptions); const stats = await getDiffStats(executionRoot, baseRef, gitOptions); const checks: ValidationCheck[] = [];
  if (candidateWorkspaceIdentity) checks.push({ id: "candidate.workspace-identity", category: "candidate-identity", status: "PASS", message: `Workspace materializes ${candidate!.candidateId} r${candidate!.revision}.`, details: { ...candidateWorkspaceIdentity } });
  checks.push(await verifyTaskSeal(executionRoot, contract, config.validation?.requireSeal ?? true));
  const scopeChecks = validateDiffScope(changedFiles, contract, config.validation?.frozenPaths ?? []); checks.push(...scopeChecks); checks.push(...validateDiffBudget(contract, stats));
  const frozenChanged = (scopeChecks.find((c) => c.id === "diff.frozen-paths")?.details?.frozenChanged ?? []) as string[];
  const evidence = collectPolicyEvidence(changedFiles);
  checks.push(await runOpaPolicies(executionRoot, config, contract, changedFiles, frozenChanged, evidence, policyRoot, options.executionIdentity));
  const commands = [...(config.validation?.commands ?? []), ...(contract.verification?.commands ?? [])]; for (const command of commands) checks.push(await runValidationCommand(executionRoot, command));
  checks.push(...await runConfiguredValidators(executionRoot, config, contract, baseRef, changedFiles));
  if (candidate) await assertWorkspaceMatchesCandidate(executionRoot, candidate, await currentCandidate(stateRoot) ?? null);
  const status = checks.some((check) => check.status === "FAIL") ? "FAIL" : "PASS";
  const findings = checks.flatMap((check) => Array.isArray(check.details?.findings) ? check.details.findings : []).filter((item): item is import("../core/types.js").ValidationFinding => Boolean(item && typeof item === "object" && typeof (item as Record<string, unknown>).fingerprint === "string"));
  const report: ValidationReport = { version: 1, taskId: contract.task.id, status, startedAt, finishedAt: new Date().toISOString(), checks, changedFiles, findings, candidate, candidateWorkspaceIdentity, metadata: { project: config.project.name, baseRef } };
  const reportsDir = config.sdd?.reportsDir ?? ".harness/reports"; const output = path.join(stateRoot, reportsDir, `${contract.task.id}.json`); await fs.mkdir(path.dirname(output), { recursive: true });
  if (candidate) await assertWorkspaceMatchesCandidate(executionRoot, candidate, await currentCandidate(stateRoot) ?? null);
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  await recordEvent(stateRoot, config, "harness.verify.finish", { taskId: contract.task.id, status, checks: checks.length }); return report;
}

async function currentCandidate(stateRoot: string): Promise<import("../operations/v2Contracts.js").CandidateRevisionV1 | undefined> {
  const operationId = currentOperationContext().id;
  if (!operationId) return undefined;
  const operation = await loadOperation(stateRoot, operationId);
  if (!operation.candidateRevision) throw new Error(`V2_CANDIDATE_BINDING_REJECTED: operation ${operationId} has no current candidate revision.`);
  return operation.candidateRevision;
}
