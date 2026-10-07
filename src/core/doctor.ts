import type { HarnessProjectConfig, ValidatorSpec } from "./types.js";
import { commandExists } from "../utils/process.js";
import { EngramMemoryProvider } from "../providers/engram.js";
import { GraphifyCodeIntelligenceProvider } from "../providers/graphify.js";
import { PaseoOrchestrationProvider } from "../providers/paseo.js";
import { createWorkerExecutor } from "../workers/factory.js";
import { resolveEndpoint } from "../telemetry/otlp.js";
import { runToolchainDoctor } from "../toolchain/doctor.js";
import { HeadroomCompressionProvider } from "../context/compression/headroom.js";
import { SerenaSemanticProvider } from "../context/repository/serena.js";
import { countStallRetryParkedFiles } from "../operations/stallRetryBudget.js";

export interface DoctorResult { component: string; required: boolean; ok: boolean; message: string; }

export async function runDoctor(root: string, config: HarnessProjectConfig): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  for (const command of ["git", "node"]) results.push({ component: command, required: true, ok: await commandExists(command, root), message: `${command} executable` });
  results.push(await stallRetryQuarantineDoctor(root));
  if (config.toolchain) results.push(...await runToolchainDoctor(root, config));
  if (config.orchestration?.provider === "paseo") { const r = await new PaseoOrchestrationProvider().doctor(root); results.push({ component: "paseo", required: config.orchestration.required ?? false, ...r }); }
  else if (config.orchestration?.provider === "podman") { const executor = createWorkerExecutor(config); const r = await executor.doctor(root, config); results.push({ component: "podman-worker", required: config.orchestration.required ?? false, ...r }); }
  if (config.memory?.provider === "engram") { const r = await new EngramMemoryProvider(root).doctor(root); results.push({ component: "engram", required: config.memory.required ?? false, ...r }); }
  if (config.codeIntelligence?.provider === "graphify") { const r = await new GraphifyCodeIntelligenceProvider(config).doctor(root); results.push({ component: "graphify", required: config.codeIntelligence.required ?? false, ...r }); }
  if (config.context) {
    results.push({ component: "context-gateway", required: true, ok: true, message: "ContextBudgetGateway, preservation policy and deterministic projection are available." });
    results.push({ component: "context-token-estimator", required: true, ok: true, message: "Dependency-free deterministic token estimator is available." });
    results.push({ component: "context-retrieval-gateway", required: true, ok: true, message: "Authorized artifact retrieval gateway is available." });
    const semantic = config.context.semanticRetrieval?.provider ?? "serena";
    if (semantic === "serena") { const r = await new SerenaSemanticProvider().doctor(root); results.push({ component: "serena", required: config.context.semanticRetrieval?.required ?? true, ...r }); }
    else if (semantic !== "none") results.push({ component: "serena", required: config.context.semanticRetrieval?.required ?? false, ok: false, message: `Unsupported semantic retrieval provider '${semantic}'.` });
    const compression = config.context.compression?.provider ?? "headroom";
    if (compression === "headroom") { const r = await new HeadroomCompressionProvider({ command: config.context.compression?.command }).doctor(root); results.push({ component: "headroom", required: config.context.compression?.required ?? true, ...r }); }
    else if (compression !== "none") results.push({ component: "headroom", required: config.context.compression?.required ?? false, ok: false, message: `Unsupported compression provider '${compression}'.` });
  }
  if (config.validation?.opa?.enabled) results.push({ component: "opa", required: false, ok: await commandExists("opa", root), message: "OPA policy engine" });
  for (const tool of config.security?.tools ?? []) results.push({ component: tool, required: false, ok: await commandExists(tool, root), message: `Security tool: ${tool}` });
  for (const validator of config.validation?.validators ?? []) { const tool = validatorTool(validator); if (tool) results.push({ component: `validator:${validator.id}`, required: validator.required ?? false, ok: await commandExists(tool, root), message: `${validator.adapter} validator (${tool})` }); }
  if (config.telemetry?.exporter === "otlp-http-json") {
    const endpoint = resolveEndpoint(config);
    results.push({ component: "otlp-endpoint", required: config.telemetry.required ?? false, ok: Boolean(endpoint), message: endpoint ? `OTLP/HTTP JSON endpoint: ${endpoint}` : "OTLP exporter configured without an endpoint" });
  }
  if (config.provenance?.signing?.key || config.provenance?.signing?.required || config.provenance?.verification?.required) results.push({ component: "cosign", required: config.provenance.signing?.required === true || config.provenance.verification?.required === true, ok: await commandExists("cosign", root), message: "Cosign provenance signing" });
  return results;
}

/**
 * Stall-retry quarantine surfacing (round-11 G2 discoverability): parked
 * `.grave-<uuid>` / `.quarantine-<uuid>` siblings accumulate at most one per
 * interrupted legacy migration and are never auto-deleted (fail closed on
 * evidence). Non-required WARNING while any remain — renders as `!` in the
 * `aeh doctor` output without failing the run. Recovery procedure lives in
 * the stallRetryBudget module header (OPERATOR RECOVERY).
 */
async function stallRetryQuarantineDoctor(root: string): Promise<DoctorResult> {
  let graves: string[] = [];
  let quarantines: string[] = [];
  try {
    ({ graves, quarantines } = await countStallRetryParkedFiles(root));
  } catch {
    return { component: "stall-retry-quarantine", required: false, ok: true, message: "Parked stall-retry graves/quarantines could not be listed; assuming none." };
  }
  const total = graves.length + quarantines.length;
  if (total === 0) {
    return { component: "stall-retry-quarantine", required: false, ok: true, message: "No parked stall-retry graves/quarantines." };
  }
  return {
    component: "stall-retry-quarantine",
    required: false,
    ok: false,
    message: `WARNING: ${total} parked stall-retry file(s) need operator review (${quarantines.length} quarantine(s), ${graves.length} crash-orphan grave(s)) under .harness/operations (*.pending.grave-*, *.pending.quarantine-*); see the stallRetryBudget OPERATOR RECOVERY docs before deleting.`,
  };
}

function validatorTool(spec: ValidatorSpec): string | undefined {
  if (spec.command) return undefined;
  switch (spec.adapter) {
    case "gherkin": return "dotnet";
    case "opengrep": return "opengrep";
    case "trivy": return "trivy";
    case "playwright": return "node_modules/.bin/playwright";
    case "visual": return "node_modules/.bin/playwright";
    default: return undefined;
  }
}
