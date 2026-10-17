import { describe, expect, it } from "vitest";
import {
  attributedReporterFailuresV1,
  evaluateTestAttributionV1,
  parsePlaywrightReporterTestsV1,
} from "../../src/validation/testAttribution.js";

/**
 * D30: file-identity selectors (Mechanism=DETERMINISTIC).
 *
 * The Playwright parser retains the spec `file` field; a selector that
 * exactly equals the retained file attributes that file's tests. Title
 * matching is unchanged, directory prefixes never match, and missing or
 * unknown files fail closed.
 */
function multiFileBundle(): unknown {
  return {
    suites: [
      {
        title: "bundle",
        specs: [
          {
            title: "alpha journey",
            file: "tests/tasks.unit.spec.js",
            tests: [{ status: "expected", results: [{ status: "passed" }] }],
          },
          {
            title: "beta journey",
            file: "tests/tasks.unit.spec.js",
            tests: [{ status: "expected", results: [{ status: "passed" }] }],
          },
          {
            title: "gamma journey",
            file: "tests/other.spec.js",
            tests: [{ status: "expected", results: [{ status: "passed" }] }],
          },
        ],
      },
    ],
  };
}

describe("D30 file-identity test attribution", () => {
  it("(a) file selector matches tests from that file only", () => {
    const tests = parsePlaywrightReporterTestsV1(multiFileBundle());
    expect(tests).toHaveLength(3);
    const evalA = evaluateTestAttributionV1({
      requirementId: "REQ-FILE-A",
      selectors: ["tests/tasks.unit.spec.js"],
      tests,
    });
    expect(evalA.verdict).toBe("PASS");
    expect(evalA.matched).toBe(2);
    // File-B tests are not attributed by the file-A selector.
    const evalB = evaluateTestAttributionV1({
      requirementId: "REQ-FILE-B",
      selectors: ["tests/other.spec.js"],
      tests,
    });
    expect(evalB.verdict).toBe("PASS");
    expect(evalB.matched).toBe(1);
  });

  it("(a-red) pre-fix behavior would be NO_MATCH: file selector is not a title", () => {
    // Guard: the file-A selector must NOT match via title matching, so this
    // test is RED (NO_MATCH) without the file-identity rule and GREEN with it.
    const tests = parsePlaywrightReporterTestsV1(multiFileBundle()).map((t) => ({
      ...t,
      file: undefined,
    }));
    const evalNoFile = evaluateTestAttributionV1({
      requirementId: "REQ-FILE-A",
      selectors: ["tests/tasks.unit.spec.js"],
      tests,
    });
    expect(evalNoFile.verdict).toBe("FAIL");
    expect(evalNoFile.blocker).toBe("TEST_ATTRIBUTION_NO_MATCH");
    expect(evalNoFile.matched).toBe(0);
  });

  it("(b) title selectors behave exactly as before with file identity present", () => {
    const tests = parsePlaywrightReporterTestsV1(multiFileBundle());
    const byTitle = evaluateTestAttributionV1({
      requirementId: "REQ-TITLE",
      selectors: ["alpha journey"],
      tests,
    });
    expect(byTitle.verdict).toBe("PASS");
    expect(byTitle.matched).toBe(1);
    // Boundary-safe title matching is unchanged: S1 still does not match S11.
    const s1 = evaluateTestAttributionV1({
      requirementId: "REQ-S1",
      selectors: ["S1"],
      tests: [
        { title: "S11-title", fullTitle: "suite > S11-title", status: "passed", passed: true },
      ],
    });
    expect(s1.matched).toBe(0);
    expect(s1.verdict).toBe("FAIL");
  });

  it("(c) absent file field never matches a file selector (fail-closed)", () => {
    const handLiteral = {
      title: "alpha journey",
      fullTitle: "bundle > alpha journey",
      status: "passed",
      passed: true,
    };
    const evalMissing = evaluateTestAttributionV1({
      requirementId: "REQ-NOFILE",
      selectors: ["tests/tasks.unit.spec.js"],
      tests: [handLiteral],
    });
    expect(evalMissing.verdict).toBe("FAIL");
    expect(evalMissing.blocker).toBe("TEST_ATTRIBUTION_NO_MATCH");
    expect(evalMissing.matched).toBe(0);
  });

  it("(d) unknown file matches nothing (fail-closed)", () => {
    const tests = parsePlaywrightReporterTestsV1(multiFileBundle());
    const evalUnknown = evaluateTestAttributionV1({
      requirementId: "REQ-UNKNOWN-FILE",
      selectors: ["tests/does-not-exist.spec.js"],
      tests,
    });
    expect(evalUnknown.verdict).toBe("FAIL");
    expect(evalUnknown.blocker).toBe("TEST_ATTRIBUTION_NO_MATCH");
    expect(evalUnknown.matched).toBe(0);
  });

  it("boundary: directory-prefix selectors never match (exact files only)", () => {
    const tests = parsePlaywrightReporterTestsV1(multiFileBundle());
    const evalDir = evaluateTestAttributionV1({
      requirementId: "REQ-DIR",
      selectors: ["tests/"],
      tests,
    });
    expect(evalDir.matched).toBe(0);
    expect(evalDir.blocker).toBe("TEST_ATTRIBUTION_NO_MATCH");
  });

  it("parser retains spec file with slash normalization, undefined when absent", () => {
    const parsed = parsePlaywrightReporterTestsV1({
      suites: [
        {
          title: "bundle",
          specs: [
            {
              title: "win journey",
              file: "tests\\win.spec.js",
              tests: [{ results: [{ status: "passed" }] }],
            },
            { title: "bare journey", tests: [{ results: [{ status: "passed" }] }] },
          ],
        },
      ],
    });
    const byTitle = new Map(parsed.map((t) => [t.title, t]));
    expect(byTitle.get("win journey")?.file).toBe("tests/win.spec.js");
    expect(byTitle.get("bare journey")?.file).toBeUndefined();
    // Backslash selector normalizes to the same retained file.
    const evalWin = evaluateTestAttributionV1({
      requirementId: "REQ-WIN",
      selectors: ["tests\\win.spec.js"],
      tests: parsed,
    });
    expect(evalWin.matched).toBe(1);
    expect(evalWin.verdict).toBe("PASS");
  });

  it("reporter-failure attribution shares the file-identity rule", () => {
    const tests = parsePlaywrightReporterTestsV1({
      suites: [
        {
          title: "bundle",
          specs: [
            {
              title: "alpha journey",
              file: "tests/a.spec.js",
              tests: [{ status: "unexpected", results: [{ status: "passed" }] }],
            },
            {
              title: "gamma journey",
              file: "tests/b.spec.js",
              tests: [{ status: "expected", results: [{ status: "passed" }] }],
            },
          ],
        },
      ],
    });
    expect(
      attributedReporterFailuresV1({ selectors: ["tests/a.spec.js"], tests }).map((t) => t.title),
    ).toEqual(["alpha journey"]);
    expect(attributedReporterFailuresV1({ selectors: ["tests/b.spec.js"], tests })).toEqual([]);
  });
});

