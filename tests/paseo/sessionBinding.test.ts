import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Canonical } from "../../src/core/digest.js";
import {
  assertPaseoSessionBinding,
  bindPaseoSession,
  loadPaseoSessionBinding,
  paseoSessionBindingMatches,
  resolveReusablePaseoSession,
  rotatePaseoSessionBinding,
  type PaseoSessionBindingInputV1,
  type PaseoSessionBindingV1
} from "../../src/paseo/sessionBinding.js";

const NOW = new Date("2026-09-23T00:00:00.000Z");
const LATER = new Date("2026-09-23T01:00:00.000Z");
const PLAN_A = "a".repeat(64);
const PLAN_B = "b".repeat(64);
const BLUEPRINT_A = "c".repeat(64);
const BLUEPRINT_B = "d".repeat(64);

const roots: string[] = [];
const previousEnv = {
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
  control: process.env.AEH_CONTROL_ROOT,
  operation: process.env.AEH_OPERATION_ID
};

beforeEach(() => {
  delete process.env.AEH_OPERATION_STATE_REDIRECT;
  delete process.env.AEH_CONTROL_ROOT;
  delete process.env.AEH_OPERATION_ID;
});

afterEach(async () => {
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", previousEnv.redirect);
  restoreEnv("AEH_CONTROL_ROOT", previousEnv.control);
  restoreEnv("AEH_OPERATION_ID", previousEnv.operation);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("durable Paseo session binding identity", () => {
  it("creates, loads, and matches one stable binding with a private file mode", async () => {
    const root = await makeRoot();
    const created = await bindPaseoSession(root, input());

    expect(created.version).toBe(1);
    expect(created.sessionGeneration).toBe(1);
    expect(created.status).toBe("ACTIVE");
    expect(created.workspaceId).toBe("workspace-1");
    expect(created.bindingId).toBe(`paseo-binding:${sha256Canonical({ operationId: created.operationId, participantId: created.participantId, sessionGeneration: created.sessionGeneration })}`);
    expect(created.bindingDigest).toMatch(/^[a-f0-9]{64}$/);
    const { bindingDigest, ...identity } = created;
    expect(bindingDigest).toBe(sha256Canonical(identity));

    const loaded = await loadPaseoSessionBinding(root, created.operationId, created.participantId);
    expect(loaded).toEqual(created);
    expect(loaded?.bindingDigest).toBe(created.bindingDigest);
    expect(paseoSessionBindingMatches(loaded!, expectedFor(created))).toBe(true);
    expect(resolveReusablePaseoSession(loaded, expectedFor(created))).toEqual(created);

    if (process.platform !== "win32") {
      const file = await findBindingFile(root);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("is idempotent when the same identity rebinds the same Paseo agent", async () => {
    const root = await makeRoot();
    const first = await bindPaseoSession(root, input());
    const second = await bindPaseoSession(root, input({ now: LATER }));

    expect(second).toEqual(first);
    expect(second.sessionGeneration).toBe(1);
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it("rejects rebinding the same identity to a different Paseo agent", async () => {
    const root = await makeRoot();
    const first = await bindPaseoSession(root, input());

    await expect(bindPaseoSession(root, input({ paseoAgentId: "paseo-agent-2", now: LATER }))).rejects.toThrow("PASEO_SESSION_BINDING_CONFLICT");
    const loaded = await loadPaseoSessionBinding(root, first.operationId, first.participantId);
    expect(loaded).toEqual(first);
  });

  it("fails closed with PASEO_SESSION_BINDING_STALE for a changed plan, blueprint, generation, or operation revision", async () => {
    const root = await makeRoot();
    const stored = await bindPaseoSession(root, input());
    const base = expectedFor(stored);
    expect(resolveReusablePaseoSession(stored, base)).toBe(stored);

    await expect(bindPaseoSession(root, input({ participantPlanDigest: PLAN_B }))).rejects.toThrow("PASEO_SESSION_BINDING_STALE");
    await expect(bindPaseoSession(root, input({ executionBlueprintDigest: BLUEPRINT_B }))).rejects.toThrow("PASEO_SESSION_BINDING_STALE");
    await expect(bindPaseoSession(root, input({ participantGeneration: 2 }))).rejects.toThrow("PASEO_SESSION_BINDING_STALE");
    await expect(bindPaseoSession(root, input({ operationRevision: 2 }))).rejects.toThrow("PASEO_SESSION_BINDING_STALE");

    expect(resolveReusablePaseoSession(stored, { ...base, participantPlanDigest: PLAN_B })).toBeUndefined();
    expect(resolveReusablePaseoSession(stored, { ...base, executionBlueprintDigest: BLUEPRINT_B })).toBeUndefined();
    expect(resolveReusablePaseoSession(stored, { ...base, participantGeneration: 2 })).toBeUndefined();
    expect(resolveReusablePaseoSession(stored, { ...base, operationRevision: 2 })).toBeUndefined();

    const reloaded = await loadPaseoSessionBinding(root, stored.operationId, stored.participantId);
    expect(reloaded).toEqual(stored);
  });

  it("rotates generation explicitly, preserving createdAt and producing a reusable identity", async () => {
    const root = await makeRoot();
    const first = await bindPaseoSession(root, input());
    const rotated = await rotatePaseoSessionBinding(root, input({ paseoAgentId: "paseo-agent-2", now: LATER }));

    expect(rotated.sessionGeneration).toBe(2);
    expect(rotated.createdAt).toBe(first.createdAt);
    expect(rotated.updatedAt).toBe(LATER.toISOString());
    expect(rotated.bindingId).not.toBe(first.bindingId);
    expect(rotated.bindingDigest).not.toBe(first.bindingDigest);
    expect(rotated.paseoAgentId).toBe("paseo-agent-2");

    const loaded = await loadPaseoSessionBinding(root, first.operationId, first.participantId);
    expect(loaded).toEqual(rotated);
    expect(resolveReusablePaseoSession(loaded, expectedFor(rotated))).toEqual(rotated);
    expect(await bindPaseoSession(root, input({ paseoAgentId: "paseo-agent-2" }))).toEqual(rotated);
  });

  it("treats rotation without a previous binding as the first generation", async () => {
    const root = await makeRoot();
    const rotated = await rotatePaseoSessionBinding(root, input());

    expect(rotated.sessionGeneration).toBe(1);
    expect(rotated.createdAt).toBe(NOW.toISOString());
    expect(resolveReusablePaseoSession(rotated, expectedFor(rotated))).toEqual(rotated);
  });

  it("reports PASEO_SESSION_BINDING_CORRUPT when a persisted binding is tampered", async () => {
    const root = await makeRoot();
    const binding = await bindPaseoSession(root, input());
    const file = await findBindingFile(root);
    const tampered = JSON.parse(await fs.readFile(file, "utf8")) as PaseoSessionBindingV1;
    tampered.bindingDigest = "0".repeat(64);
    await fs.writeFile(file, `${JSON.stringify(tampered, null, 2)}\n`);

    await expect(loadPaseoSessionBinding(root, binding.operationId, binding.participantId)).rejects.toThrow("PASEO_SESSION_BINDING_CORRUPT");
    await expect(bindPaseoSession(root, input())).rejects.toThrow("PASEO_SESSION_BINDING_CORRUPT");
    await expect(rotatePaseoSessionBinding(root, input())).rejects.toThrow("PASEO_SESSION_BINDING_CORRUPT");
  });

  it("reports PASEO_SESSION_BINDING_CORRUPT for unreadable persisted state", async () => {
    const root = await makeRoot();
    await bindPaseoSession(root, input());
    const file = await findBindingFile(root);
    await fs.writeFile(file, "{not-json");

    await expect(loadPaseoSessionBinding(root, "OP-BINDING-1", "participant:implementer")).rejects.toThrow("PASEO_SESSION_BINDING_CORRUPT");
  });

  it("validates every durable binding field before trusting it", async () => {
    const root = await makeRoot();
    const binding = await bindPaseoSession(root, input());

    expect(() => assertPaseoSessionBinding(binding)).not.toThrow();
    expect(() => assertPaseoSessionBinding({ ...binding, version: 2 })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, bindingId: "paseo-binding:not-a-digest" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, participantGeneration: -1 })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, sessionGeneration: 1.5 })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, participantPlanDigest: "xyz" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, workspaceId: "" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, status: "UNKNOWN" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, createdAt: "not-a-date" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, bindingDigest: "not-a-digest" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding(undefined)).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, extra: true })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
  });

  it("never reuses an archived or lost binding", async () => {
    const root = await makeRoot();
    const archived = await bindPaseoSession(root, input({ participantId: "participant:archived", status: "ARCHIVED" }));
    const lost = await bindPaseoSession(root, input({ participantId: "participant:lost", status: "LOST" }));

    for (const binding of [archived, lost]) {
      const expected = expectedFor(binding);
      expect(binding.status).not.toBe("ACTIVE");
      expect(paseoSessionBindingMatches(binding, expected)).toBe(true);
      expect(resolveReusablePaseoSession(binding, expected)).toBeUndefined();
      const loaded = await loadPaseoSessionBinding(root, binding.operationId, binding.participantId);
      expect(loaded).toEqual(binding);
      expect(resolveReusablePaseoSession(loaded, expected)).toBeUndefined();
    }
  });

  it("keeps two participants of the same operation independent", async () => {
    const root = await makeRoot();
    const implementer = await bindPaseoSession(root, input({ participantId: "participant:implementer", paseoAgentId: "paseo-agent-impl" }));
    const reviewer = await bindPaseoSession(root, input({ participantId: "participant:reviewer", paseoAgentId: "paseo-agent-review" }));

    expect(implementer.bindingId).not.toBe(reviewer.bindingId);
    expect(implementer.bindingDigest).not.toBe(reviewer.bindingDigest);
    expect(await loadPaseoSessionBinding(root, implementer.operationId, "participant:implementer")).toEqual(implementer);
    expect(await loadPaseoSessionBinding(root, implementer.operationId, "participant:reviewer")).toEqual(reviewer);
    expect(await loadPaseoSessionBinding(root, implementer.operationId, "participant:missing")).toBeUndefined();
  });

  it("stores optional workspace and digest fields only when provided", async () => {
    const root = await makeRoot();
    const binding = await bindPaseoSession(root, {
      projectId: "project:test",
      operationId: "OP-OPTIONAL",
      operationRevision: 0,
      participantId: "participant:lead",
      participantGeneration: 0,
      paseoAgentId: "paseo-agent-lead",
      now: NOW
    });

    expect(binding.participantPlanDigest).toBeUndefined();
    expect(binding.executionBlueprintDigest).toBeUndefined();
    expect(binding.workspaceId).toBeUndefined();
    expect(binding.status).toBe("ACTIVE");
    expect(await loadPaseoSessionBinding(root, "OP-OPTIONAL", "participant:lead")).toEqual(binding);
    expect(resolveReusablePaseoSession(binding, { operationId: "OP-OPTIONAL", participantId: "participant:lead", participantGeneration: 0 })).toEqual(binding);
  });

  it("serializes concurrent rotations through the binding lock", async () => {
    const root = await makeRoot();
    const first = await bindPaseoSession(root, input());
    const [left, right] = await Promise.all([
      rotatePaseoSessionBinding(root, input({ paseoAgentId: "paseo-agent-2", now: LATER })),
      rotatePaseoSessionBinding(root, input({ paseoAgentId: "paseo-agent-3", now: LATER }))
    ]);

    expect([left.sessionGeneration, right.sessionGeneration].sort()).toEqual([2, 3]);
    const loaded = await loadPaseoSessionBinding(root, first.operationId, first.participantId);
    expect(loaded?.sessionGeneration).toBe(3);

    const file = await findBindingFile(root);
    await expect(fs.access(`${file}.lock`)).rejects.toThrow();
  });
});

function input(overrides: Partial<PaseoSessionBindingInputV1> = {}): PaseoSessionBindingInputV1 {
  return {
    projectId: "project:test",
    operationId: "OP-BINDING-1",
    operationRevision: 1,
    participantId: "participant:implementer",
    participantGeneration: 1,
    participantPlanDigest: PLAN_A,
    executionBlueprintDigest: BLUEPRINT_A,
    paseoAgentId: "paseo-agent-1",
    workspaceId: "workspace-1",
    now: NOW,
    ...overrides
  };
}

function expectedFor(binding: PaseoSessionBindingV1): Parameters<typeof paseoSessionBindingMatches>[1] {
  return {
    operationId: binding.operationId,
    participantId: binding.participantId,
    participantGeneration: binding.participantGeneration,
    participantPlanDigest: binding.participantPlanDigest,
    executionBlueprintDigest: binding.executionBlueprintDigest,
    operationRevision: binding.operationRevision
  };
}

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-session-binding-"));
  roots.push(root);
  return root;
}

async function findBindingFile(root: string): Promise<string> {
  const base = path.join(root, ".harness", "paseo", "sessions");
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".json")) found.push(full);
    }
  }
  await walk(base);
  if (found.length !== 1) throw new Error(`expected exactly one persisted binding under ${base}, found ${found.length}.`);
  return found[0]!;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
