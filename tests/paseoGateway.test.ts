import { describe, expect, it } from "vitest";
import { PaseoGatewayV1 } from "../src/paseo/gateway.js";

describe("PaseoGatewayV1", () => {
  it("projects typed lead, participant and capability state", async () => {
    const gateway = new PaseoGatewayV1({
      inspectLead: async (_root, id) => ({ id, status: "idle", raw: {} }),
      listParticipants: async () => [{ id: "participant-1", status: "working", raw: {} }],
      readTimeline: async () => [{ type: "assistant_message", text: "done" }],
      preflight: async () => ({ ok: true, provider: "codex", model: "gpt", source: "paseo-provider-unchecked", message: "ok" })
    });

    await expect(gateway.snapshot({ root: "/tmp/project", leadId: "lead-1", provider: "codex", model: "gpt" })).resolves.toEqual(expect.objectContaining({
      status: "AVAILABLE",
      lead: expect.objectContaining({ id: "lead-1" }),
      participants: [expect.objectContaining({ id: "participant-1" })],
      capability: expect.objectContaining({ provider: "codex" })
    }));
    await expect(gateway.participantTimeline({ root: "/tmp/project", participantId: "participant-1" })).resolves.toEqual(expect.objectContaining({ source: "paseo-sdk", entries: [{ type: "assistant_message", text: "done" }] }));
  });

  it("keeps Control Center usable when Paseo is unavailable", async () => {
    const gateway = new PaseoGatewayV1({ listParticipants: async () => { throw new Error("daemon unavailable"); } });
    await expect(gateway.snapshot({ root: "/tmp/project" })).resolves.toEqual(expect.objectContaining({ status: "DEGRADED", participants: [], message: "daemon unavailable" }));
    await expect(gateway.leadConversation({ root: "/tmp/project", leadId: "lead-1", prompt: "hello" })).resolves.toEqual(expect.objectContaining({ status: "DEGRADED" }));
  });
});
