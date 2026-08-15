import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { TaskContract, ValidationReport } from "../core/types.js";
import type { MemoryRecord } from "../providers/types.js";

export interface AcceptedOperationArtifacts {
  root: string;
  project: string;
  operationId?: string;
  contract: TaskContract;
  result: { taskId: string; status: string; attempts: number; report: ValidationReport; evidence?: { complete: boolean; requirements: number; sha256: string }; review?: { status: string; rounds: number; findings: number } };
  runFile: string;
  reportFile?: string;
  evidenceFile?: string;
}

/** Build bounded, artifact-backed memory. No prompt or chain-of-thought is read. */
export async function buildAcceptedOperationCandidates(input: AcceptedOperationArtifacts): Promise<MemoryRecord[]> {
  if (input.result.status !== "PASS") return [];
  const candidates: MemoryRecord[] = [];
  const add = async (type: MemoryRecord["type"], title: string, content: string, source: string, tags: string[]): Promise<void> => {
    const relative = path.relative(input.root, source).replaceAll("\\", "/");
    const sourceSha256 = await sha256(source).catch(() => undefined);
    if (!sourceSha256) return;
    candidates.push({ project: input.project, type, title, content: content.slice(0, 3_000), source: relative, sourceSha256, createdAt: new Date().toISOString(), tags: [...new Set(["aeh", "accepted", ...tags])] });
  };
  const task = input.contract.task;
  await add("summary", `Accepted operation ${task.id}`, `Accepted task ${task.id}: ${task.title}. Validation=${input.result.report.status}; attempts=${input.result.attempts}; review=${input.result.review?.status ?? "not-run"}; evidence=${input.result.evidence?.complete === true ? "complete" : "not-configured"}.`, input.runFile, [input.contract.mode ?? "spec"]);
  const reportFile = input.reportFile ?? path.resolve(input.root, ".harness/reports", `${task.id}.json`);
  const report = input.result.report;
  if ((report.findings?.length ?? 0) > 0 || report.checks.some((check) => check.status === "WARN")) {
    const findings = (report.findings ?? []).slice(0, 12).map((finding) => `${finding.tool}/${finding.kind}${finding.rule ? ` rule=${finding.rule}` : ""}${finding.file ? ` file=${finding.file}` : ""}: ${finding.message ?? "finding"}`).join("\n");
    await add("discovery", `Validation evidence for ${task.id}`, `Accepted validation produced bounded structured evidence:\n${findings || "warnings were recorded in the report"}`, reportFile, ["validation"]);
  }
  if (input.result.evidence?.complete) {
    const evidenceFile = input.evidenceFile ?? path.resolve(input.root, ".harness/evidence", `${task.id}.json`);
    await add("decision", `Requirement coverage accepted for ${task.id}`, `The accepted operation established complete requirement coverage for ${input.result.evidence.requirements} requirement(s). EvidenceGraph sha256=${input.result.evidence.sha256}.`, evidenceFile, ["evidence", "coverage"]);
  }
  return candidates;
}

async function sha256(file: string): Promise<string> { return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"); }
