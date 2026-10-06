import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import { z } from "zod";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { computeWorktreeDigest, providerGeneratedPathspecExcludes } from "../core/git.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { assertWorkspaceMatchesCandidate } from "./identity.js";
import { runExecutable } from "../utils/process.js";
import { changeKindSchema, changeKindValues, type ChangeKind } from "../architecture/workGraph.js";
import { createSemanticEvidenceReceiptV1, semanticAssessmentEvidenceDigest, semanticEvidenceBoundaryDigest, semanticModelDeadlineMsV1, type SemanticAssessmentBindingV1, type SemanticAssessmentServiceV1, type SemanticAssessmentV1 } from "../semantic/assessment.js";
import { REPAIR_AMENDABLE_MANIFEST_PATHS } from "./repairScope.js";

export interface ChangeSetV1 {
  version: 1;
  operationId: string;
  taskId: string;
  workUnitId: string;
  participantId: string;
  /**
   * The candidate revision the worker actually observed when it produced this
   * patch. It is never rewritten because candidate state advanced later; a
   * rebase produces an explicit derived ChangeSet instead.
   */
  baseCandidateRevision: number;
  /** Identity digest of the candidate the worker actually observed. */
  baseCandidateDigest: string;
  changedFiles: string[];
  patch: string;
  patchDigest: string;
  /** Present only when this ChangeSet is an explicit derived rebase of another ChangeSet. */
  derivation?: ChangeSetDerivationV1;
}

export interface ChangeSetDerivationV1 {
  kind: "WAVE_REBASE";
  originalChangeSetDigest: string;
  originalBaseCandidateRevision: number;
  originalBaseCandidateDigest: string;
  derivedAt: string;
}

export function changeSetDigest(changeSet: ChangeSetV1): string {
  return sha256Canonical(changeSet);
}

export interface CandidateImpactV1 {
  version: 1;
  /** The exact CandidateRevision that was assessed after successful assembly. */
  candidate: { candidateId: string; revision: number; identityDigest: string };
  /** Deterministic lineage and patch facts from the assembly that created candidate. */
  baseCandidate: { candidateId: string; revision: number; identityDigest: string };
  patchDigest: string;
  changedFiles: string[];
  changeKinds: string[];
  reviewDimensions: string[];
  requiresIndependentReview: boolean;
  interpretation: "MODEL" | "BLOCKED";
  unknowns?: string[];
  semanticAssessmentDigest?: string;
  digest: string;
}

interface CandidateImpactProjectionV1 {
  version: 1;
  mechanism: "MODEL";
  changedFiles: string[];
  evidenceRefs: string[];
  changeKinds: ChangeKind[];
  reviewDimensions: string[];
  requiresIndependentReview: boolean;
  unknowns: string[];
  semanticAssessmentDigest?: string;
  assessmentDigest: string;
}

const candidateImpactProjectionSchema = z.object({
  version: z.literal(1),
  mechanism: z.literal("MODEL"),
  changedFiles: z.array(z.string().trim().min(1)).max(256),
  evidenceRefs: z.array(z.string().trim().min(1)).min(1).max(512),
  changeKinds: z.array(changeKindSchema).max(changeKindValues.length),
  reviewDimensions: z.array(z.string().trim().min(1).max(200)).max(128),
  requiresIndependentReview: z.boolean(),
  unknowns: z.array(z.string().trim().min(1).max(1_000)).max(64),
  semanticAssessmentDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  assessmentDigest: z.string().trim().length(64)
}).strict();

export interface CandidateImpactAssessmentRuntimeV1 {
  service: SemanticAssessmentServiceV1;
  policyRevision: string;
  repositoryBinding: Omit<SemanticAssessmentBindingV1, "candidateId" | "candidateRevision" | "candidateDigest">;
  /**
   * Best-effort forensic hook for a rejected CANDIDATE_IMPACT judgment
   * (declared-vs-observed file diff). The production wiring persists the same
   * `semantic.assessor.reply.rejected` trace shape family used for unparseable
   * replies, extended with the bounded file-diff lists. Never authority;
   * failures are swallowed so the fail-closed rejection still throws.
   */
  onRejectedJudgment?: (record: CandidateImpactRejectedJudgmentV1) => Promise<void> | void;
  /**
   * Best-effort forensic hook for a launch-level SEMANTIC_ASSESSMENT_UNAVAILABLE
   * observed inside `assessCandidateImpact` (exit/status/stderr-tail, no session
   * when the launch never materialized). The production wiring persists
   * `candidate.impact.assessor.unavailable` via recordPaseoTrace in the same
   * shape family as the rejected-judgment trace. Never authority; failures are
   * swallowed so the fail-closed rejection still throws.
   */
  onAssessorUnavailable?: (record: CandidateImpactAssessorUnavailableV1) => Promise<void> | void;
}

/** Bounded forensic record for a rejected candidate-impact judgment. */
export interface CandidateImpactRejectedJudgmentV1 {
  assessmentType: "CANDIDATE_IMPACT";
  candidateId?: string;
  candidateRevision?: number;
  candidateDigest?: string;
  declared: string[];
  declaredCount: number;
  observed: string[];
  observedCount: number;
  missing: string[];
  missingCount: number;
  extra: string[];
  extraCount: number;
  assessmentDigest: string;
  sessionId?: string;
  transport?: string;
}

/** Bounded forensic record for a launch-level assessor UNAVAILABLE observed during impact assessment. */
export interface CandidateImpactAssessorUnavailableV1 {
  assessmentType: "CANDIDATE_IMPACT";
  candidateId?: string;
  candidateRevision?: number;
  candidateDigest?: string;
  exitCode?: number;
  status?: string;
  transport?: string;
  sessionId?: string;
  /** Bounded launch-transport stderr tail (last 500 chars, refs-only, no secret expansion). */
  stderrTail?: string;
  /** Mismatch-attempt number during which the UNAVAILABLE was observed (1-based). */
  attempt?: number;
  willRetry?: boolean;
}

