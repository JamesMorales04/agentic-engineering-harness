import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { HarnessProjectConfig, TaskContract, ValidationCommand } from "../core/types.js";
import { getCurrentBranch } from "../core/git.js";
import { runProcess } from "../utils/process.js";

export interface OpenSpecAuthoringConfig { provider?: "openspec" | "native" | string; schema?: string; managerAgent?: string; }
export interface OpenSpecPreparedChange { taskId: string; changeName: string; directory: string; created: boolean; schema: string; managerAgent: string; }
export interface OpenSpecCompileResult { taskId: string; changeName: string; sddDirectory: string; contractPath: string; requirements: string[]; sourceSha256: string; validatorId: string; }

type SddWithAuthoring = NonNullable<HarnessProjectConfig["sdd"]> & { authoring?: OpenSpecAuthoringConfig };

export function openSpecAuthoringConfig(config: HarnessProjectConfig): Required<Pick<OpenSpecAuthoringConfig, "provider" | "schema" | "managerAgent">> {
  const authoring = (config.sdd as SddWithAuthoring | undefined)?.authoring;
  return { provider: authoring?.provider ?? "openspec", schema: authoring?.schema ?? "spec-driven", managerAgent: authoring?.managerAgent ?? "spec-manager" };
}

export function openSpecChangeName(taskId: string): string {
  const normalized = taskId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
  if (!normalized) throw new Error("Task id cannot be converted to a valid OpenSpec change name.");
  return normalized;
}

export async function prepareOpenSpecChange(root: string, config: HarnessProjectConfig, taskId: string, title: string, run = runProcess): Promise<OpenSpecPreparedChange> {
  const settings = openSpecAuthoringConfig(config);
  if (settings.provider !== "openspec") throw new Error(`Configured SDD authoring provider is '${settings.provider}', not openspec.`);
  const changeName = openSpecChangeName(taskId);
  const directory = path.join(root, "openspec", "changes", changeName);
  let created = false;
  try { await fs.access(directory); }
  catch {
    const command = `openspec new change ${quote(changeName)} --schema ${quote(settings.schema)} --description ${quote(title)} --json`;
    const result = await run(command, { cwd: root, timeoutMs: 60_000, env: { OPENSPEC_NO_ANIMATION: "1", OPENSPEC_NO_UPDATE_CHECK: "1" } });
    if (result.exitCode !== 0) throw new Error(`OpenSpec failed to create change '${changeName}': ${result.stderr || result.stdout}`);
    created = true;
  }
  return { taskId, changeName, directory, created, schema: settings.schema, managerAgent: settings.managerAgent };
}

