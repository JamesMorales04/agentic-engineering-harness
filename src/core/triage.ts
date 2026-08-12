import type { HarnessProjectConfig, TaskMode } from "./types.js";

export type TriageFlag = "architecture" | "security" | "authentication" | "authorization" | "schema" | "migration" | "public-api" | "breaking-change" | "new-dependency" | "cross-module" | "ambiguous";
export interface TriageEvidence { request: string; files?: string[]; domains?: string[]; risk?: "low" | "medium" | "high"; flags?: TriageFlag[]; }
export interface TriageDecision { mode: TaskMode; quickEligible: boolean; reasons: string[]; evidence: Required<Pick<TriageEvidence, "request">> & { files: string[]; domains: string[]; risk: "low" | "medium" | "high"; flags: TriageFlag[]; }; }

const defaultDisallowedDomains = ["security", "auth", "authentication", "authorization", "architecture", "database", "schema", "migration", "api-contract", "multi-tenancy"];
const hazardousRequestPatterns: Array<[RegExp, string]> = [
  [/\b(auth|authentication|authorization|permission|tenant|security)\b/i, "request touches a security/auth boundary"],
  [/\b(migration|schema|database|table|column)\b/i, "request may alter persistent schema/data boundaries"],
  [/\b(public\s+api|breaking\s+change|backward\s+compat)/i, "request may alter a public compatibility contract"],
  [/\b(add|new|upgrade|replace)\s+(a\s+)?dependenc(y|ies)|\bpackage\s+(upgrade|change)\b/i, "request may change dependency policy"],
  [/\barchitecture|architectural|cross[- ]module|large\s+refactor\b/i, "request may require an architectural decision"]
];

export function triageChange(config: HarnessProjectConfig, input: TriageEvidence): TriageDecision {
  const files = [...new Set(input.files ?? [])];
  const domains = [...new Set(input.domains ?? [])];
  const risk = input.risk ?? "low";
  const flags = [...new Set(input.flags ?? [])];
  const reasons: string[] = [];
  const maxFiles = config.workflow?.quick?.maxFiles ?? 5;
  const disallowed = config.workflow?.quick?.disallowedDomains ?? defaultDisallowedDomains;

  if (!files.length) reasons.push("quick mode requires an explicit bounded file scope");
  const nonConcrete = files.filter((file) => /[*?\[\]{}]/.test(file));
  if (nonConcrete.length) reasons.push(`quick mode requires concrete file paths, not wildcard scope: ${nonConcrete.join(", ")}`);
  if (files.length > maxFiles) reasons.push(`scope contains ${files.length} files/patterns; quick limit is ${maxFiles}`);
  if (risk !== "low") reasons.push(`risk is ${risk}; quick mode requires low risk`);
  if (flags.length) reasons.push(`explicit escalation flags: ${flags.join(", ")}`);
  const blockedDomains = domains.filter((domain) => disallowed.some((pattern) => domain.toLowerCase().includes(pattern.toLowerCase()) || pattern.toLowerCase().includes(domain.toLowerCase())));
  if (blockedDomains.length) reasons.push(`domains require SDD: ${blockedDomains.join(", ")}`);
  for (const [pattern, reason] of hazardousRequestPatterns) if (pattern.test(input.request)) reasons.push(reason);

  const quickEligible = reasons.length === 0;
  return { mode: quickEligible ? "quick" : "spec", quickEligible, reasons: quickEligible ? ["bounded low-risk change with no SDD escalation signals"] : reasons, evidence: { request: input.request, files, domains, risk, flags } };
}

export function formatTriageDecision(decision: TriageDecision): string { return `${decision.mode.toUpperCase()} — ${decision.reasons.join("; ")}`; }
