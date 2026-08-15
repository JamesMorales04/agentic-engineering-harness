import fs from "node:fs/promises";
import path from "node:path";
import type { ValidationCapability } from "../../core/types.js";
import { commandExists } from "../../utils/process.js";
import { normalizePactOutput } from "../../validators/toolEvidence.js";
import { configuredCommand, doctorForCommand, executePlan, fileExists, resolveCwd } from "./providerUtils.js";
import { parseJson, persistRawArtifact } from "./protocol.js";
import type { ContractVerificationResult, ProviderDetection, ProviderDoctorResult, ProviderExecution, ProviderPlan, TestFailure, ValidationProvider, ValidationProviderContext } from "./types.js";

export class PactContractTestingProvider implements ValidationProvider<ContractVerificationResult> {
  readonly id = "pact";
  readonly capabilities: ValidationCapability[] = ["contract-test"];

  async detect(context: ValidationProviderContext): Promise<ProviderDetection | undefined> {
    const explicit = await configuredCommand(context);
    if (explicit.command) return { provider: explicit.provider, command: explicit.command, runtime: explicit.runtime, reason: "explicit Pact verifier command" };
    const pactFile = optionString(context, "pactFile");
    if (!pactFile || !(await fileExists(path.resolve(context.root, pactFile)))) return undefined;
    if (await commandExists("pact", context.root)) return { provider: "pact-cli", command: "pact verifier", runtime: "pact-ffi", reason: "local Pact file and Pact CLI" };
    if (await commandExists("pact_verifier_cli", context.root)) return { provider: "pact-verifier-cli", command: "pact_verifier_cli", runtime: "pact-ffi", reason: "local Pact file and standalone verifier" };
    return { provider: "pact", command: undefined, runtime: "pact-ffi", reason: "local Pact file found but no official verifier executable is installed" };
  }

  async doctor(context: ValidationProviderContext): Promise<ProviderDoctorResult> {
    const detection = await this.detect(context);
    if (!detection?.command) return { provider: this.id, available: false, message: "Pact file is configured but the official Pact verifier is unavailable.", details: { pactFile: optionString(context, "pactFile") } };
    return doctorForCommand(detection.command, resolveCwd(context), detection.provider, { runtime: detection.runtime });
  }

  async plan(context: ValidationProviderContext, detection?: ProviderDetection): Promise<ProviderPlan> {
    const selected = detection ?? await this.detect(context); const configured = await configuredCommand(context);
    if (configured.command && context.spec?.command) return { provider: selected?.provider ?? configured.provider, capability: "contract-test", command: renderCommand(configured.command, context), cwd: resolveCwd(context), runtime: selected?.runtime ?? configured.runtime, options: { timeoutMs: (context.spec.timeoutSeconds ?? 900) * 1000 } };
    const pactFile = optionString(context, "pactFile"); if (!pactFile) throw new Error("Pact provider requires options.pactFile.");
    const report = path.resolve(context.root, context.rawArtifactDirectory, `${context.spec?.id ?? "pact"}.report.json`); const host = optionString(context, "hostname") ?? "127.0.0.1"; const port = optionNumber(context, "port") ?? 8080;
    const command = selected?.provider === "pact-verifier-cli" ? `pact_verifier_cli -f ${quote(path.resolve(context.root, pactFile))} -h ${quote(host)} -p ${port} -j ${quote(report)}` : `pact verifier --file ${quote(path.resolve(context.root, pactFile))} --hostname ${quote(host)} --port ${port} --json ${quote(report)}`;
    return { provider: selected?.provider ?? "pact", capability: "contract-test", command, cwd: resolveCwd(context), runtime: selected?.runtime ?? "pact-ffi", options: { timeoutMs: (context.spec?.timeoutSeconds ?? context.providerSpec?.timeoutSeconds ?? 900) * 1000, pactFile, report } };
  }

  async execute(context: ValidationProviderContext, plan: ProviderPlan): Promise<ProviderExecution> {
    const execution = await executePlan(plan); const id = context.spec?.id ?? context.providerSpec?.id ?? "pact";
    return { ...execution, rawArtifact: await persistRawArtifact(context.root, context.rawArtifactDirectory, id, execution.stdout, execution.stderr) };
  }