export async function compileOpenSpecChange(root: string, config: HarnessProjectConfig, taskId: string, title: string, changeName = openSpecChangeName(taskId), run = runProcess): Promise<OpenSpecCompileResult> {
  const changeDir = path.join(root, "openspec", "changes", changeName);
  const validation = await run(`openspec validate ${quote(changeName)} --strict --json`, { cwd: root, timeoutMs: 60_000, env: { OPENSPEC_NO_ANIMATION: "1", OPENSPEC_NO_UPDATE_CHECK: "1" } });
  if (validation.exitCode !== 0) throw new Error(`OpenSpec change '${changeName}' is not valid and cannot be compiled into AEH normative artifacts: ${validation.stderr || validation.stdout}`);

  const proposal = await readOptional(path.join(changeDir, "proposal.md"));
  const design = await readOptional(path.join(changeDir, "design.md"));
  const tasksMarkdown = await readOptional(path.join(changeDir, "tasks.md"));
  if (!proposal.trim()) throw new Error(`OpenSpec change '${changeName}' has no proposal.md.`);
  if (!tasksMarkdown.trim()) throw new Error(`OpenSpec change '${changeName}' has no tasks.md.`);
  const specFiles = await collectMarkdown(path.join(changeDir, "specs"));
  const specDocuments = await Promise.all(specFiles.map(async (file) => ({ file, content: await fs.readFile(file, "utf8") })));
  const parsed = parseRequirements(specDocuments);
  const requirementSources = parsed.length ? parsed : [{ title: "Preserve approved behavior", body: approvedOutcome(proposal), scenarios: [{ title: "Approved change preserves observable behavior", given: "the current behavior is covered by deterministic validation", when: "the approved OpenSpec change is implemented", then: "observable behavior remains compatible except where the proposal explicitly requires change" }] }];
  const ids = requirementSources.map((_, index) => `${taskId}-R${index + 1}`);
  const requirementValidation = await resolveRequirementValidation(root, config);
  const specsDir = config.sdd?.specsDir ?? "specs";
  const sddDir = path.join(root, specsDir, "changes", taskId); await fs.mkdir(sddDir, { recursive: true });

  const proposalOut = `${proposal.trim()}\n\n## AEH requirement mapping\n\n${requirementSources.map((item, index) => `- ${ids[index]} — ${item.title}`).join("\n")}\n\n> Authored with OpenSpec change \`${changeName}\`; compiled deterministically into AEH normative artifacts.\n`;
  const specOut = [`# Specification: ${title}`, "", "## Requirements", "", ...requirementSources.flatMap((item, index) => [`### ${ids[index]} — ${item.title}`, "", item.body.trim() || item.title, ""]), "## OpenSpec provenance", "", `- Change: \`${changeName}\``, `- Source files: ${specDocuments.map((item) => `\`${relative(root, item.file)}\``).join(", ") || "proposal-only refactor/tooling change"}`, ""].join("\n");
  const designOut = `${(design.trim() || `# Design: ${title}\n\nOpenSpec did not require a separate design artifact for this change.`)}\n\n## AEH requirement mapping\n\n${requirementSources.map((item, index) => `- ${ids[index]} — ${item.title}`).join("\n")}\n`;
  const tasks = parseTasks(tasksMarkdown, ids, requirementSources.map((item) => item.title));
  const acceptance = buildAcceptanceFeature(taskId, title, ids, requirementSources);
  await Promise.all([
    fs.writeFile(path.join(sddDir, "proposal.md"), proposalOut),
    fs.writeFile(path.join(sddDir, "spec.md"), specOut),
    fs.writeFile(path.join(sddDir, "design.md"), designOut),
    fs.writeFile(path.join(sddDir, "tasks.yaml"), YAML.stringify({ version: 1, task: taskId, items: tasks })),
    fs.writeFile(path.join(sddDir, "acceptance.feature"), acceptance)
  ]);

  const originatingBranch = await getCurrentBranch(root);
  const contractsDir = path.join(root, config.sdd?.contractsDir ?? ".harness/contracts"); await fs.mkdir(contractsDir, { recursive: true });
  const contractPath = path.join(contractsDir, `${taskId}.yaml`);
  const sourceSha256 = await hashOpenSpecChange(changeDir);
  const contract: TaskContract = {
    version: 1,
    task: { id: taskId, title },
    source: { proposal: relative(root, path.join(sddDir, "proposal.md")), spec: relative(root, path.join(sddDir, "spec.md")), design: relative(root, path.join(sddDir, "design.md")), tasks: relative(root, path.join(sddDir, "tasks.yaml")), acceptance: relative(root, path.join(sddDir, "acceptance.feature")) },
    authoring: { provider: "openspec", change: changeName, sourceSha256 },
    git: { baseRef: config.validation?.baseRef ?? "main", ...(originatingBranch ? { originatingBranch } : {}) },
    scope: { allowed: ["**"], forbidden: [], frozen: [] },
    routing: { intent: "implement", domains: [], risk: "medium" },
    requirements: ids.map((id, index) => ({ id, description: requirementSources[index].title, validators: [requirementValidation.id] })),
    constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false },
    repair: { maxAttempts: config.orchestration?.worker?.maxRepairAttempts ?? 2 },
    ...(requirementValidation.command ? { verification: { commands: [requirementValidation.command] } } : {})
  };
  await fs.writeFile(contractPath, YAML.stringify(contract));
  return { taskId, changeName, sddDirectory: sddDir, contractPath, requirements: ids, sourceSha256, validatorId: requirementValidation.id };
}

