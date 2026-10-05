import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig, ValidationCheck } from "../core/types.js";
import type { ValidationRequirementV1 } from "../architecture/validationRequirements.js";

/**
 * Per-requirement test attribution for shared validation bundles.
 *
 * Mechanism=DETERMINISTIC: boundary-safe token/phrase matching against Playwright
 * JSON reporter titles (case-sensitive, separator-insensitive), fail-closed on
 * unknown titles, missing reporter, or parse errors.
 * Requirements without declared mapping keep the bundle verdict (no change).
 */

export const TEST_ATTRIBUTION_BLOCKER_PREFIX = "TEST_ATTRIBUTION" as const;

export interface AttributedPlaywrightTestV1 {
  title: string;
  fullTitle: string;
  status: string;
  passed: boolean;
}

export interface TestAttributionEvaluationV1 {
  verdict: "PASS" | "FAIL";
  reason: string;
  blocker?: string;
  matched: number;
  total: number;
  failedTitles: string[];
  selectors: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeStatus(status: unknown): string {
  return String(status ?? "").toLowerCase().trim();
}

function isPassingResultStatus(status: string): boolean {
  // Fail-closed: only explicit pass/expected count as passing evidence.
  // Skipped, flaky, timedOut, interrupted, etc. are not passing evidence.
  return status === "passed" || status === "expected";
}

/**
 * Parse a Playwright JSON reporter document into per-test verdicts.
 * Traverses nested suites/specs/tests/results; a test passes only when it has
 * at least one result and every result is passed/expected.
 */
export function parsePlaywrightReporterTestsV1(value: unknown): AttributedPlaywrightTestV1[] {
  const root = asRecord(value);
  const suites = Array.isArray(root.suites) ? root.suites : [];
  const output: AttributedPlaywrightTestV1[] = [];
  const visitSuite = (suite: unknown, ancestors: string[]): void => {
    const record = asRecord(suite);
    const suiteTitle = typeof record.title === "string" ? record.title : "";
    const nextAncestors = suiteTitle ? [...ancestors, suiteTitle] : ancestors;
    const specs = Array.isArray(record.specs) ? record.specs : [];
    for (const spec of specs) {
      const specRecord = asRecord(spec);
      const specTitle = typeof specRecord.title === "string" ? specRecord.title : "";
      const tests = Array.isArray(specRecord.tests) ? specRecord.tests : [];
      for (const test of tests) {
        const testRecord = asRecord(test);
        const testTitle =
          typeof testRecord.title === "string" && testRecord.title.trim()
            ? testRecord.title.trim()
            : specTitle;
        const fullTitle = [...nextAncestors, specTitle, testTitle].filter(Boolean).join(" > ");
        const results = Array.isArray(testRecord.results) ? testRecord.results : [];
        const statuses = results.map((result) => normalizeStatus(asRecord(result).status));
        const passed = results.length > 0 && statuses.every(isPassingResultStatus);
        const status = statuses.length ? statuses[statuses.length - 1]! : "missing";
        output.push({
          title: specTitle || testTitle,
          fullTitle: fullTitle || specTitle || testTitle || "(untitled)",
          status,
          passed,
        });
      }
    }
    const children = Array.isArray(record.suites) ? record.suites : [];
    for (const child of children) visitSuite(child, nextAncestors);
  };
  for (const suite of suites) visitSuite(suite, []);
  return output;
}

export function parsePlaywrightReporterTextV1(text: string): AttributedPlaywrightTestV1[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      `${TEST_ATTRIBUTION_BLOCKER_PREFIX}_REPORTER_INVALID: Playwright reporter JSON is not parseable.`,
    );
  }
  const tests = parsePlaywrightReporterTestsV1(value);
  if (!Array.isArray((value as Record<string, unknown>).suites)) {
    throw new Error(
      `${TEST_ATTRIBUTION_BLOCKER_PREFIX}_REPORTER_INVALID: Playwright reporter JSON has no suites array.`,
    );
  }
  return tests;
}

/**
 * Effective selectors for a requirement: union of the requirement-declared
 * testSelectors and the project-config testAttribution entry. Empty after
 * trimming/dedup means no mapping (bundle verdict preserved).
 */
export function effectiveTestSelectorsV1(
  requirement: Pick<ValidationRequirementV1, "id"> & { testSelectors?: readonly string[] },
  config?: HarnessProjectConfig,
): string[] {
  const fromRequirement = Array.isArray(requirement.testSelectors) ? requirement.testSelectors : [];
  const fromConfig = (config?.validation?.testAttribution as Record<string, readonly string[]> | undefined)?.[
    requirement.id
  ];
  const combined = [...fromRequirement, ...(Array.isArray(fromConfig) ? fromConfig : [])];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const entry of combined) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

/**
 * Boundary-safe selector matching (Mechanism=DETERMINISTIC).
 *
 * A selector matches a title only as a standalone token/phrase: every
 * non-alphanumeric run (spaces, hyphens, underscores, colons, ">", etc.) is
 * normalized to a single space, then the normalized selector must appear as a
 * contiguous substring bounded by token edges (implemented via space-padding).
 * This prevents selector 'S1' from matching title 'S11' (false PASS risk)
 * while still allowing separator variants such as 'S9-journey' to match
 * 'S9 journey title'.
 *
 * Case behavior: case-SENSITIVE (unchanged from the previous raw `includes`),
 * to avoid widening matches; only separator/boundary handling changed.
 */
