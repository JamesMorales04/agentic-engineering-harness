import type { HarnessProjectConfig, TaskRisk } from "../core/types.js";
import { triageChange, type TriageDecision, type TriageEvidence } from "../core/triage.js";
import { createIntentDecision, type IntentDecisionV1, type IntentDecisionSource, type SemanticIntent } from "./intentDecision.js";

export { assertIntentDecisionForRoute, createIntentDecision, defaultEffects, intentDecisionV1Schema, InvalidIntentDecisionError, parseIntentDecision, semanticIntentValues, validateIntentDecision } from "./intentDecision.js";
export type { IntentDecisionRoute, IntentDecisionResolution, IntentDecisionSource, IntentDecisionV1, SemanticIntent } from "./intentDecision.js";

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
  [/\b(implement|fix|repair|refactor|rewrite|replace|remove|delete|rename|migrate|upgrade|update|change|modify|edit|implementa|arregla|repara|refactoriza|cambia|modifica|elimina|actualiza)\b/i, "request explicitly asks to change repository state"],
  [/\b(add|create|introduce|enable|disable|configure|integrate|agrega|anade|crea|introduce|habilita|deshabilita|configura|integra)\b/i, "request asks to add or configure repository behavior"],
  [/\b(make|turn|haz|convierte)\b.{0,80}\b(pass|work|support|use|return|accept|reject|funcione|acepte|rechace|pase)\b/i, "request asks for a behavioral modification"]
];

const EVALUATION_PATTERNS: Array<[RegExp, string]> = [
  [/\b(review|audit|assess|inspect|analy[sz]e|validate|evaluate|revisa|audita|evalua|evalu[aá]|comprueba|verifica|analiza|inspecciona)\b/i, "request uses an explicit evaluation speech act"],
  [/\b(find|identify|look for|search for|detect|busc\w*|encuentra|identifica|detecta)\b.{0,100}\b(bug|bugs|issue|issues|problem|problems|risk|risks|vulnerabilit|improvement|improvements|dead code|regression|regressions|error|errores|problema|problemas|riesgo|riesgos|vulnerabilidad|vulnerabilidades|regresion|regresiones)\b/i, "request asks to discover engineering findings"],
  [/\b(check|measure|comprueba|verifica|mide)\b.{0,100}\b(coverage|quality|security|performance|architecture|maintainability|correctness|compliance|cobertura|calidad|seguridad|rendimiento|arquitectura|correctitud|cumplimiento)\b/i, "request asks to measure repository quality"],
  [/\b(explain|describe|tell me|dime|explica|explicame|describe)\b.{0,100}\b(what is wrong|what's wrong|problems?|bugs?|vulnerabilit|security issues?|que esta mal|que problemas|errores|vulnerabilidades)\b/i, "explanation is explicitly about defects rather than system behavior"],
  [/\b(what|which|where|list|show|tell|que|cuales|donde|lista|muestra|dime)\b.{0,100}\b(bug|bugs|issue|issues|problem|problems|risk|risks|error|errores|problema|problemas|riesgo|riesgos|vulnerabilit|vulnerabilidad|vulnerabilidades)\b/i, "request asks to enumerate engineering defects or risks"],
  [/\b(whether|if|si)\b.{0,70}\b(secure|correct|safe|quality|security problems?|vulnerabilit|seguro|correcto|problemas de seguridad|vulnerabilidades)\b/i, "request asks for a verification judgment"],
  [/\b(check|run|execute|exercise|perform|comprueba|verifica|ejecuta|realiza)\b.{0,100}\b(result|status|evidence|validation|journey|reference|boundary|boundaries|lineage|provider|recovery|lifecycle|completion|resultado|estado|evidencia|validacion|recorrido|referencia|limite|limites|linaje|proveedor|recuperacion|ciclo|completitud)\b/i, "request asks for an operational verification result"],
  [/\b(code review|security review|architecture review|test review|performance review|revision de codigo|revision de seguridad|revision de arquitectura)\b/i, "request is an explicit review operation"]
];

const INFORMATIONAL_PATTERNS: Array<[RegExp, string]> = [
  [/\b(explain|describe|summari[sz]e|tell me|help me understand|what does|how does|how is|where is|show me where|explica|describe|resume|dime|ayudame a entender|que hace|como funciona|como esta implementad|donde esta)\b/i, "request's primary speech act is explanation or orientation"],
  [/\b(architecture|implementation|flow|system|validation|validator|context|provenance|arquitectura|implementacion|flujo|sistema|validacion|validadores|contexto|procedencia)\b/i, "request asks to understand repository behavior rather than judge it"]
];

const NEGATED_EVALUATION = /\b(?:do not|don't|without|not|no|sin|no eval(?:uate|u(?:ar|es))?|no revis(?:e|es)|no audit(?:ar|es)|sin evaluar|sin revisar)\b.{0,80}\b(?:review|audit|assess|inspect|analy[sz]e|evaluat|judge|find|check|revis|audit|evalu|analiz|comprueb|verific)\w*\b/i;

/**
 * Non-authoritative lexical signal for diagnostics, evaluation and explicitly
 * configured compatibility fallback only. Managed conversational routes must
 * use a lead-produced IntentDecisionV1 instead.
 */
export function classifyEngineeringIntentHeuristic(config: HarnessProjectConfig, input: EngineeringIntentEvidence): EngineeringIntentDecision {
  const request = input.request.trim();
  const files = [...new Set(input.files ?? [])];
  const domains = [...new Set(input.domains ?? [])];
  const risk = input.risk ?? "low";
  const flags = [...new Set(input.flags ?? [])];
  const evidence = { request, files, domains, risk, flags };

  if (input.explicitIntent) {
    return withChangeTriage(config, input.explicitIntent, [`explicit intent=${input.explicitIntent}`], evidence);
  }

  const normalizedRequest = normalizeIntentText(request);
  const changeReasons = CHANGE_PATTERNS.filter(([pattern]) => pattern.test(normalizedRequest)).map(([, reason]) => reason);
  if (changeReasons.length) return withChangeTriage(config, "change", changeReasons, evidence);

  const negatesEvaluation = NEGATED_EVALUATION.test(normalizedRequest);
  const auditReasons = EVALUATION_PATTERNS.filter(([pattern]) => pattern.test(normalizedRequest)).map(([, reason]) => reason);
  const informationalReasons = INFORMATIONAL_PATTERNS.filter(([pattern]) => pattern.test(normalizedRequest)).map(([, reason]) => reason);
  if (auditReasons.length && !negatesEvaluation) return { intent: "audit", reasons: [...new Set(auditReasons)], evidence };
  if (negatesEvaluation) informationalReasons.push("request explicitly excludes evaluation, so explanatory language remains informational");

  return { intent: "informational", reasons: [...new Set([...informationalReasons, "request asks for information without requesting an engineering judgment or repository mutation"])], evidence };
}

/** @deprecated Use classifyEngineeringIntentHeuristic outside the conversational route. */
export const classifyEngineeringIntent = classifyEngineeringIntentHeuristic;

export function intentDecisionFromHeuristic(config: HarnessProjectConfig, input: EngineeringIntentEvidence, userTurnId?: string): IntentDecisionV1 {
  const heuristic = classifyEngineeringIntentHeuristic(config, input);
  const intent = heuristic.intent as SemanticIntent;
  return createIntentDecision(intent, input.request.trim(), "heuristic-fallback" satisfies IntentDecisionSource, { userTurnId, confidence: undefined });
}

function normalizeIntentText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
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
