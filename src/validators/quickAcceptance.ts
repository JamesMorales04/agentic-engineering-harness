import fs from "node:fs/promises";
import path from "node:path";
import type { TaskContract, ValidationCheck } from "../core/types.js";

/**
 * QUICK acceptance is deliberately small and deterministic. Unsupported
 * natural-language acceptance fails closed instead of being treated as worker
 * testimony, which keeps strict evidence meaningful.
 */
export async function validateQuickAcceptance(root: string, contract: TaskContract, changedFiles: string[], scopeChecks: ValidationCheck[]): Promise<ValidationCheck[]> {
  const acceptance = contract.quick?.acceptance ?? [];
  const scopePass = scopeChecks.find((check) => check.id === "diff.allowed-scope")?.status === "PASS";
  return Promise.all(acceptance.map(async (statement, index): Promise<ValidationCheck> => {
    const id = `quick.acceptance.${index + 1}`;
    const text = statement.trim();
    const content = text.match(/^(.+?)\s+contains exactly\s+[\u0060'\"]([\s\S]*?)[\u0060'\"]\.?$/i);
    if (content) {
      const relative = stripQuotes(content[1].trim());
      const target = path.resolve(root, relative);
      const boundary = path.relative(root, target);
      if (!relative || boundary.startsWith("..") || path.isAbsolute(boundary)) return fail(id, `QUICK acceptance path escapes the workspace: ${relative}`);
      const actual = await fs.readFile(target, "utf8").catch(() => undefined);
      const expected = content[2];
      const normalizedActual = actual === undefined ? undefined : normalizeText(actual);
      const normalizedExpected = normalizeText(expected);
      return normalizedActual === normalizedExpected
        ? { id, category: "acceptance", status: "PASS", message: `${relative} contains the requested exact content.`, details: { path: relative, bytes: Buffer.byteLength(actual!, "utf8") } }
        : fail(id, `${relative} does not contain the requested exact content.`, { path: relative, expected: normalizedExpected, actual: normalizedActual });
    }
    if (/^(?:do not|don't|no)\s+(?:modify|change|touch)\s+any other\s+(?:product\s+)?files?\.?$/i.test(text) || /^no other\s+(?:product\s+)?files?\s+(?:is|are)\s+modified\.?$/i.test(text)) {
      return scopePass
        ? { id, category: "acceptance", status: "PASS", message: "No file outside the declared QUICK scope changed.", details: { changedFiles } }
        : fail(id, "A file outside the declared QUICK scope changed.", { changedFiles });
    }
    return fail(id, "QUICK acceptance has no deterministic evaluator; rewrite it as exact file content or explicit no-other-file scope.", { statement: text });
  }));
}

function stripQuotes(value: string): string { return value.replace(/^[\u0060'\"]|[\u0060'\"]$/g, ""); }
function normalizeText(value: string): string { return value.replaceAll("\r\n", "\n").replace(/\n$/, ""); }
function fail(id: string, message: string, details?: Record<string, unknown>): ValidationCheck { return { id, category: "acceptance", status: "FAIL", message, details }; }
