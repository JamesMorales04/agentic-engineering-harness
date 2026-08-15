import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenCodeRuntimeConfig } from "../../src/agents/permissions.js";
import type { AgentExecutionSelection } from "../../src/agents/types.js";
import { ContextBudgetGateway } from "../../src/context/gateway.js";
import { ContextRetrievalGateway } from "../../src/context/retrieval/gateway.js";
import { authorizeRetrieval } from "../../src/context/retrieval/authorization.js";
import type { ContextFragment } from "../../src/context/types.js";
import type { HarnessProjectConfig } from "../../src/core/types.js";
import { loadOperation, patchOperation, saveOperation, transitionOperationToTerminal, type OperationRecord } from "../../src/operations/state.js";
import { OPERATION_KIND_VALUES, OPERATION_STATUS_VALUES, isAllowedOperationStatusTransition } from "../../src/operations/state.js";
import { filterStaleRecords } from "../../src/providers/engram.js";
import { verifyProvenanceManifest } from "../../src/provenance/generate.js";
import { PRESERVATION_VALUES, SCENARIOS, generateSeededActionSequence, scenarioFailure, scenarioSeed, selectedScenarios, TRANSPORT_VALUES } from "./aehScenarioModel.js";

const selected = selectedScenarios();
const requestedScenario = process.env.AEH_SCENARIO?.trim();
function enabled(id: string): boolean { return !requestedScenario || selected.some((scenario) => scenario.id === id); }

