import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDetachedOperation } from "../src/operations/controller.js";
import { loadOperationCompletionTarget } from "../src/operations/completion.js";
import { resolveStartLeadBinding } from "../src/operations/leadBinding.js";
import { loadOperation } from "../src/operations/state.js";
import { PASEO_BOOTSTRAP_VERSION } from "../src/paseo/leadState.js";
import { VERSION } from "../src/version.js";

const roots: string[] = [];
const previousAgentId = process.env.PASEO_AGENT_ID;

afterEach(async () => {
  if (previousAgentId === undefined) delete process.env.PASEO_AGENT_ID;
  else process.env.PASEO_AGENT_ID = previousAgentId;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function projectRoot(leadAgentId = "real-lead"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-lead-binding-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".harness", "paseo"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".harness", "project.yaml"),
    ["version: 1", "project:", "  name: lead-binding-test", "orchestration:", "  provider: paseo", "  interactive:", "    stateDir: .harness/paseo", ""].join("\n")
  );
  await fs.writeFile(
    path.join(root, ".harness", "paseo", "lead-session.json"),
    `${JSON.stringify({
      version: 2, bootstrapVersion: PASEO_BOOTSTRAP_VERSION, aehVersion: VERSION, aehCommand: "aeh",
      projectRoot: root, projectName: "lead-binding-test", agentId: leadAgentId, title: "AEH Lead",
      leadAgent: "lead", provider: "codex", model: "gpt-test", createdAt: new Date().toISOString(), generation: 1
    }, null, 2)}\n`
  );
  return root;
}

function spawnStub(pid: number) {
  return vi.fn(() => ({ pid, unref: () => undefined })) as never;
}

async function traceEvents(root: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(root, ".harness", "telemetry", "paseo.ndjson"), "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { name: string }).name);
}

describe("operation-start lead binding identity (D17)", () => {
  it("does not bind an ambient env session as lead; falls back to the durable lead and still notifies the starter", async () => {
    const root = await projectRoot();
    process.env.PASEO_AGENT_ID = "ambient-shell-session";
    const record = await startDetachedOperation(root, "audit", { request: "review" }, {
      nodeExecutable: "/usr/bin/node", entryFile: "/pkg/dist/main.js", spawnProcess: spawnStub(5001)
    });
    const stored = await loadOperation(root, record.id);
    expect(stored.lead).toMatchObject({ agentId: "real-lead", source: "lead-state", generation: 1 });
    expect(await loadOperationCompletionTarget(root, record.id)).toMatchObject({ agentId: "ambient-shell-session", source: "environment", status: "PENDING" });
    expect(await traceEvents(root)).toContain("harness.paseo.operation.lead.durable-fallback");
  });

  it("binds an env identity that verifies against the durable lead, preserving its source", async () => {
    const root = await projectRoot();
    process.env.PASEO_AGENT_ID = "real-lead";
    const record = await startDetachedOperation(root, "audit", { request: "review" }, {
      nodeExecutable: "/usr/bin/node", entryFile: "/pkg/dist/main.js", spawnProcess: spawnStub(5002)
    });
    const stored = await loadOperation(root, record.id);
    expect(stored.lead).toMatchObject({ agentId: "real-lead", source: "environment", generation: 1 });
    expect(await loadOperationCompletionTarget(root, record.id)).toMatchObject({ agentId: "real-lead", source: "environment" });
    expect(await traceEvents(root)).toContain("harness.paseo.operation.lead.verified");
  });

  it("binds an explicit durable identity from a lead-state MCP start exactly as before", async () => {
    const root = await projectRoot();
    delete process.env.PASEO_AGENT_ID;
    const record = await startDetachedOperation(root, "audit", { request: "review" }, {
      nodeExecutable: "/usr/bin/node", entryFile: "/pkg/dist/main.js",
      completionAgentId: "real-lead", completionSource: "lead-state",
      initiator: { kind: "LEAD", agentId: "real-lead", requestEventId: "test:lead-state-start" },
      spawnProcess: spawnStub(5003)
    });
    const stored = await loadOperation(root, record.id);
    expect(stored.lead).toMatchObject({ agentId: "real-lead", source: "lead-state", generation: 1 });
    expect(await loadOperationCompletionTarget(root, record.id)).toMatchObject({ agentId: "real-lead", source: "lead-state" });
  });

  it("fails an explicit identity that mismatches the durable lead closed to the durable binding", async () => {
    const root = await projectRoot();
    delete process.env.PASEO_AGENT_ID;
    const record = await startDetachedOperation(root, "audit", { request: "review" }, {
      nodeExecutable: "/usr/bin/node", entryFile: "/pkg/dist/main.js",
      completionAgentId: "ambient-shell-session", completionSource: "explicit",
      initiator: { kind: "LEAD", agentId: "ambient-shell-session", requestEventId: "test:explicit-mismatch" },
      spawnProcess: spawnStub(5004)
    });
    const stored = await loadOperation(root, record.id);
    expect(stored.lead).toMatchObject({ agentId: "real-lead", source: "lead-state" });
    expect(await loadOperationCompletionTarget(root, record.id)).toMatchObject({ agentId: "ambient-shell-session", source: "explicit" });
  });

  it("leaves the lead unbound with a recorded reason when no durable lead can verify the starter", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-lead-binding-bare-"));
    roots.push(root);
    process.env.PASEO_AGENT_ID = "ambient-shell-session";
    const record = await startDetachedOperation(root, "audit", { request: "review" }, {
      nodeExecutable: "/usr/bin/node", entryFile: "/pkg/dist/main.js", spawnProcess: spawnStub(5005)
    });
    const stored = await loadOperation(root, record.id);
    expect(stored.lead).toBeUndefined();
    expect(await loadOperationCompletionTarget(root, record.id)).toMatchObject({ agentId: "ambient-shell-session" });
    const events = await traceEvents(root);
    expect(events).toContain("harness.paseo.operation.lead.unbound");
  });

  it("keeps a starter-less CLI start lead-free even when a durable lead exists", async () => {
    const root = await projectRoot();
    delete process.env.PASEO_AGENT_ID;
    const record = await startDetachedOperation(root, "audit", { request: "review" }, {
      nodeExecutable: "/usr/bin/node", entryFile: "/pkg/dist/main.js", spawnProcess: spawnStub(5006)
    });
    const stored = await loadOperation(root, record.id);
    expect(stored.lead).toBeUndefined();
    expect(await loadOperationCompletionTarget(root, record.id)).toBeUndefined();
  });
});

describe("resolveStartLeadBinding", () => {
  it("verifies a starter that is the durable lead", () => {
    expect(resolveStartLeadBinding({ agentId: "lead-1", source: "environment" }, { agentId: "lead-1", source: "lead-state" }))
      .toEqual({ status: "VERIFIED", agentId: "lead-1", source: "environment" });
  });

  it("falls back to the durable lead on mismatch and without a starter", () => {
    expect(resolveStartLeadBinding({ agentId: "ambient", source: "environment" }, { agentId: "lead-1", source: "lead-state" }))
      .toEqual({ status: "DURABLE", agentId: "lead-1", source: "lead-state" });
    expect(resolveStartLeadBinding(undefined, { agentId: "lead-1", source: "lead-state" }))
      .toEqual({ status: "DURABLE", agentId: "lead-1", source: "lead-state" });
  });

  it("leaves the binding unbound only when no durable lead exists", () => {
    expect(resolveStartLeadBinding({ agentId: "ambient", source: "environment" }, undefined).status).toBe("UNBOUND");
    expect(resolveStartLeadBinding(undefined, undefined).status).toBe("UNBOUND");
  });
});