  async normalize(context: ValidationProviderContext, execution: ProviderExecution): Promise<ContractVerificationResult> {
    const report = typeof execution.plan.options?.report === "string" ? await readJson(path.resolve(execution.plan.cwd, execution.plan.options.report)) : undefined;
    const parsed = report ?? parseJson(execution.stdout); const failures = normalizePactOutput(parsed).map((finding) => ({ id: finding.rule, message: finding.message ?? "Pact interaction failed" }));
    const summary = pactSummary(parsed, execution, failures.length); const passed = execution.exitCode === 0 && failures.length === 0;
    return { version: 1, provider: execution.plan.provider, capability: "contract-test", status: passed ? "PASS" : "FAIL", verifierCommand: execution.plan.command, pactFile: typeof execution.plan.options?.pactFile === "string" ? execution.plan.options.pactFile : undefined, providerUrl: providerUrl(execution.plan), summary, failures, requirements: requirementIds(context), rawArtifact: execution.rawArtifact };
  }
}

export async function runPactVerification(context: ValidationProviderContext, provider: ValidationProvider<ContractVerificationResult> = new PactContractTestingProvider()): Promise<{ result: ContractVerificationResult; required: boolean }> {
  const detection = await provider.detect(context);
  if (!detection?.command) return { result: { version: 1, provider: provider.id, capability: "contract-test", status: "SKIP", verifierCommand: "", summary: { total: 0, passed: 0, failed: 0, durationMs: 0 }, failures: [{ message: "An official Pact verifier command is required." }], requirements: requirementIds(context), rawArtifact: "" }, required: context.spec?.required ?? context.providerSpec?.required ?? true };
  const plan = await provider.plan(context, detection); const execution = await provider.execute(context, plan); return { result: await provider.normalize(context, execution), required: context.spec?.required ?? context.providerSpec?.required ?? true };
}

function optionString(context: ValidationProviderContext, key: string): string | undefined { const value = context.spec?.options?.[key] ?? context.providerSpec?.options?.[key]; return typeof value === "string" ? value : undefined; }
function requirementIds(context: ValidationProviderContext): string[] { return (context.contract.requirements ?? []).filter((item) => item.capabilities?.includes("contract-test") || !item.capabilities?.length).map((item) => item.id); }
function optionNumber(context: ValidationProviderContext, key: string): number | undefined { const value = context.spec?.options?.[key] ?? context.providerSpec?.options?.[key]; return typeof value === "number" ? value : undefined; }
function renderCommand(command: string, context: ValidationProviderContext): string { return command.replaceAll("{taskId}", context.contract.task.id).replaceAll("{baseRef}", context.baseRef ?? "HEAD"); }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
async function readJson(file: string): Promise<unknown> { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return undefined; } }
function pactSummary(value: unknown, execution: ProviderExecution, failureCount: number): ContractVerificationResult["summary"] { const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; const results = Array.isArray(record.interactionResults) ? record.interactionResults : []; const interactionCount = results.length || (Array.isArray(record.interactions) ? record.interactions.length : 0); const resultFailures = results.filter((item: unknown) => !["ok", "passed", "success", "verified"].includes(String((item as Record<string, unknown>)?.result ?? "").toLowerCase())).length; const total = Number(record.total ?? record.summary?.total ?? 0) || interactionCount || failureCount; const failed = Number(record.failed ?? record.summary?.failed ?? 0) || resultFailures || failureCount; return { total: Math.max(total, failed), passed: Math.max(0, total - failed), failed, durationMs: execution.durationMs }; }
function providerUrl(plan: ProviderPlan): string | undefined { const match = plan.command.match(/--hostname\s+'([^']+)'\s+--port\s+(\d+)|-h\s+'([^']+)'\s+-p\s+(\d+)/); if (!match) return undefined; const host = match[1] ?? match[3]; const port = match[2] ?? match[4]; return `http://${host}:${port}`; }
