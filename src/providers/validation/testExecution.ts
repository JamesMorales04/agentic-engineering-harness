import fs from "node:fs/promises";
import path from "node:path";
import type { ValidationCapability, ValidatorSpec } from "../../core/types.js";
import { commandExists } from "../../utils/process.js";
import { configuredCommand, doctorForCommand, executePlan, fileExists, resolveCwd } from "./providerUtils.js";
import { parseJson, persistRawArtifact } from "./protocol.js";
import type { ProviderDetection, ProviderDoctorResult, ProviderExecution, ProviderPlan, TestExecutionResult, TestFailure, ValidationProvider, ValidationProviderContext } from "./types.js";

export class ProjectNativeTestExecutionProvider implements ValidationProvider<TestExecutionResult> {
  readonly id = "project-native-test";
  readonly capabilities: ValidationCapability[] = ["unit-test", "integration-test"];

  async detect(context: ValidationProviderContext): Promise<ProviderDetection | undefined> {
    const explicit = await configuredCommand(context);
    if (explicit.command) return { provider: explicit.provider, command: explicit.command, runtime: explicit.runtime, reason: "explicit project provider configuration" };
    const packageJson = await readPackageJson(context.root);
    if (packageJson?.scripts?.test) return { provider: "node-project-test", command: "npm test", runtime: "node", reason: "package.json test script" };
    if (await fileExists(path.join(context.root, "pyproject.toml")) || await fileExists(path.join(context.root, "setup.cfg")) || await fileExists(path.join(context.root, "pytest.ini"))) {
      if (await commandExists("pytest", context.root)) return { provider: "python-pytest", command: "pytest -q", runtime: "python", reason: "Python test configuration and pytest executable" };
      if (await commandExists("python3", context.root)) return { provider: "python-unittest", command: "python3 -m unittest discover", runtime: "python", reason: "Python test configuration and Python runtime" };
    }
    if (await fileExists(path.join(context.root, "go.mod")) && await commandExists("go", context.root)) return { provider: "go-test", command: "go test ./...", runtime: "go", reason: "go.mod and Go runtime" };
    if (await fileExists(path.join(context.root, "Cargo.toml")) && await commandExists("cargo", context.root)) return { provider: "cargo-test", command: "cargo test", runtime: "rust", reason: "Cargo manifest and Rust runtime" };
    return undefined;
  }

  async doctor(context: ValidationProviderContext): Promise<ProviderDoctorResult> {
    const detection = await this.detect(context);
    if (!detection) return { provider: this.id, available: false, message: "No project-native test provider was detected." };
    return doctorForCommand(detection.command, resolveCwd(context), detection.provider, { runtime: detection.runtime, reason: detection.reason });
  }

  async plan(context: ValidationProviderContext, detection?: ProviderDetection): Promise<ProviderPlan> {
    const selected = detection ?? await this.detect(context);
    if (!selected?.command) throw new Error("No test execution provider or command is configured.");
    return { provider: selected.provider, capability: context.capability, command: renderCommand(selected.command, context), cwd: resolveCwd(context), runtime: selected.runtime, options: { timeoutMs: (context.spec?.timeoutSeconds ?? context.providerSpec?.timeoutSeconds ?? 900) * 1000 } };
  }

  async execute(context: ValidationProviderContext, plan: ProviderPlan): Promise<ProviderExecution> {
    const execution = await executePlan(plan);
    const id = context.spec?.id ?? context.providerSpec?.id ?? `${context.capability}-${plan.provider}`;
    return { ...execution, rawArtifact: await persistRawArtifact(context.root, context.rawArtifactDirectory, id, execution.stdout, execution.stderr) };
  }

  async normalize(context: ValidationProviderContext, execution: ProviderExecution): Promise<TestExecutionResult> {
    const parsed = parseJson(execution.stdout);
    const result = normalizeStructured(parsed, execution, context.capability) ?? normalizeText(execution.stdout, execution.stderr, execution, context.capability);
    result.requirements = requirementIds(context);
    result.rawArtifact = execution.rawArtifact;
    return result;
  }
}

export async function runTestExecution(context: ValidationProviderContext, provider: ValidationProvider<TestExecutionResult> = new ProjectNativeTestExecutionProvider()): Promise<{ result: TestExecutionResult; checkRequired: boolean }> {
  const detection = await provider.detect(context);
  if (!detection) {
    return { result: { version: 1, provider: provider.id, capability: context.capability, command: "", status: "SKIP", summary: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 }, failures: [{ message: "No project-native test command was detected." }], requirements: requirementIds(context), rawArtifact: "" }, checkRequired: context.spec?.required ?? context.providerSpec?.required ?? true };
  }
  const plan = await provider.plan(context, detection); const execution = await provider.execute(context, plan); const result = await provider.normalize(context, execution);
  return { result, checkRequired: context.spec?.required ?? context.providerSpec?.required ?? true };
}

