import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { HarnessProjectConfig, ValidationFinding } from "../core/types.js";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { assertWorkspaceMatchesCandidate, type CandidateWorkspaceIdentityEvidenceV1 } from "../candidates/identity.js";

export const PROVIDER_LANE_EVIDENCE_VERSION = 1 as const;
export const PROVIDER_LANE_EVIDENCE_REQUIRED = "PROVIDER_LANE_EVIDENCE_REQUIRED" as const;
export const PROVIDER_LANE_EVIDENCE_STALE = "PROVIDER_LANE_EVIDENCE_STALE" as const;
export const PROVIDER_LANE_EVIDENCE_TAMPERED = "PROVIDER_LANE_EVIDENCE_TAMPERED" as const;
export const PROVIDER_LANE_EVIDENCE_STATUS = "PROVIDER_LANE_EVIDENCE_STATUS" as const;
export const PROVIDER_LANE_CANDIDATE_BINDING_REQUIRED = "PROVIDER_LANE_CANDIDATE_BINDING_REQUIRED" as const;
export const PROVIDER_LANE_REFERENCE_REQUIRED = "PROVIDER_LANE_REFERENCE_REQUIRED" as const;
export const VISUAL_REFERENCE_BASELINE_REQUIRED = "VISUAL_REFERENCE_BASELINE_REQUIRED" as const;
export const VISUAL_COMPARISON_CONFIG_REQUIRED = "VISUAL_COMPARISON_CONFIG_REQUIRED" as const;

export const providerEvidenceLaneValues = ["CONTRACT", "INTEGRATION", "BROWSER", "VISUAL"] as const;
export type ProviderEvidenceLaneV1 = (typeof providerEvidenceLaneValues)[number];

export function providerLaneUnavailableBlocker(lane: ProviderEvidenceLaneV1): string {
  return `${lane}_PROVIDER_UNAVAILABLE`;
}

export type ProviderLaneArtifactKindV1 = "raw" | "report" | "screenshot" | "trace" | "video" | "log" | "diff" | "baseline";

export interface ProviderLaneArtifactV1 {
  kind: ProviderLaneArtifactKindV1;
  path: string;
  digest: string;
  bytes: number;
  sanitized: boolean;
}

export interface ProviderIdentityV1 {
  name: string;
  version: string;
  runtime?: string;
  executable?: string;
}

/** Comparison configuration the provider actually ran, bound to the lane evidence. */
export interface ProviderLaneComparisonV1 {
  tool: string;
  name?: string;
  options: Record<string, unknown>;
}

export interface ProviderLaneEvidenceV1 {
  version: 1;
  lane: ProviderEvidenceLaneV1;
  checkId: string;
  candidate: { candidateId: string; revision: number; identityDigest: string };
  workspace: CandidateWorkspaceIdentityEvidenceV1;
  provider: ProviderIdentityV1;
  commandDigest: string;
  status: "PASS" | "FAIL" | "WARN";
  summary: string;
  findingCount: number;
  findings: ValidationFinding[];
  artifacts: ProviderLaneArtifactV1[];
  rawArtifact: string;
  rawArtifactDigest: string;
  startedAt: string;
  finishedAt: string;
  blockers: string[];
  comparison?: ProviderLaneComparisonV1;
  artifact: string;
  digest: string;
}

export interface PersistProviderLaneEvidenceInputV1 {
  root: string;
  config: HarnessProjectConfig;
  lane: ProviderEvidenceLaneV1;
  checkId: string;
  candidate: CandidateRevisionV1;
  provider: ProviderIdentityV1;
  command: string;
  status: "PASS" | "FAIL" | "WARN";
  summary: string;
  findings: ValidationFinding[];
  rawArtifactText: string;
  artifacts?: Array<{ kind: ProviderLaneArtifactKindV1; path: string; sanitized?: boolean }>;
  comparison?: ProviderLaneComparisonV1;
  startedAt: string;
  finishedAt: string;
  blockers?: string[];
}

const candidateBindingSchema = z.object({
  candidateId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  identityDigest: z.string().regex(/^[a-f0-9]{64}$/)
});

const workspaceSchema = z.object({
  version: z.literal(1),
  candidateId: z.string().min(1),
  candidateRevision: z.number().int().nonnegative(),
  candidateIdentityDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedSourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  observedSourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.literal("MATCH")
});

