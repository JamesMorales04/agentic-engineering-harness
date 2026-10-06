import fs from "node:fs/promises";
import path from "node:path";
import { sha256Canonical } from "../core/digest.js";
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

export const TEST_ATTRIBUTION_REPORTER_INCOMPLETE =
  `${TEST_ATTRIBUTION_BLOCKER_PREFIX}_REPORTER_INCOMPLETE` as const;

export interface AttributedPlaywrightTestV1 {
  title: string;
  fullTitle: string;
  status: string;
  passed: boolean;
  /**
   * True when ANY recorded result carries an explicit failure status
   * (failed/timedOut/interrupted). Present on parser output; absent on
   * hand-constructed literals, where callers fall back to `status`.
   * Tracks retries: a flaky test (failed then passed) still recorded a
   * failure even though its final status is passing.
   */
  hasFailedResult?: boolean;
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
 * Explicit failure statuses from the Playwright reporter vocabulary
 * (Mechanism=DETERMINISTIC).
 *
 * Per-result status (`TestStatus`: passed | failed | timedOut | skipped |
 * interrupted — see playwright `JSONReportTestResult.status`) is lowercased
 * by `normalizeStatus`, so `timedOut` arrives as `timedout`. Only failed,
 * timedout, and interrupted explain a bundle failure. There is no `error`
 * status in the schema (errors are a result payload, not a status);
 * `expected`/`unexpected`/`flaky` are test-level (`JSONReportTest.status`),
 * never result-level, and this parser emits only last-result statuses (or
 * `missing` for zero results). Skipped, missing-result, passing, and unknown
 * statuses are NOT failures: a bundle that fails with zero failed-status
 * tests (all-skipped + crash, empty run + nonzero exit) has an incomplete
 * reporter and must fail closed.
 */
function isFailedResultStatus(status: string): boolean {
  return status === "failed" || status === "timedout" || status === "interrupted";
}

/**
 * Whether a reporter test records an explicit failure. Prefers the
 * parser-computed per-result flag (retry-aware); falls back to the final
 * status for hand-constructed literals.
 */
function hasExplicitFailure(test: AttributedPlaywrightTestV1): boolean {
  if (typeof test.hasFailedResult === "boolean") return test.hasFailedResult;
  return isFailedResultStatus(normalizeStatus(test.status));
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
          hasFailedResult: statuses.some(isFailedResultStatus),
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
  const failed = matched.filter((test) => hasExplicitFailure(test));
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
  // Attributed-but-unevaluated (Mechanism=DETERMINISTIC): an attributed test
  // that neither passed nor explicitly failed (skipped, missing result) is
  // not evidence of passing and can never PASS — but it is not a test
  // failure either, so it fails via the NO_MATCH blocker path, never
  // TEST_FAILED.
  const unevaluated = matched.filter((test) => !test.passed);
  if (unevaluated.length) {
    return {
      verdict: "FAIL",
      reason: `Requirement '${input.requirementId}' has ${unevaluated.length}/${matched.length} attributed tests without passing evidence (no explicit failure): ${unevaluated
        .slice(0, 5)
        .map((t) => `'${t.fullTitle}' (${t.status})`)
        .join("; ")}${unevaluated.length > 5 ? ` (+${unevaluated.length - 5} more)` : ""}. Skipped or missing results cannot PASS.`,
      blocker: `${TEST_ATTRIBUTION_BLOCKER_PREFIX}_NO_MATCH`,
      matched: matched.length,
      total: input.tests.length,
      failedTitles: [],
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

/**
 * Reporter failures inside a requirement's attributed set
 * (Mechanism=DETERMINISTIC).
 *
 * Computed from the single authentic reporter's OWN per-test failure list:
 * every reporter test with an EXPLICIT failure status (failed/timedOut/
 * interrupted on any result) is checked against the requirement selectors
 * with the same boundary-safe matching as evaluation. Bundle stderr text is
 * never consulted — stderr carries untrusted process output, while the
 * reporter document is the authentic per-test record. An attributed SKIPPED
 * (or missing-result) test is unevaluated, not failed: it is excluded here
 * (evaluation already FAILs it via NO_MATCH, never TEST_FAILED). A mapped
 * PASS requires this list to be empty (every recorded failure is outside
 * the attributed set); a non-empty list FAILs the requirement even if the
 * bundle exit code looks healthy.
 */
export function attributedReporterFailuresV1(input: {
  selectors: readonly string[];
  tests: readonly AttributedPlaywrightTestV1[];
}): AttributedPlaywrightTestV1[] {
  const selectors = [...new Set(input.selectors.map((s) => s.trim()).filter(Boolean))];
  if (!selectors.length) return [];
  return input.tests.filter(
    (test) =>
      hasExplicitFailure(test) &&
      selectors.some(
        (selector) =>
          matchesAttributionSelectorV1(test.fullTitle, selector) ||
          matchesAttributionSelectorV1(test.title, selector),
      ),
  );
}

/**
 * Reporter failures anywhere in the single authentic reporter
 * (Mechanism=DETERMINISTIC).
 *
 * A non-passing bundle must be explained by at least one EXPLICIT failure
 * status (failed/timedOut/interrupted on any result) recorded in its own
 * reporter document. Skipped and missing-result tests are non-passing but
 * explain nothing — a bundle that fails with zero failed-status tests
 * (all-skipped + teardown crash, empty run + nonzero exit) is incomplete
 * (or forged: code under test shares the bundle's stdout and can inject an
 * all-green document while the real failure goes elsewhere) and must fail
 * closed. Forgery cannot escape by inventing failures either: an invented
 * failure inside the attribution fails rule (iii), and one outside the
 * attribution is consistent with the real bundle failure, which is the
 * honest outcome.
 */
export function reporterHasAnyFailureV1(tests: readonly AttributedPlaywrightTestV1[]): boolean {
  return tests.some((test) => hasExplicitFailure(test));
}

/**
 * Collect every Playwright reporter document embedded in a text,
 * deduplicated by canonical content digest (Mechanism=DETERMINISTIC).
 *
 * Reporter stdout may be embedded in `stdout\n--- stderr ---\n stderr` raw
 * files or have trailing logs. The incremental brace scan finds `{` ... `}`
 * slices that parse with a suites array. Identical documents observed more
 * than once (the provider flow duplicates bounded stdout into the raw
 * artifact file) are one provenance, not ambiguity; distinct documents mean
 * the output is ambiguous — model-authored code under test can console.log a
 * second all-green reporter to forge a PASS — so callers must refuse
 * attribution. Never largest-wins, never first-parseable-wins, and no
 * whole-text fast path that could bypass the count.
 */
function collectReporterDocumentsFromText(
  text: unknown,
): Array<{ digest: string; tests: AttributedPlaywrightTestV1[] }> {
  if (typeof text !== "string" || !text.trim()) return [];
  const trimmed = text.trim();
  const documents: Array<{ digest: string; tests: AttributedPlaywrightTestV1[] }> = [];
  const seen = new Set<string>();
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
            const digest = sha256Canonical(parsed);
            if (!seen.has(digest)) {
              seen.add(digest);
              documents.push({ digest, tests: parsePlaywrightReporterTestsV1(parsed) });
            }
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
  return documents;
}

/**
 * Extract Playwright reporter tests from a bundle execution check.
 * Reads details.stdout, the rawArtifact file, and details.stderr together.
 * Returns the reporter tests only when exactly one DISTINCT reporter
 * document is present across every source. Zero means no attributable
 * reporter; more than one means the output is ambiguous and attribution is
 * refused. Callers fail closed on undefined. No path returns a reporter
 * without the count check.
 */
export async function extractReporterTestsFromExecutionV1(
  root: string,
  execution: ValidationCheck,
): Promise<AttributedPlaywrightTestV1[] | undefined> {
  const details = (execution.details ?? {}) as Record<string, unknown>;
  const sources: unknown[] = [details.stdout];
  const rawArtifact = details.rawArtifact;
  if (typeof rawArtifact === "string" && rawArtifact.trim()) {
    try {
      const absolute = path.resolve(root, rawArtifact);
      sources.push(await fs.readFile(absolute, "utf8"));
    } catch {
      // Missing/unreadable artifact contributes no reporter document.
    }
  }
  sources.push(details.stderr);
  const documents = new Map<string, AttributedPlaywrightTestV1[]>();
  for (const text of sources) {
    for (const document of collectReporterDocumentsFromText(text)) {
      if (!documents.has(document.digest)) documents.set(document.digest, document.tests);
    }
  }
  if (documents.size !== 1) return undefined;
  return [...documents.values()][0];
}