/**
 * Bound for the file-diff lists attached to impact-mismatch rejections.
 * Paths are already bounded (1-500 chars); ten capped entries keep the
 * message and trace bounded while preserving exact strings for forensics.
 * Mirrors MAX_OFFENDING_EVIDENCE_REFS_V1 (PR88) with total counts preserved.
 */
export const MAX_CANDIDATE_IMPACT_FILE_DIFF_V1 = 10;

/** Bound for the launch-transport stderr tail persisted in the unavailable trace. */
export const MAX_CANDIDATE_IMPACT_STDERR_TAIL_V1 = 500;

/**
 * Independent bound for transient launch-level non-timeout UNAVAILABLE retries
 * inside `assessCandidateImpact`: at most 1 extra fresh turn. Timeout-class
 * UNAVAILABLE never retries here (behavior unchanged).
 */
export const MAX_CANDIDATE_IMPACT_UNAVAILABLE_RETRIES = 1;

/** Bounded backoff ceiling for the unavailable retry (small backoff+jitter, ≤5s). */
export const MAX_CANDIDATE_IMPACT_UNAVAILABLE_BACKOFF_MS_V1 = 5_000;

/**
 * Deterministic declared-vs-observed file diff: dedupe, locale-sort, cap at
 * MAX_CANDIDATE_IMPACT_FILE_DIFF_V1 with total unique counts preserved.
 * Exact-match semantics are unchanged; this only bounds diagnostics.
 */
export function candidateImpactFileDiffV1(declared: readonly string[], observed: readonly string[]): {
  declared: string[];
  declaredCount: number;
  observed: string[];
  observedCount: number;
  missing: string[];
  missingCount: number;
  extra: string[];
  extraCount: number;
} {
  const declaredUnique = [...new Set(declared.map(normalizePath))].sort((left, right) => left.localeCompare(right));
  const observedUnique = [...new Set(observed.map(normalizePath))].sort((left, right) => left.localeCompare(right));
  const observedSet = new Set(observedUnique);
  const declaredSet = new Set(declaredUnique);
  const missingUnique = declaredUnique.filter((file) => !observedSet.has(file));
  const extraUnique = observedUnique.filter((file) => !declaredSet.has(file));
  return {
    declared: declaredUnique.slice(0, MAX_CANDIDATE_IMPACT_FILE_DIFF_V1),
    declaredCount: declaredUnique.length,
    observed: observedUnique.slice(0, MAX_CANDIDATE_IMPACT_FILE_DIFF_V1),
    observedCount: observedUnique.length,
    missing: missingUnique.slice(0, MAX_CANDIDATE_IMPACT_FILE_DIFF_V1),
    missingCount: missingUnique.length,
    extra: extraUnique.slice(0, MAX_CANDIDATE_IMPACT_FILE_DIFF_V1),
    extraCount: extraUnique.length
  };
}

/**
 * Bound for the scope-escape file lists attached to PARTICIPANT_PLAN_INVALID
 * escape rejections. Ten capped entries keep the message and trace bounded
 * while preserving exact strings for forensics. Mirrors
 * MAX_CANDIDATE_IMPACT_FILE_DIFF_V1 (PR88) with total counts preserved.
 */
export const MAX_ASSEMBLER_SCOPE_ESCAPE_FILES_V1 = 10;

/** Bounded forensic record for a ChangeSet scope escape (observability only). */
export interface CandidateScopeEscapeV1 {
  operationId: string;
  taskId: string;
  escapedFiles: string[];
  escapedCount: number;
  amendableManifests: string[];
  amendableCount: number;
  hardProtected: string[];
  hardProtectedCount: number;
}

/**
 * Deterministic scope-escape split: dedupe, locale-sort, cap at
 * MAX_ASSEMBLER_SCOPE_ESCAPE_FILES_V1 with total unique counts preserved.
 * The amendable subset reuses REPAIR_AMENDABLE_MANIFEST_PATHS from
 * repairScope.ts (dependency manifests that a ledger-approved amendment may
 * exempt); everything else is hard-protected for observability (frozen
 * TaskContract, seal, validators, acceptance/spec, policy). Exact-match
 * fail-closed semantics are unchanged; this only bounds diagnostics.
 */
export function assemblerScopeEscapeDiffV1(escaped: readonly string[]): {
  escapedFiles: string[];
  escapedCount: number;
  amendableManifests: string[];
  amendableCount: number;
  hardProtected: string[];
  hardProtectedCount: number;
} {
  const unique = [...new Set(escaped.map(normalizePath))].sort((left, right) => left.localeCompare(right));
  const amendablePatterns: string[] = [];
  for (const raw of REPAIR_AMENDABLE_MANIFEST_PATHS) {
    const value = raw.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!value) continue;
    amendablePatterns.push(value, `${value}/**`);
  }
  const amendableUnique = unique.filter((file) => matchesAny(file, amendablePatterns));
  const hardUnique = unique.filter((file) => !matchesAny(file, amendablePatterns));
  return {
    escapedFiles: unique.slice(0, MAX_ASSEMBLER_SCOPE_ESCAPE_FILES_V1),
    escapedCount: unique.length,
    amendableManifests: amendableUnique.slice(0, MAX_ASSEMBLER_SCOPE_ESCAPE_FILES_V1),
    amendableCount: amendableUnique.length,
    hardProtected: hardUnique.slice(0, MAX_ASSEMBLER_SCOPE_ESCAPE_FILES_V1),
    hardProtectedCount: hardUnique.length
  };
}

