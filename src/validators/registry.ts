import type { HarnessProjectConfig, TaskContract, ValidationCheck, ValidatorSpec } from "../core/types.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { runExternalToolValidator } from "./external.js";
import { runOpenApiValidator } from "./openapi.js";
import { runGraphifyValidator } from "./graphify.js";
import { runSpecCommand } from "./toolCommand.js";
import type { ValidationContext } from "./types.js";
import { capabilityRequirements, providerSpecFor, runCapabilityValidator } from "../providers/validation/registry.js";

export interface RunConfiguredValidatorsOptionsV1 {
  candidate?: CandidateRevisionV1;
}

export async function runConfiguredValidators(root: string, config: HarnessProjectConfig, contract: TaskContract, baseRef: string, changedFiles: string[], options: RunConfiguredValidatorsOptionsV1 = {}): Promise<ValidationCheck[]> {
  const specs = [...(config.validation?.validators ?? []), ...(contract.verification?.validators ?? [])];
  const checks: ValidationCheck[] = [];
  for (const spec of specs) {
    const capability = capabilityForAdapter(spec.adapter);
    const context: ValidationContext = { root, config, contract, spec, providerSpec: capability ? providerSpecFor(config, capability, spec) : undefined, baseRef, changedFiles, ...(options.candidate ? { candidate: options.candidate } : {}) };
    try { checks.push(await runValidator(context)); }
    catch (error) { checks.push({ id: spec.id, category: "validator", status: spec.required ? "FAIL" : "WARN", message: `${spec.adapter} validator crashed: ${String(error)}` }); }
  }
  const declared = capabilityRequirements(contract);
  for (const capability of declared) {
    if (specs.some((spec) => capabilityForAdapter(spec.adapter) === capability)) continue;
    const adapter = capabilityAdapter(capability);
    if (!adapter) {
      checks.push({ id: `capability.${capability}`, category: "capability", status: "FAIL", message: `UNSUPPORTED_VALIDATION_CAPABILITY: no approved validator or provider resolves the declared '${capability}' capability.` });
      continue;
    }
    const spec: ValidatorSpec = { id: `capability.${capability}`, adapter, required: true };
    const context: ValidationContext = { root, config, contract, spec, providerSpec: providerSpecFor(config, capability), baseRef, changedFiles, ...(options.candidate ? { candidate: options.candidate } : {}) };
    try { checks.push(await runValidator(context)); }
    catch (error) { checks.push({ id: spec.id, category: "capability", status: "FAIL", message: `${capability} capability crashed: ${String(error)}` }); }
  }
  return checks;
}

async function runValidator(context: ValidationContext): Promise<ValidationCheck> {
  switch (context.spec.adapter) {
    case "reqnroll": return runCapabilityValidator({ root: context.root, config: context.config, contract: context.contract, spec: { ...context.spec, options: { ...(context.spec.options ?? {}), provider: "reqnroll" } }, providerSpec: context.providerSpec, capability: "bdd", rawArtifactDirectory: `${context.config.evidence?.outputDir ?? ".harness/evidence"}/raw`, baseRef: context.baseRef, ...(context.candidate ? { candidate: context.candidate } : {}) }, context.spec.id, "bdd", context.spec.required ?? true);
    case "test-execution": case "unit-test": case "integration-test": case "integration-environment": case "contract-test": case "pact": case "gherkin": case "bdd": return runCapabilityValidator({ root: context.root, config: context.config, contract: context.contract, spec: context.spec, providerSpec: context.providerSpec, capability: capabilityForAdapter(context.spec.adapter) ?? context.spec.adapter, rawArtifactDirectory: `${context.config.evidence?.outputDir ?? ".harness/evidence"}/raw`, baseRef: context.baseRef, ...(context.candidate ? { candidate: context.candidate } : {}) }, context.spec.id, capabilityForAdapter(context.spec.adapter) ?? context.spec.adapter, context.spec.required ?? true);
    case "graphify": return runGraphifyValidator(context);
    case "openapi": return runOpenApiValidator(context);
    case "opengrep": case "trivy": case "playwright": case "visual": case "mutation": case "property": return runExternalToolValidator(context);
    case "command": return context.spec.command ? runSpecCommand(context, context.spec.command, "custom") : unknown(context.spec);
    default: return unknown(context.spec);
  }
}
function unknown(spec: ValidatorSpec): ValidationCheck { return { id: spec.id, category: "validator", status: spec.required ? "FAIL" : "WARN", message: `Unknown validator adapter '${spec.adapter}'.` }; }
function capabilityForAdapter(adapter: string): string | undefined {
  if (["gherkin", "bdd", "reqnroll"].includes(adapter)) return "bdd";
  if (["test-execution", "unit-test"].includes(adapter)) return "unit-test";
  if (adapter === "integration-test") return "integration-test";
  if (adapter === "integration-environment") return "integration-test";
  if (["contract-test", "pact"].includes(adapter)) return "contract-test";
  if (adapter === "openapi") return "contract-test";
  if (["playwright", "browser-test"].includes(adapter)) return "browser-test";
  if (["visual", "visual-test"].includes(adapter)) return "visual-test";
  if (adapter === "opengrep") return "static-security";
  if (adapter === "trivy") return "dependency-security";
  return undefined;
}
function capabilityAdapter(capability: string): string | undefined {
  const mapping: Record<string, string> = {
    "unit-test": "test-execution",
    "integration-test": "integration-environment",
    "bdd": "bdd",
    "contract-test": "contract-test",
    "browser-test": "playwright",
    "visual-test": "visual",
    "static-security": "opengrep",
    "dependency-security": "trivy"
  };
  return mapping[capability];
}