interface ParsedRequirement { title: string; body: string; scenarios: Array<{ title: string; given?: string; when?: string; then?: string }> }
function parseRequirements(documents: Array<{ file: string; content: string }>): ParsedRequirement[] {
  const result: ParsedRequirement[] = [];
  for (const document of documents) {
    const requirementMatches = [...document.content.matchAll(/^###\s+Requirement:\s*(.+?)\s*$/gim)];
    for (let index = 0; index < requirementMatches.length; index += 1) {
      const match = requirementMatches[index]; const start = (match.index ?? 0) + match[0].length; const end = requirementMatches[index + 1]?.index ?? document.content.length; const section = document.content.slice(start, end).trim();
      result.push({ title: match[1].trim(), body: section.replace(/^####\s+Scenario:[\s\S]*$/im, "").trim(), scenarios: parseScenarios(section) });
    }
  }
  return result;
}
function parseScenarios(section: string): ParsedRequirement["scenarios"] {
  const matches = [...section.matchAll(/^####\s+Scenario:\s*(.+?)\s*$/gim)];
  return matches.map((match, index) => { const start = (match.index ?? 0) + match[0].length; const end = matches[index + 1]?.index ?? section.length; const body = section.slice(start, end); return { title: match[1].trim(), given: bullet(body, "GIVEN"), when: bullet(body, "WHEN"), then: bullet(body, "THEN") }; });
}
function bullet(body: string, keyword: string): string | undefined { return body.match(new RegExp(`^-\\s*\\*\\*${keyword}\\*\\*\\s*(.+)$`, "im"))?.[1]?.trim(); }
function parseTasks(markdown: string, requirementIds: string[], titles: string[]): Array<{ id: number; title: string; status: string; requirements: string[] }> {
  const matches = [...markdown.matchAll(/^\s*-\s*\[( |x|X)\]\s*(.+?)\s*$/gm)];
  if (!matches.length) return requirementIds.map((id, index) => ({ id: index + 1, title: `Implement ${titles[index]}`, status: "pending", requirements: [id] }));
  return matches.map((match, index) => ({ id: index + 1, title: match[2].trim(), status: /x/i.test(match[1]) ? "done" : "pending", requirements: [...requirementIds] }));
}
function buildAcceptanceFeature(taskId: string, title: string, ids: string[], requirements: ParsedRequirement[]): string {
  const lines = [`@${taskId}`, `Feature: ${title}`, ""];
  requirements.forEach((requirement, index) => {
    const scenarios = requirement.scenarios.length ? requirement.scenarios : [{ title: requirement.title, given: "the repository is in the sealed pre-change state", when: "the approved change is implemented", then: requirement.body.trim().split(/\r?\n/).find(Boolean) ?? requirement.title }];
    lines.push(`  Rule: ${requirement.title}`, "");
    scenarios.forEach((scenario) => { lines.push(`    @${ids[index]}`, `    Scenario: ${scenario.title}`, `      Given ${scenario.given ?? "the relevant preconditions from the approved specification hold"}`, `      When ${scenario.when ?? "the approved behavior is exercised"}`, `      Then ${scenario.then ?? requirement.title}`, ""); });
  });
  return `${lines.join("\n")}\n`;
}

async function resolveRequirementValidation(root: string, config: HarnessProjectConfig): Promise<{ id: string; command?: ValidationCommand }> {
  const preferredIds = ["test", "typecheck", "build"];
  for (const id of preferredIds) {
    const command = (config.validation?.commands ?? []).find((item) => item.id === id && item.required !== false);
    if (command) return { id };
    const validator = (config.validation?.validators ?? []).find((item) => item.id === id && item.required !== false);
    if (validator) return { id };
  }
  const validator = config.validation?.validators?.find((item) => item.required !== false);
  if (validator) return { id: validator.id };
  const command = config.validation?.commands?.find((item) => item.required !== false);
  if (command) return { id: command.id };

  const packageJson = await readPackageJson(root);
  const scripts = packageJson?.scripts ?? {};
  for (const id of preferredIds) {
    if (typeof scripts[id] === "string" && scripts[id].trim()) return { id, command: { id, command: id === "test" ? "npm test" : `npm run ${id}`, required: true, timeoutSeconds: 900 } };
  }
  const rootFiles = await fs.readdir(root).catch(() => [] as string[]);
  if (rootFiles.some((name) => name.endsWith(".sln") || name.endsWith(".slnx") || name.endsWith(".csproj")) || rootFiles.includes("global.json")) return { id: "test", command: { id: "test", command: "dotnet test", required: true, timeoutSeconds: 1200 } };
  throw new Error("OpenSpec compilation requires deterministic requirement validation. Configure validation.commands/validators or provide a project test/typecheck/build script (or a .NET solution/project) before compiling the SPEC.");
}

async function readPackageJson(root: string): Promise<{ scripts?: Record<string, unknown> } | undefined> { try { return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }; } catch { return undefined; } }
function approvedOutcome(proposal: string): string { const outcome = proposal.match(/##\s+(?:Desired outcome|Why|What Changes)\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1]?.trim(); return outcome || proposal.trim(); }
async function collectMarkdown(dir: string): Promise<string[]> { const result: string[] = []; async function visit(current: string): Promise<void> { const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []); for (const entry of entries) { const full = path.join(current, entry.name); if (entry.isDirectory()) await visit(full); else if (entry.isFile() && entry.name.endsWith(".md")) result.push(full); } } await visit(dir); return result.sort(); }
async function hashOpenSpecChange(dir: string): Promise<string> { const hash = crypto.createHash("sha256"); for (const file of await collectAllFiles(dir)) { hash.update(relative(dir, file)); hash.update(await fs.readFile(file)); } return hash.digest("hex"); }
async function collectAllFiles(dir: string): Promise<string[]> { const result: string[] = []; async function visit(current: string): Promise<void> { const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []); for (const entry of entries) { const full = path.join(current, entry.name); if (entry.isDirectory()) await visit(full); else if (entry.isFile()) result.push(full); } } await visit(dir); return result.sort(); }
async function readOptional(file: string): Promise<string> { return fs.readFile(file, "utf8").catch(() => ""); }
function relative(root: string, file: string): string { return path.relative(root, file).replaceAll("\\", "/"); }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
