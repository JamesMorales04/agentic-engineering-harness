import type { HarnessProjectConfig, TaskContract, ValidationCheck, ValidatorSpec } from "../core/types.js";
import { runGherkinValidator } from "./gherkin.js";
import { runExternalToolValidator } from "./external.js";
import { runOpenApiValidator } from "./openapi.js";
import { runGraphifyValidator } from "./graphify.js";
import { runSpecCommand } from "./toolCommand.js";
import type { ValidationContext } from "./types.js";
import { capabilityRequirements, providerSpecFor, runCapabilityValidator } from "../providers/validation/registry.js";

export async function runConfiguredValidators(root: string, config: HarnessProjectConfig, contract: TaskContract, baseRef: string, changedFiles: string[]): Promise<ValidationCheck[]> {
  const specs = [...(config.validation?.validators ?? []), ...(contract.verification?.validators ?? [])];
  const checks: ValidationCheck[] = [];
  for (const spec of specs) {
    const capability = capabilityForAdapter(spec.adapter);
    const context: ValidationContext = { root, config, contract, spec, providerSpec: capability ? providerSpecFor(config, capability, spec) : undefined, baseRef, changedFiles };
    try { checks.push(await runValidator(context)); }
    catch (error) { checks.push({ id: spec.id, category: "validator", status: spec.required ? "FAIL" : "WARN", message: `${spec.adapter} validator crashed: ${String(error)}` }); }
  }
  const declared = capabilityRequirements(contract);
  for (const capability of declared) {
    if (specs.some((spec) => capabilityForAdapter(spec.adapter) === capability)) continue;
    const spec: ValidatorSpec = { id: `capability.${capability}`, adapter: capabilityAdapter(capability), required: true };
    const context: ValidationContext = { root, config, contract, spec, providerSpec: providerSpecFor(config, capability), baseRef, changedFiles };
    try { checks.push(await runValidator(context)); }
    catch (error) { checks.push({ id: spec.id, category: "capability", status: "FAIL", message: `${capability} capability crashed: ${String(error)}` }); }
  }
  return checks;
}
async function runValidator(context: ValidationContext): Promise<ValidationCheck> {
  switch (context.spec.adapter) {
    case "gherkin": case "bdd": return runGherkinValidator(context);
    case "reqnroll": return runCapabilityValidator({ root: context.root, config: context.config, contract: context.contract, spec: { ...context.spec, options: { ...(context.spec.options ?? {}), provider: "reqnroll" } }, providerSpec: context.providerSpec, capability: "bdd", rawArtifactDirectory: `${context.config.evidence?.outputDir ?? ".harness/evidence"}/raw`, baseRef: context.baseRef }, context.spec.id, "bdd", context.spec.required ?? true);
    case "test-execution": case "unit-test": case "integration-test": case "integration-environment": case "contract-test": case "pact": return runCapabilityValidator({ root: context.root, config: context.config, contract: context.contract, spec: context.spec, providerSpec: context.providerSpec, capability: capabilityForAdapter(context.spec.adapter) ?? context.spec.adapter, rawArtifactDirectory: `${context.config.evidence?.outputDir ?? ".harness/evidence"}/raw`, baseRef: context.baseRef }, context.spec.id, capabilityForAdapter(context.spec.adapter) ?? context.spec.adapter, context.spec.required ?? true);
    case "graphify": return runGraphifyValidator(context);
    case "openapi": return runOpenApiValidator(context);
    case "opengrep": case "trivy": case "playwright": case "mutation": case "property": return runExternalToolValidator(context);
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
  return undefined;
}
function capabilityAdapter(capability: string): string { if (capability === "bdd") return "bdd"; if (capability === "contract-test") return "contract-test"; if (capability === "integration-test") return "test-execution"; return "test-execution"; }