function normalizeAttributionTextV1(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function matchesAttributionSelectorV1(haystack: string, selector: string): boolean {
  const normalizedHaystack = normalizeAttributionTextV1(haystack);
  const normalizedSelector = normalizeAttributionTextV1(selector);
  if (!normalizedHaystack || !normalizedSelector) return false;
  return ` ${normalizedHaystack} `.includes(` ${normalizedSelector} `);
}

export function evaluateTestAttributionV1(input: {
  requirementId: string;
  selectors: readonly string[];
  tests: readonly AttributedPlaywrightTestV1[];
}): TestAttributionEvaluationV1 {
  const selectors = [...new Set(input.selectors.map((s) => s.trim()).filter(Boolean))];
  if (!selectors.length) {
    return {
      verdict: "FAIL",
      reason: `Requirement '${input.requirementId}' declares no test selectors; attribution requires at least one.`,
      blocker: `${TEST_ATTRIBUTION_BLOCKER_PREFIX}_NO_MATCH`,
      matched: 0,
      total: input.tests.length,
      failedTitles: [],
      selectors,
    };
  }
  const matched = input.tests.filter((test) =>
    selectors.some(
      (selector) =>
        matchesAttributionSelectorV1(test.fullTitle, selector) ||
        matchesAttributionSelectorV1(test.title, selector),
    ),
  );
  if (!matched.length) {
    return {
      verdict: "FAIL",
      reason: `Requirement '${input.requirementId}' selectors matched 0 of ${input.tests.length} reporter tests; unknown titles fail closed.`,
      blocker: `${TEST_ATTRIBUTION_BLOCKER_PREFIX}_NO_MATCH`,
      matched: 0,
      total: input.tests.length,
      failedTitles: [],
      selectors,
    };
  }
  const failed = matched.filter((test) => !test.passed);
  if (failed.length) {
    return {
      verdict: "FAIL",
      reason: `Requirement '${input.requirementId}' has ${failed.length}/${matched.length} failing attributed tests: ${failed
        .slice(0, 5)
        .map((t) => `'${t.fullTitle}' (${t.status})`)
        .join("; ")}${failed.length > 5 ? ` (+${failed.length - 5} more)` : ""}.`,
      blocker: `${TEST_ATTRIBUTION_BLOCKER_PREFIX}_TEST_FAILED`,
      matched: matched.length,
      total: input.tests.length,
      failedTitles: failed.map((t) => t.fullTitle),
      selectors,
    };
  }
  return {
    verdict: "PASS",
    reason: `Requirement '${input.requirementId}' has ${matched.length}/${matched.length} attributed tests passing.`,
    matched: matched.length,
    total: input.tests.length,
    failedTitles: [],
    selectors,
  };
}

function tryParseReporterFromText(
  text: unknown,
): AttributedPlaywrightTestV1[] | undefined {
  if (typeof text !== "string" || !text.trim()) return undefined;
  const trimmed = text.trim();
  // Fast path: whole stdout is JSON.
  try {
    return parsePlaywrightReporterTextV1(trimmed);
  } catch {
    // Fall through to embedded-JSON scan below.
  }
  // Reporter stdout may be embedded in `stdout\n--- stderr ---\n stderr`
  // raw files or have trailing logs. Scan for the largest JSON object with suites.
  const candidates: AttributedPlaywrightTestV1[][] = [];
  // Try incremental brace scan: find `{` ... `}` slices that parse with suites.
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const slice = trimmed.slice(start, i + 1);
        try {
          const parsed = JSON.parse(slice) as Record<string, unknown>;
          if (Array.isArray(parsed.suites)) {
            candidates.push(parsePlaywrightReporterTestsV1(parsed));
          }
        } catch {
          // Not JSON; continue scanning.
        }
        start = -1;
      }
      if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }
  if (!candidates.length) return undefined;
  // Prefer the candidate with the most tests (fullest report).
  return candidates.sort((a, b) => b.length - a.length)[0];
}

/**
 * Extract Playwright reporter tests from a bundle execution check.
 * Reads (in order): details.stdout, rawArtifact file, details.stderr.
 * Returns undefined when no parseable reporter is available (caller fails closed).
 */
export async function extractReporterTestsFromExecutionV1(
  root: string,
  execution: ValidationCheck,
): Promise<AttributedPlaywrightTestV1[] | undefined> {
  const details = (execution.details ?? {}) as Record<string, unknown>;
  const directTexts: unknown[] = [details.stdout];
  for (const text of directTexts) {
    const parsed = tryParseReporterFromText(text);
    if (parsed) return parsed;
  }
  const rawArtifact = details.rawArtifact;
  if (typeof rawArtifact === "string" && rawArtifact.trim()) {
    try {
      const absolute = path.resolve(root, rawArtifact);
      const content = await fs.readFile(absolute, "utf8");
      const parsed = tryParseReporterFromText(content);
      if (parsed) return parsed;
    } catch {
      // Missing/unreadable artifact falls through to stderr/fail-closed.
    }
  }
  const stderrParsed = tryParseReporterFromText(details.stderr);
  if (stderrParsed) return stderrParsed;
  return undefined;
}
