import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { runDoctor, type DoctorResult } from "../core/doctor.js";

export interface FullStackDogfoodReport {
  version: 1;
  profile: "full-stack";
  generatedAt: string;
  status: "PASS" | "FAIL";
  checks: DoctorResult[];
  configuredComponents: string[];
  limitations: string[];
}

/**
 * Explicit, deterministic full-stack lane. It runs provider setup/doctor
 * checks and records the exact configured surface; expensive agent execution
 * remains opt-in instead of being silently forced into every local run.
 */
export async function runFullStackDogfood(root: string, config: HarnessProjectConfig): Promise<FullStackDogfoodReport> {
  const checks = await runDoctor(root, config);
  const configuredComponents = configuredSurface(config);
  const limitations = ["This lane validates installed/configured provider contracts; consumer application tests remain owned by the consumer repository."];
  const requiredFailures = checks.filter((check) => check.required && !check.ok);
  const report: FullStackDogfoodReport = { version: 1, profile: "full-stack", generatedAt: new Date().toISOString(), status: requiredFailures.length ? "FAIL" : "PASS", checks, configuredComponents, limitations };
  const outputDir = path.resolve(root, config.evals?.resultsDir ?? ".harness/evals/results");
  await fs.mkdir(outputDir, { recursive: true }); await fs.writeFile(path.join(outputDir, `full-stack-${Date.now()}.json`), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function configuredSurface(config: HarnessProjectConfig): string[] {
  const result = ["git", "node"];
  if (config.orchestration?.provider && config.orchestration.provider !== "none") result.push(config.orchestration.provider);
  if (config.memory?.provider && config.memory.provider !== "none") result.push(`memory:${config.memory.provider}`);
  if (config.codeIntelligence?.provider && config.codeIntelligence.provider !== "none") result.push(`code-intelligence:${config.codeIntelligence.provider}`);
  if (config.context?.semanticRetrieval?.provider && config.context.semanticRetrieval.provider !== "none") result.push(`semantic:${config.context.semanticRetrieval.provider}`);
  if (config.context?.compression?.provider && config.context.compression.provider !== "none") result.push(`compression:${config.context.compression.provider}`);
  if (config.validation?.opa?.enabled) result.push("opa");
  for (const validator of config.validation?.validators ?? []) result.push(`validator:${validator.adapter}`);
  if (config.telemetry?.exporter && config.telemetry.exporter !== "none") result.push("otlp");
  if (config.provenance?.cosignKey) result.push("cosign");
  return [...new Set(result)];
}
