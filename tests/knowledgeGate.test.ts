import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileKnowledgeCacheV1, InMemoryKnowledgeCacheV1, applySkillTrustGate, evaluateKnowledgeGate, knowledgePack, resolveKnowledgeGate, validateAcceptedEphemeralSkill } from "../src/knowledge/index.js";
import { knowledgePackOutputSchema } from "../src/agents/outputContracts.js";

const competency = "unknown.library";
const evidence = (gap: NonNullable<ReturnType<typeof evaluateKnowledgeGate>>, kind: "official" | "repository" | "public-code" | "unknown" = "official") => knowledgePack({
  cacheKey: gap.cacheKey,
  topic: competency,
  claims: [{ id: "claim-1", statement: "Use the documented library adapter.", competency, confidence: "high" }],
  sources: [{ uri: `https://example.test/${kind}`, kind, version: "1" }],
  retrievedAt: "2026-09-22T00:00:00.000Z"
});

describe("knowledge gate", () => {
  it("uses known knowledge without a Librarian and reports an offline gap otherwise", async () => {
    const sufficient = await resolveKnowledgeGate({ requiredCompetencies: ["typescript"], knownCompetencies: ["typescript"] });
    expect(sufficient).toMatchObject({ gate: "SUFFICIENT", status: "VERIFIED", cacheHit: false });
    let calls = 0;
    const offline = await resolveKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [], mode: "OFFLINE", lookup: async () => { calls += 1; throw new Error("offline lookup must not run"); } });
    expect(offline).toMatchObject({ gate: "GAP", status: "MISSING", gap: { librarianRequired: false, mode: "OFFLINE", missingCompetencies: [competency] } });
    expect(calls).toBe(0);
  });

  it("binds cache identity to mode and source policy", () => {
    const docsOnly = evaluateKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [], mode: "DOCS_ONLY" })!;
    const discovery = evaluateKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [], mode: "TRUSTED_DISCOVERY" })!;
    const offline = evaluateKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [], mode: "OFFLINE" })!;
    expect(new Set([docsOnly.cacheKey, discovery.cacheKey, offline.cacheKey]).size).toBe(3);
  });

  it("accepts a policy-bound pack, creates an accepted skill, and reuses the cache", async () => {
    const cache = new InMemoryKnowledgeCacheV1();
    let calls = 0;
    const lookup = async (gap: NonNullable<ReturnType<typeof evaluateKnowledgeGate>>) => { calls += 1; return evidence(gap); };
    const first = await resolveKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [], mode: "DOCS_ONLY", cache, lookup });
    const second = await resolveKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [], mode: "DOCS_ONLY", cache, lookup });
    expect(first).toMatchObject({ gate: "SUFFICIENT", status: "GROUNDED", cacheHit: false, acceptedSkill: { id: `ephemeral:${competency}`, trustDecision: { status: "ACCEPTED", mode: "DOCS_ONLY" } } });
    expect(second).toMatchObject({ gate: "SUFFICIENT", status: "GROUNDED", cacheHit: true, acceptedSkill: { id: `ephemeral:${competency}`, trustDecision: { status: "ACCEPTED", mode: "DOCS_ONLY" } } });
    expect(first.acceptedSkill?.groundedProcedure[0]).toMatchObject({ stepIndex: 0, procedureDigest: expect.any(String), claims: [{ claimId: "claim-1", claimDigest: expect.any(String), sourceUris: ["https://example.test/official"] }] });
    expect(first.acceptedSkill).not.toHaveProperty("trusted");
    expect(calls).toBe(1);
  });

  it("persists cache entries across instances and keeps mode-specific entries isolated", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-knowledge-cache-"));
    try {
      const cacheKey = new FileKnowledgeCacheV1(directory);
      const gap = evaluateKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [], mode: "DOCS_ONLY" })!;
      const pack = evidence(gap);
      await cacheKey.set({ key: gap.cacheKey, pack });
      const reopened = new FileKnowledgeCacheV1(directory);
      const cached = await resolveKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [], mode: "DOCS_ONLY", cache: reopened });
      expect(cached).toMatchObject({ gate: "SUFFICIENT", cacheHit: true, pack: { packDigest: pack.packDigest } });
      const stricterDifferentMode = await resolveKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [], mode: "TRUSTED_DISCOVERY", cache: reopened });
      expect(stricterDifferentMode).toMatchObject({ gate: "GAP", cacheHit: false });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("rejects public-code, repository, and unknown sources in DOCS_ONLY", async () => {
    for (const kind of ["public-code", "repository", "unknown"] as const) {
      await expect(resolveKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [], mode: "DOCS_ONLY", lookup: async (gap) => evidence(gap, kind) }))
        .rejects.toMatchObject({ code: "KNOWLEDGE_PACK_REJECTED" });
    }
  });

  it("allows public-code only in TRUSTED_DISCOVERY and rejects unknown sources in every mode", async () => {
    const allowed = await resolveKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [], mode: "TRUSTED_DISCOVERY", lookup: async (gap) => evidence(gap, "public-code") });
    expect(allowed).toMatchObject({ gate: "SUFFICIENT", acceptedSkill: { trustDecision: { mode: "TRUSTED_DISCOVERY" } } });
    await expect(resolveKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [], mode: "TRUSTED_DISCOVERY", lookup: async (gap) => evidence(gap, "unknown") }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_PACK_REJECTED" });
  });

  it("treats a Librarian skill as a proposal and rejects model-supplied trust assertions", async () => {
    const gap = evaluateKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [], mode: "DOCS_ONLY" })!;
    const pack = evidence(gap);
    const proposal = { version: 1 as const, id: `ephemeral:${competency}`, competency, procedure: ["read official documentation", "run the focused test"], sourcePackDigest: pack.packDigest, procedureEvidence: [
      { stepIndex: 0, claimIds: ["claim-1"], sourceUris: [pack.sources[0]!.uri] },
      { stepIndex: 1, claimIds: ["claim-1"], sourceUris: [pack.sources[0]!.uri] }
    ] };
    expect(knowledgePackOutputSchema.parse({ pack, skillCandidate: proposal }).skillCandidate).toEqual(proposal);
    expect(() => knowledgePackOutputSchema.parse({ pack, skillCandidate: { ...proposal, trusted: true } })).toThrow();
    const accepted = applySkillTrustGate(proposal, pack, gap)!;
    expect(accepted.trustDecision).toMatchObject({ version: 1, status: "ACCEPTED", mode: "DOCS_ONLY", packDigest: pack.packDigest });
    expect(accepted.groundedProcedure).toHaveLength(proposal.procedure.length);
    expect(accepted.groundedProcedure[0]).toMatchObject({ stepIndex: 0, procedureDigest: expect.any(String), claims: [{ claimId: "claim-1", claimDigest: expect.any(String), sourceUris: [pack.sources[0]!.uri] }] });
    expect(() => validateAcceptedEphemeralSkill({ ...accepted, procedure: ["changed after gate"] }, pack, gap)).toThrow(/trust-gate digest is invalid/);
    expect(() => validateAcceptedEphemeralSkill({ ...accepted, trustDecision: { ...accepted.trustDecision, decisionDigest: "f".repeat(64) } }, pack, gap)).toThrow(/trust-gate digest is invalid/);
  });

  it("rejects unknown and digest-mismatched knowledge claims before skill acceptance", async () => {
    await expect(resolveKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [], lookup: async (gap) => evidence(gap, "unknown") }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_PACK_REJECTED" });
    const cache = new InMemoryKnowledgeCacheV1();
    const gap = evaluateKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [] })!;
    const wrongPack = knowledgePack({ cacheKey: gap.cacheKey, topic: "other.library", claims: [{ id: "claim", statement: "Use another adapter.", competency: "other.library", confidence: "high" }], sources: [{ uri: "https://example.test/official", kind: "official" }], retrievedAt: "2026-09-22T00:00:00.000Z" });
    await cache.set({ key: gap.cacheKey, pack: wrongPack });
    await expect(resolveKnowledgeGate({ requiredCompetencies: gap.missingCompetencies, knownCompetencies: [], cache })).rejects.toMatchObject({ code: "KNOWLEDGE_PACK_REJECTED" });
    await expect(resolveKnowledgeGate({ requiredCompetencies: gap.missingCompetencies, knownCompetencies: [], lookup: async (requested) => knowledgePack({ cacheKey: requested.cacheKey, topic: "other.library", claims: [{ id: "claim", statement: "Use another adapter.", competency: "other.library", confidence: "high" }], sources: [{ uri: "https://example.test/official", kind: "official" }], retrievedAt: "2026-09-22T00:00:00.000Z" }) })).rejects.toMatchObject({ code: "KNOWLEDGE_PACK_REJECTED" });
  });

  it("rejects procedure grounding with missing step, claim, or source references", () => {
    const gap = evaluateKnowledgeGate({ requiredCompetencies: [competency], knownCompetencies: [], mode: "DOCS_ONLY" })!;
    const pack = evidence(gap);
    const base = { version: 1 as const, id: `ephemeral:${competency}`, competency, procedure: ["Use the documented adapter."], sourcePackDigest: pack.packDigest };
    const invalid = [
      { ...base, procedureEvidence: [] },
      { ...base, procedureEvidence: [{ stepIndex: 0, claimIds: ["claim:missing"], sourceUris: [pack.sources[0]!.uri] }] },
      { ...base, procedureEvidence: [{ stepIndex: 0, claimIds: ["claim-1"], sourceUris: ["https://example.test/unlisted"] }] },
      { ...base, procedureEvidence: [{ stepIndex: 1, claimIds: ["claim-1"], sourceUris: [pack.sources[0]!.uri] }] }
    ];
    for (const candidate of invalid) expect(() => applySkillTrustGate(candidate, pack, gap)).toThrowError(/KNOWLEDGE_PACK_REJECTED/);
  });
});