export interface CandidateAssemblyInputV1 {
  root: string;
  operationId: string;
  projectId?: string;
  taskId: string;
  currentCandidate: CandidateRevisionV1;
  changeSet: ChangeSetV1;
  allowedScope: readonly string[];
  forbiddenScope?: readonly string[];
  candidateId: string;
  semanticAssessment?: CandidateImpactAssessmentRuntimeV1;
  workspace?: string;
  worktree?: string;
  /**
   * Best-effort forensic hook for a scope-escape rejection
   * (out-of-scope or forbidden ChangeSet paths). The production wiring
   * persists the same `candidate.scope.escape.rejected` trace shape family
   * used for `candidate.impact.judgment.rejected`, extended with the bounded
   * hard/amendable split. Never authority; failures are swallowed so the
   * fail-closed rejection still throws.
   */
  onScopeEscape?: (record: CandidateScopeEscapeV1) => Promise<void> | void;
}

/**
 * Single owner of the impact-assessment retry bound: at most 2 service turns
 * (1 initial + 1 retry on changedFiles mismatch only), each with
 * `attemptBudget: 1` so the service's own retry cannot compose (no envelope
 * bypass; counts against normal provider-turn accounting).
 */
const MAX_CANDIDATE_IMPACT_ASSESSMENT_ATTEMPTS = 2;

export interface CandidateAssemblyResultV1 {
  version: 1;
  changeSet: ChangeSetV1;
  candidate: CandidateRevisionV1;
  impact: CandidateImpactV1;
}

export async function assembleCandidateChangeSet(input: CandidateAssemblyInputV1): Promise<CandidateAssemblyResultV1> {
  const changeSet = input.changeSet;
  if (changeSet.version !== 1 || changeSet.operationId !== input.operationId || changeSet.taskId !== input.taskId) {
    throw new AehError("CANDIDATE_STALE", "ChangeSet identity does not match the assembly request.");
  }
  if (changeSet.baseCandidateRevision !== input.currentCandidate.revision) {
    throw new AehError("CANDIDATE_STALE", `ChangeSet is based on revision ${changeSet.baseCandidateRevision}, current candidate is revision ${input.currentCandidate.revision}.`);
  }
  if (changeSet.baseCandidateDigest !== input.currentCandidate.identityDigest) {
    throw new AehError("CANDIDATE_STALE", "ChangeSet base candidate digest does not match the candidate it is being assembled against.");
  }
  if (input.currentCandidate.operationId !== input.operationId) throw new AehError("CANDIDATE_STALE", "Current candidate belongs to another operation.");
  await assertWorkspaceMatchesCandidate(input.root, input.currentCandidate);
  if (sha256Utf8(changeSet.patch) !== changeSet.patchDigest) throw new AehError("CANDIDATE_STALE", "ChangeSet patch digest does not match its content.");
  const changedFiles = [...new Set(changeSet.changedFiles.map(normalizePath))].sort();
  const patchFiles = await pathsTouchedByPatch(input.root, changeSet.patch);
  if (JSON.stringify(changedFiles) !== JSON.stringify(patchFiles)) {
    throw new AehError("CANDIDATE_STALE", "ChangeSet changedFiles do not exactly match the paths touched by its patch.", { details: { declared: changedFiles, observed: patchFiles } });
  }
  // C-NEW-4 (fail-closed): a mode-120000 patch entry whose *string* path is
  // in-scope (e.g. `src/link`) can still point its link target outside the
  // candidate root (`../../outside`, `/etc/passwd`). The scope gate below only
  // matches path strings, so the patch-introduced link target must be gated
  // here, before any `git apply` touches the worktree. This is the single
  // assembly choke point: repair, wave and direct-assemble all funnel through
  // this function. Residual (not covered here): patch-scope is not a sandbox;
  // worker off-patch filesystem writes are only observed through the captured
  // diff, never scope-checked live.
  await assertPatchSymlinksContained(input.root, changeSet.patch);
  const outOfScope = changedFiles.filter((file) => !matchesAny(file, input.allowedScope));
  const forbidden = changedFiles.filter((file) => matchesAny(file, input.forbiddenScope ?? []));
  if (outOfScope.length || forbidden.length) {
    // Observability-only enrichment (fail-closed preserved): attach the
    // bounded hard/amendable split to the error details and emit a
    // best-effort forensic trace. Still throws terminal; no blocker routing
    // for silent expansion (preserves declare-first incentives).
    // PR88 convention: message prefix stays stable, details appended.
    const escapeDiff = assemblerScopeEscapeDiffV1([...outOfScope, ...forbidden]);
    const base = `ChangeSet escaped its assigned scope: ${escapeDiff.escapedFiles.join(", ")} (escapedCount=${escapeDiff.escapedCount}).`;
    const suffix = ` escaped=${JSON.stringify(escapeDiff.escapedFiles)} escapedCount=${escapeDiff.escapedCount} amendableManifests=${JSON.stringify(escapeDiff.amendableManifests)} amendableCount=${escapeDiff.amendableCount} hardProtected=${JSON.stringify(escapeDiff.hardProtected)} hardProtectedCount=${escapeDiff.hardProtectedCount}`;
    const error = new AehError("PARTICIPANT_PLAN_INVALID", `${base}${suffix}`, {
      details: {
        ...escapeDiff,
        operationId: input.operationId,
        taskId: input.taskId
      }
    });
    await emitCandidateScopeEscape(input, {
      operationId: input.operationId,
      taskId: input.taskId,
      ...escapeDiff
    });
    throw error;
  }
  if (!changeSet.patch.trim()) throw new AehError("PARTICIPANT_PLAN_INVALID", "ChangeSet patch is empty.");

  await assertWorkspaceMatchesCandidate(input.root, input.currentCandidate);
  const check = await runExecutable("git", ["apply", "--check", "--binary", "-"], { cwd: input.root, timeoutMs: 60_000, stdin: changeSet.patch });
  if (check.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `ChangeSet cannot apply to the current candidate: ${check.stderr || check.stdout}`);
  const apply = await runExecutable("git", ["apply", "--binary", "-"], { cwd: input.root, timeoutMs: 60_000, stdin: changeSet.patch });
  if (apply.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `ChangeSet application failed: ${apply.stderr || apply.stdout}`);
  try {
    const sourceDigest = await computeWorktreeDigest(input.root);
    const candidate = createCandidateRevisionV1({
      operationId: input.operationId,
      candidateId: input.candidateId,
      projectId: input.projectId,
      taskId: input.taskId,
      revision: input.currentCandidate.revision + 1,
      parentCandidateId: input.currentCandidate.candidateId,
      sourceDigest,
      workspace: input.workspace,
      worktree: input.worktree ?? input.root,
      createdAt: new Date().toISOString()
    });
    const semanticImpact = input.semanticAssessment ? await assessCandidateImpact(input.root, changeSet, changedFiles, candidate, input.semanticAssessment) : undefined;
    const impact = projectCandidateImpact(changedFiles, semanticImpact, {
      candidate: { candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest },
      baseCandidate: { candidateId: input.currentCandidate.candidateId, revision: input.currentCandidate.revision, identityDigest: input.currentCandidate.identityDigest },
      patchDigest: changeSet.patchDigest
    });
    return { version: 1, changeSet: { ...changeSet, changedFiles }, candidate, impact };
  } catch (error) {
    const reverse = await runExecutable("git", ["apply", "--reverse", "--binary", "-"], { cwd: input.root, timeoutMs: 60_000, stdin: changeSet.patch });
    if (reverse.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `candidate assembly failed and the unbound ChangeSet could not be reverted: ${reverse.stderr || reverse.stdout}`, { cause: error });
    await assertWorkspaceMatchesCandidate(input.root, input.currentCandidate).catch((rollbackError) => {
      throw new AehError("CANDIDATE_STALE", "candidate assembly failed and the reverted workspace no longer matches its base CandidateRevision.", { cause: rollbackError });
    });
    throw error;
  }
}

