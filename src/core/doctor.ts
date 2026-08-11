import type { HarnessProjectConfig } from "./types.js";
import { commandExists } from "../utils/process.js";
import { EngramMemoryProvider } from "../providers/engram.js";
import { GraphifyCodeIntelligenceProvider } from "../providers/graphify.js";
import { PaseoOrchestrationProvider } from "../providers/paseo.js";

export interface DoctorResult {
  component: string;
  required: boolean;
  ok: boolean;
  message: string;
}

export async function runDoctor(root: string, config: HarnessProjectConfig): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];

  for (const command of ["git", "node"]) {
    results.push({ component: command, required: true, ok: await commandExists(command, root), message: `${command} executable` });
  }

  if (config.orchestration?.provider === "paseo") {
    const provider = new PaseoOrchestrationProvider();
    const r = await provider.doctor(root);
    results.push({ component: "paseo", required: config.orchestration.required ?? false, ...r });
  }

  if (config.memory?.provider === "engram") {
    const provider = new EngramMemoryProvider();
    const r = await provider.doctor(root);
    results.push({ component: "engram", required: config.memory.required ?? false, ...r });
  }

  if (config.codeIntelligence?.provider === "graphify") {
    const provider = new GraphifyCodeIntelligenceProvider();
    const r = await provider.doctor(root);
    results.push({ component: "graphify", required: config.codeIntelligence.required ?? false, ...r });
  }

  if (config.validation?.opa?.enabled) {
    results.push({ component: "opa", required: false, ok: await commandExists("opa", root), message: "OPA policy engine" });
  }

  for (const tool of config.security?.tools ?? []) {
    results.push({ component: tool, required: false, ok: await commandExists(tool, root), message: `Security tool: ${tool}` });
  }

  const sandbox = config.security?.sandbox?.provider;
  if (sandbox && sandbox !== "none") {
    results.push({
      component: sandbox,
      required: config.security?.sandbox?.required ?? false,
      ok: await commandExists(sandbox, root),
      message: `${sandbox} sandbox runtime`
    });
  }

  return results;
}
