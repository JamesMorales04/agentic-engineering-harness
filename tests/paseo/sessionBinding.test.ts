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
  type PaseoSessionBindingIdentityV1,
  type PaseoSessionBindingInputV1,
  type PaseoSessionBindingV1
} from "../../src/paseo/sessionBinding.js";

const NOW = new Date("2026-09-23T00:00:00.000Z");
const LATER = new Date("2026-09-23T01:00:00.000Z");
const CANDIDATE_A = "1".repeat(64);
const CANDIDATE_B = "2".repeat(64);
const BLUEPRINT_A = "3".repeat(64);
const BLUEPRINT_B = "4".repeat(64);
const POLICY_A = "5".repeat(64);
const POLICY_B = "6".repeat(64);
const CONTEXT_A = "7".repeat(64);
const CONTEXT_B = "8".repeat(64);
const PROMPT_A = "9".repeat(64);
const PROMPT_B = "0".repeat(64);

const IDENTITY_FIELDS = [
  "projectId",
  "operationId",
  "operationExecutionRevision",
  "participantId",
  "participantGeneration",
  "candidateRevision",
  "candidateDigest",
  "executionBlueprintDigest",
  "operationPolicyDigest",
  "contextManifestDigest",
  "promptManifestDigest",
  "controllerEpoch"
] as const satisfies readonly (keyof PaseoSessionBindingIdentityV1)[];

