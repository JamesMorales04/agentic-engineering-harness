import type { ValidationReport } from "../core/types.js";
import { createCertificationOracleResult } from "./oracle.js";
import type { CertificationOracle } from "./types.js";

/** Bridge existing deterministic AEH validation into the runtime-agnostic oracle contract. */
export function validationReportOracle(source: ValidationReport | (() => Promise<ValidationReport>)): CertificationOracle {
  return {
    id: "aeh-validation-report",
    independent: true,
    async evaluate() {
      const report = typeof source === "function" ? await source() : source;
      return createCertificationOracleResult({
        oracleId: "aeh-validation-report",
        checks: [{ id: "validation.report-status", category: "validation", status: report.status === "PASS" ? "PASS" : "FAIL", required: true, message: `Validation report status is ${report.status}.` }, ...report.checks.map((check) => ({ id: check.id, category: check.category, status: check.status, required: check.status === "SKIP" ? check.details?.required !== false : check.status !== "WARN", message: check.message, durationMs: check.durationMs, evidence: check.details }))],
        evidence: { taskId: report.taskId, changedFiles: report.changedFiles, metadata: report.metadata, reportStatus: report.status }
      });
    }
  };
}
