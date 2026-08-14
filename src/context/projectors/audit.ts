import { estimateTokens } from "../estimator.js";
import type { ContextFragment, ContextFragmentProjection } from "../types.js";

export function projectAudit(fragment: ContextFragment): ContextFragmentProjection {
  const source = parseJson(fragment.content);
  const findings = Array.isArray(source?.findings) ? source.findings : [];
  const lines = findings.map((finding) => {
    const item = record(finding);
    return [item.id, item.severity, item.location, item.evidence, item.status].filter(Boolean).join(" | ");
  });
  const content = [
    `findings=${findings.length}`,
    ...lines,
    "authoritative raw audit evidence is available through the fragment source"
  ].join("\n");
  return { ...fragment, content, estimatedTokens: estimateTokens(content), originalTokens: estimateTokens(fragment.content), projected: true };
}

function parseJson(content: string): Record<string, unknown> | undefined { try { const value: unknown = JSON.parse(content); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; } catch { return undefined; } }
function record(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const item = value as Record<string, unknown>;
  const location = item.location && typeof item.location === "object" ? JSON.stringify(item.location) : String(item.location ?? "");
  return { id: String(item.id ?? ""), severity: String(item.severity ?? ""), location, evidence: String(item.evidence ?? item.summary ?? ""), status: String(item.status ?? "") };
}
