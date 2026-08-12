import { z } from "zod";
import type { WorkerSession } from "../core/types.js";
import type { NormalizedFinding } from "./outputContracts.js";

export type ExceptionType = "SPEC_CONTRADICTION" | "REQUIRES_PRODUCT_DECISION" | "BLOCKED_EXTERNAL" | "SYSTEM_FAILURE";
export interface ExceptionDecision { type: ExceptionType; humanRequired: boolean; rationale: string; findings: string[]; }

export const exceptionDiagnosisSchema = z.object({
  classification: z.enum(["IMPLEMENTATION_DEFECT", "SPEC_CONTRADICTION", "REQUIRES_PRODUCT_DECISION", "BLOCKED_EXTERNAL", "SYSTEM_FAILURE"]),
  rationale: z.string().min(1),
  recommendedAction: z.string().min(1)
});

export function detectHumanException(findings: NormalizedFinding[]): ExceptionDecision | undefined {
  const matches: Array<{ type: ExceptionType; finding: NormalizedFinding }> = [];
  for (const finding of findings) {
    const explicit = finding.exceptionType;
    if (explicit && explicit !== "IMPLEMENTATION_DEFECT") matches.push({ type: explicit, finding });
    else {
      const category = finding.category.toLowerCase().replace(/[_\s]+/g, "-");
      if (["spec-contradiction", "requirement-contradiction", "conflicting-requirements"].includes(category)) matches.push({ type: "SPEC_CONTRADICTION", finding });
      else if (["product-decision", "business-decision", "ambiguous-requirement", "product-ambiguity"].includes(category)) matches.push({ type: "REQUIRES_PRODUCT_DECISION", finding });
      else if (["external-blocker", "missing-secret", "credential-required", "external-permission", "external-dependency-unavailable"].includes(category)) matches.push({ type: "BLOCKED_EXTERNAL", finding });
    }
  }
  if (!matches.length) return undefined;
  const priority: ExceptionType[] = ["SPEC_CONTRADICTION", "REQUIRES_PRODUCT_DECISION", "BLOCKED_EXTERNAL", "SYSTEM_FAILURE"];
  const type = priority.find((candidate) => matches.some((match) => match.type === candidate))!;
  const relevant = matches.filter((match) => match.type === type).map((match) => match.finding);
  return { type, humanRequired: type !== "SYSTEM_FAILURE", rationale: relevant.map((finding) => finding.evidence).join(" | "), findings: relevant.map((finding) => finding.id) };
}

export function detectRuntimeExternalException(session: WorkerSession): ExceptionDecision | undefined {
  const text = `${session.stderr}\n${session.stdout}`;
  const patterns = [/missing\s+(api[- ]?key|token|secret|credential)/i, /authentication\s+(required|failed)/i, /not\s+(authenticated|logged\s+in)/i, /credential(s)?\s+(required|missing|unavailable)/i, /permission denied[^\n]*(credential|secret|token|account)/i];
  if (!patterns.some((pattern) => pattern.test(text))) return undefined;
  return { type: "BLOCKED_EXTERNAL", humanRequired: true, rationale: text.slice(-2000), findings: [] };
}

export function diagnosisToException(value: z.infer<typeof exceptionDiagnosisSchema>): ExceptionDecision | undefined {
  if (value.classification === "IMPLEMENTATION_DEFECT") return undefined;
  return { type: value.classification, humanRequired: value.classification !== "SYSTEM_FAILURE", rationale: value.rationale, findings: [] };
}
