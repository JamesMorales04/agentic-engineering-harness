export type StructuredOutputFailureReason =
  | "EMPTY_OUTPUT"
  | "NO_MARKER"
  | "MARKER_INVALID_JSON"
  | "NATIVE_JSON_INVALID";

export class StructuredOutputError extends Error {
  readonly reason: StructuredOutputFailureReason;

  constructor(reason: StructuredOutputFailureReason, message: string) {
    super(message);
    this.name = "StructuredOutputError";
    this.reason = reason;
  }
}

export function extractMarkedJson(stdout: string, stderr = ""): unknown {
  const candidates: string[] = [];
  collectCandidateStrings(stdout, candidates);
  collectCandidateStrings(stderr, candidates);
  let markerObserved = false;
  for (const candidate of [...candidates].reverse()) {
    const marker = "AEH_RESULT_JSON=";
    const index = candidate.lastIndexOf(marker);
    if (index < 0) continue;
    markerObserved = true;
    const parsed = parseJsonPrefix(candidate.slice(index + marker.length).trim());
    if (parsed !== undefined) return parsed;
  }
  if (markerObserved) {
    throw new StructuredOutputError(
      "MARKER_INVALID_JSON",
      "Agent output contained AEH_RESULT_JSON= but the marker payload was not valid JSON."
    );
  }

  const stdoutRaw = stdout.trim();
  const stderrRaw = stderr.trim();
  const stdoutJson = parseWholeJson(stdoutRaw); if (stdoutJson !== undefined) return stdoutJson;
  const stderrJson = parseWholeJson(stderrRaw); if (stderrJson !== undefined) return stderrJson;
  if (!stdoutRaw && !stderrRaw) {
    throw new StructuredOutputError(
      "EMPTY_OUTPUT",
      "Agent turn completed without a captured structured output payload."
    );
  }
  const looksLikeNativeJson = [stdoutRaw, stderrRaw].some((raw) => {
    const normalized = normalizeJsonSyntax(raw);
    return normalized.startsWith("{") || normalized.startsWith("[");
  });
  if (looksLikeNativeJson) {
    throw new StructuredOutputError(
      "NATIVE_JSON_INVALID",
      "Agent output looked like native JSON but could not be parsed."
    );
  }
  throw new StructuredOutputError(
    "NO_MARKER",
    "Agent output contained no valid native JSON and no AEH_RESULT_JSON=<json> marker."
  );
}

function collectCandidateStrings(text: string, output: string[]): void {
  output.push(text);
  for (const line of text.split(/\r?\n/)) {
    output.push(line);
    try { collectStrings(JSON.parse(line) as unknown, output); } catch { /* plain log line */ }
  }
}
function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") { output.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, output); return; }
  if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, output);
}
function parseJsonPrefix(raw: string): unknown | undefined {
  for (const candidate of jsonSyntaxCandidates(raw)) {
    try { return JSON.parse(candidate); } catch { /* marker may be followed by log text */ }
    for (let end = candidate.length; end > 1; end -= 1) {
      try { return JSON.parse(candidate.slice(0, end)); } catch { /* keep shrinking */ }
    }
  }
  return undefined;
}
function parseWholeJson(raw: string): unknown | undefined {
  if (!raw) return undefined;
  for (const candidate of jsonSyntaxCandidates(raw)) {
    try { return JSON.parse(candidate); } catch { /* try next deterministic normalization */ }
  }
  return undefined;
}
function jsonSyntaxCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  const unfenced = stripJsonFence(trimmed);
  return [...new Set([trimmed, unfenced, normalizeJsonSyntax(trimmed), normalizeJsonSyntax(unfenced)])].filter(Boolean);
}
function normalizeJsonSyntax(raw: string): string {
  return raw
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/\u00a0/g, " ")
    .trim();
}
function stripJsonFence(raw: string): string {
  const match = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return match?.[1]?.trim() ?? raw;
}
