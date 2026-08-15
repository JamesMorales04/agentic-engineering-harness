import fs from "node:fs/promises";
import path from "node:path";
import { commandExists, runProcess } from "../../utils/process.js";
import type { ProviderExecution, ProviderPlan, ValidationProviderContext } from "./types.js";

export async function fileExists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { return undefined; }
}

export async function configuredCommand(context: ValidationProviderContext, fallback?: string): Promise<{ command?: string; runtime?: string; provider: string }> {
  const providerSpec = context.providerSpec;
  const spec = context.spec;
  const command = providerSpec?.command ?? spec?.command ?? fallback;
  const provider = providerSpec?.provider ?? spec?.options?.provider;
  return { command, runtime: typeof spec?.options?.runtime === "string" ? spec.options.runtime : undefined, provider: typeof provider === "string" ? provider : "configured-command" };
}

export async function doctorForCommand(command: string | undefined, cwd: string, provider: string, details: Record<string, unknown> = {}) {
  const executable = command?.trim().split(/\s+/, 1)[0];
  const available = Boolean(executable) && await commandExists(executable!, cwd);
  return { provider, available, message: available ? `${provider} is available.` : `${provider} command is unavailable.`, details: { ...details, executable } };
}

export async function executePlan(plan: ProviderPlan): Promise<ProviderExecution> {
  const result = await runProcess(plan.command, { cwd: plan.cwd, timeoutMs: Number(plan.options?.timeoutMs ?? 900_000), env: plan.env });
  return { plan, ...result, rawArtifact: "" };
}

export function resolveCwd(context: ValidationProviderContext): string {
  return path.resolve(context.root, context.providerSpec?.workingDirectory ?? context.spec?.workingDirectory ?? ".");
}
