import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SWEEP_INCOMPLETE_CODE,
  WorkspaceSweepIncompleteError,
  isWorkspaceSweepIncompleteError,
  isWorkspaceSweepIncompleteFailure,
} from "../src/runtime/operationResources.js";

/**
 * RED-first: unforgeable provenance.
 * Desired (fixed) behavior:
 * - plain object {code} must NOT classify
 * - cross-realm-ish copy without brand must NOT classify
 * - genuine error DOES classify
 * - sweep-failure predicate never gates on bare `code`
 */
describe("ROUND5 RED: unforgeable workspace-sweep provenance", () => {
  it("plain object with matching code must NOT classify as incomplete", () => {
    const forged = { code: WORKSPACE_SWEEP_INCOMPLETE_CODE, message: `${WORKSPACE_SWEEP_INCOMPLETE_CODE}: forged` };
    expect(isWorkspaceSweepIncompleteError(forged)).toBe(false);
  });

  it("cross-realm-ish copy without brand must NOT classify", () => {
    const genuine = new WorkspaceSweepIncompleteError("boom");
    // Simulate a cross-realm / structured-clone / JSON round-trip copy:
    // same visible fields, no prototype, no module-private brand.
    const jsonCopy = JSON.parse(JSON.stringify(genuine)) as Record<string, unknown>;
    jsonCopy.message = genuine.message;
    jsonCopy.name = "WorkspaceSweepIncompleteError";
    expect(isWorkspaceSweepIncompleteError(jsonCopy)).toBe(false);

    const spreadCopy = { ...(genuine as unknown as Record<string, unknown>), message: genuine.message };
    expect(isWorkspaceSweepIncompleteError(spreadCopy)).toBe(false);
  });

  it("genuine error DOES classify", () => {
    const genuine = new WorkspaceSweepIncompleteError("boom");
    expect(isWorkspaceSweepIncompleteError(genuine)).toBe(true);
  });

  it("sweep-failure predicate must NOT gate on bare code string", () => {
    expect(isWorkspaceSweepIncompleteFailure({ code: WORKSPACE_SWEEP_INCOMPLETE_CODE } as never)).toBe(false);
    expect(isWorkspaceSweepIncompleteFailure({} as never)).toBe(false);
  });

  it("genuine branded sweep failure DOES classify (cause carries provenance, code stays diagnostics-only)", () => {
    const genuine = new WorkspaceSweepIncompleteError("boom");
    expect(
      isWorkspaceSweepIncompleteFailure({
        operationId: "AUDIT-OLD",
        error: genuine.message,
        code: WORKSPACE_SWEEP_INCOMPLETE_CODE,
        cause: genuine,
      } as never)
    ).toBe(true);
    // Same visible `code` without the branded cause is forged.
    expect(
      isWorkspaceSweepIncompleteFailure({
        operationId: "AUDIT-OLD",
        error: genuine.message,
        code: WORKSPACE_SWEEP_INCOMPLETE_CODE,
      } as never)
    ).toBe(false);
  });
});
