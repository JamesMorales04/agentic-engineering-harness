import { describe, expect, it } from "vitest";
import {
  evaluateLiveMergeState,
  type LiveMergeStateV1,
  type ObservedCheckRunV1,
  type RequiredCheckObservationV1,
} from "../src/delivery/merge.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const STALE_HEAD = "f".repeat(40);

function reviewed() {
  return {
    repository: "owner/repo",
    number: 155,
    headSha: HEAD,
    baseSha: BASE,
    baseRef: "main",
  };
}

function liveBase(): LiveMergeStateV1 {
  return {
    state: "open",
    headSha: HEAD,
    baseSha: BASE,
    baseRef: "main",
    mergeable: true,
    mergeableState: "clean",
  };
}

function run(overrides: Partial<ObservedCheckRunV1> & { name: string }): ObservedCheckRunV1 {
  return {
    status: "completed",
    conclusion: "success",
    headSha: HEAD,
    ...overrides,
  };
}

function req(context: string, extra: Partial<RequiredCheckObservationV1> = {}): RequiredCheckObservationV1 {
  return { context, source: "check", ...extra };
}

describe("required-check evaluation with GitHub check-run semantics", () => {
  it("accepts green required check runs while legacy combined status is pending with zero entries", () => {
    // The reported external finding: combined status `pending` with zero
    // entries beside green check runs must not block once the required set
    // is observed from branch protection.
    const blockers = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      combinedStatus: "pending",
      requiredChecks: [req("test"), req("all-green required gate")],
      checkRuns: [run({ name: "test" }), run({ name: "all-green required gate" })],
      statusContexts: [],
    });
    expect(blockers).toEqual([]);
  });

  it("blocks a missing required check", () => {
    const blockers = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      requiredChecks: [req("test"), req("supply-chain")],
      checkRuns: [run({ name: "test" })],
      statusContexts: [],
    });
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.join("\n")).toMatch("supply-chain");
  });

  it("blocks pending, queued, and in_progress runs as not green yet", () => {
    for (const status of ["queued", "in_progress", "pending"]) {
      const blockers = evaluateLiveMergeState(reviewed(), {
        ...liveBase(),
        requiredChecks: [req("test")],
        checkRuns: [run({ name: "test", status, conclusion: null })],
        statusContexts: [],
      });
      expect(blockers.length).toBeGreaterThan(0);
      expect(blockers.join("\n")).toMatch("not complete");
    }
  });

  it("blocks failure, cancelled, timed_out, action_required, and stale conclusions", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "stale"]) {
      const blockers = evaluateLiveMergeState(reviewed(), {
        ...liveBase(),
        requiredChecks: [req("test")],
        checkRuns: [run({ name: "test", conclusion })],
        statusContexts: [],
      });
      expect(blockers.length).toBeGreaterThan(0);
      expect(blockers.join("\n")).toMatch(conclusion);
    }
  });

  it("blocks null and unknown conclusions as not green", () => {
    for (const conclusion of [null, "mystery"] as const) {
      const blockers = evaluateLiveMergeState(reviewed(), {
        ...liveBase(),
        requiredChecks: [req("test")],
        checkRuns: [run({ name: "test", conclusion })],
        statusContexts: [],
      });
      expect(blockers.length).toBeGreaterThan(0);
      expect(blockers.join("\n")).toMatch("not green");
    }
  });

  it("accepts skipped and neutral conclusions as green", () => {
    for (const conclusion of ["skipped", "neutral"]) {
      const blockers = evaluateLiveMergeState(reviewed(), {
        ...liveBase(),
        requiredChecks: [req("test")],
        checkRuns: [run({ name: "test", conclusion })],
        statusContexts: [],
      });
      expect(blockers).toEqual([]);
    }
  });

  it("blocks a stale-head success (conclusion success at a superseded SHA)", () => {
    const blockers = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      requiredChecks: [req("test")],
      checkRuns: [run({ name: "test", headSha: STALE_HEAD })],
      statusContexts: [],
    });
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.join("\n")).toMatch("no observed run for the reviewed head");
  });

  it("requires ALL fresh duplicate-name runs green", () => {
    const mixed = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      requiredChecks: [req("test")],
      checkRuns: [run({ name: "test", conclusion: "success" }), run({ name: "test", conclusion: "failure" })],
      statusContexts: [],
    });
    expect(mixed.length).toBeGreaterThan(0);
    const bothGreen = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      requiredChecks: [req("test")],
      checkRuns: [run({ name: "test", conclusion: "success" }), run({ name: "test", conclusion: "skipped" })],
      statusContexts: [],
    });
    expect(bothGreen).toEqual([]);
  });

  it("blocks wrong-app suites and empty suites as missing required checks", () => {
    const wrongApp = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      requiredChecks: [req("test")],
      checkRuns: [run({ name: "unrelated-ci", appSlug: "other-app" })],
      statusContexts: [],
    });
    expect(wrongApp.length).toBeGreaterThan(0);
    expect(wrongApp.join("\n")).toMatch("test");
    const empty = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      requiredChecks: [req("test")],
      checkRuns: [],
      statusContexts: [],
    });
    expect(empty.length).toBeGreaterThan(0);
  });

  it("enforces branch-protection app binding when appId is set", () => {
    const wrongAppId = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      requiredChecks: [req("test", { appId: 123 })],
      checkRuns: [run({ name: "test", appId: 999 })],
      statusContexts: [],
    });
    expect(wrongAppId.length).toBeGreaterThan(0);
    const rightAppId = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      requiredChecks: [req("test", { appId: 123 })],
      checkRuns: [run({ name: "test", appId: 123 })],
      statusContexts: [],
    });
    expect(rightAppId).toEqual([]);
  });

  it("evaluates legacy required status contexts only when protection declares them", () => {
    const green = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      requiredChecks: [{ context: "ci/build", source: "status" }],
      checkRuns: [],
      statusContexts: [{ context: "ci/build", state: "success" }],
    });
    expect(green).toEqual([]);
    const pending = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      requiredChecks: [{ context: "ci/build", source: "status" }],
      checkRuns: [],
      statusContexts: [{ context: "ci/build", state: "pending" }],
    });
    expect(pending.length).toBeGreaterThan(0);
    const missing = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      requiredChecks: [{ context: "ci/build", source: "status" }],
      checkRuns: [],
      statusContexts: [],
    });
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.join("\n")).toMatch("ci/build");
  });

  it("ignores non-required failing statuses in required-set mode", () => {
    const blockers = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      combinedStatus: "failure",
      requiredChecks: [req("test")],
      checkRuns: [run({ name: "test" })],
      statusContexts: [{ context: "unrelated-status", state: "failure" }],
    });
    expect(blockers).toEqual([]);
  });

  it("blocks when branch-protection observation failed", () => {
    const blockers = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      protectionError: "HTTP 403",
      requiredChecks: [req("test")],
      checkRuns: [run({ name: "test" })],
      statusContexts: [],
    });
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.join("\n")).toMatch("unobserved");
  });

  it("blocks on truncated check-run pagination", () => {
    const blockers = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      requiredChecks: [req("test")],
      checkRuns: [run({ name: "test" })],
      checkRunsIncomplete: true,
      statusContexts: [],
    });
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.join("\n")).toMatch("incomplete");
  });

  it("fails closed on malformed required-check entries", () => {
    const blockers = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      requiredChecks: [{ context: "", source: "check" }],
      checkRuns: [run({ name: "test" })],
      statusContexts: [],
    });
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.join("\n")).toMatch("malformed");
  });

  it("compares run head SHAs case-insensitively", () => {
    const blockers = evaluateLiveMergeState(reviewed(), {
      ...liveBase(),
      requiredChecks: [req("test")],
      checkRuns: [run({ name: "test", headSha: HEAD.toUpperCase() })],
      statusContexts: [],
    });
    expect(blockers).toEqual([]);
  });

  it("preserves the legacy combined-status fallback without requiredChecks", () => {
    expect(evaluateLiveMergeState(reviewed(), { ...liveBase(), combinedStatus: "success" })).toEqual([]);
    for (const combinedStatus of ["failure", "pending", undefined]) {
      const blockers = evaluateLiveMergeState(reviewed(), { ...liveBase(), combinedStatus });
      expect(blockers.length).toBeGreaterThan(0);
      expect(blockers.join("\n")).toMatch("not green");
    }
  });
});
