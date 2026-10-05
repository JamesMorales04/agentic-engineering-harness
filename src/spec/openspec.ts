import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { HarnessProjectConfig, TaskContract, ValidationCommand } from "../core/types.js";
import { getCurrentBranch } from "../core/git.js";
import { AehError } from "../core/errors.js";
import { runShell } from "../utils/process.js";
import { isValidationCapability } from "../validation/capabilityCatalog.js";

export interface OpenSpecAuthoringConfig { provider?: "openspec" | "native" | string; schema?: string; managerAgent?: string; }
export interface OpenSpecPreparedChange { taskId: string; changeName: string; directory: string; schema: string; managerAgent: string; }
export interface OpenSpecCompileResult { taskId: string; changeName: string; sddDirectory: string; contractPath: string; requirements: string[]; sourceSha256: string; validatorId: string; }
export interface OpenSpecPreflightResult { version: string; schema: string; managerAgent: string; }
/** One capability's canonical OpenSpec change spec delta (`specs/<capability>/spec.md`). */
export interface OpenSpecSpecDeltaV1 { capability: string; content: string; }
export interface OpenSpecAuthoringContentV1 {
  proposal: string;
  design?: string;
  tasks: string;
  specs: readonly OpenSpecSpecDeltaV1[];
}

type SddWithAuthoring = NonNullable<HarnessProjectConfig["sdd"]> & { authoring?: OpenSpecAuthoringConfig };
const OPENSPEC_ENV = { OPENSPEC_NO_ANIMATION: "1", OPENSPEC_NO_UPDATE_CHECK: "1" };

export function openSpecAuthoringConfig(config: HarnessProjectConfig): Required<Pick<OpenSpecAuthoringConfig, "provider" | "schema" | "managerAgent">> {
  const authoring = (config.sdd as SddWithAuthoring | undefined)?.authoring;
  return { provider: authoring?.provider ?? "openspec", schema: authoring?.schema ?? "spec-driven", managerAgent: authoring?.managerAgent ?? "spec-manager" };
}

export function openSpecChangeName(taskId: string): string {
  const normalized = taskId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
  if (!normalized) throw new Error("Task id cannot be converted to a valid OpenSpec change name.");
  return normalized;
}

export async function preflightOpenSpec(root: string, config: HarnessProjectConfig, run = runShell): Promise<OpenSpecPreflightResult> {
  const settings = openSpecAuthoringConfig(config);
  if (settings.provider !== "openspec") throw new Error(`Configured SDD authoring provider is '${settings.provider}', not openspec.`);
  const options = { cwd: root, timeoutMs: 30_000, env: OPENSPEC_ENV };
  const version = await run("openspec --version", options);
  if (version.exitCode !== 0) throw new Error(`OPENSPEC_UNAVAILABLE: ${version.stderr || version.stdout || "openspec --version failed"}`);
  const createHelp = await run("openspec new change --help", options);
  if (createHelp.exitCode !== 0) throw new Error(`OPENSPEC_CAPABILITY_UNAVAILABLE: 'openspec new change' is unavailable: ${createHelp.stderr || createHelp.stdout}`);
  const createText = `${createHelp.stdout}\n${createHelp.stderr}`;
  for (const flag of ["--schema", "--description"]) {
    if (!createText.includes(flag)) throw new Error(`OPENSPEC_CAPABILITY_UNAVAILABLE: 'openspec new change' does not advertise required option ${flag}.`);
  }
  const validateHelp = await run("openspec validate --help", options);
  if (validateHelp.exitCode !== 0) throw new Error(`OPENSPEC_CAPABILITY_UNAVAILABLE: 'openspec validate' is unavailable: ${validateHelp.stderr || validateHelp.stdout}`);
  if (!`${validateHelp.stdout}\n${validateHelp.stderr}`.includes("--strict")) throw new Error("OPENSPEC_CAPABILITY_UNAVAILABLE: 'openspec validate' does not advertise required option --strict.");
  return { version: firstLine(version.stdout || version.stderr) || "unknown", schema: settings.schema, managerAgent: settings.managerAgent };
}

export async function prepareOpenSpecChange(root: string, config: HarnessProjectConfig, taskId: string): Promise<OpenSpecPreparedChange> {
  const settings = openSpecAuthoringConfig(config);
  if (settings.provider !== "openspec") throw new Error(`Configured SDD authoring provider is '${settings.provider}', not openspec.`);
  const changeName = openSpecChangeName(taskId);
  const directory = path.join(root, "openspec", "changes", changeName);
  // CandidateRevision is frozen before participant execution. OpenSpec's `new change` command
  // writes placeholder files into the project tree, which would invalidate that binding before
  // the read-only Spec Manager can submit its result. The Spec Manager returns the complete
  // structured authoring content; the controller persists it after that result is accepted.
  return { taskId, changeName, directory, schema: settings.schema, managerAgent: settings.managerAgent };
}

