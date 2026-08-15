import fs from "node:fs/promises";
import path from "node:path";
import type { ValidationCheck } from "../core/types.js";
import { commandExists, runProcess } from "../utils/process.js";
import type { ValidationContext } from "./types.js";
import { missingTool } from "./toolCommand.js";
import { parseToolEvidence } from "./toolEvidence.js";

export async function runExternalToolValidator(context: ValidationContext): Promise<ValidationCheck> {
  const adapter = context.spec.adapter;
  const configured = context.spec.command?.trim();
  const defaults: Record<string, { tool: string; command?: string; category: string }> = {
    opengrep: { tool: "opengrep", command: "opengrep scan --json --error .", category: "security" },
    trivy: { tool: "trivy", command: "trivy fs --format json --exit-code 1 --severity HIGH,CRITICAL --scanners vuln,misconfig,secret .", category: "security" },
    playwright: { tool: "npx", command: "npx playwright test --grep \"{taskId}\" --reporter=json", category: "e2e" },
    pact: { tool: "", category: "contract" },
    mutation: { tool: "", category: "test-quality" },
    property: { tool: "", category: "test-quality" },
    command: { tool: "", category: "custom" }
  };
  const definition = defaults[adapter] ?? { tool: "", category: "custom" };
  if (!configured && !definition.command) return { id: context.spec.id, category: definition.category, status: context.spec.required ? "FAIL" : "WARN", message: `${adapter} requires an explicit command in .harness/project.yaml.` };
  if (!configured && definition.tool && !(await commandExists(definition.tool, context.root))) return missingTool(context.spec, definition.tool, definition.category);
  const command = configured ?? definition.command!;
  const rendered = command.replaceAll("{taskId}", context.contract.task.id).replaceAll("{baseRef}", context.baseRef).replaceAll("{acceptance}", context.contract.source?.acceptance ?? "");
  const cwd = path.resolve(context.root, context.spec.workingDirectory ?? ".");
  const result = await runProcess(rendered, { cwd, timeoutMs: (context.spec.timeoutSeconds ?? 900) * 1000 });
  const evidenceFile = typeof context.spec.options?.evidenceFile === "string" ? path.resolve(cwd, context.spec.options.evidenceFile) : undefined;
  const evidenceText = evidenceFile ? await fs.readFile(evidenceFile, "utf8").catch(() => result.stdout) : result.stdout;
  const findings = parseToolEvidence(adapter, evidenceText);
  const rawPath = path.resolve(context.root, context.config.evidence?.outputDir ?? ".harness/evidence", `${context.spec.id.replace(/[^A-Za-z0-9._-]/g, "-")}.raw`);
  await fs.mkdir(path.dirname(rawPath), { recursive: true });
  await fs.writeFile(rawPath, `${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`, "utf8");
  const failedByEvidence = findings.length > 0 && ["opengrep", "trivy", "playwright", "pact"].includes(adapter);
  const failed = result.exitCode !== 0 || failedByEvidence;
  return {
    id: context.spec.id,
    category: definition.category,
    status: failed ? "FAIL" : "PASS",
    message: failed ? `${adapter} validator failed${findings.length ? ` with ${findings.length} normalized finding(s)` : ` with exit code ${result.exitCode}`}.` : `${adapter} validator passed.`,
    durationMs: result.durationMs,
    details: { command: rendered, rawArtifact: path.relative(context.root, rawPath).replaceAll("\\", "/"), evidenceFormat: evidenceFile ? context.spec.options?.evidenceFormat ?? "json-or-junit" : "stdout-json", findings, findingCount: findings.length }
  };
}
