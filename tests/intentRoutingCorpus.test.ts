import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertIntentDecisionForRoute, parseIntentDecision, type SemanticIntent } from "../src/audit/intentDecision.js";

interface RoutingCase {
  id: string;
  prompt?: string;
  conversation?: string[];
  expectedIntent: SemanticIntent;
  resolution?: string;
  continuation?: { operationId?: string; findingIds?: string[]; taskId?: string };
  decision: unknown;
}

interface RoutingCorpus { version: number; kind: string; cases: RoutingCase[]; }

describe("semantic routing eval corpus", () => {
  it("contains broad, non-authoritative prompt fixtures with valid typed decisions", async () => {
    const file = path.resolve(process.cwd(), "evals/corpus/intent-routing.json");
    const corpus = JSON.parse(await fs.readFile(file, "utf8")) as RoutingCorpus;
    expect(corpus.version).toBe(1);
    expect(corpus.kind).toBe("semantic-intent-routing");
    expect(corpus.cases.length).toBeGreaterThanOrEqual(12);

    const intents = new Set<SemanticIntent>();
    for (const item of corpus.cases) {
      expect(item.prompt || item.conversation?.length).toBeTruthy();
      const decision = parseIntentDecision(item.decision);
      expect(decision.intent).toBe(item.expectedIntent);
      expect(decision.resolution).toBe(item.resolution ?? "resolved");
      if (item.continuation) expect(decision.continuation).toEqual(item.continuation);
      intents.add(decision.intent);
      if (decision.resolution === "resolved") expect(assertIntentDecisionForRoute(decision, decision.intent)).toEqual(decision);
      else expect(() => assertIntentDecisionForRoute(decision, decision.intent)).toThrow("resolved referent");
    }
    expect([...intents].sort()).toEqual(["audit", "cancel", "change", "informational", "run", "status"]);
  });

  it("keeps the corpus independent from the heuristic classifier", async () => {
    const source = await fs.readFile(path.resolve(process.cwd(), "evals/corpus/intent-routing.json"), "utf8");
    expect(source).not.toContain("classifyEngineeringIntent");
    expect(source).toContain("followup-explain-first");
    expect(source).toContain("unresolved-mutation");
  });
});
