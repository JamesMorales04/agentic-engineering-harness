import fs from "node:fs/promises";
import path from "node:path";
import type { ValidationCapability } from "../../core/types.js";
import { commandExists } from "../../utils/process.js";
import { configuredCommand, doctorForCommand, executePlan, fileExists, resolveCwd } from "./providerUtils.js";
import { parseJson, persistRawArtifact } from "./protocol.js";
import type { BddExecutionResult, BddScenarioResult, ProviderDetection, ProviderDoctorResult, ProviderExecution, ProviderPlan, ValidationProvider, ValidationProviderContext } from "./types.js";

export class GenericBddExecutionProvider implements ValidationProvider<BddExecutionResult> {
  readonly id: string = "bdd-runner";
  readonly capabilities: ValidationCapability[] = ["bdd"];

  async detect(context: ValidationProviderContext): Promise<ProviderDetection | undefined> {
    const explicit = await configuredCommand(context);
    if (explicit.command) return { provider: explicit.provider, command: explicit.command, runtime: explicit.runtime, reason: "explicit BDD provider configuration" };
    const packageJson = await readPackageJson(context.root);
    if (packageJson?.scripts?.bdd) return { provider: "node-bdd-script", command: "npm run bdd", runtime: "node", reason: "package.json bdd script" };
    if (packageJson?.scripts?.acceptance) return { provider: "node-acceptance-script", command: "npm run acceptance", runtime: "node", reason: "package.json acceptance script" };
    if (await fileExists(path.join(context.root, "features")) && await commandExists("pytest", context.root)) return { provider: "python-bdd", command: "pytest -q", runtime: "python", reason: "features directory and Python BDD-capable runner" };
    return undefined;
  }

  async doctor(context: ValidationProviderContext): Promise<ProviderDoctorResult> {
    const detection = await this.detect(context);
    if (!detection) return { provider: this.id, available: false, message: "No BDD provider was detected." };
    return doctorForCommand(detection.command, resolveCwd(context), detection.provider, { runtime: detection.runtime, reason: detection.reason });
  }

  async plan(context: ValidationProviderContext, detection?: ProviderDetection): Promise<ProviderPlan> {
    const selected = detection ?? await this.detect(context);
    if (!selected?.command) throw new Error("No BDD provider or command is configured.");
    return { provider: selected.provider, capability: "bdd", command: renderCommand(selected.command, context), cwd: resolveCwd(context), runtime: selected.runtime, options: { timeoutMs: (context.spec?.timeoutSeconds ?? context.providerSpec?.timeoutSeconds ?? 900) * 1000 } };
  }

  async execute(context: ValidationProviderContext, plan: ProviderPlan): Promise<ProviderExecution> {
    const execution = await executePlan(plan); const id = context.spec?.id ?? context.providerSpec?.id ?? "bdd";
    return { ...execution, rawArtifact: await persistRawArtifact(context.root, context.rawArtifactDirectory, id, execution.stdout, execution.stderr) };
  }

  async normalize(context: ValidationProviderContext, execution: ProviderExecution): Promise<BddExecutionResult> {
    const parsed = parseJson(execution.stdout); const scenarios = normalizeScenarios(parsed, execution, context);
    const failed = scenarios.filter((item) => item.status === "FAIL").length; const skipped = scenarios.filter((item) => item.status === "SKIP").length; const passed = scenarios.filter((item) => item.status === "PASS").length;
    return { version: 1, provider: execution.plan.provider, capability: "bdd", command: execution.plan.command, runtime: execution.plan.runtime, status: execution.exitCode === 0 && failed === 0 ? "PASS" : "FAIL", scenarios, summary: { total: scenarios.length, passed, failed, skipped, durationMs: execution.durationMs }, rawArtifact: execution.rawArtifact };
  }
}

export async function runBddExecution(context: ValidationProviderContext, provider: ValidationProvider<BddExecutionResult> = new GenericBddExecutionProvider()): Promise<{ result: BddExecutionResult; required: boolean }> {
  const detection = await provider.detect(context);
  if (!detection) return { result: { version: 1, provider: provider.id, capability: "bdd", command: "", status: "SKIP", scenarios: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 }, rawArtifact: "" }, required: context.spec?.required ?? context.providerSpec?.required ?? true };
  const plan = await provider.plan(context, detection); const execution = await provider.execute(context, plan); return { result: await provider.normalize(context, execution), required: context.spec?.required ?? context.providerSpec?.required ?? true };
}

