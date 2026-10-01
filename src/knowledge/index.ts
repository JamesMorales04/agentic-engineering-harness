import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Canonical } from "../core/digest.js";
import { AehError } from "../core/errors.js";

export type KnowledgeModeV1 = "OFFLINE" | "DOCS_ONLY" | "TRUSTED_DISCOVERY";
export const knowledgeSufficiencyStatusValues = ["VERIFIED", "GROUNDED", "PRIOR_ONLY", "PARTIAL", "MISSING", "STALE", "CONFLICTING"] as const;
export type KnowledgeSufficiencyStatusV1 = (typeof knowledgeSufficiencyStatusValues)[number];

export interface KnowledgeSourceV1 {
  uri: string;
  kind: "official" | "repository" | "public-code" | "unknown";
  version?: string;
}

export interface KnowledgeClaimV1 {
  id: string;
  statement: string;
  competency: string;
  confidence: "high" | "medium" | "low";
}

export interface KnowledgePackV1 {
  version: 1;
  cacheKey: string;
  topic: string;
  claims: KnowledgeClaimV1[];
  sources: KnowledgeSourceV1[];
  retrievedAt: string;
  packDigest: string;
}

/** Untrusted Librarian proposal. It carries no trust assertion. */
export interface SkillCandidateV1 {
  version: 1;
  id: string;
  competency: string;
  procedure: string[];
  sourcePackDigest: string;
  procedureEvidence: Array<{ stepIndex: number; claimIds: string[]; sourceUris: string[] }>;
}

export interface GroundedProcedureStepV1 {
  stepIndex: number;
  procedureDigest: string;
  claims: Array<{ claimId: string; claimDigest: string; sourceUris: string[] }>;
}

/** Created only by SkillTrustGate after validating the candidate and its pack. */
export interface AcceptedEphemeralSkillV1 extends SkillCandidateV1 {
  groundedProcedure: GroundedProcedureStepV1[];
  trustDecision: {
    version: 1;
    status: "ACCEPTED";
    mode: KnowledgeModeV1;
    packDigest: string;
    policyDigest: string;
    cacheKey: string;
    decisionDigest: string;
  };
}

export interface KnowledgeGapV1 {
  version: 1;
  cacheKey: string;
  missingCompetencies: string[];
  mode: KnowledgeModeV1;
  librarianRequired: boolean;
  reason: string;
  status: Extract<KnowledgeSufficiencyStatusV1, "MISSING" | "PARTIAL" | "STALE" | "CONFLICTING">;
}

export interface KnowledgeResolutionV1 {
  gate: "SUFFICIENT" | "GAP";
  status: KnowledgeSufficiencyStatusV1;
  gap?: KnowledgeGapV1;
  pack?: KnowledgePackV1;
  cacheHit: boolean;
  acceptedSkill?: AcceptedEphemeralSkillV1;
}

/** Raw Librarian output. The trust gate consumes this proposal after pack validation. */
export interface KnowledgeLookupResultV1 {
  pack: KnowledgePackV1;
  skillCandidate?: SkillCandidateV1;
}

export interface KnowledgeCacheEntryV1 {
  key: string;
  pack: KnowledgePackV1;
}

export interface KnowledgeCacheV1 {
  get(key: string): Promise<KnowledgePackV1 | undefined>;
  set(entry: KnowledgeCacheEntryV1): Promise<void>;
}

/** Process-local cache for bounded tests and callers that do not need persistence. */
export class InMemoryKnowledgeCacheV1 implements KnowledgeCacheV1 {
  private readonly entries = new Map<string, KnowledgePackV1>();

  async get(key: string): Promise<KnowledgePackV1 | undefined> { return this.entries.get(key); }

  async set(entry: KnowledgeCacheEntryV1): Promise<void> {
    validateCacheEntry(entry);
    this.entries.set(entry.key, entry.pack);
  }
}

/** One immutable, atomically replaced file per policy-bound cache key. */
export class FileKnowledgeCacheV1 implements KnowledgeCacheV1 {
  constructor(private readonly directory: string) {}