export const OPENSPEC_CAPABILITY_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPENSPEC_DELTA_HEADER_PATTERN = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/;
const OPENSPEC_REQUIREMENT_PATTERN = /^###\s+Requirement:\s*(.+?)\s*$/;
const OPENSPEC_SCENARIO_PATTERN = /^####\s+Scenario:\s*(.+?)\s*$/;
/**
 * DETERMINISTIC canonical tasks checkbox shape. `openspec validate --strict` counts a
 * change as 0 tasks when no line in its task files is a checkbox (`- [ ] 1.1 Description`);
 * dash bullets without checkboxes, numbered lists and prose all fail compilation. The
 * pre-persistence gate mirrors that exact rule so a READY result without a checkbox fails
 * here with the exact artifact instead of inside the compiler (CHANGE-20261005T060646Z rev61).
 * Shared with `parseTasks` below; do not diverge the pattern without updating the drift-guard
 * cross-test (`tests/specContentGate.test.ts` mirror==compiler).
 */
export const OPENSPEC_TASK_CHECKBOX_PATTERN = /^\s*-\s*\[( |x|X)\]/m;

function specDeltaArtifactLabel(changeName: string, index: number, capability: string): string {
  return `openspec/changes/${changeName}/specs/${capability || `<capability-${index + 1}>`}/spec.md (artifacts.specs[${index}])`;
}

function notCanonical(artifact: string, detail: string): AehError {
  return new AehError("SPEC_MANAGER_CONTENT_NOT_CANONICAL", `${artifact}: ${detail}`, { details: { artifact } });
}

/**
 * DETERMINISTIC pre-persistence canonicality gate for a READY Spec Manager result. OpenSpec
 * compilation (`openspec validate --strict`) requires a canonical change layout; accepting a
 * typed-but-non-canonical READY result would persist unusable content and fail later inside the
 * compiler with a generic error. This gate rejects the result before any controller-owned write,
 * with a typed `SPEC_MANAGER_CONTENT_NOT_CANONICAL` error naming the exact artifact.
 */
export function validateOpenSpecSpecDeltaCanonicalityV1(changeName: string, index: number, spec: OpenSpecSpecDeltaV1): void {
  const artifact = specDeltaArtifactLabel(changeName, index, spec?.capability?.trim() ?? "");
  if (!spec || typeof spec !== "object" || typeof spec.capability !== "string" || typeof spec.content !== "string") throw notCanonical(artifact, "spec delta must provide a canonical capability name and its complete markdown content.");
  if (!OPENSPEC_CAPABILITY_NAME_PATTERN.test(spec.capability.trim())) throw notCanonical(artifact, `capability name '${spec.capability}' is not a canonical kebab-case OpenSpec capability name.`);
  if (!spec.content.trim()) throw notCanonical(artifact, "spec delta content is empty.");
  let deltaSeen = false;
  let requirementCount = 0;
  let openRequirement = "";
  let openRequirementScenarios = 0;
  let openRequirementNormative = false;
  // OpenSpec `validate --strict` rejects a requirement whose text has no normative keyword; the
  // pre-persistence gate must mirror that rule so a READY result without SHALL/MUST fails here with
  // the exact artifact instead of inside the compiler (AEH-V2-0111/0115).
  const normativePattern = /\b(SHALL|MUST)\b/;
  const closeRequirement = (): void => {
    if (!openRequirement) return;
    if (openRequirementScenarios === 0) throw notCanonical(artifact, `requirement '${openRequirement}' has no '#### Scenario:' block; every canonical requirement needs at least one scenario.`);
    if (!openRequirementNormative) throw notCanonical(artifact, `requirement '${openRequirement}' must contain the normative keyword SHALL or MUST; OpenSpec strict validation rejects non-normative requirements.`);
  };
  for (const line of spec.content.split(/\r?\n/)) {
    if (OPENSPEC_DELTA_HEADER_PATTERN.test(line)) {
      closeRequirement();
      openRequirement = "";
      openRequirementScenarios = 0;
      openRequirementNormative = false;
      deltaSeen = true;
      continue;
    }
    const requirement = OPENSPEC_REQUIREMENT_PATTERN.exec(line);
    if (requirement) {
      if (!deltaSeen) throw notCanonical(artifact, "flat requirement document found: '### Requirement:' appears before any delta section (for example '## ADDED Requirements'). Canonical OpenSpec change deltas require an ADDED/MODIFIED/REMOVED/RENAMED Requirements section.");
      closeRequirement();
      openRequirement = requirement[1].trim();
      openRequirementScenarios = 0;
      openRequirementNormative = normativePattern.test(line);
      requirementCount += 1;
      continue;
    }
    const scenario = OPENSPEC_SCENARIO_PATTERN.exec(line);
    if (scenario) {
      if (!openRequirement) throw notCanonical(artifact, `'#### Scenario: ${scenario[1].trim()}' appears outside a '### Requirement:' block.`);
      openRequirementScenarios += 1;
    } else if (openRequirement && normativePattern.test(line)) {
      openRequirementNormative = true;
    }
  }
  closeRequirement();
  if (!deltaSeen) throw notCanonical(artifact, "no delta sections found. Add a '## ADDED Requirements', '## MODIFIED Requirements', '## REMOVED Requirements' or '## RENAMED Requirements' section; the change must have at least one delta.");
  if (requirementCount === 0) throw notCanonical(artifact, "delta sections contain no '### Requirement:' entry; the change must have at least one delta requirement.");
}

