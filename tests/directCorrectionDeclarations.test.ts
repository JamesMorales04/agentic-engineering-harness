import { describe, expect, it } from "vitest";
import { AehError } from "../src/core/errors.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import {
  DirectCorrectionScopeBlockedError,
  directCorrectionDeclarationsCoverEscapeV1,
  routeDirectScopeDeclarationsV1,
} from "../src/core/run.js";

describe("DIRECT escape-correction declaration routing", () => {
  it("coverage: exactly-declared escapes are covered", () => {
    expect(
      directCorrectionDeclarationsCoverEscapeV1(
        [
          { path: "tests/delegationExpiryLive.test.ts" },
          { path: "tests/browser/s13-delegation-countdown-live.e2e.ts" },
        ],
        ["tests/delegationExpiryLive.test.ts", "tests/browser/s13-delegation-countdown-live.e2e.ts"],
      ),
    ).toBe(true);
  });

  it("coverage: an undeclared escape is not covered (no laundering)", () => {
    expect(
      directCorrectionDeclarationsCoverEscapeV1(
        [{ path: "tests/delegationExpiryLive.test.ts" }],
        ["tests/delegationExpiryLive.test.ts", "tests/browser/s13-delegation-countdown-live.e2e.ts"],
      ),
    ).toBe(false);
  });

  it("coverage: empty declarations never cover a real escape", () => {
    expect(directCorrectionDeclarationsCoverEscapeV1([], ["tests/a.test.ts"])).toBe(false);
  });

  it("coverage: empty escape list is vacuously covered", () => {
    expect(directCorrectionDeclarationsCoverEscapeV1([], [])).toBe(true);
  });

  it("coverage: unsafe entries never match (fail-closed both directions)", () => {
    expect(directCorrectionDeclarationsCoverEscapeV1([{ path: "../outside.ts" }], ["../outside.ts"])).toBe(false);
    expect(directCorrectionDeclarationsCoverEscapeV1([{ path: "tests/a.test.ts" }], ["../outside.ts"])).toBe(false);
  });

  it("coverage: normalization shares one identity (./x matches x)", () => {
    expect(
      directCorrectionDeclarationsCoverEscapeV1([{ path: "./tests/a.test.ts" }], ["tests/a.test.ts"]),
    ).toBe(true);
  });

  it("routing: empty declarations short-circuit to NONE without side effects", async () => {
    const routing = await routeDirectScopeDeclarationsV1({
      root: "/nonexistent-root",
      controlRoot: "/nonexistent-control",
      operationId: "op-1",
      config: {} as HarnessProjectConfig,
      contract: { version: 1, task: { id: "T1", title: "t" } } as never,
      declared: [],
      workUnitId: "direct:T1:escape-correction",
      source: "direct-correction-declaration",
    });
    expect(routing).toEqual({ status: "NONE" });
  });

  it("marker: blocked error carries code, check, and session", () => {
    const check = { id: "scope-blocked", category: "scope", status: "FAIL", message: "blocked" } as never;
    const session = { id: "sess-1", participantId: "implementer-1" } as never;
    const error = new DirectCorrectionScopeBlockedError(check, session);
    expect(error).toBeInstanceOf(AehError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("DIRECT_CORRECTION_SCOPE_BLOCKED");
    expect(error.check).toBe(check);
    expect(error.session).toBe(session);
  });
});
