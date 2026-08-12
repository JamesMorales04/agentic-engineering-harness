import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import type { NormalizedFinding, PlannerOutput } from "../agents/outputContracts.js";
import type { DeliveryFinalizationResult } from "../delivery/finalize.js";
import type { HarnessProjectConfig, TaskContract, ValidationCheck, ValidationReport, WorkerSession } from "../core/types.js";

export type EvidenceNodeType = "run" | "requirement" | "task" | "file" | "check" | "finding" | "agent-session" | "commit" | "pull-request";
export interface EvidenceNode { id: string; type: EvidenceNodeType; label: string; data?: Record<string, unknown>; }
export interface EvidenceEdge { from: string; to: string; type: "contains" | "implemented-by" | "changed" | "validated-by" | "reported-by" | "located-in" | "produced" | "finalized-as" | "delivered-by"; }
export interface RequirementCoverage { requirementId: string; implementation: boolean; validation: boolean; passingValidators: string[]; missingValidators: string[]; files: string[]; tasks: string[]; complete: boolean; }
export interface RequirementEvidenceGraph {
  version: 1;
  taskId: string;
  createdAt: string;
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
  requirements: RequirementCoverage[];
  complete: boolean;
  reasons: string[];
  sha256: string;
}

export async function buildRequirementEvidenceGraph(input: {
  root: string;
  stateRoot?: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  report: ValidationReport;
  plan?: PlannerOutput;
  findings?: NormalizedFinding[];
  sessions?: WorkerSession[];
  delivery?: DeliveryFinalizationResult;
}): Promise<RequirementEvidenceGraph> {
  const stateRoot = path.resolve(input.stateRoot ?? input.root);
  const runId = `run:${input.contract.task.id}`;
  const nodes = new Map<string, EvidenceNode>();
  const edges: EvidenceEdge[] = [];
  addNode(nodes, { id: runId, type: "run", label: input.contract.task.title, data: { mode: input.contract.mode ?? "spec", status: input.report.status } });

  const requirements = normalizedRequirements(input.contract);
  const planTasks = input.plan?.tasks?.length ? input.plan.tasks : [{ id: input.contract.task.id, summary: input.contract.task.title, agent: input.contract.routing?.agent ?? "implementation-worker", scope: input.contract.scope?.allowed ?? ["**"], dependencies: [], acceptance: requirements.map((item) => item.id), risk: input.contract.routing?.risk ?? "low" as const }];
  for (const requirement of requirements) {
    const id = `req:${requirement.id}`; addNode(nodes, { id, type: "requirement", label: requirement.description || requirement.id }); addEdge(edges, runId, id, "contains");
  }
  for (const task of planTasks) {
    const id = `task:${task.id}`; addNode(nodes, { id, type: "task", label: task.summary, data: { agent: task.agent, scope: task.scope, dependencies: task.dependencies } }); addEdge(edges, runId, id, "contains");
    for (const req of task.acceptance) if (requirements.some((item) => item.id === req)) addEdge(edges, `req:${req}`, id, "implemented-by");
  }
  for (const file of input.report.changedFiles) {
    const id = `file:${file}`; addNode(nodes, { id, type: "file", label: file }); addEdge(edges, runId, id, "contains");
    for (const task of planTasks) if (task.scope.some((scope) => matches(file, scope))) addEdge(edges, `task:${task.id}`, id, "changed");
  }
  for (const check of input.report.checks) {
    const id = `check:${check.id}`; addNode(nodes, { id, type: "check", label: check.id, data: { category: check.category, status: check.status, message: check.message } }); addEdge(edges, runId, id, "contains");
    for (const requirement of requirements) if (requirement.validators.includes(check.id)) addEdge(edges, `req:${requirement.id}`, id, "validated-by");
  }
  for (const [index, finding] of (input.findings ?? []).entries()) {
    const id = `finding:${finding.id || index}`; addNode(nodes, { id, type: "finding", label: finding.id, data: { severity: finding.severity, category: finding.category, evidence: finding.evidence } }); addEdge(edges, runId, id, "contains");
    const fileId = `file:${finding.location.file}`; if (!nodes.has(fileId)) addNode(nodes, { id: fileId, type: "file", label: finding.location.file }); addEdge(edges, id, fileId, "located-in");
  }
  for (const [index, session] of (input.sessions ?? []).entries()) {
    const id = `session:${session.id ?? `${session.logicalAgent ?? session.provider}-${index}`}`; addNode(nodes, { id, type: "agent-session", label: session.logicalAgent ?? session.provider, data: { runtime: session.runtime, model: session.model, exitCode: session.exitCode } }); addEdge(edges, runId, id, "produced");
  }
  if (input.delivery?.commitSha) {
    const id = `commit:${input.delivery.commitSha}`; addNode(nodes, { id, type: "commit", label: input.delivery.commitSha }); addEdge(edges, runId, id, "finalized-as");
  }
  if (input.delivery?.pullRequest?.number) {
    const id = `pr:${input.delivery.pullRequest.number}`; addNode(nodes, { id, type: "pull-request", label: `PR #${input.delivery.pullRequest.number}`, data: { url: input.delivery.pullRequest.url } }); addEdge(edges, runId, id, "delivered-by");
    if (input.delivery.commitSha) addEdge(edges, `commit:${input.delivery.commitSha}`, id, "delivered-by");
  }

  const coverage = requirements.map((requirement) => coverageFor(requirement, nodes, edges));
  const reasons: string[] = [];
  for (const item of coverage) {
    if (!item.implementation) reasons.push(`${item.requirementId} has no changed implementation evidence.`);
    if (!item.validation) reasons.push(`${item.requirementId} lacks PASS evidence for: ${item.missingValidators.join(", ") || "a declared validator"}.`);
  }
  const payload = { version: 1 as const, taskId: input.contract.task.id, createdAt: new Date().toISOString(), nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges: uniqueEdges(edges), requirements: coverage, complete: coverage.every((item) => item.complete), reasons };
  const graph: RequirementEvidenceGraph = { ...payload, sha256: digest(payload) };
  const output = path.resolve(stateRoot, input.config.evidence?.outputDir ?? ".harness/evidence", `${input.contract.task.id}.json`);
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, `${JSON.stringify(graph, null, 2)}\n`);
  return graph;
}