function renderCommand(command: string, context: ValidationProviderContext): string {
  return command.replaceAll("{taskId}", context.contract.task.id).replaceAll("{baseRef}", context.baseRef ?? "HEAD").replaceAll("{acceptance}", context.contract.source?.acceptance ?? "");
}

async function readPackageJson(root: string): Promise<{ scripts?: Record<string, string> } | undefined> {
  try { return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }; } catch { return undefined; }
}

function requirementIds(context: ValidationProviderContext): string[] {
  return (context.contract.requirements ?? []).filter((item) => item.capabilities?.includes(context.capability) || !item.capabilities?.length).map((item) => item.id);
}

function normalizeStructured(value: unknown, execution: ProviderExecution, capability: ValidationCapability): TestExecutionResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version === 1 && typeof record.provider === "string" && record.summary && typeof record.summary === "object") {
    const summary = record.summary as Record<string, unknown>;
    return { version: 1, provider: String(record.provider), capability, command: execution.plan.command, runtime: execution.plan.runtime, status: asStatus(record.status, execution.exitCode), summary: { total: number(summary.total), passed: number(summary.passed), failed: number(summary.failed), skipped: number(summary.skipped), durationMs: number(summary.durationMs) || execution.durationMs }, failures: failures(record.failures), requirements: [], rawArtifact: execution.rawArtifact };
  }
  const tests = Array.isArray(record.tests) ? record.tests : Array.isArray(record.testResults) ? record.testResults : [];
  if (!tests.length && !record.summary) return undefined;
  const parsedFailures = tests.flatMap((test) => { const item = asRecord(test); const status = String(item.status ?? "").toLowerCase(); return status === "failed" || status === "fail" ? [{ id: stringValue(item.id ?? item.name), message: String(item.message ?? item.error ?? "test failed"), source: source(item) }] : []; });
  const summary = asRecord(record.summary);
  const total = number(summary.total) || tests.length; const failed = number(summary.failed) || parsedFailures.length; const skipped = number(summary.skipped); const passed = number(summary.passed) || Math.max(0, total - failed - skipped);
  return { version: 1, provider: execution.plan.provider, capability, command: execution.plan.command, runtime: execution.plan.runtime, status: asStatus(record.status, execution.exitCode), summary: { total, passed, failed, skipped, durationMs: number(summary.durationMs) || execution.durationMs }, failures: parsedFailures, requirements: [], rawArtifact: execution.rawArtifact };
}

function normalizeText(stdout: string, stderr: string, execution: ProviderExecution, capability: ValidationCapability): TestExecutionResult {
  const text = `${stdout}\n${stderr}`; const failures: TestFailure[] = [];
  for (const line of text.split(/\r?\n/)) if (/^\s*(not ok|FAIL(?:ED)?\b)/i.test(line)) failures.push({ id: line.replace(/^\s*(not ok|FAIL(?:ED)?\s*:?)\s*/i, "").trim(), message: line.trim() || "test failed" });
  const total = firstNumber(text, [/1\.\.(\d+)/, /(?:tests?|total)\D+(\d+)/i]) ?? 0;
  const skipped = firstNumber(text, [/(\d+)\s+skipped/i, /#\s*skip/gi]) ?? countMatches(text, /#\s*skip/gi);
  const failed = firstNumber(text, [/(\d+)\s+(?:failed|failures)/i]) ?? failures.length;
  const passed = firstNumber(text, [/(\d+)\s+passed/i, /ok\s+(\d+)/i]) ?? Math.max(0, total - failed - skipped);
  const inferredTotal = Math.max(total, passed + failed + skipped);
  return { version: 1, provider: execution.plan.provider, capability, command: execution.plan.command, runtime: execution.plan.runtime, status: execution.exitCode === 0 && failed === 0 ? "PASS" : "FAIL", summary: { total: inferredTotal, passed, failed, skipped, durationMs: execution.durationMs }, failures, requirements: [], rawArtifact: execution.rawArtifact };
}

function asStatus(value: unknown, exitCode: number): "PASS" | "FAIL" | "SKIP" { const normalized = String(value ?? "").toUpperCase(); if (normalized === "SKIP") return "SKIP"; return exitCode === 0 && normalized !== "FAIL" ? "PASS" : "FAIL"; }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" || typeof value === "number" ? String(value) : undefined; }
function source(item: Record<string, unknown>): TestFailure["source"] | undefined { const source = asRecord(item.source ?? item.location); const file = stringValue(source.file ?? source.path); const line = number(source.line); const column = number(source.column); return file || line || column ? { file, line: line || undefined, column: column || undefined } : undefined; }
function failures(value: unknown): TestFailure[] { return Array.isArray(value) ? value.map((item) => { const record = asRecord(item); return { id: stringValue(record.id ?? record.name), message: String(record.message ?? record.error ?? "test failed"), source: source(record) }; }) : []; }
function firstNumber(value: string, patterns: RegExp[]): number | undefined { for (const pattern of patterns) { const match = value.match(pattern); if (match?.[1]) return Number(match[1]); } return undefined; }
function countMatches(value: string, pattern: RegExp): number { return [...value.matchAll(pattern)].length; }