const findingSchema = z.object({
  fingerprint: z.string().min(1),
  tool: z.string(),
  kind: z.string(),
  rule: z.string().optional(),
  severity: z.string().optional(),
  file: z.string().optional(),
  line: z.number().optional(),
  endLine: z.number().optional(),
  column: z.number().optional(),
  endColumn: z.number().optional(),
  message: z.string().optional(),
  category: z.string().optional(),
  cwe: z.array(z.string()).optional(),
  package: z.string().optional(),
  installedVersion: z.string().optional(),
  fixedVersion: z.string().optional(),
  target: z.string().optional(),
  artifact: z.string().optional(),
  durationMs: z.number().optional(),
  status: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional()
});

const evidenceSchema = z.object({
  version: z.literal(PROVIDER_LANE_EVIDENCE_VERSION),
  lane: z.enum(providerEvidenceLaneValues),
  checkId: z.string().min(1),
  candidate: candidateBindingSchema,
  workspace: workspaceSchema,
  provider: z.object({ name: z.string().min(1), version: z.string().min(1), runtime: z.string().optional(), executable: z.string().optional() }),
  commandDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["PASS", "FAIL", "WARN"]),
  summary: z.string(),
  findingCount: z.number().int().nonnegative(),
  findings: z.array(findingSchema),
  artifacts: z.array(z.object({ kind: z.enum(["raw", "report", "screenshot", "trace", "video", "log", "diff", "baseline"]), path: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(), sanitized: z.boolean() })),
  rawArtifact: z.string().min(1),
  rawArtifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  blockers: z.array(z.string()),
  comparison: z.object({ tool: z.string().min(1), name: z.string().optional(), options: z.record(z.string(), z.unknown()) }).optional(),
  artifact: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/)
});

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function laneDirectoryName(lane: ProviderEvidenceLaneV1): string {
  return lane.toLowerCase();
}

export function providerLaneEvidenceDirectory(root: string, config: HarnessProjectConfig, lane: ProviderEvidenceLaneV1, candidate: Pick<CandidateRevisionV1, "candidateId" | "revision" | "identityDigest">): string {
  const outputDir = config.evidence?.outputDir ?? ".harness/evidence";
  return path.resolve(root, outputDir, laneDirectoryName(lane), sanitizeSegment(`${candidate.candidateId}-r${candidate.revision}-${candidate.identityDigest.slice(0, 12)}`));
}

export function providerLaneEvidenceArtifactPath(root: string, config: HarnessProjectConfig, lane: ProviderEvidenceLaneV1, candidate: Pick<CandidateRevisionV1, "candidateId" | "revision" | "identityDigest">, checkId: string): string {
  return path.join(providerLaneEvidenceDirectory(root, config, lane, candidate), `${sanitizeSegment(checkId)}.json`);
}

async function digestArtifact(root: string, relativeOrAbsolute: string, kind: ProviderLaneArtifactKindV1, sanitized: boolean): Promise<ProviderLaneArtifactV1> {
  const absolute = path.resolve(root, relativeOrAbsolute);
  const bytes = await fs.readFile(absolute);
  return { kind, path: path.relative(root, absolute).replaceAll("\\", "/"), digest: sha256Utf8(bytes), bytes: bytes.byteLength, sanitized };
}