async function assessCandidateImpact(root: string, changeSet: ChangeSetV1, changedFiles: readonly string[], candidate: CandidateRevisionV1, runtime: CandidateImpactAssessmentRuntimeV1): Promise<CandidateImpactProjectionV1> {
  if (!changedFiles.length || changedFiles.length > 15) throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact assessment requires 1-15 changed files with individually receipted evidence.");
  if (runtime.policyRevision.trim() === "") throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact assessment requires a semantic capability policy revision.");
  const repositoryBinding = runtime.repositoryBinding;
  const binding: SemanticAssessmentBindingV1 = {
    ...repositoryBinding,
    candidateId: candidate.candidateId,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest
  };
  const boundaryDigest = semanticEvidenceBoundaryDigest(binding);
  const resolvedRoot = await fs.realpath(path.resolve(root));
  const compactEvidence: Array<{ ref: string; content: string }> = [];
  const evidenceReceipts = [] as ReturnType<typeof createSemanticEvidenceReceiptV1>[];
  const unknowns: string[] = [];
  const patchEvidence = changeSet.patch.slice(0, 4_000);
  if (Buffer.byteLength(changeSet.patch, "utf8") > Buffer.byteLength(patchEvidence, "utf8")) unknowns.push("ChangeSet patch evidence was truncated at the controller byte bound.");
  compactEvidence.push({ ref: "candidate:patch", content: patchEvidence });
  evidenceReceipts.push(createSemanticEvidenceReceiptV1({ binding, ref: "candidate:patch", content: patchEvidence, kind: "OPERATION_ARTIFACT" }));
  const perFileEvidenceLimit = Math.min(4_000, Math.floor(20_000 / changedFiles.length));
  for (const file of changedFiles) {
    if (!isSafeRepositoryPath(file)) throw new AehError("CANDIDATE_IMPACT_INVALID", `candidate changed path '${file}' is not a safe repository-relative path.`);
    const read = await readCandidateFile(resolvedRoot, file, perFileEvidenceLimit);
    if (read?.truncated) unknowns.push(`Candidate file '${file}' exceeded its evidence byte bound.`);
    const ref = `file:${file}`;
    const content = read?.content ?? `The candidate file '${file}' is absent after assembly; inspect the receipted ChangeSet patch for its removal.`;
    compactEvidence.push({ ref, content });
    evidenceReceipts.push(createSemanticEvidenceReceiptV1({
      binding,
      ref,
      content,
      kind: read ? "CANDIDATE_FILE" : "OBSERVED_FACT",
      ...(read ? { path: file } : {})
    }));
  }
  if (compactEvidence.reduce((total, item) => total + Buffer.byteLength(item.content, "utf8"), 0) > 24_000) throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact evidence exceeds the controller byte bound.");
  const request = {
    version: 1 as const,
    assessmentType: "CANDIDATE_IMPACT" as const,
    evidenceRefs: compactEvidence.map((item) => item.ref),
    compactEvidence,
    evidenceReceipts,
    requiredOutputSchema: "semantic-assessment-v1" as const,
    reasoningRequirement: { reasoningClass: "STANDARD" as const, structuredOutputRequired: true, independenceRequired: false, externalKnowledgeRequired: false, maxContextClass: "LARGE" as const, riskClass: "HIGH" as const },
    binding,
    budget: { maxInputTokens: 8_000, maxOutputTokens: 2_000, deadlineMs: semanticModelDeadlineMsV1 },
    policyRevision: runtime.policyRevision
  };
  let lastMismatch: AehError | undefined;
  let unavailableRetries = 0;
  let attempt = 1;
  while (attempt <= MAX_CANDIDATE_IMPACT_ASSESSMENT_ATTEMPTS) {
    // IDENTICAL inputs: same request object, no repair hint, no correction
    // evidence, no list re-assertion. Re-asserting the exact list would lead
    // the semantic judgment and compromise independence. The service
    // normalizes internally without mutating this object. Any retry (mismatch
    // or unavailable) skips the cache read (bypassCache) so the identical
    // cache identity cannot return the same cached wrong judgment as a HIT;
    // the fresh result is still stored under that identity with normal
    // provider-turn accounting (no envelope bypass).
    const bypassCache = attempt > 1 || unavailableRetries > 0;
    let assessment: SemanticAssessmentV1;
    try {
      assessment = await runtime.service.assess(request, bypassCache ? { attemptBudget: 1, bypassCache: true } : { attemptBudget: 1 });
    } catch (error) {
      if (error instanceof AehError && error.code === "SEMANTIC_ASSESSMENT_UNAVAILABLE") {
        const details = (error.details ?? {}) as { timeout?: unknown; exitCode?: unknown; status?: unknown; transport?: unknown; sessionId?: unknown; stderrTail?: unknown };
        const isTimeout = details.timeout === true;
        const canRetry = !isTimeout && unavailableRetries < MAX_CANDIDATE_IMPACT_UNAVAILABLE_RETRIES;
        await emitCandidateImpactAssessorUnavailable(runtime, {
          assessmentType: "CANDIDATE_IMPACT",
          ...(candidate.candidateId ? { candidateId: candidate.candidateId } : {}),
          ...(candidate.revision !== undefined ? { candidateRevision: candidate.revision } : {}),
          ...(candidate.identityDigest ? { candidateDigest: candidate.identityDigest } : {}),
          ...(typeof details.exitCode === "number" ? { exitCode: details.exitCode } : {}),
          ...(typeof details.status === "string" ? { status: details.status } : {}),
          ...(typeof details.transport === "string" ? { transport: details.transport } : {}),
          ...(typeof details.sessionId === "string" ? { sessionId: details.sessionId } : {}),
          ...(typeof details.stderrTail === "string" && details.stderrTail ? { stderrTail: details.stderrTail.slice(-MAX_CANDIDATE_IMPACT_STDERR_TAIL_V1) } : {}),
          attempt,
          willRetry: canRetry,
        });
        if (canRetry) {
          unavailableRetries += 1;
          await backoffCandidateImpactUnavailableRetry();
          // Retry the same mismatch attempt with a fresh turn (bypassCache now true).
          continue;
        }
        // Timeout-class behavior unchanged (no retry); second non-timeout
        // failure rethrows with the runner-threaded diagnostics preserved.
        throw error;
      }
      throw error;
    }
    if (assessment.assessmentType !== "CANDIDATE_IMPACT" || assessment.mechanism !== "MODEL" || assessment.judgment.type !== "CANDIDATE_IMPACT") throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact requires a canonical MODEL CANDIDATE_IMPACT judgment.");
    if (assessment.policyRevision !== runtime.policyRevision || sha256Canonical(assessment.binding) !== sha256Canonical(binding)) throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact assessment policy or candidate binding is stale.");
    const expectedRefs = [...request.evidenceRefs].sort();
    const actualRefs = [...assessment.evidenceRefs].sort();
    const expectedReceipts = [...request.evidenceReceipts].sort((left, right) => left.ref.localeCompare(right.ref));
    const actualReceipts = [...assessment.evidenceReceipts].sort((left, right) => left.ref.localeCompare(right.ref));
    if (assessment.evidenceDigest !== semanticAssessmentEvidenceDigest(request) || new Set(actualRefs).size !== actualRefs.length || sha256Canonical(actualRefs) !== sha256Canonical(expectedRefs) || sha256Canonical(actualReceipts) !== sha256Canonical(expectedReceipts)) throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact assessment evidence receipts or digest do not match the assembled candidate.");
    const judgment = assessment.judgment;
    // Frozen exact-match authority: normalized sorted-unique comparison only.
    // Details are appended (PR88 convention); the message prefix stays stable.
    if (sha256Canonical([...new Set(judgment.changedFiles.map(normalizePath))].sort()) !== sha256Canonical(changedFiles)) {
      const diff = candidateImpactFileDiffV1(changedFiles, judgment.changedFiles);
      const error = buildCandidateImpactMismatchError(diff, assessment);
      await emitCandidateImpactRejectedJudgment(runtime, {
        assessmentType: "CANDIDATE_IMPACT",
        candidateId: candidate.candidateId,
        candidateRevision: candidate.revision,
        candidateDigest: candidate.identityDigest,
        ...diff,
        assessmentDigest: assessment.assessmentDigest,
        ...(assessment.paseoSession?.agentId ? { sessionId: assessment.paseoSession.agentId } : {}),
        ...(assessment.paseoSession?.transport ? { transport: assessment.paseoSession.transport } : {})
      });
      if (attempt < MAX_CANDIDATE_IMPACT_ASSESSMENT_ATTEMPTS) { lastMismatch = error; attempt += 1; continue; }
      throw error;
    }
    const fileRefs = changedFiles.map((file) => `file:${file}`);
    if (fileRefs.some((ref) => !judgment.evidenceRefs.includes(ref))) throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact judgment must cite receipted evidence for every changed file.");
    if (judgment.evidenceRefs.some((ref) => !request.evidenceRefs.includes(ref))) throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact judgment cited evidence outside the current candidate receipts.");
    const valueWithoutDigest = {
      version: 1 as const,
      mechanism: "MODEL" as const,
      changedFiles: [...changedFiles],
      evidenceRefs: changedFiles.map((file) => `candidate:file:${file}`),
      changeKinds: judgment.changeKinds,
      reviewDimensions: judgment.reviewDimensions,
      requiresIndependentReview: true,
      unknowns: [...new Set([...assessment.unknowns, ...judgment.unknowns, ...unknowns])].sort(),
      semanticAssessmentDigest: assessment.assessmentDigest
    };
    return { ...valueWithoutDigest, assessmentDigest: candidateImpactProjectionDigest(valueWithoutDigest) };
  }
  throw lastMismatch ?? new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact assessment failed after bounded attempts.");
}

