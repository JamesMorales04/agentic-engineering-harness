import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { HarnessProjectConfig, RequirementTrace, TaskContract } from "./types.js";

const requiredArtifacts = ["proposal.md", "spec.md", "design.md", "tasks.yaml", "acceptance.feature"] as const;

export interface SddValidationResult {
  ok: boolean;
  missing: string[];
  issues: string[];
  requirements: RequirementTrace[];
}

export async function createSddChange(root: string, taskId: string, title: string, config?: HarnessProjectConfig): Promise<string> {
  const specsDir = config?.sdd?.specsDir ?? "specs";
  const dir = path.join(root, specsDir, "changes", taskId);
  const requirementId = `${taskId}-R1`;
  await fs.mkdir(dir, { recursive: true });

  const files: Record<string, string> = {
    "proposal.md": `# ${taskId}: ${title}\n\n## Problem\n\nTODO\n\n## Desired outcome\n\nTODO\n\n## Requirements\n\n- ${requirementId} — TODO observable requirement.\n\n## Scope\n\n## Non-goals\n`,
    "spec.md": `# Specification: ${title}\n\n## Requirements\n\n### ${requirementId}\n\nTODO observable behavior.\n\n## Invariants\n\nTODO\n`,
    "design.md": `# Design: ${title}\n\n## Current state\n\n## Proposed design\n\n## Requirement mapping\n\n- ${requirementId} — TODO implementation approach.\n\n## Data/API impact\n\n## Risks and trade-offs\n`,
    "tasks.yaml": `version: 1\ntask: ${taskId}\nitems:\n  - id: 1\n    title: Implement ${requirementId}\n    status: pending\n    requirements:\n      - ${requirementId}\n`,
    "acceptance.feature": `@${taskId}\nFeature: ${title}\n\n  Rule: TODO business rule\n\n    @${requirementId}\n    Scenario: TODO observable behavior\n      Given TODO\n      When TODO\n      Then TODO\n`
  };

  for (const [name, content] of Object.entries(files)) await writeIfMissing(path.join(dir, name), content);

  const contractsDir = path.join(root, config?.sdd?.contractsDir ?? ".harness/contracts");
  await fs.mkdir(contractsDir, { recursive: true });
  const contractPath = path.join(contractsDir, `${taskId}.yaml`);
  const contract: TaskContract = {
    version: 1,
    task: { id: taskId, title },
    source: {
      proposal: relative(root, path.join(dir, "proposal.md")),
      spec: relative(root, path.join(dir, "spec.md")),
      design: relative(root, path.join(dir, "design.md")),
      tasks: relative(root, path.join(dir, "tasks.yaml")),
      acceptance: relative(root, path.join(dir, "acceptance.feature"))
    },
    git: { baseRef: config?.validation?.baseRef ?? "main" },
    scope: { allowed: ["**"], forbidden: [], frozen: [] },
    requirements: [{ id: requirementId, description: "TODO observable requirement.", validators: ["gherkin"] }],
    constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false },
    repair: { maxAttempts: config?.orchestration?.worker?.maxRepairAttempts ?? 2 }
  };
  await writeIfMissing(contractPath, YAML.stringify(contract));
  return dir;
}

