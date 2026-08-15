import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ValidationCheck } from "../../core/types.js";
import type { BddExecutionResult, ContractVerificationResult, IntegrationEnvironmentResult, TestExecutionResult } from "./types.js";

export type NormalizedValidationResult = TestExecutionResult | BddExecutionResult | IntegrationEnvironmentResult | ContractVerificationResult;

export async function persistRawArtifact(root: string, directory: string, id: string, stdout: string, stderr: string): Promise<string> {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "-");
  const output = path.resolve(root, directory, `${safe}.raw`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const body = `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`;
  await fs.writeFile(output, body, "utf8");
  return path.relative(root, output).replaceAll("\\", "/");
}

export function resultCheck(id: string, category: string, result: NormalizedValidationResult, required: boolean): ValidationCheck {
  const failed = result.status === "FAIL";
  const skipped = result.status === "SKIP";
  return {
    id,
    category,
    status: failed ? "FAIL" : skipped ? (required ? "FAIL" : "SKIP") : "PASS",
    message: failed ? `${result.provider} ${category} failed.` : skipped ? `${result.provider} ${category} was skipped.` : `${result.provider} ${category} passed.`,
    durationMs: "summary" in result ? result.summary.durationMs : result.lifecycle.durationMs,
    details: { provider: result.provider, capability: result.capability, result, rawArtifact: result.rawArtifact }
  };
}

export function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

export function stableFingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