/**
 * Bounded retry-once for the non-authoritative CANDIDATE_IMPACT judgment plus
 * an independent bounded retry-once for transient launch-level non-timeout
 * UNAVAILABLE. The first assessment runs against the frozen evidence packet;
 * if the deterministic exact-match gate rejects its changedFiles, one retry
 * runs with IDENTICAL inputs (same request object, fresh turn, no hints, no
 * list re-assertion — re-asserting the exact list would lead the semantic
 * judgment and compromise independence). The retry passes `bypassCache: true`
 * so the identical cache identity cannot return the same cached wrong
 * judgment as a HIT; the fresh result is still stored under that identity. A
 * second mismatch rethrows with details.
 *
 * A transient launch-level SEMANTIC_ASSESSMENT_UNAVAILABLE with
 * `details.timeout !== true` (e.g. exit=1, empty result id, tiny payload,
 * ample envelope/deadline) retries once with IDENTICAL inputs, fresh turn,
 * `bypassCache: true`, `attemptBudget: 1`, normal envelope/provider-turn
 * accounting, after a small bounded backoff+jitter (≤5s). The second failure
 * rethrows with the runner-threaded diagnostics preserved. Timeout-class
 * UNAVAILABLE never retries here (behavior unchanged).
 *
 * This loop is the single owner of the retry bounds: every `service.assess`
 * call passes `attemptBudget: 1`, so the service's own bounded retry cannot
 * compose with this loop. One impact assessment therefore launches at most
 * MAX_CANDIDATE_IMPACT_ASSESSMENT_ATTEMPTS + MAX_CANDIDATE_IMPACT_UNAVAILABLE_RETRIES
 * real model turns (no envelope bypass; counts against normal provider-turn
 * accounting). All other gates (type, policy/binding, evidence receipts) fail
 * closed immediately with no retry. Fail-closed is preserved; no fuzzy
 * matching, no normalization widening, no evidence rewrite.
 */