export function validateOpenSpecAuthoringContentCanonicalityV1(changeName: string, content: Pick<OpenSpecAuthoringContentV1, "specs">): void {
  if (!Array.isArray(content.specs) || content.specs.length === 0) {
    throw new AehError("SPEC_MANAGER_CONTENT_NOT_CANONICAL", `openspec/changes/${changeName}/specs (artifacts.specs): at least one canonical capability spec delta is required; OpenSpec changes must contain at least one delta.`, { details: { artifact: `openspec/changes/${changeName}/specs (artifacts.specs)` } });
  }
  const capabilities = new Set<string>();
  content.specs.forEach((spec, index) => {
    validateOpenSpecSpecDeltaCanonicalityV1(changeName, index, spec);
    const capability = spec.capability.trim();
    if (capabilities.has(capability)) throw notCanonical(specDeltaArtifactLabel(changeName, index, capability), `capability '${capability}' is declared more than once.`);
    capabilities.add(capability);
  });
}

/**
 * DETERMINISTIC pre-persistence canonicality gate for `tasks.md` (CHANGE-20261005T060646Z rev61).
 * Mirrors the exact `openspec validate --strict` rule: the change must contain at least one
 * checkbox task line (`- [ ] 1.1 Description`). Dash bullets without checkboxes, numbered
 * lists and prose count as 0 tasks and fail compilation; they are rejected here with a typed
 * `SPEC_MANAGER_CONTENT_NOT_CANONICAL` error naming `tasks.md (artifacts.tasks)`.
 */
export function validateOpenSpecTasksCanonicalityV1(changeName: string, tasks: string | undefined): void {
  const artifact = `openspec/changes/${changeName}/tasks.md (artifacts.tasks)`;
  if (typeof tasks !== "string" || !tasks.trim()) throw notCanonical(artifact, "tasks.md content is empty; the change must have at least one checkbox task.");
  if (!OPENSPEC_TASK_CHECKBOX_PATTERN.test(tasks)) throw notCanonical(artifact, "tasks.md counts as 0 tasks: no line is a checkbox task. Write each task as '- [ ] 1.1 Description'; dash bullets without checkboxes, numbered lists and prose are rejected before persistence.");
}