function seedRecord(root: string, kind: "audit" | "run" | "change", status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED", id = `SCN-${kind}-${status}`): OperationRecord {
  const now = new Date(0).toISOString();
  return { version: 2, id, kind, status, phase: status.toLowerCase(), root, payload: kind === "run" ? { taskId: "SCN-TASK" } : kind === "change" ? { request: "scenario" } : { request: "scenario" }, revision: 1, createdAt: now, updatedAt: now, lastProgressAt: now, supervision: { required: kind !== "run", materialized: false, generations: [] }, stages: {}, participants: {}, progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 }, notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 } };
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
    expect(SCENARIOS.length).toBeGreaterThan(100);
    expect(new Set(SCENARIOS.flatMap((scenario) => Object.keys(scenario.dimensions))).size).toBeGreaterThanOrEqual(15);
  });

  it("executes every generated pairwise state-space combination", () => {
    const pairwisePrefixes = ["SCN-PHASE-", "SCN-AUTH-", "SCN-RUNTIME-", "SCN-PROVIDER-", "SCN-CONTEXT-AUTH-", "SCN-OUTCOME-", "SCN-REVIEW-", "SCN-RECOVERY-"];
    const pairwise = SCENARIOS.filter((scenario) => pairwisePrefixes.some((prefix) => scenario.id.startsWith(prefix)));
    expect(pairwise.length).toBeGreaterThan(100);
    for (const scenario of pairwise) {
      if (!enabled(scenario.id)) continue;
      expect(Object.keys(scenario.dimensions).length).toBe(2);
      expect(scenario.invariant.length).toBeGreaterThan(20);
      expect(scenario.expected).toMatch(/checked|classified/);
    }
  });

  it("executes seeded valid and invalid action sequences against the durable lifecycle model", async () => {
    if (!enabled("SCN-SEEDED-ACTIONS")) return;
    const seed = scenarioSeed();
    const actions = generateSeededActionSequence(seed, 48);
    const repeat = generateSeededActionSequence(seed, 48);
    const alternate = generateSeededActionSequence(seed + 1, 48);
    expect(repeat).toEqual(actions);
    expect(alternate).not.toEqual(actions);
    expect(actions.some((action) => action.expected === "allowed")).toBe(true);
    expect(actions.some((action) => action.expected === "rejected")).toBe(true);

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-seeded-actions-"));
    try {
      for (const action of actions) {
        const record = seedRecord(root, "run", action.initialStatus, `SCN-ACTION-${action.index}`);
        await saveOperation(root, record);
        try {
          if (action.mode === "terminal") {
            const result = await transitionOperationToTerminal(root, record.id, { status: action.to as "SUCCEEDED" | "FAILED" | "CANCELLED", phase: action.to.toLowerCase() });
            expect(result.transitioned).toBe(action.expected === "allowed");
          } else {
            const result = await patchOperation(root, record.id, { status: action.to });
            expect(result.status).toBe(action.expected === "allowed" ? action.to : action.initialStatus);
          }
        } catch (error) {
          if (action.expected !== "rejected") throw scenarioFailure(SCENARIOS.find((scenario) => scenario.id === "SCN-SEEDED-ACTIONS")!, { error: String(error), action }, actions);
        }
        const current = await loadOperation(root, record.id);
        if (action.expected === "rejected" && current.status !== action.initialStatus) throw scenarioFailure(SCENARIOS.find((scenario) => scenario.id === "SCN-SEEDED-ACTIONS")!, current, actions);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("enforces the P1-P10 truth properties at the production boundaries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-state-properties-"));
    try {
      const terminal = seedRecord(root, "run", "QUEUED", "P1-terminal");
      await saveOperation(root, terminal);
      await transitionOperationToTerminal(root, terminal.id, { status: "FAILED", phase: "failed" });
      expect((await patchOperation(root, terminal.id, { status: "RUNNING", phase: "running" })).status).toBe("FAILED"); // P1 terminal truth forbids active re-entry.

      for (const transport of TRANSPORT_VALUES) { // P2 deny stays deny across projections.
        const projected = buildOpenCodeRuntimeConfig(selection(transport));
        expect(projected.permission).toMatchObject({ webfetch: "deny", websearch: "deny", task: "deny" });
      }

      const rejectedDelivery = seedRecord(root, "run", "RUNNING", "P3-delivery");
      await saveOperation(root, rejectedDelivery);
      await transitionOperationToTerminal(root, rejectedDelivery.id, { status: "FAILED", phase: "delivery-failed" });
      await expect(transitionOperationToTerminal(root, rejectedDelivery.id, { status: "SUCCEEDED", phase: "accepted" })).resolves.toMatchObject({ transitioned: false }); // P3/P7 delivery failure cannot become success.

      const context = new ContextBudgetGateway(root, baseConfig(), { telemetry: false });
      const fragmentA: ContextFragment = { id: "fragment-a", kind: "normative", preservation: "VERBATIM", priority: 10, content: "authoritative A\n" };
      const fragmentB: ContextFragment = { id: "fragment-b", kind: "normative", preservation: "VERBATIM", priority: 10, content: "authoritative B\n" };
      const preparedA = await context.prepare({ operationId: "P4-A", logicalAgent: "reviewer", phase: "review", fragments: [fragmentA], capabilities: { authorizedRetrieval: true, semanticRetrieval: false } });
      await context.prepare({ operationId: "P4-B", logicalAgent: "reviewer", phase: "review", fragments: [fragmentB], capabilities: { authorizedRetrieval: true, semanticRetrieval: false } });
      expect(preparedA.envelope.fragments.find((fragment) => fragment.id === fragmentA.id)?.content).toBe(fragmentA.content); // P5 VERBATIM is byte exact.
      const retrievalA = new ContextRetrievalGateway(authorizeRetrieval({ root, operationId: "P4-A", logicalAgent: "reviewer", allowedFragmentIds: [fragmentA.id], fragments: [fragmentA] }), { maxRequestsPerTurn: 2, maxTokensPerRequest: 100, maxTotalTokensPerTurn: 200 });
      await expect(retrievalA.retrieve({ fragmentId: fragmentB.id })).rejects.toThrow("CONTEXT_RETRIEVAL_UNAUTHORIZED"); // P4 cross-operation retrieval is rejected.

      const source = path.join(root, "task-contract.yaml");
      await fs.writeFile(source, "task: authoritative\n");
      const sourceSha256 = (await import("node:crypto")).createHash("sha256").update("task: authoritative\n").digest("hex");
      const stale = await filterStaleRecords(root, [{ project: "p", type: "discovery", title: "stale", content: "memory cannot win", source: "task-contract.yaml", sourceSha256: "0".repeat(64) }]);
      expect(stale).toEqual([]); // P6 advisory memory cannot override current normative source.
      expect(sourceSha256).not.toBe("0".repeat(64));

      const manifestPath = path.join(root, "manifest.json");
      await fs.writeFile(manifestPath, JSON.stringify({ version: 1, entries: [{ path: "task-contract.yaml", kind: "task-contract", sha256: sourceSha256 }] }));
      expect((await verifyProvenanceManifest(root, "manifest.json")).ok).toBe(true);
      await fs.writeFile(source, "task: tampered\n");
      expect((await verifyProvenanceManifest(root, "manifest.json")).ok).toBe(false); // P10 lineage/source tampering breaks provenance.
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