function buildCandidateImpactMismatchError(
  diff: ReturnType<typeof candidateImpactFileDiffV1>,
  assessment: SemanticAssessmentV1
): AehError {
  const base = "candidate impact judgment changedFiles do not exactly match the assembled ChangeSet.";
  const suffix = ` declared=${JSON.stringify(diff.declared)} observed=${JSON.stringify(diff.observed)} missing=${JSON.stringify(diff.missing)} extra=${JSON.stringify(diff.extra)} declaredCount=${diff.declaredCount} observedCount=${diff.observedCount} missingCount=${diff.missingCount} extraCount=${diff.extraCount} assessmentDigest=${assessment.assessmentDigest}${assessment.paseoSession?.agentId ? ` assessorSession=${assessment.paseoSession.agentId}` : ""}`;
  return new AehError("CANDIDATE_IMPACT_INVALID", `${base}${suffix}`, {
    details: {
      ...diff,
      assessmentDigest: assessment.assessmentDigest,
      ...(assessment.paseoSession?.agentId ? { sessionId: assessment.paseoSession.agentId } : {}),
      ...(assessment.paseoSession?.transport ? { transport: assessment.paseoSession.transport } : {})
    }
  });
}

async function emitCandidateImpactRejectedJudgment(
  runtime: CandidateImpactAssessmentRuntimeV1,
  record: CandidateImpactRejectedJudgmentV1
): Promise<void> {
  const hook = runtime.onRejectedJudgment;
  if (!hook) return;
  try {
    await hook(record);
  } catch { /* forensic hook never masks the fail-closed rejection */ }
}

async function emitCandidateScopeEscape(
  input: CandidateAssemblyInputV1,
  record: CandidateScopeEscapeV1
): Promise<void> {
  const hook = input.onScopeEscape;
  if (!hook) return;
  try {
    await hook(record);
  } catch { /* forensic hook never masks the fail-closed rejection */ }
}

async function emitCandidateImpactAssessorUnavailable(
  runtime: CandidateImpactAssessmentRuntimeV1,
  record: CandidateImpactAssessorUnavailableV1
): Promise<void> {
  const hook = runtime.onAssessorUnavailable;
  if (!hook) return;
  try {
    await hook(record);
  } catch { /* forensic hook never masks the fail-closed rejection */ }
}

/**
 * Small bounded backoff+jitter before the transient UNAVAILABLE retry:
 * ~200ms base + 0-200ms jitter, capped at MAX_CANDIDATE_IMPACT_UNAVAILABLE_BACKOFF_MS_V1.
 */
async function backoffCandidateImpactUnavailableRetry(): Promise<void> {
  const baseMs = 200;
  const jitterMs = Math.floor(Math.random() * 200);
  const delayMs = Math.min(baseMs + jitterMs, MAX_CANDIDATE_IMPACT_UNAVAILABLE_BACKOFF_MS_V1);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function readCandidateFile(root: string, relative: string, maxBytes: number): Promise<{ content: string; truncated: boolean } | undefined> {
  const absolute = path.join(root, relative);
  let before: import("node:fs").Stats;
  let real: string;
  try {
    before = await fs.lstat(absolute);
    real = await fs.realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new AehError("CANDIDATE_IMPACT_INVALID", `unable to read assembled candidate evidence '${relative}'.`, { cause: error });
  }
  if (before.isSymbolicLink() || !before.isFile() || !isInsideRoot(root, real)) throw new AehError("CANDIDATE_IMPACT_INVALID", `candidate evidence '${relative}' is not a regular file inside the authorized candidate root.`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(absolute, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    const current = await fs.lstat(absolute);
    const after = await fs.realpath(absolute);
    if (!opened.isFile() || current.isSymbolicLink() || opened.dev !== before.dev || opened.ino !== before.ino || current.dev !== opened.dev || current.ino !== opened.ino || after !== real || !isInsideRoot(root, after)) throw new AehError("CANDIDATE_IMPACT_INVALID", `candidate evidence '${relative}' changed while its read receipt was being captured.`);
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    const bytes = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    if (bytes.includes(0)) throw new AehError("CANDIDATE_IMPACT_INVALID", `candidate evidence '${relative}' is not bounded text input.`);
    const decoded = decodeUtf8Prefix(bytes);
    if (!decoded) throw new AehError("CANDIDATE_IMPACT_INVALID", `candidate evidence '${relative}' is not valid bounded UTF-8 text.`);
    return { content: decoded.content, truncated: bytesRead > maxBytes || decoded.droppedBytes > 0 };
  } finally {
    await handle.close();
  }
}

function decodeUtf8Prefix(bytes: Buffer): { content: string; droppedBytes: number } | undefined {
  for (let droppedBytes = 0; droppedBytes <= Math.min(3, bytes.length); droppedBytes += 1) {
    try { return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - droppedBytes)), droppedBytes }; }
    catch { /* only an incomplete trailing code point may be discarded */ }
  }
  return undefined;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isSafeRepositoryPath(value: string): boolean {
  return Boolean(value) && !path.isAbsolute(value) && !value.split("/").some((part) => !part || part === "." || part === "..");
}