const RECORD_FIELDS = [
  "version",
  "bindingId",
  ...IDENTITY_FIELDS,
  "paseoAgentId",
  "sessionGeneration",
  "status",
  "createdAt",
  "updatedAt",
  "bindingDigest"
].sort();

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
    expect(created.paseoAgentId).toBe("paseo-agent-1");
    expect(created.projectId).toBe("project:test");
    expect(created.operationId).toBe("OP-BINDING-1");
    expect(created.operationExecutionRevision).toBe(1);
    expect(created.participantId).toBe("participant:implementer");
    expect(created.participantGeneration).toBe("generation:1");
    expect(created.candidateRevision).toBe(1);
    expect(created.candidateDigest).toBe(CANDIDATE_A);
    expect(created.executionBlueprintDigest).toBe(BLUEPRINT_A);
    expect(created.operationPolicyDigest).toBe(POLICY_A);
    expect(created.contextManifestDigest).toBe(CONTEXT_A);
    expect(created.promptManifestDigest).toBe(PROMPT_A);
    expect(created.controllerEpoch).toBe(1);
    expect(Object.keys(created).sort()).toEqual(RECORD_FIELDS);

    expect(created.bindingId).toBe(`paseo-binding:${sha256Canonical({ operationId: created.operationId, participantId: created.participantId, sessionGeneration: created.sessionGeneration })}`);
    expect(created.bindingDigest).toMatch(/^[a-f0-9]{64}$/);
    const { bindingDigest, ...body } = created;
    expect(bindingDigest).toBe(sha256Canonical(body));
    for (const field of Object.keys(body) as Array<keyof typeof body>) {
      expect(sha256Canonical({ ...body, [field]: `${String(body[field])}:changed` })).not.toBe(bindingDigest);
    }

    const loaded = await loadPaseoSessionBinding(root, created.operationId, created.participantId);
    expect(loaded).toEqual(created);
    expect(loaded?.bindingDigest).toBe(created.bindingDigest);
    expect(paseoSessionBindingMatches(loaded!, identityFor(created))).toBe(true);
    expect(resolveReusablePaseoSession(loaded, identityFor(created))).toEqual(created);

    if (process.platform !== "win32") {
      const file = await findBindingFile(root);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("is idempotent when the same complete identity rebinds the same Paseo agent", async () => {
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
    expect(resolveReusablePaseoSession(loaded, identityFor(first))).toEqual(first);
  });

  it("fails closed with PASEO_SESSION_BINDING_STALE for any changed identity field", async () => {
    const root = await makeRoot();
    const stored = await bindPaseoSession(root, input());
    const identity = identityFor(stored);
    expect(resolveReusablePaseoSession(stored, identity)).toBe(stored);

    const mutations: Array<Partial<PaseoSessionBindingInputV1>> = [
      { operationExecutionRevision: 2 },
      { participantGeneration: "generation:2" },
      { candidateRevision: 2 },
      { candidateDigest: CANDIDATE_B },
      { executionBlueprintDigest: BLUEPRINT_B },
      { operationPolicyDigest: POLICY_B },
      { contextManifestDigest: CONTEXT_B },
      { promptManifestDigest: PROMPT_B },
      { controllerEpoch: 2 },
      { projectId: "project:other" }
    ];

    for (const mutation of mutations) {
      await expect(bindPaseoSession(root, input(mutation))).rejects.toThrow("PASEO_SESSION_BINDING_STALE");
      const stale = { ...identity, ...mutation } as PaseoSessionBindingIdentityV1;
      expect(paseoSessionBindingMatches(stored, stale)).toBe(false);
      expect(resolveReusablePaseoSession(stored, stale)).toBeUndefined();
    }

    const reloaded = await loadPaseoSessionBinding(root, stored.operationId, stored.participantId);
    expect(reloaded).toEqual(stored);
  });

  it("rotates generation explicitly, preserving createdAt and persisting the complete new identity", async () => {
    const root = await makeRoot();
    const first = await bindPaseoSession(root, input());
    const rotatedInput = input({
      paseoAgentId: "paseo-agent-2",
      participantGeneration: "generation:2",
      candidateRevision: 2,
      candidateDigest: CANDIDATE_B,
      executionBlueprintDigest: BLUEPRINT_B,
      operationPolicyDigest: POLICY_B,
      contextManifestDigest: CONTEXT_B,
      promptManifestDigest: PROMPT_B,
      controllerEpoch: 2,
      now: LATER
    });
    const rotated = await rotatePaseoSessionBinding(root, rotatedInput);

    expect(rotated.sessionGeneration).toBe(2);
    expect(rotated.createdAt).toBe(first.createdAt);
    expect(rotated.updatedAt).toBe(LATER.toISOString());
    expect(rotated.bindingId).not.toBe(first.bindingId);
    expect(rotated.bindingDigest).not.toBe(first.bindingDigest);
    expect(rotated.paseoAgentId).toBe("paseo-agent-2");
    expect(rotated.participantGeneration).toBe("generation:2");
    expect(rotated.candidateRevision).toBe(2);
    expect(rotated.candidateDigest).toBe(CANDIDATE_B);
    expect(rotated.operationPolicyDigest).toBe(POLICY_B);

    const loaded = await loadPaseoSessionBinding(root, first.operationId, first.participantId);
    expect(loaded).toEqual(rotated);
    expect(resolveReusablePaseoSession(loaded, identityFor(rotated))).toEqual(rotated);
    expect(resolveReusablePaseoSession(loaded, identityFor(first))).toBeUndefined();
    expect(await bindPaseoSession(root, rotatedInput)).toEqual(rotated);
  });

  it("treats rotation without a previous binding as the first generation", async () => {
    const root = await makeRoot();
    const rotated = await rotatePaseoSessionBinding(root, input());

    expect(rotated.sessionGeneration).toBe(1);
    expect(rotated.createdAt).toBe(NOW.toISOString());
    expect(resolveReusablePaseoSession(rotated, identityFor(rotated))).toEqual(rotated);
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

  it("reports PASEO_SESSION_BINDING_CORRUPT for a semantic field mutated without re-signing", async () => {
    const root = await makeRoot();
    const binding = await bindPaseoSession(root, input());
    const file = await findBindingFile(root);
    const tampered = JSON.parse(await fs.readFile(file, "utf8")) as PaseoSessionBindingV1;
    tampered.paseoAgentId = "paseo-agent-other";
    await fs.writeFile(file, `${JSON.stringify(tampered, null, 2)}\n`);

    await expect(loadPaseoSessionBinding(root, binding.operationId, binding.participantId)).rejects.toThrow("PASEO_SESSION_BINDING_CORRUPT");
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
    const { promptManifestDigest: _missing, ...missingField } = binding;

    expect(() => assertPaseoSessionBinding(binding)).not.toThrow();
    expect(() => assertPaseoSessionBinding({ ...binding, version: 2 })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, bindingId: "paseo-binding:not-a-digest" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding(resign({ ...binding, bindingId: `paseo-binding:${sha256Canonical({ operationId: binding.operationId, participantId: binding.participantId, sessionGeneration: 2 })}` }))).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, projectId: "" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, operationId: "" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, operationExecutionRevision: 0 })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, operationExecutionRevision: 1.5 })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, participantId: "" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, participantGeneration: "" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, participantGeneration: 1 })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, candidateRevision: -1 })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, candidateDigest: "xyz" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, executionBlueprintDigest: "xyz" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, operationPolicyDigest: "xyz" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, contextManifestDigest: "xyz" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, promptManifestDigest: "xyz" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, controllerEpoch: -1 })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, paseoAgentId: "" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, paseoAgentId: "launch:synthetic" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, sessionGeneration: 0 })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, sessionGeneration: 1.5 })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, status: "UNKNOWN" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, createdAt: "not-a-date" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, updatedAt: "not-a-date" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, bindingDigest: "not-a-digest" })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding(undefined)).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding({ ...binding, extra: true })).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding(missingField)).toThrow("PASEO_SESSION_BINDING_CORRUPT");
  });

  it("requires every identity field and actual agent id on persisted records", async () => {
    const root = await makeRoot();
    const binding = await bindPaseoSession(root, input());
    const file = await findBindingFile(root);
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;

    for (const field of IDENTITY_FIELDS) {
      const incomplete = { ...stored };
      delete incomplete[field];
      expect(() => assertPaseoSessionBinding(incomplete)).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    }
    const { paseoAgentId: _agent, ...withoutAgent } = stored;
    expect(() => assertPaseoSessionBinding(withoutAgent)).toThrow("PASEO_SESSION_BINDING_CORRUPT");
    expect(() => assertPaseoSessionBinding(resign({ ...stored, unexpected: "field" }))).toThrow("PASEO_SESSION_BINDING_CORRUPT");

    await expect(bindPaseoSession(root, withoutField(input(), "promptManifestDigest"))).rejects.toThrow("PASEO_SESSION_BINDING_INVALID");
    await expect(bindPaseoSession(root, withoutField(input(), "paseoAgentId"))).rejects.toThrow("PASEO_SESSION_BINDING_INVALID");
    await expect(bindPaseoSession(root, { ...input(), paseoAgentId: "launch:prepared" })).rejects.toThrow("PASEO_SESSION_BINDING_INVALID");
    await expect(bindPaseoSession(root, { ...input(), candidateDigest: "not-a-digest" })).rejects.toThrow("PASEO_SESSION_BINDING_INVALID");

    await fs.writeFile(file, `${JSON.stringify({ ...stored, participantPlanDigest: CANDIDATE_A }, null, 2)}\n`);
    await expect(loadPaseoSessionBinding(root, binding.operationId, binding.participantId)).rejects.toThrow("PASEO_SESSION_BINDING_CORRUPT");
  });

  it("rejects missing or malformed reuse expectations without wildcards", async () => {
    const root = await makeRoot();
    const binding = await bindPaseoSession(root, input());
    const identity = identityFor(binding);

    expect(paseoSessionBindingMatches(binding, identity)).toBe(true);
    for (const field of IDENTITY_FIELDS) {
      const partial = { ...identity } as Record<string, unknown>;
      delete partial[field];
      expect(paseoSessionBindingMatches(binding, partial as unknown as PaseoSessionBindingIdentityV1)).toBe(false);
      expect(resolveReusablePaseoSession(binding, partial as unknown as PaseoSessionBindingIdentityV1)).toBeUndefined();
    }
    expect(paseoSessionBindingMatches(binding, {} as PaseoSessionBindingIdentityV1)).toBe(false);
    expect(paseoSessionBindingMatches(binding, undefined as unknown as PaseoSessionBindingIdentityV1)).toBe(false);
    expect(paseoSessionBindingMatches(binding, null as unknown as PaseoSessionBindingIdentityV1)).toBe(false);
    expect(resolveReusablePaseoSession(undefined, identity)).toBeUndefined();
    expect(paseoSessionBindingMatches(binding, { ...identity, candidateDigest: "xyz" })).toBe(false);
    expect(paseoSessionBindingMatches(binding, { ...identity, operationExecutionRevision: 0 })).toBe(false);
    expect(paseoSessionBindingMatches(binding, { ...identity, participantGeneration: "" })).toBe(false);
    expect(paseoSessionBindingMatches(binding, { ...identity, controllerEpoch: -1 })).toBe(false);
    expect(paseoSessionBindingMatches(binding, { ...identity, candidateRevision: 1.5 })).toBe(false);
  });

  it("never throws or reuses for a corrupt in-memory record", async () => {
    const root = await makeRoot();
    const binding = await bindPaseoSession(root, input());

    expect(resolveReusablePaseoSession({ ...binding, bindingDigest: "0".repeat(64) }, identityFor(binding))).toBeUndefined();
    expect(resolveReusablePaseoSession({ ...binding, paseoAgentId: "" }, identityFor(binding))).toBeUndefined();
    expect(paseoSessionBindingMatches({ ...binding, status: "UNKNOWN" } as unknown as PaseoSessionBindingV1, identityFor(binding))).toBe(false);
  });

  it("never reuses an archived or lost binding", async () => {
    const root = await makeRoot();
    const archived = await bindPaseoSession(root, input({ participantId: "participant:archived", status: "ARCHIVED" }));
    const lost = await bindPaseoSession(root, input({ participantId: "participant:lost", status: "LOST" }));

    for (const binding of [archived, lost]) {
      const expected = identityFor(binding);
      expect(binding.status).not.toBe("ACTIVE");
      expect(paseoSessionBindingMatches(binding, expected)).toBe(true);
      expect(resolveReusablePaseoSession(binding, expected)).toBeUndefined();
      const loaded = await loadPaseoSessionBinding(root, binding.operationId, binding.participantId);
      expect(loaded).toEqual(binding);
      expect(resolveReusablePaseoSession(loaded, expected)).toBeUndefined();
    }
  });

  it("fails closed on an internally consistent but stale persisted identity", async () => {
    const root = await makeRoot();
    const binding = await bindPaseoSession(root, input());
    const file = await findBindingFile(root);
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    await fs.writeFile(file, `${JSON.stringify(resign({ ...stored, participantGeneration: "generation:stale" }), null, 2)}\n`);

    const loaded = await loadPaseoSessionBinding(root, binding.operationId, binding.participantId);
    expect(loaded?.participantGeneration).toBe("generation:stale");
    expect(resolveReusablePaseoSession(loaded, identityFor(binding))).toBeUndefined();
    await expect(bindPaseoSession(root, input())).rejects.toThrow("PASEO_SESSION_BINDING_STALE");
    await expect(rotatePaseoSessionBinding(root, input({ now: LATER }))).resolves.toMatchObject({ sessionGeneration: 2, participantGeneration: "generation:1" });
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
    operationExecutionRevision: 1,
    participantId: "participant:implementer",
    participantGeneration: "generation:1",
    candidateRevision: 1,
    candidateDigest: CANDIDATE_A,
    executionBlueprintDigest: BLUEPRINT_A,
    operationPolicyDigest: POLICY_A,
    contextManifestDigest: CONTEXT_A,
    promptManifestDigest: PROMPT_A,
    controllerEpoch: 1,
    paseoAgentId: "paseo-agent-1",
    now: NOW,
    ...overrides
  };
}

function identityFor(binding: PaseoSessionBindingV1): PaseoSessionBindingIdentityV1 {
  return {
    projectId: binding.projectId,
    operationId: binding.operationId,
    operationExecutionRevision: binding.operationExecutionRevision,
    participantId: binding.participantId,
    participantGeneration: binding.participantGeneration,
    candidateRevision: binding.candidateRevision,
    candidateDigest: binding.candidateDigest,
    executionBlueprintDigest: binding.executionBlueprintDigest,
    operationPolicyDigest: binding.operationPolicyDigest,
    contextManifestDigest: binding.contextManifestDigest,
    promptManifestDigest: binding.promptManifestDigest,
    controllerEpoch: binding.controllerEpoch
  };
}

function withoutField(inputValue: PaseoSessionBindingInputV1, field: keyof PaseoSessionBindingInputV1): PaseoSessionBindingInputV1 {
  const copy = { ...inputValue };
  delete (copy as Record<string, unknown>)[field];
  return copy;
}

function resign(record: Record<string, unknown>): Record<string, unknown> {
  const { bindingDigest: _drop, ...body } = record;
  return { ...body, bindingDigest: sha256Canonical(body) };
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
