import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenCodeRuntimeConfig } from "../../src/agents/permissions.js";
import type { AgentExecutionSelection } from "../../src/agents/types.js";
import { ContextBudgetGateway } from "../../src/context/gateway.js";
import type { ContextFragment } from "../../src/context/types.js";
import type { HarnessProjectConfig } from "../../src/core/types.js";
import { loadOperation, patchOperation, saveOperation, transitionOperationToTerminal, type OperationRecord } from "../../src/operations/state.js";
import { OPERATION_KIND_VALUES, OPERATION_STATUS_VALUES, isAllowedOperationStatusTransition } from "../../src/operations/state.js";
import { PRESERVATION_VALUES, SCENARIOS, scenarioFailure, scenarioSeed, selectedScenarios, TRANSPORT_VALUES } from "./aehScenarioModel.js";

const selected = selectedScenarios();
const requestedScenario = process.env.AEH_SCENARIO?.trim();
function enabled(id: string): boolean { return !requestedScenario || selected.some((scenario) => scenario.id === id); }

function seedRecord(root: string, kind: "audit" | "run" | "change", status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED"): OperationRecord {
  const now = new Date(0).toISOString();
  return { version: 2, id: `SCN-${kind}-${status}`, kind, status, phase: status.toLowerCase(), root, payload: kind === "run" ? { taskId: "SCN-TASK" } : kind === "change" ? { request: "scenario" } : { request: "scenario" }, revision: 1, createdAt: now, updatedAt: now, lastProgressAt: now, supervision: { required: kind !== "run", materialized: false, generations: [] }, stages: {}, participants: {}, progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 }, notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 } };
}

function baseConfig(): HarnessProjectConfig {
  return { version: 1, project: { name: "scenario-matrix" }, telemetry: { enabled: false }, context: { mode: "enforce", semanticRetrieval: { provider: "none", required: false }, compression: { provider: "none", required: false }, retrieval: { maxRequestsPerTurn: 2, maxTokensPerRequest: 100, maxTotalTokensPerTurn: 200 } } };
}

function selection(transport: "direct" | "paseo" | "podman", role: "implementer" | "reviewer" = "implementer"): AgentExecutionSelection {
  return { logicalAgent: `${role}-${transport}`, role, domains: [], runtimeName: "opencode", runtimeAdapter: "opencode", paseoProvider: "opencode", modelAlias: "test", modelId: "test/model", modelName: "model", transport, skills: [], mcps: [], permissions: { read: "allow", write: role === "reviewer" ? "deny" : "allow", shell: "deny", network: "deny", delegate: "deny", gitWrite: "deny" }, args: [], runtimeCapabilities: { nativeAgent: true } };
}

describe("AEH generated scenario matrix", () => {
  it("enumerates the current finite operation kinds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-scenario-kinds-"));
    try {
      for (const kind of OPERATION_KIND_VALUES) {
        if (!enabled(`SCN-OP-KIND-${kind.toUpperCase()}`)) continue;
        const record = seedRecord(root, kind, "QUEUED");
        await saveOperation(root, record);
        expect((await loadOperation(root, record.id)).kind).toBe(kind);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("exhaustively exercises lifecycle status pairs with deterministic rejection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-scenario-lifecycle-"));
    try {
      for (const from of OPERATION_STATUS_VALUES) for (const to of OPERATION_STATUS_VALUES) {
        const scenario = SCENARIOS.find((item) => item.id === `SCN-LIFECYCLE-${from}-${to}`)!;
        if (!enabled(scenario.id)) continue;
        const record = seedRecord(root, "audit", from);
        await saveOperation(root, record);
        const allowed = isAllowedOperationStatusTransition(from, to);
        try {
          if (to === "SUCCEEDED" || to === "FAILED" || to === "CANCELLED") {
            const result = await transitionOperationToTerminal(root, record.id, { status: to, phase: to.toLowerCase() });
            if (allowed && from !== to) expect(result.transitioned).toBe(true);
            if (!allowed && from === to) expect(result.transitioned).toBe(false);
          } else {
            const result = await patchOperation(root, record.id, { status: to });
            expect(result.status).toBe(from === "SUCCEEDED" || from === "FAILED" || from === "CANCELLED" ? from : to);
          }
        } catch (error) {
          if (allowed || from === "SUCCEEDED" || from === "FAILED" || from === "CANCELLED") throw scenarioFailure(scenario, { error: String(error), state: await loadOperation(root, record.id) });
          expect(String(error)).toContain(`Invalid operation status transition ${from} -> ${to}`);
        }
        const current = await loadOperation(root, record.id);
        if (!allowed && from !== to && current.status !== from) throw scenarioFailure(scenario, current);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps denied capabilities denied in every supported runtime projection", () => {
    for (const transport of TRANSPORT_VALUES) {
      const projected = buildOpenCodeRuntimeConfig(selection(transport));
      expect(projected.permission).toMatchObject({ edit: "allow", webfetch: "deny", websearch: "deny", task: "deny" });
      const bash = projected.permission && typeof projected.permission === "object" ? (projected.permission as Record<string, unknown>).bash : undefined;
      expect(JSON.stringify(bash)).toContain("deny");
    }
  });

  it("covers every context preservation class without leaking unavailable retrieval", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-scenario-context-"));
    try {
      for (const preservation of PRESERVATION_VALUES) {
        for (const transport of TRANSPORT_VALUES) {
          const id = `SCN-CONTEXT-${preservation}-${transport.toUpperCase()}`;
          if (!enabled(id)) continue;
          const fragment: ContextFragment = { id: preservation.toLowerCase(), kind: preservation === "VERBATIM" ? "normative" : "tool-output", preservation, priority: 10, content: preservation === "VERBATIM" ? "exact\nline\u2028anchor" : `bounded ${preservation} content` };
          const authorizedRetrieval = transport !== "podman";
          const result = await new ContextBudgetGateway(root, baseConfig(), { telemetry: false }).prepare({ operationId: `CTX-${preservation}-${transport}`, logicalAgent: "reviewer", phase: "review", fragments: [fragment], capabilities: { authorizedRetrieval, semanticRetrieval: false } });
          const delivered = result.envelope.fragments[0];
          if (preservation === "DISCARDABLE") {
            expect(delivered).toBeUndefined();
            continue;
          }
          expect(delivered).toBeDefined();
          if (preservation === "VERBATIM") expect(delivered?.content).toBe(fragment.content);
          if (preservation === "RETRIEVABLE" && authorizedRetrieval) expect(delivered?.content).toContain("Retrievable");
          if (!authorizedRetrieval) expect(result.rendered).not.toContain("aeh_context_retrieve");
        }
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("reports the deterministic seed and stable scenario inventory", () => {
    const configuredSeed = process.env.AEH_SCENARIO_SEED?.trim();
    expect(scenarioSeed()).toBe(configuredSeed ? Number(configuredSeed) : 20260814);
    expect(selected.length).toBe(requestedScenario ? 1 : SCENARIOS.length);
    expect(new Set(SCENARIOS.map((scenario) => scenario.id)).size).toBe(SCENARIOS.length);
  });
});
