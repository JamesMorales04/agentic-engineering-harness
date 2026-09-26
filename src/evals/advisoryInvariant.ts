import fs from "node:fs/promises";
import path from "node:path";

/**
 * Deterministic advisory-invariant guard. Memory, telemetry, logs, and evals
 * are observations, never authority: no authority decision surface may import
 * eval/telemetry modules, and observation read helpers must not be consumed by
 * decision code. This module reads source text only and grants no authority.
 */
export interface AdvisoryInvariantViolationV1 {
  file: string;
  kind: "EVAL_IMPORT" | "AUTHORITY_OBSERVATION_IMPORT" | "OBSERVATION_READ_HELPER";
  detail: string;
}

export const AUTHORITY_DECISION_MODULES = [
  "src/architecture/acceptanceOracle.ts",
  "src/architecture/objectiveCompletion.ts",
  "src/architecture/candidateAssurance.ts",
  "src/architecture/executionIdentity.ts",
  "src/architecture/validationRequirements.ts",
  "src/operations/state.ts",
  "src/security/actionPolicy.ts",
  "src/security/toolActionGate.ts",
  "src/security/gatedAction.ts",
  "src/security/humanDecision.ts",
  "src/agents/routing.ts",
  "src/agents/routingV2.ts",
  "src/certification/core.ts",
  "src/delivery/finalize.ts",
  "src/delivery/handoff.ts",
  "src/provenance/generate.ts"
] as const;

export const OBSERVATION_READ_HELPERS = [
  "readTelemetryEvents",
  "readMetricSnapshots",
  "loadEvalCorpusManifest",
  "computeEvalCorpusIdentity",
  "compareEvalCase",
  "buildEvalDashboard",
  "evalResultComparableV1"
] as const;

const EVAL_IMPORT_ALLOWLIST = new Set(["src/cli.ts", "src/entry.ts"]);

export async function scanAdvisoryInvariantV1(root: string): Promise<AdvisoryInvariantViolationV1[]> {
  const violations: AdvisoryInvariantViolationV1[] = [];
  for (const file of await walkTypeScript(path.join(root, "src"))) {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    const source = await fs.readFile(file, "utf8");
    const specifiers = importSpecifiers(source);
    const importsEval = specifiers.some((specifier) => /(^|\/)evals\//.test(specifier));
    const importsTelemetry = specifiers.some((specifier) => /(^|\/)telemetry\//.test(specifier));
    if (importsEval && !relative.startsWith("src/evals/") && !EVAL_IMPORT_ALLOWLIST.has(relative)) {
      violations.push({ file: relative, kind: "EVAL_IMPORT", detail: "imports an eval module" });
    }
    if ((importsEval || importsTelemetry) && (AUTHORITY_DECISION_MODULES as readonly string[]).includes(relative)) {
      violations.push({ file: relative, kind: "AUTHORITY_OBSERVATION_IMPORT", detail: "authority decision module imports observation modules" });
    }
    if (!relative.startsWith("src/evals/") && !relative.startsWith("src/telemetry/") && !EVAL_IMPORT_ALLOWLIST.has(relative)) {
      for (const helper of OBSERVATION_READ_HELPERS) {
        if (source.includes(helper)) violations.push({ file: relative, kind: "OBSERVATION_READ_HELPER", detail: `references observation read helper ${helper}` });
      }
    }
  }
  return violations;
}

async function walkTypeScript(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkTypeScript(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) specifiers.push(match[1]!);
  return specifiers;
}