/** Persist the validated Spec Manager's structured authoring content using controller-owned writes. */
export async function persistOpenSpecAuthoringContentV1(root: string, changeName: string, content: OpenSpecAuthoringContentV1): Promise<string[]> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changeName)) throw new Error("OPENSPEC_CHANGE_NAME_INVALID: authoring output can only be persisted under a canonical change name.");
  if (!content.proposal.trim() || !content.tasks.trim()) throw new Error("OPENSPEC_AUTHORING_CONTENT_INCOMPLETE: proposal and tasks content are required.");
  validateOpenSpecTasksCanonicalityV1(changeName, content.tasks);
  validateOpenSpecAuthoringContentCanonicalityV1(changeName, content);
  const directory = path.join(root, "openspec", "changes", changeName);
  const files: Array<[string, string]> = [
    [path.join(directory, "proposal.md"), content.proposal],
    [path.join(directory, "tasks.md"), content.tasks]
  ];
  if (content.design?.trim()) files.push([path.join(directory, "design.md"), content.design]);
  content.specs.forEach((spec) => {
    files.push([path.join(directory, "specs", spec.capability.trim(), "spec.md"), spec.content]);
  });
  for (const [file, text] of files) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${text.trimEnd()}\n`, "utf8");
  }
  return files.map(([file]) => relative(root, file));
}

export async function compileOpenSpecChange(root: string, config: HarnessProjectConfig, taskId: string, title: string, changeName = openSpecChangeName(taskId), run = runShell, request?: string): Promise<OpenSpecCompileResult> {
  const changeDir = path.join(root, "openspec", "changes", changeName);
  const validation = await run(`openspec validate ${quote(changeName)} --strict`, { cwd: root, timeoutMs: 60_000, env: OPENSPEC_ENV });
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
    ...(request !== undefined ? { request } : {}),
    source: { proposal: relative(root, path.join(sddDir, "proposal.md")), spec: relative(root, path.join(sddDir, "spec.md")), design: relative(root, path.join(sddDir, "design.md")), tasks: relative(root, path.join(sddDir, "tasks.yaml")), acceptance: relative(root, path.join(sddDir, "acceptance.feature")) },
    authoring: { provider: "openspec", change: changeName, sourceSha256 },
    git: { baseRef: config.validation?.baseRef ?? "main", ...(originatingBranch ? { originatingBranch } : {}) },
    scope: { allowed: ["**"], forbidden: [], frozen: [] },
    routing: { intent: "implement", domains: [], risk: "medium" },
    requirements: ids.map((id, index) => ({ id, description: requirementSources[index].title, validators: [requirementValidation.id], ...(requirementValidation.capability ? { capabilities: [requirementValidation.capability] } : {}) })),
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

async function resolveRequirementValidation(root: string, config: HarnessProjectConfig): Promise<{ id: string; command?: ValidationCommand; capability?: string }> {
  const preferredIds = ["test", "typecheck", "build"];
  for (const id of preferredIds) {
    const command = (config.validation?.commands ?? []).find((item) => item.id === id && item.required !== false);
    if (command) return { id };
    const validator = (config.validation?.validators ?? []).find((item) => item.id === id && item.required !== false);
    if (validator) return { id, capability: capabilityForAdapter(validator.adapter) };
  }
  const validator = config.validation?.validators?.find((item) => item.required !== false);
  if (validator) return { id: validator.id, capability: capabilityForAdapter(validator.adapter) };
  const provider = config.validation?.providers?.find((item) => item.required !== false);
  if (provider) {
    if (!isValidationCapability(provider.capability)) throw new Error(`OpenSpec provider '${provider.id}' declares unsupported requirement capability '${provider.capability}'.`);
    return { id: `capability:${provider.capability}`, capability: provider.capability };
  }
  const command = config.validation?.commands?.find((item) => item.required !== false);
  if (command) return { id: command.id };

  const packageJson = await readPackageJson(root);
  const scripts = packageJson?.scripts ?? {};
  for (const id of preferredIds) {
    if (typeof scripts[id] === "string" && scripts[id].trim()) return { id, command: { id, command: id === "test" ? "npm test" : `npm run ${id}`, required: true, timeoutSeconds: 900 } };
  }
  throw new Error("OpenSpec compilation requires deterministic requirement validation. Configure validation.commands/validators/providers or provide a project test/typecheck/build script before compiling the SPEC.");
}

async function readPackageJson(root: string): Promise<{ scripts?: Record<string, unknown> } | undefined> { try { return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }; } catch { return undefined; } }
function capabilityForAdapter(adapter: string): string | undefined { if (["gherkin", "bdd"].includes(adapter)) return "bdd"; if (["test-execution", "unit-test"].includes(adapter)) return "unit-test"; if (["integration-test", "integration-environment"].includes(adapter)) return "integration-test"; if (["pact", "contract-test"].includes(adapter)) return "contract-test"; return undefined; }
function approvedOutcome(proposal: string): string { const outcome = proposal.match(/##\s+(?:Desired outcome|Why|What Changes)\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1]?.trim(); return outcome || proposal.trim(); }
async function collectMarkdown(dir: string): Promise<string[]> { const result: string[] = []; async function visit(current: string): Promise<void> { const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []); for (const entry of entries) { const full = path.join(current, entry.name); if (entry.isDirectory()) await visit(full); else if (entry.isFile() && entry.name.endsWith(".md")) result.push(full); } } await visit(dir); return result.sort(); }
async function hashOpenSpecChange(dir: string): Promise<string> { const hash = crypto.createHash("sha256"); for (const file of await collectAllFiles(dir)) { hash.update(relative(dir, file)); hash.update(await fs.readFile(file)); } return hash.digest("hex"); }
async function collectAllFiles(dir: string): Promise<string[]> { const result: string[] = []; async function visit(current: string): Promise<void> { const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []); for (const entry of entries) { const full = path.join(current, entry.name); if (entry.isDirectory()) await visit(full); else if (entry.isFile()) result.push(full); } } await visit(dir); return result.sort(); }
async function readOptional(file: string): Promise<string> { return fs.readFile(file, "utf8").catch(() => ""); }
function firstLine(value: string): string { return value.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? ""; }
function relative(root: string, file: string): string { return path.relative(root, file).replaceAll("\\", "/"); }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
