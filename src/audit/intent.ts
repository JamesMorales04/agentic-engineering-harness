import type { HarnessProjectConfig, TaskRisk } from "../core/types.js";
import { triageChange, type TriageDecision, type TriageEvidence } from "../core/triage.js";

export type EngineeringIntent = "informational" | "audit" | "change";

export interface EngineeringIntentEvidence extends TriageEvidence {
  explicitIntent?: EngineeringIntent;
}

export interface EngineeringIntentDecision {
  intent: EngineeringIntent;
  reasons: string[];
  evidence: {
    request: string;
    files: string[];
    domains: string[];
    risk: TaskRisk;
    flags: TriageEvidence["flags"] extends Array<infer T> | undefined ? T[] : never[];
  };
  changeTriage?: TriageDecision;
}

const CHANGE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(implement|fix|repair|refactor|rewrite|replace|remove|delete|rename|migrate|upgrade|update|change|modify|edit)\b/i, "request explicitly asks to change repository state"],
  [/\b(add|create|introduce|enable|disable|configure|integrate)\b/i, "request asks to add or configure repository behavior"],
  [/\b(make|turn)\b.{0,80}\b(pass|work|support|use|return|accept|reject)\b/i, "request asks for a behavioral modification"]
];

const AUDIT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(review|audit|assess|inspect|analy[sz]e|validate|evaluate)\b/i, "request asks for an engineering assessment"],
  [/\b(find|identify|look for|search for|detect)\b.{0,80}\b(bug|bugs|issue|issues|problem|problems|risk|risks|vulnerabilit|improvement|improvements|dead code|regression|regressions)\b/i, "request asks to discover engineering findings"],
  [/\b(check|measure)\b.{0,80}\b(coverage|quality|security|performance|architecture|maintainability|correctness|compliance)\b/i, "request asks to measure repository quality"],
  [/\b(code review|security review|architecture review|test review|performance review)\b/i, "request is an explicit review operation"]
];

export function classifyEngineeringIntent(config: HarnessProjectConfig, input: EngineeringIntentEvidence): EngineeringIntentDecision {
  const request = input.request.trim();
  const files = [...new Set(input.files ?? [])];
  const domains = [...new Set(input.domains ?? [])];
  const risk = input.risk ?? "low";
  const flags = [...new Set(input.flags ?? [])];
  const evidence = { request, files, domains, risk, flags };

  if (input.explicitIntent) {
    return withChangeTriage(config, input.explicitIntent, [`explicit intent=${input.explicitIntent}`], evidence);
  }

  const changeReasons = CHANGE_PATTERNS.filter(([pattern]) => pattern.test(request)).map(([, reason]) => reason);
  if (changeReasons.length) return withChangeTriage(config, "change", changeReasons, evidence);

  const auditReasons = AUDIT_PATTERNS.filter(([pattern]) => pattern.test(request)).map(([, reason]) => reason);
  if (auditReasons.length) return { intent: "audit", reasons: [...new Set(auditReasons)], evidence };

  return { intent: "informational", reasons: ["request asks for information and contains no repository-change or engineering-audit signal"], evidence };
}

function withChangeTriage(
  config: HarnessProjectConfig,
  intent: EngineeringIntent,
  reasons: string[],
  evidence: EngineeringIntentDecision["evidence"]
): EngineeringIntentDecision {
  if (intent !== "change") return { intent, reasons, evidence };
  const changeTriage = triageChange(config, evidence);
  return { intent, reasons, evidence, changeTriage };
}

export function formatEngineeringIntent(decision: EngineeringIntentDecision): string {
  if (decision.intent !== "change") return `${decision.intent.toUpperCase()} — ${decision.reasons.join("; ")}`;
  return `CHANGE/${decision.changeTriage?.mode.toUpperCase() ?? "UNKNOWN"} — ${[...decision.reasons, ...(decision.changeTriage?.reasons ?? [])].join("; ")}`;
}