export function evidenceValidationCheck(graph: RequirementEvidenceGraph, config: HarnessProjectConfig): ValidationCheck {
  const strict = config.evidence?.requireComplete === true;
  return {
    id: "evidence.requirement-coverage",
    category: "evidence",
    status: graph.complete ? "PASS" : strict ? "FAIL" : "WARN",
    message: graph.complete ? `Requirement evidence graph complete for ${graph.requirements.length} requirement(s).` : `Requirement evidence graph is incomplete: ${graph.reasons.join("; ")}`,
    details: { sha256: graph.sha256, requirements: graph.requirements, strict }
  };
}

function normalizedRequirements(contract: TaskContract): Array<{ id: string; description: string; validators: string[] }> {
  if (contract.requirements?.length) return contract.requirements.map((item) => ({ id: item.id, description: item.description ?? item.id, validators: [...new Set([...(item.validators ?? []), ...(item.validator ? [item.validator] : [])])] }));
  return (contract.quick?.acceptance ?? []).map((description, index) => ({ id: `QUICK-AC-${index + 1}`, description, validators: (contract.verification?.validators ?? []).map((item) => item.id) }));
}

function coverageFor(requirement: { id: string; validators: string[] }, nodes: Map<string, EvidenceNode>, edges: EvidenceEdge[]): RequirementCoverage {
  const req = `req:${requirement.id}`;
  const taskIds = edges.filter((edge) => edge.from === req && edge.type === "implemented-by").map((edge) => edge.to);
  const files = [...new Set(taskIds.flatMap((task) => edges.filter((edge) => edge.from === task && edge.type === "changed").map((edge) => edge.to.replace(/^file:/, ""))))].sort();
  const validators = requirement.validators;
  const passingValidators = validators.filter((id) => nodes.get(`check:${id}`)?.data?.status === "PASS");
  const missingValidators = validators.filter((id) => !passingValidators.includes(id));
  const implementation = taskIds.length > 0 && (files.length > 0 || nodes.get(taskIds[0])?.data?.scope !== undefined);
  const validation = validators.length > 0 && missingValidators.length === 0;
  return { requirementId: requirement.id, implementation, validation, passingValidators, missingValidators, files, tasks: taskIds.map((id) => id.replace(/^task:/, "")), complete: implementation && validation };
}

function addNode(nodes: Map<string, EvidenceNode>, node: EvidenceNode): void { if (!nodes.has(node.id)) nodes.set(node.id, node); }
function addEdge(edges: EvidenceEdge[], from: string, to: string, type: EvidenceEdge["type"]): void { edges.push({ from, to, type }); }
function uniqueEdges(edges: EvidenceEdge[]): EvidenceEdge[] { const seen = new Set<string>(); return edges.filter((edge) => { const key = `${edge.from}\0${edge.type}\0${edge.to}`; if (seen.has(key)) return false; seen.add(key); return true; }).sort((a, b) => `${a.from}:${a.type}:${a.to}`.localeCompare(`${b.from}:${b.type}:${b.to}`)); }
function matches(file: string, scope: string): boolean { return scope === "**" || minimatch(file, scope, { dot: true }) || file.startsWith(scope.split(/[?*\[]/, 1)[0].replace(/\/+$/, "")); }
function digest(value: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
