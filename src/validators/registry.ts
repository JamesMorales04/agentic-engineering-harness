import type { HarnessProjectConfig, TaskContract, ValidationCheck, ValidatorSpec } from "../core/types.js";
import { runGherkinValidator } from "./gherkin.js";
import { runExternalToolValidator } from "./external.js";
import { runOpenApiValidator } from "./openapi.js";
import { runGraphifyValidator } from "./graphify.js";
import { runSpecCommand } from "./toolCommand.js";
import type { ValidationContext } from "./types.js";

export async function runConfiguredValidators(root: string, config: HarnessProjectConfig, contract: TaskContract, baseRef: string, changedFiles: string[]): Promise<ValidationCheck[]> {
  const specs = [...(config.validation?.validators ?? []), ...(contract.verification?.validators ?? [])];
  const checks: ValidationCheck[] = [];
  for (const spec of specs) {
    const context: ValidationContext = { root, config, contract, spec, baseRef, changedFiles };
    try { checks.push(await runValidator(context)); }
    catch (error) { checks.push({ id: spec.id, category: "validator", status: spec.required ? "FAIL" : "WARN", message: `${spec.adapter} validator crashed: ${String(error)}` }); }
  }
  return checks;
}
async function runValidator(context: ValidationContext): Promise<ValidationCheck> {
  switch (context.spec.adapter) {
    case "gherkin": return runGherkinValidator(context);
    case "graphify": return runGraphifyValidator(context);
    case "openapi": return runOpenApiValidator(context);
    case "opengrep": case "trivy": case "playwright": case "pact": case "mutation": case "property": return runExternalToolValidator(context);
    case "command": return context.spec.command ? runSpecCommand(context, context.spec.command, "custom") : unknown(context.spec);
    default: return unknown(context.spec);
  }
}
function unknown(spec: ValidatorSpec): ValidationCheck { return { id: spec.id, category: "validator", status: spec.required ? "FAIL" : "WARN", message: `Unknown validator adapter '${spec.adapter}'.` }; }