  async get(key: string): Promise<KnowledgePackV1 | undefined> {
    const file = this.fileFor(key);
    try {
      const pack = JSON.parse(await fs.readFile(file, "utf8")) as KnowledgePackV1;
      validateCacheEntry({ key, pack });
      return pack;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof AehError) throw error;
      throw new AehError("KNOWLEDGE_CACHE_REJECTED", `knowledge cache entry '${key}' is unreadable or malformed.`, { cause: error });
    }
  }

  async set(entry: KnowledgeCacheEntryV1): Promise<void> {
    validateCacheEntry(entry);
    await fs.mkdir(this.directory, { recursive: true });
    const file = this.fileFor(entry.key);
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(entry.pack, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private fileFor(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new AehError("KNOWLEDGE_CACHE_REJECTED", "cache key must be a SHA-256 digest.");
    return path.join(this.directory, `${key}.json`);
  }
}

const KNOWLEDGE_SOURCE_POLICY_V1: Readonly<Record<KnowledgeModeV1, readonly KnowledgeSourceV1["kind"][]>> = {
  OFFLINE: ["official", "repository"],
  DOCS_ONLY: ["official"],
  TRUSTED_DISCOVERY: ["official", "repository", "public-code"]
};

export function knowledgeSourcePolicyDigest(mode: KnowledgeModeV1): string {
  return digest({ version: 1, mode, allowedSourceKinds: KNOWLEDGE_SOURCE_POLICY_V1[mode] });
}

export function evaluateKnowledgeGate(input: { requiredCompetencies: readonly string[]; knownCompetencies: readonly string[]; stackDigest?: string; versions?: Readonly<Record<string, string>>; mode?: KnowledgeModeV1 }): KnowledgeGapV1 | undefined {
  const missingCompetencies = [...new Set(input.requiredCompetencies)].filter((competency) => !input.knownCompetencies.includes(competency)).sort();
  if (!missingCompetencies.length) return undefined;
  const mode = input.mode ?? "TRUSTED_DISCOVERY";
  // Bind both the retrieval mode and its source-policy revision so a pack accepted
  // under one mode can never satisfy a stricter mode through cache reuse.
  const cacheKey = digest({ version: 1, mode, sourcePolicyDigest: knowledgeSourcePolicyDigest(mode), competencies: missingCompetencies, stackDigest: input.stackDigest, versions: input.versions });
  return { version: 1, cacheKey, missingCompetencies, mode, librarianRequired: mode !== "OFFLINE", reason: mode === "OFFLINE" ? "required knowledge is not available in the offline cache" : "required knowledge is absent from the trusted local knowledge set", status: "MISSING" };
}

export async function resolveKnowledgeGate(input: { requiredCompetencies: readonly string[]; knownCompetencies: readonly string[]; stackDigest?: string; versions?: Readonly<Record<string, string>>; mode?: KnowledgeModeV1; cache?: KnowledgeCacheV1; lookup?: (gap: KnowledgeGapV1) => Promise<KnowledgePackV1 | KnowledgeLookupResultV1>; }): Promise<KnowledgeResolutionV1> {
  const gap = evaluateKnowledgeGate(input);
  if (!gap) return { gate: "SUFFICIENT", status: "VERIFIED", cacheHit: false };
  const cached = await input.cache?.get(gap.cacheKey);
  if (cached) {
    const pack = validateKnowledgePack(cached, gap);
    const acceptedSkill = applySkillTrustGate(candidateFromPack(pack, gap.missingCompetencies), pack, gap);
    return { gate: "SUFFICIENT", status: "GROUNDED", gap, pack, cacheHit: true, ...(acceptedSkill ? { acceptedSkill } : {}) };
  }
  if (!gap.librarianRequired || !input.lookup) return { gate: "GAP", status: "MISSING", gap, cacheHit: false };
  const lookedUp = await input.lookup(gap);
  const pack = validateKnowledgePack(isKnowledgeLookupResult(lookedUp) ? lookedUp.pack : lookedUp, gap);
  await input.cache?.set({ key: gap.cacheKey, pack });
  const suppliedCandidate = isKnowledgeLookupResult(lookedUp) ? lookedUp.skillCandidate : undefined;
  const acceptedSkill = applySkillTrustGate(suppliedCandidate ?? candidateFromPack(pack, gap.missingCompetencies), pack, gap);
  return { gate: "SUFFICIENT", status: "GROUNDED", gap, pack, cacheHit: false, ...(acceptedSkill ? { acceptedSkill } : {}) };
}

export function validateKnowledgePack(pack: KnowledgePackV1, gap: KnowledgeGapV1): KnowledgePackV1 {
  if (pack.version !== 1 || pack.cacheKey !== gap.cacheKey || !pack.claims.length || !pack.sources.length) throw new AehError("KNOWLEDGE_PACK_REJECTED", "pack is incomplete or not bound to the requested gap.");
  const allowedSources = new Set(KNOWLEDGE_SOURCE_POLICY_V1[gap.mode]);
  const rejected = pack.sources.filter((source) => !allowedSources.has(source.kind));
  if (rejected.length) throw new AehError("KNOWLEDGE_PACK_REJECTED", `${gap.mode} policy rejects source kinds: ${[...new Set(rejected.map((source) => source.kind))].join(", ")}.`, { details: { mode: gap.mode, rejectedSources: rejected } });
  if (pack.sources.some((source) => !source.uri.trim())) throw new AehError("KNOWLEDGE_PACK_REJECTED", "knowledge source URI is empty.");
  const uncovered = gap.missingCompetencies.filter((competency) => !pack.claims.some((claim) => claim.competency === competency && claim.confidence === "high"));
  if (uncovered.length) throw new AehError("KNOWLEDGE_PACK_REJECTED", `pack does not provide a trusted high-confidence claim for: ${uncovered.join(", ")}.`);
  if (pack.packDigest !== knowledgePackDigest(pack)) throw new AehError("KNOWLEDGE_PACK_REJECTED", "pack digest is invalid.");
  return pack;
}

/** Deterministic trust gate for an operation-local skill derived from accepted knowledge. */
export function applySkillTrustGate(candidate: SkillCandidateV1 | undefined, pack: KnowledgePackV1, gap: KnowledgeGapV1): AcceptedEphemeralSkillV1 | undefined {
  if (!candidate) return undefined;
  validateKnowledgePack(pack, gap);
  if (candidate.version !== 1 || !candidate.id.startsWith("ephemeral:") || !candidate.competency.trim() || !candidate.procedure.length || candidate.procedure.some((step) => !step.trim() || step.length > 1_000) || candidate.sourcePackDigest !== pack.packDigest || !gap.missingCompetencies.includes(candidate.competency) || !pack.claims.some((claim) => claim.competency === candidate.competency && claim.confidence === "high") || !validProcedureEvidence(candidate, pack, gap)) {
    throw new AehError("KNOWLEDGE_PACK_REJECTED", `skill candidate '${candidate.id}' is not bound to an accepted high-confidence claim in the knowledge pack.`);
  }
  const policyDigest = knowledgeSourcePolicyDigest(gap.mode);
  const base = { version: 1 as const, id: candidate.id, competency: candidate.competency, procedure: [...candidate.procedure], sourcePackDigest: candidate.sourcePackDigest, procedureEvidence: canonicalProcedureEvidence(candidate.procedureEvidence) };
  const groundedProcedure = base.procedureEvidence.map((evidence) => ({
    stepIndex: evidence.stepIndex,
    procedureDigest: sha256Canonical(base.procedure[evidence.stepIndex]),
    claims: evidence.claimIds.map((claimId) => {
      const claim = pack.claims.find((item) => item.id === claimId)!;
      return { claimId, claimDigest: sha256Canonical(claim), sourceUris: [...evidence.sourceUris].sort() };
    })
  }));
  const decisionWithoutDigest = { version: 1 as const, status: "ACCEPTED" as const, mode: gap.mode, packDigest: pack.packDigest, policyDigest, cacheKey: gap.cacheKey };
  const decision = { ...decisionWithoutDigest, decisionDigest: digest({ candidate: base, groundedProcedure, decision: decisionWithoutDigest }) };
  return { ...base, groundedProcedure, trustDecision: decision };
}

export function validateAcceptedEphemeralSkill(skill: AcceptedEphemeralSkillV1, pack: KnowledgePackV1, gap: KnowledgeGapV1): AcceptedEphemeralSkillV1 {
  assertSkillTrustDecision(skill);
  const accepted = applySkillTrustGate({ version: skill.version, id: skill.id, competency: skill.competency, procedure: skill.procedure, sourcePackDigest: skill.sourcePackDigest, procedureEvidence: skill.procedureEvidence }, pack, gap);
  if (!accepted || sha256Canonical(accepted) !== sha256Canonical(skill)) throw new AehError("KNOWLEDGE_PACK_REJECTED", `accepted skill '${skill.id}' does not match the deterministic trust-gate result.`);
  return accepted;
}

export function assertSkillTrustDecision(skill: AcceptedEphemeralSkillV1): void {
  const decision = skill.trustDecision;
  if (!decision || decision.version !== 1 || decision.status !== "ACCEPTED" || !Object.hasOwn(KNOWLEDGE_SOURCE_POLICY_V1, decision.mode) || decision.packDigest !== skill.sourcePackDigest || decision.policyDigest !== knowledgeSourcePolicyDigest(decision.mode) || !/^[a-f0-9]{64}$/.test(decision.cacheKey)) {
    throw new AehError("KNOWLEDGE_PACK_REJECTED", `accepted skill '${skill.id}' has an invalid trust-gate decision.`);
  }
  const candidate = { version: skill.version, id: skill.id, competency: skill.competency, procedure: skill.procedure, sourcePackDigest: skill.sourcePackDigest, procedureEvidence: skill.procedureEvidence };
  const { decisionDigest: _digest, ...decisionWithoutDigest } = decision;
  if (decision.decisionDigest !== digest({ candidate, groundedProcedure: skill.groundedProcedure, decision: decisionWithoutDigest })) throw new AehError("KNOWLEDGE_PACK_REJECTED", `accepted skill '${skill.id}' trust-gate digest is invalid.`);
  if (!Array.isArray(skill.groundedProcedure) || skill.groundedProcedure.length !== skill.procedure.length || skill.groundedProcedure.some((step, index) => step.stepIndex !== index || step.procedureDigest !== sha256Canonical(skill.procedure[index]) || !step.claims.length || step.claims.some((claim) => !/^[a-f0-9]{64}$/.test(claim.claimDigest) || !claim.sourceUris.length))) throw new AehError("KNOWLEDGE_PACK_REJECTED", `accepted skill '${skill.id}' procedure evidence is incomplete or inconsistent.`);
}

export function knowledgePack(input: Omit<KnowledgePackV1, "version" | "packDigest">): KnowledgePackV1 {
  const unsigned = { version: 1 as const, ...input };
  return { ...unsigned, packDigest: digest(unsigned) };
}

function candidateFromPack(pack: KnowledgePackV1, requiredCompetencies: readonly string[] = []): SkillCandidateV1 | undefined {
  const required = new Set(requiredCompetencies);
  const claim = pack.claims.find((item) => item.confidence === "high" && (!required.size || required.has(item.competency)));
  if (!claim) return undefined;
  return { version: 1, id: `ephemeral:${claim.competency}`, competency: claim.competency, procedure: [claim.statement], sourcePackDigest: pack.packDigest, procedureEvidence: [{ stepIndex: 0, claimIds: [claim.id], sourceUris: pack.sources.map((source) => source.uri).sort() }] };
}

function validProcedureEvidence(candidate: SkillCandidateV1, pack: KnowledgePackV1, gap: KnowledgeGapV1): boolean {
  if (!Array.isArray(candidate.procedureEvidence) || candidate.procedureEvidence.length !== candidate.procedure.length) return false;
  const allowedSources = new Set(KNOWLEDGE_SOURCE_POLICY_V1[gap.mode]);
  const packSources = new Map(pack.sources.filter((source) => allowedSources.has(source.kind)).map((source) => [source.uri, source]));
  return candidate.procedureEvidence.every((evidence, index) => {
    if (!evidence || evidence.stepIndex !== index || !Array.isArray(evidence.claimIds) || !evidence.claimIds.length || !Array.isArray(evidence.sourceUris) || !evidence.sourceUris.length) return false;
    if (new Set(evidence.claimIds).size !== evidence.claimIds.length || new Set(evidence.sourceUris).size !== evidence.sourceUris.length) return false;
    if (evidence.claimIds.some((claimId) => !pack.claims.some((claim) => claim.id === claimId && claim.competency === candidate.competency && claim.confidence === "high"))) return false;
    return evidence.sourceUris.every((uri) => packSources.has(uri));
  });
}

function canonicalProcedureEvidence(evidence: SkillCandidateV1["procedureEvidence"]): SkillCandidateV1["procedureEvidence"] {
  return evidence.map((step) => ({ stepIndex: step.stepIndex, claimIds: [...new Set(step.claimIds)].sort(), sourceUris: [...new Set(step.sourceUris)].sort() })).sort((a, b) => a.stepIndex - b.stepIndex);
}

function validateCacheEntry(entry: KnowledgeCacheEntryV1): void {
  if (entry.pack.cacheKey !== entry.key) throw new AehError("KNOWLEDGE_CACHE_REJECTED", "cache key does not match the knowledge pack.");
  if (entry.pack.packDigest !== knowledgePackDigest(entry.pack)) throw new AehError("KNOWLEDGE_CACHE_REJECTED", "knowledge cache pack digest is invalid.");
}

function isKnowledgeLookupResult(value: KnowledgePackV1 | KnowledgeLookupResultV1): value is KnowledgeLookupResultV1 {
  return Object.hasOwn(value, "pack");
}

function knowledgePackDigest(pack: KnowledgePackV1): string {
  return digest({ version: pack.version, cacheKey: pack.cacheKey, topic: pack.topic, claims: pack.claims, sources: pack.sources, retrievedAt: pack.retrievedAt });
}

function digest(value: unknown): string { return sha256Canonical(value); }
