import type { CertificationCheck, CertificationOracleResult } from "./types.js";

/** Construct oracle output and make the deterministic acceptance rule explicit. */
export function createCertificationOracleResult(input: {
  oracleId: string;
  independent?: boolean;
  checks: CertificationCheck[];
  evidence?: Record<string, unknown>;
}): CertificationOracleResult {
  const failures = [
    ...(input.checks.length ? [] : [{ id: "oracle.empty", category: "oracle", message: "Certification oracle returned no checks.", details: {} }]),
    ...input.checks
      .filter((check) => check.status === "FAIL" || (check.status === "SKIP" && check.required))
      .map((check) => ({ id: check.id, category: "oracle", message: check.message, details: { required: check.required, status: check.status, ...(check.evidence ?? {}) } }))
  ];
  return {
    version: 1,
    oracleId: input.oracleId,
    deterministic: true,
    status: failures.length ? "FAIL" : "PASS",
    checks: input.checks,
    failures,
    evidence: input.evidence ?? {},
    generatedAt: new Date().toISOString()
  };
}

export function oracleCanAccept(result: CertificationOracleResult, policy: { allowRequiredSkippedChecks: boolean }): boolean {
  if (result.deterministic !== true || result.status !== "PASS") return false;
  if (result.failures.length > 0) return false;
  if (result.checks.some((check) => check.status === "FAIL" || (check.required && check.status === "WARN"))) return false;
  return policy.allowRequiredSkippedChecks || !result.checks.some((check) => check.required && check.status === "SKIP");
}
