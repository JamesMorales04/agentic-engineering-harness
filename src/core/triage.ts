import type { HarnessProjectConfig } from "./types.js";
import { resolveImplementationRoute, type ImplementationRoutingEvidence, type RouteAssessmentV1 } from "../agents/routingV2.js";
import type { AssuranceLevel, ImplementationRoute, RouteEvidence } from "../architecture/contracts.js";
import { sha256Canonical } from "./digest.js";
import { AehError } from "./errors.js";
import { createSemanticEvidenceReceiptV1, SemanticAssessmentServiceV1, type DecisionMechanismV1, type SemanticAssessmentBindingV1 } from "../semantic/assessment.js";

export type TriageFlag = "architecture" | "security" | "authentication" | "authorization" | "schema" | "migration" | "public-api" | "breaking-change" | "new-dependency" | "cross-module" | "ambiguous";
export interface TriageEvidence { request: string; files?: string[]; domains?: string[]; risk?: "low" | "medium" | "high"; flags?: TriageFlag[]; }
export interface TriageDecision {
  route: ImplementationRoute;
  assurance: AssuranceLevel;
  mechanism: DecisionMechanismV1;
  assessmentDigest?: string;
  routeEvidence: RouteEvidence[];
  reasons: string[];
  unknowns?: string[];
  evidence: Required<Pick<TriageEvidence, "request">> & { files: string[]; domains: string[]; risk: "low" | "medium" | "high"; flags: TriageFlag[]; };
}

const defaultDisallowedDomains = ["security", "auth", "authentication", "authorization", "architecture", "database", "schema", "migration", "api-contract", "multi-tenancy"];
export function triageChange(config: HarnessProjectConfig, input: TriageEvidence): TriageDecision {
  return triageChangeUsingAssessment(config, input);
}

export async function triageChangeWithSemanticAssessment(
  config: HarnessProjectConfig,
  input: TriageEvidence,
  options: { service: SemanticAssessmentServiceV1; binding: SemanticAssessmentBindingV1; policyRevision: string }
): Promise<TriageDecision> {
  const files = [...new Set(input.files ?? [])];
  const domains = [...new Set(input.domains ?? [])];
  const risk = input.risk ?? "low";
  const flags = [...new Set(input.flags ?? [])];
  const compactEvidence = [
    { ref: "request", content: input.request.trim() },
    { ref: "scope", content: files.length ? files.join("\n") : "No concrete file scope was supplied." },
    { ref: "domains", content: domains.length ? domains.join(", ") : "No domain labels were supplied." },
    { ref: "risk", content: risk },
    { ref: "flags", content: flags.length ? flags.join(", ") : "No escalation flags were supplied." }
  ];
  const binding = { ...options.binding, intentDigest: options.binding.intentDigest ?? sha256Canonical({ request: input.request, files, domains, risk, flags }) };
  const assessment = await options.service.assess({
    version: 1,
    assessmentType: "ROUTE",
    evidenceRefs: compactEvidence.map((item) => item.ref),
    compactEvidence,
    evidenceReceipts: compactEvidence.map((item) => createSemanticEvidenceReceiptV1({ binding, ref: item.ref, content: item.content, kind: "REQUEST" })),
    requiredOutputSchema: "semantic-assessment-v1",
    reasoningRequirement: { reasoningClass: "STANDARD", structuredOutputRequired: true, independenceRequired: false, externalKnowledgeRequired: false, maxContextClass: "STANDARD", riskClass: risk === "high" ? "HIGH" : risk === "medium" ? "STANDARD" : "LOW" },
    binding,
    budget: { maxInputTokens: 2_000, maxOutputTokens: 500, deadlineMs: 15_000 },
    policyRevision: options.policyRevision
  });
  if (assessment.judgment?.type !== "ROUTE") throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "ROUTE assessment did not contain a typed route judgment.");
  const judgment = assessment.judgment;
  const nonConcrete = files.filter((file) => /[*?\[\]{}]/.test(file));
  const deterministicDelegationFloor = files.length === 0 || nonConcrete.length > 0 || files.length > 5 || flags.includes("cross-module") || judgment.scopeClarity === "LOW" || judgment.decompositionNeed || judgment.coordinationNeed;
  const recommendedRoute = deterministicDelegationFloor && judgment.recommendedRoute === "DIRECT" ? "DELEGATED" : judgment.recommendedRoute;
  const semanticAssessment: RouteAssessmentV1 = { ...judgment, recommendedRoute };
  return {
    ...triageChangeUsingAssessment(config, input, semanticAssessment, assessment.assessmentDigest),
    unknowns: [...new Set([...assessment.unknowns, ...judgment.unknowns])].sort()
  };
}