export async function validateSddChange(root: string, taskId: string, config?: HarnessProjectConfig): Promise<SddValidationResult> {
  const specsDir = config?.sdd?.specsDir ?? "specs";
  const dir = path.join(root, specsDir, "changes", taskId);
  const missing: string[] = [];
  const issues: string[] = [];
  const contents = new Map<string, string>();

  for (const name of requiredArtifacts) {
    try {
      const content = await fs.readFile(path.join(dir, name), "utf8");
      if (!content.trim()) missing.push(name); else contents.set(name, content);
    } catch { missing.push(name); }
  }
  if (missing.length) return { ok: false, missing, issues, requirements: [] };

  const spec = contents.get("spec.md") ?? "";
  const proposal = contents.get("proposal.md") ?? "";
  const design = contents.get("design.md") ?? "";
  const acceptance = contents.get("acceptance.feature") ?? "";
  const tasksRaw = contents.get("tasks.yaml") ?? "";
  const requirementIds = extractRequirementIds(spec);
  if (!requirementIds.length) issues.push("spec.md defines no traceable requirement IDs (expected e.g. CHANGE-123-R1 or REQ-001).");

  const taskRequirements = extractTaskRequirements(tasksRaw);
  const contract = await tryLoadContract(root, taskId, config);
  if (!contract) issues.push(`TaskContract ${taskId}.yaml is missing or unreadable.`);
  const known = config ? knownValidatorNames(config, contract) : undefined;

  const traces: RequirementTrace[] = requirementIds.map((id) => {
    const contractRequirement = contract?.requirements?.find((item) => item.id === id);
    const validators = normalizeValidators(contractRequirement);
    const trace: RequirementTrace = {
      id,
      proposal: proposal.includes(id),
      spec: true,
      design: design.includes(id),
      acceptance: containsTag(acceptance, id),
      tasks: taskRequirements.has(id),
      contract: Boolean(contractRequirement),
      validators
    };
    for (const field of ["proposal", "design", "acceptance", "tasks", "contract"] as const) {
      if (!trace[field]) issues.push(`${id} is not traceable through ${field}.`);
    }
    if (!validators.length) issues.push(`${id} has no validator declared in the TaskContract.`);
    if (known) {
      for (const validator of validators) {
        const name = validator.split(":", 1)[0];
        if (!known.has(name) && !known.has(validator)) issues.push(`${id} references unknown validator '${validator}'.`);
      }
    }
    return trace;
  });

  for (const requirement of contract?.requirements ?? []) {
    if (!requirementIds.includes(requirement.id)) issues.push(`${requirement.id} exists in the TaskContract but not in spec.md.`);
  }
  return { ok: issues.length === 0, missing, issues, requirements: traces };
}

export function formatTraceabilityMatrix(requirements: RequirementTrace[]): string {
  if (!requirements.length) return "No requirements found.";
  const header = "Requirement | Proposal | Spec | Design | Gherkin | Tasks | Contract | Validators";
  const separator = "---|---|---|---|---|---|---|---";
  const rows = requirements.map((item) => [item.id, mark(item.proposal), mark(item.spec), mark(item.design), mark(item.acceptance), mark(item.tasks), mark(item.contract), item.validators.length ? item.validators.join(",") : "✗"].join(" | "));
  return [header, separator, ...rows].join("\n");
}

function extractRequirementIds(spec: string): string[] {
  const ids = new Set<string>();
  const heading = /^###\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s*$/gm;
  for (const match of spec.matchAll(heading)) {
    const candidate = match[1];
    if (/-R\d+$/i.test(candidate) || /^REQ-\d+$/i.test(candidate)) ids.add(candidate);
  }
  return [...ids];
}

function extractTaskRequirements(raw: string): Set<string> {
  try {
    const parsed = YAML.parse(raw) as { items?: Array<{ requirements?: string[] }> };
    return new Set((parsed.items ?? []).flatMap((item) => item.requirements ?? []));
  } catch { return new Set(); }
}

async function tryLoadContract(root: string, taskId: string, config?: HarnessProjectConfig): Promise<TaskContract | undefined> {
  const contractsDir = config?.sdd?.contractsDir ?? ".harness/contracts";
  try { return YAML.parse(await fs.readFile(path.join(root, contractsDir, `${taskId}.yaml`), "utf8")) as TaskContract; }
  catch { return undefined; }
}

function knownValidatorNames(config: HarnessProjectConfig, contract?: TaskContract): Set<string> {
  const names = new Set<string>();
  for (const validator of [...(config.validation?.validators ?? []), ...(contract?.verification?.validators ?? [])]) {
    names.add(validator.id); names.add(validator.adapter);
  }
  for (const command of [...(config.validation?.commands ?? []), ...(contract?.verification?.commands ?? [])]) names.add(command.id);
  return names;
}

function normalizeValidators(requirement?: { validator?: string; validators?: string[] }): string[] {
  return [...new Set([...(requirement?.validators ?? []), ...(requirement?.validator ? [requirement.validator] : [])])];
}

function containsTag(content: string, tag: string): boolean {
  return new RegExp(`(^|\\s)@${escapeRegExp(tag)}(?=\\s|$)`, "m").test(content);
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
async function writeIfMissing(file: string, content: string): Promise<void> {
  try { await fs.access(file); } catch { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
}
function relative(root: string, file: string): string { return path.relative(root, file).replaceAll("\\", "/"); }
function mark(value: boolean): string { return value ? "✓" : "✗"; }
