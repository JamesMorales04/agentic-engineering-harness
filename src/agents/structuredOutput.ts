export function extractMarkedJson(stdout: string, stderr = ""): unknown {
  const direct = parseWholeJson(stdout.trim()); if (direct !== undefined) return direct;
  const candidates: string[] = [];
  collectCandidateStrings(stdout, candidates);
  collectCandidateStrings(stderr, candidates);
  for (const candidate of candidates.reverse()) {
    const marker = "AEH_RESULT_JSON=";
    const index = candidate.lastIndexOf(marker);
    if (index >= 0) {
      const raw = candidate.slice(index + marker.length).trim();
      const parsed = parseJsonPrefix(raw);
      if (parsed !== undefined) return parsed;
    }
    const rawObject = parseWholeJson(candidate.trim());
    if (rawObject && typeof rawObject === "object" && !Array.isArray(rawObject)) return rawObject;
  }
  throw new Error("Agent output did not contain valid native JSON or an AEH_RESULT_JSON=<json> marker.");
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
  try { return JSON.parse(raw); } catch { /* marker may be followed by log text */ }
  for (let end = raw.length; end > 1; end -= 1) { try { return JSON.parse(raw.slice(0, end)); } catch { /* keep shrinking */ } }
  return undefined;
}
function parseWholeJson(raw: string): unknown | undefined { if (!raw) return undefined; try { return JSON.parse(raw); } catch { return undefined; } }