/**
 * Pure lexical rule shared by the assembly patch gate and the DIRECT
 * materialize gate (direct.ts): a patch-introduced or untracked symlink must
 * not point at an absolute/drive target and must not lexically resolve outside
 * the repository root. Fail-closed: unsafe link paths, empty targets and
 * unparseable inputs count as escapes.
 */
export function symlinkTargetEscapesRoot(linkPath: string, target: string): boolean {
  if (!isSafeRepositoryPath(linkPath)) return true;
  if (!target || target.includes("\0")) return true;
  if (target.startsWith("/") || target.startsWith("\\")) return true;
  if (/^[A-Za-z]:([\\/]|$)/.test(target)) return true;
  const directory = path.posix.dirname(linkPath);
  const joined = directory === "." ? target : `${directory}/${target}`;
  const normalized = path.posix.normalize(joined);
  return normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized);
}

interface PatchSymlinkV1 {
  path: string;
  target: string;
}

/**
 * Fail-closed choke point for patch-introduced symlinks (C-NEW-4). Parses the
 * patch text for entries whose post-image is a symlink (`new file mode
 * 120000`, `new mode 120000`, or an `index <old>..<new> 120000` retarget) and
 * rejects lexically escaping, absolute/drive, or unverifiable targets before
 * any `git apply` touches the worktree. Pure deletions (`+++ /dev/null`) carry
 * no post-image link and are skipped; a pure rename (no hunks) introduces no
 * new target and is skipped. A nearest-existing realpath check augments the
 * lexical verdict where the link dirname already exists on disk.
 */
async function assertPatchSymlinksContained(root: string, patch: string): Promise<void> {
  const { links, unverifiable } = patchSymlinksWithPostImageLink(patch);
  const lexicalOffense = links.find((link) => symlinkTargetEscapesRoot(link.path, link.target));
  if (lexicalOffense || unverifiable.length > 0) {
    const detail = lexicalOffense ? `${lexicalOffense.path} -> ${lexicalOffense.target}` : `${unverifiable[0]} -> <unverifiable link target>`;
    throw new AehError("PARTICIPANT_PLAN_INVALID", `ChangeSet patch creates a symlink escaping the candidate root: ${detail}.`);
  }
  if (links.length === 0) return;
  const resolvedRoot = await fs.realpath(path.resolve(root)).catch(() => undefined);
  if (!resolvedRoot) return;
  for (const link of links) {
    const directory = path.posix.dirname(link.path);
    const absoluteDirectory = directory === "." ? resolvedRoot : path.join(resolvedRoot, ...directory.split("/"));
    const realDirectory = await fs.realpath(absoluteDirectory).catch(() => undefined);
    if (!realDirectory) continue;
    const resolved = path.resolve(realDirectory, link.target);
    if (!isInsideRoot(resolvedRoot, resolved)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `ChangeSet patch creates a symlink escaping the candidate root: ${link.path} -> ${link.target}.`);
    }
  }
}

function patchSymlinksWithPostImageLink(patch: string): { links: PatchSymlinkV1[]; unverifiable: string[] } {
  const links: PatchSymlinkV1[] = [];
  const unverifiable: string[] = [];
  for (const block of patch.split(/^diff --git /m).slice(1)) {
    const lines = block.split("\n").map((line) => line.replace(/\r$/, ""));
    const postMarker = lines.find((line) => line.startsWith("+++ "));
    if (!postMarker) continue;
    const rawPost = postMarker.slice("+++ ".length).trim();
    if (rawPost === "/dev/null") continue;
    if (!isPostImageSymlinkBlock(lines)) continue;
    const postPath = stripDiffPathPrefix(rawPost);
    if (!postPath || !isSafeRepositoryPath(postPath)) {
      unverifiable.push(postPath || rawPost);
      continue;
    }
    const added = lines
      .filter((line) => line.startsWith("+") && !line.startsWith("+++ "))
      .map((line) => line.slice(1).replace(/\r$/, ""));
    if (added.length === 0) {
      if (lines.some((line) => line.startsWith("rename from "))) continue;
      unverifiable.push(postPath);
      continue;
    }
    for (const target of added) links.push({ path: postPath, target });
  }
  return { links, unverifiable };
}

function isPostImageSymlinkBlock(lines: readonly string[]): boolean {
  if (lines.some((line) => /^new file mode 120000$/.test(line))) return true;
  if (lines.some((line) => /^new mode 120000$/.test(line))) return true;
  if (lines.some((line) => /^new mode /.test(line))) return false;
  if (lines.some((line) => /^deleted file mode /.test(line))) return false;
  // The index-mode form covers retargets of an already-committed link. The
  // hash shape is deliberately loose (`\S+`): a hand-crafted patch with
  // non-hex placeholders must still be recognized, never skipped.
  return lines.some((line) => /^index \S+\.\.\S+ 120000(?: |$)/.test(line));
}

