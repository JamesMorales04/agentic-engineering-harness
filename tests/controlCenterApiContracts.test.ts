import { describe, expect, it } from "vitest";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { controlCenterResourceId, type ControlCenterSnapshotInputV1 } from "../src/control-center/contracts.js";
import { LocalControlCenterV1 } from "../src/control-center/index.js";
import { PaseoGatewayV1 } from "../src/paseo/gateway.js";
import { pairControlCenter } from "./helpers/controlCenterSession.js";

function snapshot(): ControlCenterSnapshotInputV1 {
  const candidate = createCandidateRevisionV1({ operationId: "op-1", candidateId: "candidate-1", projectId: "project-1", revision: 1, sourceDigest: "a".repeat(64) });
  const projectId = controlCenterResourceId("project", "project-1");
  const operationId = controlCenterResourceId("operation", "op-1");
  const participantId = controlCenterResourceId("participant", "participant-1");
  const candidateId = controlCenterResourceId("candidate", candidate.candidateId);
  return {
    projects: [{ version: 1, projectId, repositoryIdentity: "https://example.test/acme/project", displayName: "Project One", configDigest: "config", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", availability: "available" }],
    operations: [{
      version: 1,
      operationId,
      kind: "change",
      status: "RUNNING",
      phase: "implementation",
      revision: 3,
      projectId,
      candidateId,
      candidateDigest: candidate.identityDigest,
      participantCount: 1,
      runningParticipantCount: 1,
      completedParticipantCount: 0,
      failedParticipantCount: 0,
      blockedParticipantCount: 0,
      blockedStageCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      payloadSummary: "bounded Control Center API slice",
      stages: [],
      participants: [{ version: 1, participantId, operationId, logicalAgent: "implementer", role: "Implementer", phase: "implementation", status: "RUNNING", specializations: ["typescript-node"], skills: ["implementation-discipline"], tools: ["repository-read"], registeredAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:01.000Z" }]
    }],
    participants: [{ version: 1, participantId, operationId, logicalAgent: "implementer", role: "Implementer", phase: "implementation", status: "RUNNING", specializations: ["typescript-node"], skills: ["implementation-discipline"], tools: ["repository-read"], registeredAt: "2026-01-01T00:00:00.000Z" }],
    candidates: [{ ...candidate, controlCenterId: candidateId }],
    context: { version: 1, operationId, candidateDigest: candidate.identityDigest, continuationCount: 1, authorizedReferenceCount: 2, budgetTokens: 10_000, consumedTokens: 2_000 },
    authority: { version: 1, operationId, candidateDigest: candidate.identityDigest, participantId, leases: [] },
    evidence: [{ version: 1, evidenceId: controlCenterResourceId("evidence", "check-1"), type: "check", label: "typecheck", status: "PASS", operationId, candidateDigest: candidate.identityDigest }],
    services: { version: 1, capturedAt: "2026-01-01T00:00:00.000Z", services: [], providerLeases: [] },
    knowledge: { version: 1, mode: "OFFLINE", gate: "SUFFICIENT", status: "VERIFIED", missingCompetencies: [], trustedSourceCount: 0, librarianRequired: false },
    quality: { version: 1, status: "ready", rounds: 1, findingCount: 0, unresolvedFindingCount: 0, candidateDigest: candidate.identityDigest },
    certification: { version: 1, status: "in-progress", checks: 2, passedChecks: 1, failedChecks: 0, candidateDigest: candidate.identityDigest }
  };
}

describe("Control Center v1 API contracts", () => {
  it("serves versioned authenticated projections for every resource boundary", async () => {
    const center = new LocalControlCenterV1({ snapshot });
    const started = await center.start();
    try {
      const session = await pairControlCenter(started);
      const headers = session.headers();
      const resources: Array<[string, string]> = [
        ["projects", "project"],
        ["operations", "operation"],
        ["participants", "participant"],
        ["candidates", "candidate"],
        ["context", "context"],
        ["authority", "authority"],
        ["evidence", "evidence"],
        ["services", "services"],
        ["knowledge", "knowledge"],
        ["events/history", "event"]
      ];
      for (const [path, resource] of resources) {
        const response = await fetch(`${started.url}api/v1/${path}`, { headers });
        expect(response.status, path).toBe(200);
        const body = await response.json() as { version: number; resource: string; items?: Array<{ [key: string]: unknown }>; item?: { [key: string]: unknown } };
        expect(body.version, path).toBe(1);
        expect(body.resource, path).toBe(resource);
        if (body.items && path !== "events/history") expect(body.items.length, path).toBeGreaterThan(0);
        if (body.item) expect(body.item.version, path).toBe(1);
      }

      const operationList = await fetch(`${started.url}api/v1/operations`, { headers }).then((response) => response.json()) as { items: Array<Record<string, unknown>> };
      expect(operationList.items[0]).not.toHaveProperty("participants");
      const operationDetail = await fetch(`${started.url}api/v1/operations/op-1`, { headers }).then((response) => response.json()) as { item: Record<string, unknown> };
      expect(operationDetail.item).toMatchObject({ operationId: "op-1", payloadSummary: "bounded Control Center API slice" });
      expect(operationDetail.item.participants).toHaveLength(1);

      const projectDetail = await fetch(`${started.url}api/v1/projects/project-1`, { headers }).then((response) => response.json()) as { item: Record<string, unknown> };
      expect(projectDetail.item.projectId).toBe("project-1");
    } finally {
      await center.close();
    }
  });

  it("keeps resource projections behind the existing token boundary", async () => {
    const center = new LocalControlCenterV1({ snapshot });
    const started = await center.start();
    try {
      for (const path of ["projects", "operations", "participants", "candidates", "context", "authority", "evidence", "services", "knowledge", "events/history"]) {
        expect((await fetch(`${started.url}api/v1/${path}`)).status, path).toBe(401);
      }
    } finally {
      await center.close();
    }
  });

  it("serves the paired-session SSE stream from durable operation history", async () => {
    const center = new LocalControlCenterV1({ snapshot });
    const started = await center.start();
    try {
      const session = await pairControlCenter(started);
      const response = await fetch(`${started.url}api/v1/events`, { headers: session.headers() });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      await response.body?.cancel();
      const history = await fetch(`${started.url}api/v1/events/history`, { headers: session.headers() }).then((item) => item.json()) as { items: Array<{ eventId: string; version: number }> };
      expect(history.items).toEqual([]);
    } finally {
      await center.close();
    }
  });

  it("exposes bounded Paseo state and lead conversation without a generic proxy", async () => {
    const center = new LocalControlCenterV1({
      paseo: { root: "/tmp/project", leadId: "lead-1" },
      paseoGateway: new PaseoGatewayV1({
        inspectLead: async (_root, id) => ({ id, status: "idle", raw: {} }),
        listParticipants: async () => [],
        dispatchLead: async (_root, leadId) => ({ id: leadId, status: "idle", lastMessage: "acknowledged" })
      })
    });
    const started = await center.start();
    try {
      const session = await pairControlCenter(started);
      const headers = session.headers();
      const snapshot = await fetch(`${started.url}api/v1/paseo`, { headers }).then((response) => response.json()) as { status: string };
      expect(snapshot.status).toBe("AVAILABLE");
      const response = await fetch(`${started.url}api/v1/paseo/lead/messages`, { method: "POST", headers: { ...session.headers(true), "content-type": "application/json" }, body: JSON.stringify({ prompt: "continue" }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ leadId: "lead-1", lastMessage: "acknowledged" });
    } finally {
      await center.close();
    }
  });
});