describe("D30b segment-suffix file matching (bare-vs-rooted variance)", () => {
  function passingTest(title: string, fullTitle: string, file: string) {
    return { title, fullTitle, status: "passed", passed: true, file };
  }

  it("bare reporter file vs rooted selector MATCHES (live D30b case)", () => {
    // Live: reporter emits `contract-api.spec.js`, authors select `tests/contract-api.spec.js`.
    const tests = parsePlaywrightReporterTestsV1({
      suites: [
        {
          title: "bundle",
          specs: [
            {
              title: "contract list journey",
              file: "contract-api.spec.js",
              tests: [{ status: "expected", results: [{ status: "passed" }] }],
            },
          ],
        },
      ],
    });
    expect(tests).toHaveLength(1);
    expect(tests[0]!.file).toBe("contract-api.spec.js");
    const evalLive = evaluateTestAttributionV1({
      requirementId: "REQ-D30B-LIVE",
      selectors: ["tests/contract-api.spec.js"],
      tests,
    });
    expect(evalLive.verdict).toBe("PASS");
    expect(evalLive.matched).toBe(1);
  });

  it("prefixed reporter file vs shorter relative selector MATCHES (suffix)", () => {
    const tests = [
      passingTest(
        "contract list journey",
        "bundle > contract list journey",
        "frontend/tests/contract-api.spec.js",
      ),
    ];
    const evalShorter = evaluateTestAttributionV1({
      requirementId: "REQ-D30B-SHORTER",
      selectors: ["tests/contract-api.spec.js"],
      tests,
    });
    expect(evalShorter.verdict).toBe("PASS");
    expect(evalShorter.matched).toBe(1);
  });

  it("absolute reporter file vs rooted selector MATCHES", () => {
    const tests = [
      passingTest(
        "contract list journey",
        "bundle > contract list journey",
        "/home/runner/work/repo/tests/contract-api.spec.js",
      ),
    ];
    const evalAbs = evaluateTestAttributionV1({
      requirementId: "REQ-D30B-ABS",
      selectors: ["tests/contract-api.spec.js"],
      tests,
    });
    expect(evalAbs.verdict).toBe("PASS");
    expect(evalAbs.matched).toBe(1);
  });

  it("`./`-prefixed selector MATCHES the same file", () => {
    const tests = [
      passingTest(
        "contract list journey",
        "bundle > contract list journey",
        "tests/contract-api.spec.js",
      ),
    ];
    const evalDot = evaluateTestAttributionV1({
      requirementId: "REQ-D30B-DOTSLASH",
      selectors: ["./tests/contract-api.spec.js"],
      tests,
    });
    expect(evalDot.verdict).toBe("PASS");
    expect(evalDot.matched).toBe(1);
  });

  it("same-basename collision does NOT match (segment-aligned)", () => {
    const tests = [
      passingTest("other journey", "bundle > other journey", "b/foo.spec.js"),
    ];
    const evalCollision = evaluateTestAttributionV1({
      requirementId: "REQ-D30B-COLLISION",
      selectors: ["a/foo.spec.js"],
      tests,
    });
    expect(evalCollision.verdict).toBe("FAIL");
    expect(evalCollision.blocker).toBe("TEST_ATTRIBUTION_NO_MATCH");
    expect(evalCollision.matched).toBe(0);
  });

  it("`tests/` directory prefix still never file-matches", () => {
    const tests = parsePlaywrightReporterTestsV1(multiFileBundle());
    const evalDir = evaluateTestAttributionV1({
      requirementId: "REQ-D30B-DIR",
      selectors: ["tests/"],
      tests,
    });
    expect(evalDir.matched).toBe(0);
    expect(evalDir.blocker).toBe("TEST_ATTRIBUTION_NO_MATCH");
  });

  it("slash-less selector never file-matches (title-only path unchanged)", () => {
    const withoutTitle = [
      passingTest("alpha journey", "bundle > alpha journey", "tests/contract-api.spec.js"),
    ];
    // Titles lack the selector, and the slash-less selector must not file-match.
    const evalNoTitle = evaluateTestAttributionV1({
      requirementId: "REQ-D30B-SLASHLESS-NOTITLE",
      selectors: ["contract-api"],
      tests: withoutTitle,
    });
    expect(evalNoTitle.verdict).toBe("FAIL");
    expect(evalNoTitle.blocker).toBe("TEST_ATTRIBUTION_NO_MATCH");
    expect(evalNoTitle.matched).toBe(0);
    // Title containing it still matches via the (unchanged) title path.
    const withTitle = [
      passingTest(
        "contract-api journey",
        "bundle > contract-api journey",
        "tests/other.spec.js",
      ),
    ];
    const evalTitle = evaluateTestAttributionV1({
      requirementId: "REQ-D30B-SLASHLESS-TITLE",
      selectors: ["contract-api"],
      tests: withTitle,
    });
    expect(evalTitle.verdict).toBe("PASS");
    expect(evalTitle.matched).toBe(1);
  });
});
