import type { ValidationCheck } from "../core/types.js";
import { commandExists } from "../utils/process.js";
import type { ValidationContext } from "./types.js";
import { missingTool, runSpecCommand } from "./toolCommand.js";

export async function runExternalToolValidator(context: ValidationContext): Promise<ValidationCheck> {
  const adapter = context.spec.adapter;
  const configured = context.spec.command?.trim();
  const defaults: Record<string, { tool: string; command?: string; category: string }> = {
    opengrep: { tool: "opengrep", command: "opengrep scan --json --error .", category: "security" },
    trivy: { tool: "trivy", command: "trivy fs --exit-code 1 --severity HIGH,CRITICAL --scanners vuln,misconfig,secret .", category: "security" },
    playwright: { tool: "npx", command: "npx playwright test --grep \"{taskId}\" --reporter=line", category: "e2e" },
    pact: { tool: "", category: "contract" },
    mutation: { tool: "", category: "test-quality" },
    property: { tool: "", category: "test-quality" },
    command: { tool: "", category: "custom" }
  };
  const definition = defaults[adapter] ?? { tool: "", category: "custom" };
  if (!configured && !definition.command) return { id: context.spec.id, category: definition.category, status: context.spec.required ? "FAIL" : "WARN", message: `${adapter} requires an explicit command in .harness/project.yaml.` };
  if (!configured && definition.tool && !(await commandExists(definition.tool, context.root))) return missingTool(context.spec, definition.tool, definition.category);
  return runSpecCommand(context, configured ?? definition.command!, definition.category);
}