function triageChangeUsingAssessment(config: HarnessProjectConfig, input: TriageEvidence, semanticAssessment?: RouteAssessmentV1, assessmentDigest?: string): TriageDecision {
  const files = [...new Set(input.files ?? [])];
  const domains = [...new Set(input.domains ?? [])];
  const risk = input.risk ?? "low";
  const flags = [...new Set(input.flags ?? [])];
  const reasons: string[] = [];
  const maxFiles = 5;
  const disallowed = defaultDisallowedDomains;

  if (!files.length) reasons.push("a bounded file scope was not supplied");
  const nonConcrete = files.filter((file) => /[*?\[\]{}]/.test(file));
  if (nonConcrete.length) reasons.push(`scope requires concrete file paths, not wildcard paths: ${nonConcrete.join(", ")}`);
  if (files.length > maxFiles) reasons.push(`scope contains ${files.length} files/patterns; delegated planning is required beyond ${maxFiles}`);
  if (risk !== "low") reasons.push(`risk is ${risk}; elevated assurance is required`);
  if (flags.length) reasons.push(`explicit escalation flags: ${flags.join(", ")}`);
  const blockedDomains = domains.filter((domain) => disallowed.some((pattern) => domain.toLowerCase().includes(pattern.toLowerCase()) || pattern.toLowerCase().includes(domain.toLowerCase())));
  if (blockedDomains.length) reasons.push(`domains require elevated assurance and review: ${blockedDomains.join(", ")}`);

  const routingEvidence: ImplementationRoutingEvidence = {
    intent: input.request,
    ambiguity: flags.includes("ambiguous"),
    architecture: flags.includes("architecture") || domains.some((domain) => /architecture/i.test(domain)),
    crossModule: flags.includes("cross-module") || files.length > maxFiles,
    scopeConfidence: files.length === 0 || nonConcrete.length > 0 ? "low" : "high",
    expectedWorkUnits: Math.max(files.length, 1),
    risk,
    publicContractImpact: flags.includes("public-api") || flags.includes("breaking-change") || domains.some((domain) => /public-api|breaking|contract/i.test(domain)),
    dataOrSchemaImpact: flags.includes("schema") || flags.includes("migration") || domains.some((domain) => /schema|migration|database/i.test(domain)),
    securityBoundary: flags.some((flag) => ["security", "authentication", "authorization"].includes(flag)) || domains.some((domain) => /security|auth|permission/i.test(domain)),
    files,
    semanticAssessment
  };
  const route = resolveImplementationRoute(routingEvidence);
  const finalReasons = [...reasons, ...(route.route === "FORMAL_SDD" ? [route.routeEvidence[0].statement] : [])];
  return { route: route.route, assurance: route.assurance, mechanism: route.mechanism, ...(assessmentDigest ? { assessmentDigest } : {}), routeEvidence: route.routeEvidence, reasons: finalReasons.length ? finalReasons : ["bounded request classified by explicit evidence and canonical route policy"], evidence: { request: input.request, files, domains, risk, flags } };
}

export function formatTriageDecision(decision: TriageDecision): string { return `${decision.route}/${decision.assurance} — ${decision.reasons.join("; ")}`; }
