import { describe, expect, it } from "vitest";
import {
  createEscapeCorrectionBudgetGateV1,
  escapeCorrectionBudgetV1,
} from "../src/agents/waveExecutor.js";

/**
 * RED-first round 2 (B1): parallel wave must not overspend the existing repair
 * budget. Corrections are counted AFTER offering today (post-hoc sum), so a
 * parallel wave can offer N corrections against a budget of 1.
 * Correct behavior: check REMAINING before offering; reserve synchronously.
 */
describe("escape-correction budget gate (B1 RED)", () => {
  it("budget derives from existing repair knob (no new budget)", () => {
    const contract = { repair: { maxAttempts: 1 } } as never;
    const config = { orchestration: { worker: { maxRepairAttempts: 5 } } } as never;
    expect(escapeCorrectionBudgetV1(contract, config)).toBe(1);
    const fallback = escapeCorrectionBudgetV1({} as never, {} as never);
    expect(fallback).toBe(2);
  });

  it("overspend accepted RED: parallel reservations cannot double-spend a budget of 1", () => {
    const gate = createEscapeCorrectionBudgetGateV1(1);
    // Synchronous reserve-then-check: first wins, second denied (no await between).
    const first = gate.tryReserve();
    const second = gate.tryReserve();
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(gate.used).toBe(1);
  });

  it("no remaining → no correction (original throw immediately)", () => {
    const gate = createEscapeCorrectionBudgetGateV1(0);
    expect(gate.tryReserve()).toBe(false);
    expect(gate.used).toBe(0);
  });

  it("sequential waves share one counter (budget 2 allows exactly 2)", () => {
    const gate = createEscapeCorrectionBudgetGateV1(2);
    expect(gate.tryReserve()).toBe(true);
    expect(gate.tryReserve()).toBe(true);
    expect(gate.tryReserve()).toBe(false);
    expect(gate.used).toBe(2);
  });
});