export async function persistProviderLaneEvidenceV1(input: PersistProviderLaneEvidenceInputV1): Promise<ProviderLaneEvidenceV1> {
  const directory = providerLaneEvidenceDirectory(input.root, input.config, input.lane, input.candidate);
  let workspace: CandidateWorkspaceIdentityEvidenceV1;
  try {
    workspace = await assertWorkspaceMatchesCandidate(input.root, input.candidate);
  } catch (error) {
    throw new Error(`${PROVIDER_LANE_EVIDENCE_STALE}: ${input.lane} workspace does not match candidate ${input.candidate.candidateId} r${input.candidate.revision}: ${String(error)}`);
  }
  const safeCheckId = sanitizeSegment(input.checkId);
  const rawPath = path.join(directory, `${safeCheckId}.raw`);
  const artifactPath = path.join(directory, `${safeCheckId}.json`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(rawPath, input.rawArtifactText, "utf8");
  const artifacts: ProviderLaneArtifactV1[] = [{ kind: "raw", path: path.relative(input.root, rawPath).replaceAll("\\", "/"), digest: sha256Utf8(input.rawArtifactText), bytes: Buffer.byteLength(input.rawArtifactText, "utf8"), sanitized: true }];
  for (const artifact of input.artifacts ?? []) {
    try {
      artifacts.push(await digestArtifact(input.root, artifact.path, artifact.kind, artifact.sanitized ?? true));
    } catch (error) {
      throw new Error(`${PROVIDER_LANE_EVIDENCE_TAMPERED}: ${input.lane} artifact '${artifact.path}' could not be read: ${String(error)}`);
    }
  }
  const payload = {
    version: PROVIDER_LANE_EVIDENCE_VERSION,
    lane: input.lane,
    checkId: input.checkId,
    candidate: { candidateId: input.candidate.candidateId, revision: input.candidate.revision, identityDigest: input.candidate.identityDigest },
    workspace,
    provider: input.provider,
    commandDigest: sha256Utf8(input.command),
    status: input.status,
    summary: input.summary,
    findingCount: input.findings.length,
    findings: input.findings,
    artifacts,
    rawArtifact: path.relative(input.root, rawPath).replaceAll("\\", "/"),
    rawArtifactDigest: sha256Utf8(input.rawArtifactText),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    blockers: [...(input.blockers ?? [])],
    ...(input.comparison ? { comparison: input.comparison } : {}),
    artifact: path.relative(input.root, artifactPath).replaceAll("\\", "/")
  };
  const evidence = { ...payload, digest: sha256Canonical(payload) } as ProviderLaneEvidenceV1;
  await fs.writeFile(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidence;
}

export async function loadProviderLaneEvidenceV1(root: string, config: HarnessProjectConfig, lane: ProviderEvidenceLaneV1, candidate: Pick<CandidateRevisionV1, "candidateId" | "revision" | "identityDigest">, checkId: string): Promise<ProviderLaneEvidenceV1 | undefined> {
  const artifactPath = providerLaneEvidenceArtifactPath(root, config, lane, candidate, checkId);
  let text: string;
  try {
    text = await fs.readFile(artifactPath, "utf8");
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${PROVIDER_LANE_EVIDENCE_TAMPERED}: ${path.relative(root, artifactPath)} is not readable JSON.`);
  }
  const parsed = evidenceSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${PROVIDER_LANE_EVIDENCE_TAMPERED}: ${path.relative(root, artifactPath)} is not a valid ProviderLaneEvidence v1 document.`);
  return parsed.data as ProviderLaneEvidenceV1;
}

export interface ProviderLaneEvidenceVerificationV1 {
  ok: boolean;
  blockers: string[];
  evidence?: ProviderLaneEvidenceV1;
}

export async function verifyProviderLaneEvidenceV1(root: string, config: HarnessProjectConfig, evidence: ProviderLaneEvidenceV1, expected: CandidateRevisionV1): Promise<ProviderLaneEvidenceVerificationV1> {
  const blockers: string[] = [];
  const { digest, ...payload } = evidence as ProviderLaneEvidenceV1 & Record<string, unknown>;
  if (sha256Canonical(payload) !== digest) blockers.push(`${PROVIDER_LANE_EVIDENCE_TAMPERED}: evidence digest does not match its content.`);
  if (evidence.candidate.candidateId !== expected.candidateId || evidence.candidate.revision !== expected.revision || evidence.candidate.identityDigest !== expected.identityDigest) {
    blockers.push(`${PROVIDER_LANE_EVIDENCE_STALE}: ${evidence.lane} evidence is bound to ${evidence.candidate.candidateId} r${evidence.candidate.revision} (${evidence.candidate.identityDigest.slice(0, 12)}) but the current candidate is ${expected.candidateId} r${expected.revision} (${expected.identityDigest.slice(0, 12)}).`);
  }
  // Fail-closed (Mechanism=DETERMINISTIC): lane evidence records the outcome
  // of the provider check that produced it. Non-PASS evidence must never
  // satisfy a PASS claim — a FAIL bundle's evidence cannot corroborate a
  // forged or mistaken PASS attribution. Workspace binding above is untouched.
  if (evidence.status !== "PASS") {
    blockers.push(`${PROVIDER_LANE_EVIDENCE_STATUS}: ${evidence.lane} evidence for '${evidence.checkId}' records status '${evidence.status}'; only PASS evidence can satisfy a PASS claim.`);
  }
  const artifactPath = path.resolve(root, evidence.artifact);
  if (artifactPath !== path.join(providerLaneEvidenceDirectory(root, config, evidence.lane, expected), `${sanitizeSegment(evidence.checkId)}.json`)) blockers.push(`${PROVIDER_LANE_EVIDENCE_TAMPERED}: evidence artifact path '${evidence.artifact}' is not the candidate-scoped path for '${evidence.checkId}'.`);
  for (const artifact of evidence.artifacts) {
    try {
      const bytes = await fs.readFile(path.resolve(root, artifact.path));
      if (sha256Utf8(bytes) !== artifact.digest) blockers.push(`${PROVIDER_LANE_EVIDENCE_TAMPERED}: ${artifact.kind} artifact '${artifact.path}' digest does not match the recorded digest.`);
      if (bytes.byteLength !== artifact.bytes) blockers.push(`${PROVIDER_LANE_EVIDENCE_TAMPERED}: ${artifact.kind} artifact '${artifact.path}' byte length does not match the recorded length.`);
    } catch {
      blockers.push(`${PROVIDER_LANE_EVIDENCE_TAMPERED}: ${artifact.kind} artifact '${artifact.path}' is missing.`);
    }
  }
  if (evidence.lane === "VISUAL") {
    if (!evidence.artifacts.some((artifact) => artifact.kind === "baseline")) blockers.push(`${PROVIDER_LANE_REFERENCE_REQUIRED}: VISUAL evidence must bind the committed reference baseline artifact used for the comparison.`);
    if (!evidence.comparison?.tool?.trim()) blockers.push(`${PROVIDER_LANE_REFERENCE_REQUIRED}: VISUAL evidence must bind the comparison configuration that produced the verdict.`);
  }
  return blockers.length ? { ok: false, blockers: [...new Set(blockers)].sort() } : { ok: true, blockers: [], evidence };
}

export async function requireProviderLaneEvidenceV1(root: string, config: HarnessProjectConfig, lane: ProviderEvidenceLaneV1, candidate: CandidateRevisionV1, checkId: string): Promise<ProviderLaneEvidenceV1> {
  const evidence = await loadProviderLaneEvidenceV1(root, config, lane, candidate, checkId);
  if (!evidence) throw new Error(`${PROVIDER_LANE_EVIDENCE_REQUIRED}: required candidate-bound ${lane} evidence '${checkId}' is absent for ${candidate.candidateId} r${candidate.revision}.`);
  const verification = await verifyProviderLaneEvidenceV1(root, config, evidence, candidate);
  if (!verification.ok) throw new Error(verification.blockers.join("; "));
  return evidence;
}

export interface RequireProviderLaneEvidenceForActionInputV1 {
  root: string;
  config: HarnessProjectConfig;
  lane: ProviderEvidenceLaneV1;
  candidate: CandidateRevisionV1;
  checkId: string;
  kind: string;
  actionSource: string;
  actionSelector: string;
}

/**
 * Fails closed unless the check that PASSed a specialized lane requirement was
 * executed by the matching provider/adapter and persisted candidate-bound lane
 * evidence. A project script, configured command, or raw provider command that
 * merely exited zero cannot satisfy a CONTRACT/INTEGRATION/BROWSER/VISUAL
 * requirement; only provider execution persists this evidence.
 */
export async function requireProviderLaneEvidenceForActionV1(input: RequireProviderLaneEvidenceForActionInputV1): Promise<ProviderLaneEvidenceV1> {
  const evidence = await loadProviderLaneEvidenceV1(input.root, input.config, input.lane, input.candidate, input.checkId);
  if (!evidence) {
    throw new Error(`${PROVIDER_LANE_EVIDENCE_REQUIRED}: required ${input.lane} evidence for '${input.checkId}' is absent; requirement kind '${input.kind}' must be satisfied by the matching ${input.lane} provider/adapter execution, but action '${input.actionSource}:${input.actionSelector}' did not produce candidate-bound provider evidence.`);
  }
  const verification = await verifyProviderLaneEvidenceV1(input.root, input.config, evidence, input.candidate);
  if (!verification.ok) throw new Error(verification.blockers.join("; "));
  return evidence;
}
