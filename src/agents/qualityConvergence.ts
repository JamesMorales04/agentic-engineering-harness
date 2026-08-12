import crypto from "node:crypto";
import type { HarnessProjectConfig } from "../core/types.js";
import type { NormalizedFinding } from "./outputContracts.js";

export type FindingSeverity = NormalizedFinding["severity"];
export type ConvergenceStatus = "INITIAL" | "CONVERGED" | "IMPROVING" | "STABLE" | "STAGNATING" | "REGRESSING" | "CYCLING";
export interface SeverityCounts { critical: number; high: number; medium: number; low: number; note: number; }
export interface QualityState {
  round: number;
  counts: SeverityCounts;
  debtPoints: number;
  debtScore: number;
  fingerprint: string;
  findingFingerprints: string[];
  resolved: string[];
  persistent: string[];
  introduced: string[];
  convergence: ConvergenceStatus;
  gate: QualityGateResult;
}
export interface QualityGateResult { pass: boolean; reasons: string[]; counts: SeverityCounts; debtPoints: number; debtScore: number; }

export const DEFAULT_SEVERITY_POINTS: Record<FindingSeverity, number> = { critical: 300, high: 75, medium: 24, low: 3, note: 1 };
export const DEFAULT_FINAL_MAX: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 3, note: Number.MAX_SAFE_INTEGER };

export function severityPoints(config: HarnessProjectConfig): Record<FindingSeverity, number> {
  return { ...DEFAULT_SEVERITY_POINTS, ...(config.workflow?.reviews?.quality?.severityPoints ?? {}) };
}

export function calculateQuality(findings: NormalizedFinding[], config: HarnessProjectConfig): { counts: SeverityCounts; debtPoints: number; debtScore: number } {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, note: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const weights = severityPoints(config);
  const debtPoints = (Object.keys(counts) as FindingSeverity[]).reduce((sum, severity) => sum + counts[severity] * weights[severity], 0);
  return { counts, debtPoints, debtScore: debtPoints / 3 };
}

export function evaluateFinalQualityGate(findings: NormalizedFinding[], config: HarnessProjectConfig): QualityGateResult {
  const { counts, debtPoints, debtScore } = calculateQuality(findings, config);
  const configured = config.workflow?.reviews?.finalQualityGate?.maxBySeverity ?? {};
  const max: SeverityCounts = { ...DEFAULT_FINAL_MAX, ...configured };
  const maxDebtPoints = config.workflow?.reviews?.finalQualityGate?.maxDebtPoints ?? 9;
  const reasons: string[] = [];
  for (const severity of ["critical", "high", "medium", "low"] as FindingSeverity[]) {
    if (counts[severity] > max[severity]) reasons.push(`${severity}=${counts[severity]} exceeds final maximum ${max[severity]}`);
  }
  if (debtPoints > maxDebtPoints) reasons.push(`DebtScore=${formatDebtScore(debtScore)} exceeds final maximum ${formatDebtScore(maxDebtPoints / 3)}`);
  return { pass: reasons.length === 0, reasons, counts, debtPoints, debtScore };
}

export function analyzeQualityState(findings: NormalizedFinding[], history: QualityState[], config: HarnessProjectConfig): QualityState {
  const round = history.length;
  const findingFingerprints = findings.map(findingFingerprint).sort();
  const fingerprint = crypto.createHash("sha256").update(findingFingerprints.join("\n")).digest("hex");
  const current = calculateQuality(findings, config);
  const gate = evaluateFinalQualityGate(findings, config);
  const previous = history.at(-1);
  const previousSet = new Set(previous?.findingFingerprints ?? []);
  const currentSet = new Set(findingFingerprints);
  const resolved = [...previousSet].filter((item) => !currentSet.has(item));
  const persistent = [...currentSet].filter((item) => previousSet.has(item));
  const introduced = [...currentSet].filter((item) => !previousSet.has(item));
  const convergence = classifyConvergence({ fingerprint, debtPoints: current.debtPoints, gatePass: gate.pass, history, config });
  return { round, ...current, fingerprint, findingFingerprints, resolved, persistent, introduced, convergence, gate };
}

export function remediationRequired(state: QualityState): boolean { return !state.gate.pass; }

function classifyConvergence(input: { fingerprint: string; debtPoints: number; gatePass: boolean; history: QualityState[]; config: HarnessProjectConfig }): ConvergenceStatus {
  if (input.gatePass) return "CONVERGED";
  const previous = input.history.at(-1);
  if (!previous) return "INITIAL";
  const convergence = input.config.workflow?.reviews?.convergence;
  if (convergence?.regressionDetection !== false && input.debtPoints > previous.debtPoints) return "REGRESSING";
  if (convergence?.cycleDetection !== false && input.history.some((state) => state.fingerprint === input.fingerprint)) return "CYCLING";
  const minimumImprovement = convergence?.minimumDebtPointImprovement ?? 3;
  const improvement = previous.debtPoints - input.debtPoints;
  if (improvement >= minimumImprovement) return "IMPROVING";
  const window = Math.max(1, convergence?.stagnationWindow ?? 2);
  const debtSequence = [...input.history.map((state) => state.debtPoints), input.debtPoints].slice(-window);
  if (debtSequence.length >= window) {
    let meaningful = false;
    for (let index = 1; index < debtSequence.length; index += 1) if (debtSequence[index - 1] - debtSequence[index] >= minimumImprovement) meaningful = true;
    if (!meaningful) return "STAGNATING";
  }
  return "STABLE";
}

export function findingFingerprint(finding: NormalizedFinding): string {
  const normalized = [finding.category, finding.location.file, finding.location.startLine ?? "", finding.location.endLine ?? "", finding.evidence.toLowerCase().replace(/\s+/g, " ").trim()].join("|");
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 20);
}

export function formatDebtScore(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""); }
