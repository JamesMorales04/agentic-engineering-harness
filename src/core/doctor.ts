import type { HarnessProjectConfig, ValidatorSpec } from "./types.js";
import { commandExists } from "../utils/process.js";
import { EngramMemoryProvider } from "../providers/engram.js";
import { GraphifyCodeIntelligenceProvider } from "../providers/graphify.js";
import { PaseoOrchestrationProvider } from "../providers/paseo.js";
import { createWorkerExecutor } from "../workers/factory.js";
import { resolveEndpoint } from "../telemetry/otlp.js";
import { runToolchainDoctor } from "../toolchain/doctor.js";

export interface DoctorResult { component: string; required: boolean; ok: boolean; message: string; }

export async function runDoctor(root: string, config: HarnessProjectConfig): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  for (const command of ["git", "node"]) results.push({ component: command, required: true, ok: await commandExists(command, root), message: `${command} executable` });
  if (config.toolchain) results.push(...await runToolchainDoctor(root, config));
  if (config.orchestration?.provider === "paseo") { const r = await new PaseoOrchestrationProvider().doctor(root); results.push({ component: "paseo", required: config.orchestration.required ?? false, ...r }); }
  else if (config.orchestration?.provider === "podman") { const executor = createWorkerExecutor(config); const r = await executor.doctor(root, config); results.push({ component: "podman-worker", required: config.orchestration.required ?? false, ...r }); }
  if (config.memory?.provider === "engram") { const r = await new EngramMemoryProvider().doctor(root); results.push({ component: "engram", required: config.memory.required ?? false, ...r }); }
  if (config.codeIntelligence?.provider === "graphify") { const r = await new GraphifyCodeIntelligenceProvider().doctor(root); results.push({ component: "graphify", required: config.codeIntelligence.required ?? false, ...r }); }
  if (config.validation?.opa?.enabled) results.push({ component: "opa", required: false, ok: await commandExists("opa", root), message: "OPA policy engine" });
  for (const tool of config.security?.tools ?? []) results.push({ component: tool, required: false, ok: await commandExists(tool, root), message: `Security tool: ${tool}` });
  for (const validator of config.validation?.validators ?? []) { const tool = validatorTool(validator); if (tool) results.push({ component: `validator:${validator.id}`, required: validator.required ?? false, ok: await commandExists(tool, root), message: `${validator.adapter} validator (${tool})` }); }
  if (config.telemetry?.exporter === "otlp-http-json") {
    const endpoint = resolveEndpoint(config);
    results.push({ component: "otlp-endpoint", required: config.telemetry.required ?? false, ok: Boolean(endpoint), message: endpoint ? `OTLP/HTTP JSON endpoint: ${endpoint}` : "OTLP exporter configured without an endpoint" });
  }
  if (config.provenance?.cosignKey) results.push({ component: "cosign", required: false, ok: await commandExists("cosign", root), message: "Cosign provenance signing" });
  return results;
}

function validatorTool(spec: ValidatorSpec): string | undefined {
  if (spec.command) return undefined;
  switch (spec.adapter) {
    case "gherkin": return "dotnet";
    case "opengrep": return "opengrep";
    case "trivy": return "trivy";
    case "playwright": return "npx";
    default: return undefined;
  }
}