function stripDiffPathPrefix(raw: string): string {
  let value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/\\(\\|")/g, "$1");
  }
  if (value.startsWith("b/")) return value.slice(2);
  return value;
}

async function pathsTouchedByPatch(root: string, patch: string): Promise<string[]> {
  const validationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-candidate-index-"));
  const indexFile = path.join(validationRoot, "index");
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    const readTree = await runExecutable("git", ["read-tree", "HEAD"], { cwd: root, timeoutMs: 30_000, env });
    if (readTree.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `Unable to prepare isolated patch validation: ${readTree.stderr || readTree.stdout}`);
    const stageCurrent = await runExecutable("git", ["add", "-A"], { cwd: root, timeoutMs: 60_000, env });
    if (stageCurrent.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `Unable to snapshot the bound candidate for patch validation: ${stageCurrent.stderr || stageCurrent.stdout}`);
    const baseTree = await runExecutable("git", ["write-tree"], { cwd: root, timeoutMs: 30_000, env });
    if (baseTree.exitCode !== 0 || !baseTree.stdout.trim()) throw new AehError("CANDIDATE_STALE", `Unable to identify the patch validation base: ${baseTree.stderr || baseTree.stdout}`);
    const applied = await runExecutable("git", ["apply", "--cached", "--binary", "-"], { cwd: root, timeoutMs: 60_000, stdin: patch, env });
    if (applied.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `ChangeSet patch cannot be applied to the current candidate: ${applied.stderr || applied.stdout}`);
    // Provider-owned scratch (.serena/, graphify-out/) never enters candidate
    // accounting: the same shared pathspec excludes direct.ts uses for DIRECT
    // ChangeSets, so both assembly paths observe identical patch paths.
    const changed = await runExecutable("git", ["diff", "--cached", "--name-only", "--no-renames", "-z", baseTree.stdout.trim(), "--", ...providerGeneratedPathspecExcludes()], { cwd: root, timeoutMs: 30_000, env });
    if (changed.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `Unable to derive paths touched by ChangeSet patch: ${changed.stderr || changed.stdout}`);
    return [...new Set(changed.stdout.split("\0").filter(Boolean).map(normalizePath))].sort();
  } finally {
    await fs.rm(validationRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function candidateImpactProjectionDigest(assessment: Omit<CandidateImpactProjectionV1, "assessmentDigest">): string {
  const { assessmentDigest: _ignored, ...digestInput } = assessment as CandidateImpactProjectionV1;
  return sha256Canonical(digestInput);
}

function projectCandidateImpact(changedFiles: readonly string[], assessment: CandidateImpactProjectionV1 | undefined, binding: Pick<CandidateImpactV1, "candidate" | "baseCandidate" | "patchDigest">): CandidateImpactV1 {
  const normalized = [...new Set(changedFiles.map(normalizePath))].sort();
  if (!assessment) {
    const payload = { version: 1 as const, ...binding, changedFiles: normalized, changeKinds: [], reviewDimensions: [], requiresIndependentReview: true, interpretation: "BLOCKED" as const, unknowns: ["No evidence-bound candidate impact assessment was supplied."] };
    return { ...payload, digest: sha256Canonical(payload) };
  }
  const parsed = candidateImpactProjectionSchema.safeParse(assessment);
  if (!parsed.success) throw new AehError("CANDIDATE_IMPACT_INVALID", parsed.error.issues.map((issue) => `${issue.path.join(".") || "assessment"}: ${issue.message}`).join("; "));
  const value = parsed.data;
  const assessedFiles = [...new Set(value.changedFiles.map(normalizePath))].sort();
  if (JSON.stringify(assessedFiles) !== JSON.stringify(normalized)) {
    const diff = candidateImpactFileDiffV1(normalized, value.changedFiles);
    const base = "candidate impact changedFiles do not match the observed ChangeSet paths.";
    const suffix = ` declared=${JSON.stringify(diff.declared)} observed=${JSON.stringify(diff.observed)} missing=${JSON.stringify(diff.missing)} extra=${JSON.stringify(diff.extra)} declaredCount=${diff.declaredCount} observedCount=${diff.observedCount} missingCount=${diff.missingCount} extraCount=${diff.extraCount} assessmentDigest=${value.assessmentDigest}`;
    throw new AehError("CANDIDATE_IMPACT_INVALID", `${base}${suffix}`, {
      details: { ...diff, assessmentDigest: value.assessmentDigest }
    });
  }
  const allowedRefs = new Set(normalized.map((file) => `candidate:file:${file}`));
  if (value.evidenceRefs.some((ref) => !allowedRefs.has(ref)) || normalized.some((file) => !value.evidenceRefs.includes(`candidate:file:${file}`))) throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact evidenceRefs are not bound to every observed changed file.");
  if (value.assessmentDigest !== candidateImpactProjectionDigest(value)) throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact projection digest does not match its typed claims.");
  const payload = { version: 1 as const, ...binding, changedFiles: normalized, changeKinds: [...new Set(value.changeKinds)].sort(), reviewDimensions: [...new Set(value.reviewDimensions)].sort(), requiresIndependentReview: true, interpretation: value.mechanism, unknowns: [...new Set(value.unknowns)].sort(), ...(value.semanticAssessmentDigest ? { semanticAssessmentDigest: value.semanticAssessmentDigest } : {}) };
  return { ...payload, digest: sha256Canonical(payload) };
}

function normalizePath(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\//, ""); }
function matchesAny(file: string, patterns: readonly string[]): boolean { return patterns.some((pattern) => pattern === "**" || minimatch(file, pattern, { dot: true })); }
