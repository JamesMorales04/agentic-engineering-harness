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

export const TEST_ATTRIBUTION_SKIPPED =
  `${TEST_ATTRIBUTION_BLOCKER_PREFIX}_SKIPPED` as const;

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
  /**
   * Normalized test-level outcome (`JSONReportTest.status`: expected |
   * unexpected | flaky | skipped), lowercased; "" when the document omits it
   * (legacy reporter shapes / hand-constructed literals). Distinct from
   * `status`, which remains the LAST RESULT status for display and
   * back-compat. The outcome model reads THIS field: `unexpected` is always
   * a failure (it fails the bundle even when every result passed);
   * expected/flaky/skipped are never failures (Playwright pass semantics
   * for flaky); unknown/"" falls back to the explicit-failed-result rule.
   */
  testStatus?: string;
}

export interface TestAttributionEvaluationV1 {
  verdict: "PASS" | "FAIL";
  reason: string;
  blocker?: string;
  matched: number;
  total: number;
  failedTitles: string[];
  selectors: string[];
  /**
   * Full titles of matched tests whose test-level outcome is `flaky`
   * (ultimate pass after a retry). Recorded on PASS so the flakiness is
   * explicit in the details, never silent; also present on FAIL paths that
   * evaluated the attribution.
   */
  flakyTitles: string[];
  /**
   * Full titles of attributed-but-skipped tests. Non-empty exactly when the
   * blocker is TEST_ATTRIBUTION_SKIPPED.
   */
  skippedTitles: string[];
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
 * timedout, and interrupted explain a bundle failure at RESULT level; the
 * TEST-level `unexpected` outcome additionally explains one (handled by the
 * outcome model, not here). There is no `error`
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
 * Normalized test-level outcome for a reporter test
 * (Mechanism=DETERMINISTIC).
 *
 * Reads the test-level `testStatus` (`JSONReportTest.status`: expected |
 * unexpected | flaky | skipped). Hand-constructed literals and legacy
 * reporter documents omit it (""); callers treat "" as unknown and fall
 * back to the explicit-failed-result rule (back-compat).
 */
function testOutcomeStatus(test: AttributedPlaywrightTestV1): string {
  return typeof test.testStatus === "string" ? normalizeStatus(test.testStatus) : "";
}

/**
 * Test-level outcomes that are never failures even when a recorded result
 * carries an explicit failure status (Mechanism=DETERMINISTIC):
 * - `expected`: the outcome matched the declared expectation (including an
 *   expected-to-fail test that failed as declared — the bundle stays green);
 * - `flaky`: the test passed on retry — Playwright pass semantics, reported
 *   separately via flakyTitles, never a requirement failure absent an
 *   explicit anti-flake policy;
 * - `skipped`: the test did not run — unevaluated, never a TEST_FAILED.
 */
const NON_FAILURE_OUTCOMES_V1 = new Set(["expected", "flaky", "skipped"]);

/**
 * Whether a reporter test counts as a failure for attribution
 * (Mechanism=DETERMINISTIC):
 *
 * failurePresent(test) = test-level `unexpected`
 *   OR (explicit failed result AND test-level NOT IN {expected, flaky, skipped}).
 *
 * `unexpected` fails the bundle even when every result passed (an
 * expected-to-fail test that PASSES is an anomaly the reporter DOES
 * explain). Unknown/missing test-level status falls back to the
 * explicit-failed-result rule (back-compat for legacy documents and
 * hand-constructed literals); unknown with no failed result is no failure.
 */
function isAttributionFailurePresent(test: AttributedPlaywrightTestV1): boolean {
  const outcome = testOutcomeStatus(test);
  if (outcome === "unexpected") return true;
  const explicitFailed = hasExplicitFailure(test);
  if (!outcome || outcome === "missing" || outcome === "unknown") return explicitFailed;
  if (NON_FAILURE_OUTCOMES_V1.has(outcome)) return false;
  return explicitFailed;
}

/**
 * Whether a reporter test is skipped for attribution (Mechanism=DETERMINISTIC):
 * explicit test-level `skipped`, or — for legacy inputs without a test-level
 * outcome — a skipped last-result status. Missing-result tests are NOT
 * skipped (they stay on the NO_MATCH path).
 */
function isSkippedAttributionTest(test: AttributedPlaywrightTestV1): boolean {
  const outcome = testOutcomeStatus(test);
  if (outcome === "skipped") return true;
  if (outcome) return false;
  return normalizeStatus(test.status) === "skipped";
}

function isFlakyAttributionTest(test: AttributedPlaywrightTestV1): boolean {
  return testOutcomeStatus(test) === "flaky";
}

/**
 * Parse a Playwright JSON reporter document into per-test verdicts.
 * Traverses nested suites/specs/tests/results. Records BOTH the test-level
 * outcome (`JSONReportTest.status`: expected | unexpected | flaky | skipped)
 * and the last-result status: a test passes only when its outcome is not an
 * anomaly — `unexpected`/`skipped` never pass; `expected` passes when it ran;
 * `flaky` passes when its final result passed (Playwright pass semantics;
 * the retry failure stays visible via hasFailedResult and flakyTitles).
 * Documents without a test-level status keep the legacy rule (at least one
 * result and every result passed/expected).
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
        const outcome = normalizeStatus(testRecord.status);
        const lastStatus = statuses.length ? statuses[statuses.length - 1]! : "missing";
        let passed: boolean;
        if (outcome === "unexpected" || outcome === "skipped") passed = false;
        else if (outcome === "expected") passed = results.length > 0;
        else if (outcome === "flaky") passed = statuses.length > 0 && isPassingResultStatus(lastStatus);
        else passed = results.length > 0 && statuses.every(isPassingResultStatus);
        const status = lastStatus;
        output.push({
          title: specTitle || testTitle,
          fullTitle: fullTitle || specTitle || testTitle || "(untitled)",
          status,
          passed,
          hasFailedResult: statuses.some(isFailedResultStatus),
          testStatus: outcome,
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
      flakyTitles: [],
      skippedTitles: [],
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
      flakyTitles: [],
      skippedTitles: [],
      selectors,
    };
  }
  // Outcome-model failures (Mechanism=DETERMINISTIC): test-level `unexpected`
  // (even with all-passing results), or an explicit failed result on a test
  // whose outcome is not expected/flaky/skipped. Attributed flaky-pass and
  // expected-outcome tests are NOT failures.
  const failed = matched.filter((test) => isAttributionFailurePresent(test));
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
      flakyTitles: matched.filter((test) => isFlakyAttributionTest(test)).map((t) => t.fullTitle),
      skippedTitles: [],
      selectors,
    };
  }
  const flakyTitles = matched.filter((test) => isFlakyAttributionTest(test)).map((t) => t.fullTitle);
  // Attributed-but-unevaluated (Mechanism=DETERMINISTIC): an attributed test
  // that neither passed nor counts as a failure (skipped, missing result) is
  // not evidence of passing and can never PASS — but a skipped test is not a
  // test failure either, so it fails via the distinct TEST_ATTRIBUTION_SKIPPED
  // blocker (the selector DID match), never TEST_FAILED and never NO_MATCH.
  // Missing-result tests stay on the NO_MATCH path.
  const unevaluated = matched.filter((test) => !test.passed);
  if (unevaluated.length) {
    const skipped = unevaluated.filter((test) => isSkippedAttributionTest(test));
    if (skipped.length) {
      const others = unevaluated.length - skipped.length;
      return {
        verdict: "FAIL",
        reason: `Requirement '${input.requirementId}' has ${skipped.length}/${matched.length} attributed tests skipped without passing evidence: ${skipped
          .slice(0, 5)
          .map((t) => `'${t.fullTitle}' (${t.status})`)
          .join("; ")}${skipped.length > 5 ? ` (+${skipped.length - 5} more)` : ""}${others ? ` (+${others} other attributed test(s) without passing evidence)` : ""}. Skipped tests cannot PASS.`,
        blocker: TEST_ATTRIBUTION_SKIPPED,
        matched: matched.length,
        total: input.tests.length,
        failedTitles: [],
        flakyTitles,
        skippedTitles: skipped.map((t) => t.fullTitle),
        selectors,
      };
    }
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
      flakyTitles,
      skippedTitles: [],
      selectors,
    };
  }
  return {
    verdict: "PASS",
    reason: `Requirement '${input.requirementId}' has ${matched.length}/${matched.length} attributed tests passing${flakyTitles.length ? ` (including ${flakyTitles.length} flaky ultimate-pass: ${flakyTitles.slice(0, 5).map((t) => `'${t}'`).join("; ")}${flakyTitles.length > 5 ? ` (+${flakyTitles.length - 5} more)` : ""})` : ""}.`,
    matched: matched.length,
    total: input.tests.length,
    failedTitles: [],
    flakyTitles,
    skippedTitles: [],
    selectors,
  };
}

/**
 * Reporter failures inside a requirement's attributed set
 * (Mechanism=DETERMINISTIC).
 *
 * Computed from the single authentic reporter's OWN per-test failure list
 * under the outcome model: test-level `unexpected`, or an explicit failure
 * status (failed/timedOut/interrupted on any result) on a test whose outcome
 * is not expected/flaky/skipped. Bundle stderr text is never consulted —
 * stderr carries untrusted process output, while the reporter document is
 * the authentic per-test record. An attributed SKIPPED test is unevaluated,
 * not failed: it is excluded here (evaluation already FAILs it via
 * TEST_ATTRIBUTION_SKIPPED, never TEST_FAILED), as is an attributed
 * flaky-pass (Playwright pass semantics). A mapped PASS requires this list
 * to be empty (every recorded failure is outside the attributed set); a
 * non-empty list FAILs the requirement even if the bundle exit code looks
 * healthy.
 */
export function attributedReporterFailuresV1(input: {
  selectors: readonly string[];
  tests: readonly AttributedPlaywrightTestV1[];
}): AttributedPlaywrightTestV1[] {
  const selectors = [...new Set(input.selectors.map((s) => s.trim()).filter(Boolean))];
  if (!selectors.length) return [];
  return input.tests.filter(
    (test) =>
      isAttributionFailurePresent(test) &&
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
 * A non-passing bundle must be explained by at least one failure under the
 * outcome model recorded in its own reporter document: test-level
 * `unexpected` (even with all-passing results — an expected-to-fail test
 * that PASSES fails the bundle and the reporter DOES explain the anomaly),
 * or an EXPLICIT failure status (failed/timedOut/interrupted on any result)
 * on a test whose outcome is not expected/flaky/skipped. Skipped,
 * flaky-ultimate-pass, expected-outcome, and missing-result tests explain
 * nothing — a bundle that fails with zero outcome-model failures
 * (all-skipped + teardown crash, empty run + nonzero exit) is incomplete
 * (or forged: code under test shares the bundle's stdout and can inject an
 * all-green document while the real failure goes elsewhere) and must fail
 * closed. Forgery cannot escape by inventing failures either: an invented
 * failure inside the attribution fails rule (iii), and one outside the
 * attribution is consistent with the real bundle failure, which is the
 * honest outcome.
 */
export function reporterHasAnyFailureV1(tests: readonly AttributedPlaywrightTestV1[]): boolean {
  return tests.some((test) => isAttributionFailurePresent(test));
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
 *
 * File-only mode (R-NEW-1, Mechanism=DETERMINISTIC): when
 * `details.evidenceFile` declares a reporter file (propagated from
 * `spec.options.evidenceFile` by the external validator), reporter JSON is
 * read ONLY from that file — never stdout/stderr/rawArtifact. Missing,
 * unreadable, malformed, or ambiguous declared files yield undefined so
 * callers fail closed with a coded TEST_ATTRIBUTION_REPORTER_MISSING.
 *
 * Default (no evidenceFile) discovery behavior is UNCHANGED: reads
 * details.stdout, the rawArtifact file, and details.stderr together. Returns
 * the reporter tests only when exactly one DISTINCT reporter document is
 * present across every consulted source. Zero means no attributable
 * reporter; more than one means the output is ambiguous and attribution is
 * refused. Callers fail closed on undefined. No path returns a reporter
 * without the count check.
 */
export async function extractReporterTestsFromExecutionV1(
  root: string,
  execution: ValidationCheck,
): Promise<AttributedPlaywrightTestV1[] | undefined> {
  const details = (execution.details ?? {}) as Record<string, unknown>;
  const declaredEvidenceFile =
    typeof details.evidenceFile === "string" && details.evidenceFile.trim()
      ? details.evidenceFile.trim()
      : undefined;
  if (declaredEvidenceFile) {
    let text: string;
    try {
      text = await fs.readFile(path.resolve(root, declaredEvidenceFile), "utf8");
    } catch {
      // Missing/unreadable declared file contributes no reporter document.
      return undefined;
    }
    const documents = new Map<string, AttributedPlaywrightTestV1[]>();
    for (const document of collectReporterDocumentsFromText(text)) {
      if (!documents.has(document.digest)) documents.set(document.digest, document.tests);
    }
    if (documents.size !== 1) return undefined;
    return [...documents.values()][0];
  }
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