function normalizeScenarios(value: unknown, execution: ProviderExecution, context: ValidationProviderContext): BddScenarioResult[] {
  if (value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).version === 1) {
    const scenarios = (value as Record<string, unknown>).scenarios;
    if (Array.isArray(scenarios)) return scenarios.map((item) => normalizeScenario(item, execution, context));
  }
  if (Array.isArray(value)) {
    const cucumber = value.flatMap((feature) => {
      const item = record(feature); const featureName = stringValue(item.name) ?? "feature"; const featureFile = stringValue(item.uri ?? item.location?.file);
      return (Array.isArray(item.elements) ? item.elements : Array.isArray(item.children) ? item.children : []).filter((scenario) => ["scenario", "background"].includes(String(record(scenario).type ?? "scenario"))).map((scenario) => fromCucumber(record(scenario), featureName, featureFile, execution, context));
    });
    if (cucumber.length) return cucumber;
  }
  const fallback = `${execution.stdout}\n${execution.stderr}`.split(/\r?\n/).filter((line) => /^\s*(Scenario:|scenario:)/i.test(line)).map((line, index) => ({ feature: "unknown", scenario: line.replace(/^\s*Scenario:\s*/i, "").trim(), tags: [], status: execution.exitCode === 0 ? "PASS" as const : "FAIL" as const, requirementIds: index === 0 ? requirementIds(context) : [] }));
  return fallback;
}

function normalizeScenario(value: unknown, execution: ProviderExecution, context: ValidationProviderContext): BddScenarioResult {
  const item = record(value); const status = statusValue(item.status, execution.exitCode); const source = sourceValue(item.source ?? item.location); const tags = arrayValue(item.tags); const taggedRequirements = tags.map((tag) => tag.replace(/^@/, "")).filter((tag) => (context.contract.requirements ?? []).some((requirement) => requirement.id === tag));
  return { feature: stringValue(item.feature) ?? "feature", rule: stringValue(item.rule), scenario: stringValue(item.scenario ?? item.name) ?? "scenario", examplesRow: numberValue(item.examplesRow), tags, status, durationMs: numberValue(item.durationMs), failingStep: stringValue(item.failingStep), source, error: stringValue(item.error ?? item.message), requirementIds: arrayValue(item.requirementIds).length ? arrayValue(item.requirementIds) : taggedRequirements.length ? taggedRequirements : requirementIds(context) };
}

function fromCucumber(item: Record<string, unknown>, feature: string, file: string | undefined, execution: ProviderExecution, context: ValidationProviderContext): BddScenarioResult {
  const steps = Array.isArray(item.steps) ? item.steps : []; const failedStep = steps.find((step) => ["failed", "undefined"].includes(String(record(step).result?.status ?? "")));
  const result = record(failedStep ? record(failedStep).result : undefined); const source = sourceValue(item.location) ?? (file ? { file, line: numberValue(record(item.location).line) } : undefined);
  const tags = arrayValue(item.tags).map((tag) => typeof tag === "string" ? tag : stringValue(record(tag).name) ?? "" ).filter(Boolean); const taggedRequirements = tags.map((tag) => tag.replace(/^@/, "")).filter((tag) => (context.contract.requirements ?? []).some((requirement) => requirement.id === tag));
  return { feature, rule: stringValue(item.rule), scenario: stringValue(item.name) ?? "scenario", tags, status: failedStep ? "FAIL" : execution.exitCode === 0 ? "PASS" : "FAIL", durationMs: numberValue(item.duration) ?? numberValue(result.duration), failingStep: failedStep ? stringValue(record(failedStep).text ?? record(failedStep).keyword) : undefined, source, error: stringValue(result.message ?? result.error_message), requirementIds: taggedRequirements.length ? taggedRequirements : requirementIds(context) };
}

function requirementIds(context: ValidationProviderContext): string[] { return (context.contract.requirements ?? []).filter((item) => item.capabilities?.includes("bdd") || !item.capabilities?.length).map((item) => item.id); }
function renderCommand(command: string, context: ValidationProviderContext): string { return command.replaceAll("{taskId}", context.contract.task.id).replaceAll("{baseRef}", context.baseRef ?? "HEAD").replaceAll("{acceptance}", context.contract.source?.acceptance ?? ""); }
async function readPackageJson(root: string): Promise<{ scripts?: Record<string, string> } | undefined> { try { return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }; } catch { return undefined; } }
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" || typeof value === "number" ? String(value) : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function arrayValue(value: unknown): string[] { return Array.isArray(value) ? value.map((item) => typeof item === "string" ? item : stringValue(record(item).name) ?? "").filter(Boolean) : []; }
function sourceValue(value: unknown): BddScenarioResult["source"] | undefined { const source = record(value); const file = stringValue(source.file ?? source.uri ?? source.path); const line = numberValue(source.line); const column = numberValue(source.column); return file || line || column ? { file, line, column } : undefined; }
function statusValue(value: unknown, exitCode: number): BddScenarioResult["status"] { const status = String(value ?? "").toLowerCase(); if (["skipped", "pending", "undefined"].includes(status)) return "SKIP"; return status === "failed" || status === "fail" || exitCode !== 0 ? "FAIL" : "PASS"; }
