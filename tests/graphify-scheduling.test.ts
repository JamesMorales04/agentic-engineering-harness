import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planParallelism } from "../src/agents/parallelism.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "test" },
  codeIntelligence: { provider: "graphify", snapshotDir: ".harness/graphify", scheduling: { useEdges: true, maxGraphHops: 1, maxSharedNodes: 0, centralityConflictThreshold: 1 } }
};

describe("deeper Graphify scheduling", () => {
  it("serializes structurally adjacent tasks even when file scopes do not overlap", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-graph-scheduling-"));
    try {
      const dir = path.join(root, ".harness", "graphify", "T"); await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "before.json"), JSON.stringify({
        nodes: ["ApiController", "MembershipService"],
        nodeFiles: { ApiController: "src/api/controller.ts", MembershipService: "src/domain/membership.ts" },
        communities: { ApiController: "api", MembershipService: "domain" },
        edgePairs: [{ from: "ApiController", to: "MembershipService", relation: "calls" }],
        centrality: { ApiController: 0.2, MembershipService: 0.2 }
      }));
      const plan = await planParallelism(root, config, "T", [
        { id: "A", summary: "api", agent: "backend-implementer", scope: ["src/api/**"], dependencies: [], acceptance: ["R1"], risk: "low" },
        { id: "B", summary: "domain", agent: "backend-implementer", scope: ["src/domain/**"], dependencies: [], acceptance: ["R2"], risk: "low" }
      ]);
      expect(plan.graphUsed).toBe(true);
      expect(plan.conflicts[0].reasons).toContain("graphify-nearby:1-hop");
      expect(plan.waves).toEqual([["A"], ["B"]]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
