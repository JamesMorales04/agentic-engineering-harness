import { describe, expect, it } from "vitest";
import { planParallelism } from "../src/agents/parallelism.js";
import { waveConcurrencyV1 } from "../src/agents/waveExecutor.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
const config: HarnessProjectConfig = { version: 1, project: { name: "test" } };
describe("parallelism", () => { it("keeps overlapping scopes out of the same wave and honors dependencies", async () => { const result = await planParallelism("/definitely/missing", config, "T", [{ id: "A", summary: "a", agent: "x", scope: ["src/auth/**"], dependencies: [], acceptance: ["REQ-1"], risk: "medium" }, { id: "B", summary: "b", agent: "x", scope: ["src/auth/service.ts"], dependencies: [], acceptance: ["REQ-2"], risk: "medium" }, { id: "C", summary: "c", agent: "x", scope: ["src/ui/**"], dependencies: ["A"], acceptance: ["REQ-3"], risk: "low" }]); expect(result.waves[0]).toEqual(["A"]); expect(result.waves.flat()).toEqual(expect.arrayContaining(["A", "B", "C"])); expect(result.conflicts.some((conflict) => conflict.reasons.includes("scope-overlap"))).toBe(true); }); });
describe("waveConcurrencyV1 (AEH-V2-0129)", () => {
  it("honors worktreeIsolation (serialized same-workspace writers) and maxWaveConcurrency", () => {
    expect(waveConcurrencyV1({ worktreeIsolation: true }, 3)).toBe(3);
    expect(waveConcurrencyV1({ worktreeIsolation: true, maxWaveConcurrency: 2 }, 3)).toBe(2);
    expect(waveConcurrencyV1({ worktreeIsolation: false, maxWaveConcurrency: 4 }, 3)).toBe(1);
    expect(waveConcurrencyV1(undefined, 2)).toBe(2);
    expect(waveConcurrencyV1({ maxWaveConcurrency: 5 }, 2)).toBe(2);
    expect(waveConcurrencyV1({ worktreeIsolation: false }, 1)).toBe(1);
  });
});
