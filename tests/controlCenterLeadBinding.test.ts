import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalControlCenterV1 } from "../src/control-center/index.js";
import { resolveControlCenterLeadBinding } from "../src/control-center/leadBinding.js";
import { PaseoGatewayV1 } from "../src/paseo/gateway.js";
import { PASEO_BOOTSTRAP_VERSION } from "../src/paseo/start.js";
import { VERSION } from "../src/version.js";
import { pairControlCenter } from "./helpers/controlCenterSession.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function project(stateDir = ".harness/paseo") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-control-center-lead-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  await fs.writeFile(path.join(root, ".harness/project.yaml"), [
    "version: 1",
    "project:",
    "  name: demo",
    "orchestration:",
    "  provider: paseo",
    "  interactive:",
    `    stateDir: ${stateDir}`,
    ""
  ].join("\n"));
  return root;
}

async function writeLeadState(root: string, overrides: Record<string, unknown> = {}, stateDir = ".harness/paseo") {
  const directory = path.resolve(root, stateDir);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "lead-session.json"), `${JSON.stringify({
    version: 2,
    bootstrapVersion: PASEO_BOOTSTRAP_VERSION,
    aehVersion: VERSION,
    aehCommand: "aeh",
    projectRoot: root,
    projectName: "demo",
    agentId: "current-managed-lead",
    title: "AEH Lead",
    leadAgent: "lead",
    provider: "codex",
    model: "gpt-test",
    createdAt: new Date().toISOString(),
    generation: 1,
    ...overrides
  }, null, 2)}\n`);
}

describe("Control Center current managed Lead binding", () => {
  it("binds a fresh start to its matching durable lead before any operation exists", async () => {
    const root = await project();
    await writeLeadState(root);
    await expect(resolveControlCenterLeadBinding(root, "current-managed-lead"))
      .resolves.toEqual({ status: "BOUND", leadId: "current-managed-lead" });
  });

  it("fails closed when the start result differs from the current durable lead", async () => {
    const root = await project();
    await writeLeadState(root);
    await expect(resolveControlCenterLeadBinding(root, "stale-operation-lead"))
      .rejects.toThrow("does not match the current durable managed-lead identity");
  });

  it("direct Control Center resolution uses durable current state and ignores ambient Paseo identity", async () => {
    const root = await project();
    await writeLeadState(root);
    const previous = process.env.PASEO_AGENT_ID;
    process.env.PASEO_AGENT_ID = "ambient-stale-lead";
    try {
      await expect(resolveControlCenterLeadBinding(root))
        .resolves.toEqual({ status: "BOUND", leadId: "current-managed-lead" });
    } finally {
      if (previous === undefined) delete process.env.PASEO_AGENT_ID;
      else process.env.PASEO_AGENT_ID = previous;
    }
  });

  it("keeps direct Control Center unconfigured when current durable identity is absent or incompatible", async () => {
    const missingRoot = await project();
    await expect(resolveControlCenterLeadBinding(missingRoot))
      .resolves.toMatchObject({ status: "UNCONFIGURED" });
    await expect(resolveControlCenterLeadBinding(missingRoot, "start-result-lead"))
      .rejects.toThrow("current durable managed-lead identity could not be validated");

    const incompatibleRoot = await project();
    await writeLeadState(incompatibleRoot, { bootstrapVersion: PASEO_BOOTSTRAP_VERSION - 1 });
    await expect(resolveControlCenterLeadBinding(incompatibleRoot))
      .resolves.toMatchObject({ status: "UNCONFIGURED" });
  });

  it("dispatches the actual paired Lead message route to the resolved current lead", async () => {
    const root = await project();
    await writeLeadState(root);
    const binding = await resolveControlCenterLeadBinding(root);
    expect(binding.status).toBe("BOUND");
    if (binding.status !== "BOUND") throw new Error("Expected a current managed lead binding.");
    const dispatched: string[] = [];
    const center = new LocalControlCenterV1({
      paseo: { root, leadId: binding.leadId },
      paseoGateway: new PaseoGatewayV1({
        dispatchLead: async (_root, leadId) => {
          dispatched.push(leadId);
          return { id: leadId, status: "idle", lastMessage: "operation request accepted" };
        }
      })
    });
    const started = await center.start();
    try {
      const session = await pairControlCenter(started);
      const response = await fetch(`${started.url}api/v1/paseo/lead/messages`, {
        method: "POST",
        headers: { ...session.headers(true), "content-type": "application/json" },
        body: JSON.stringify({ prompt: "start a governed operation and return its status" })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ leadId: "current-managed-lead", lastMessage: "operation request accepted" });
      expect(dispatched).toEqual(["current-managed-lead"]);
    } finally {
      await center.close();
    }
  });

  it("re-resolves the durable current Lead for an already running Control Center", async () => {
    const root = await project();
    await writeLeadState(root);
    const dispatched: string[] = [];
    const center = new LocalControlCenterV1({
      paseo: {
        root,
        leadId: "current-managed-lead",
        resolveLeadId: async () => {
          const binding = await resolveControlCenterLeadBinding(root);
          return binding.status === "BOUND" ? binding.leadId : undefined;
        }
      },
      paseoGateway: new PaseoGatewayV1({
        dispatchLead: async (_root, leadId) => {
          dispatched.push(leadId);
          return { id: leadId, status: "idle", lastMessage: "operation request accepted" };
        }
      })
    });
    const started = await center.start();
    try {
      const session = await pairControlCenter(started);
      const send = () => fetch(`${started.url}api/v1/paseo/lead/messages`, {
        method: "POST",
        headers: { ...session.headers(true), "content-type": "application/json" },
        body: JSON.stringify({ prompt: "continue the governed operation" })
      });
      expect((await send()).status).toBe(200);
      await writeLeadState(root, { agentId: "replacement-current-managed-lead", generation: 2 });
      expect((await send()).status).toBe(200);
      expect(dispatched).toEqual(["current-managed-lead", "replacement-current-managed-lead"]);
    } finally {
      await center.close();
    }
  });
});
