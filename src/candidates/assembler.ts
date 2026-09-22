import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import { z } from "zod";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { computeWorktreeDigest } from "../core/git.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { assertWorkspaceMatchesCandidate } from "./identity.js";
import { runExecutable } from "../utils/process.js";
import { changeKindSchema, changeKindValues, type ChangeKind } from "../architecture/workGraph.js";
import { createSemanticEvidenceReceiptV1, semanticAssessmentEvidenceDigest, semanticEvidenceBoundaryDigest, type SemanticAssessmentBindingV1, type SemanticAssessmentServiceV1, type SemanticAssessmentV1 } from "../semantic/assessment.js";

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
}

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
  const outOfScope = changedFiles.filter((file) => !matchesAny(file, input.allowedScope));
  const forbidden = changedFiles.filter((file) => matchesAny(file, input.forbiddenScope ?? []));
  if (outOfScope.length || forbidden.length) throw new AehError("PARTICIPANT_PLAN_INVALID", `ChangeSet escaped its assigned scope: ${[...new Set([...outOfScope, ...forbidden])].join(", ")}.`);
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
    const impact = projectCandidateImpact(changedFiles, semanticImpact);
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
    budget: { maxInputTokens: 8_000, maxOutputTokens: 2_000, deadlineMs: 45_000 },
    policyRevision: runtime.policyRevision
  };
  const assessment: SemanticAssessmentV1 = await runtime.service.assess(request);
  if (assessment.assessmentType !== "CANDIDATE_IMPACT" || assessment.mechanism !== "MODEL" || assessment.judgment.type !== "CANDIDATE_IMPACT") throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact requires a canonical MODEL CANDIDATE_IMPACT judgment.");
  if (assessment.policyRevision !== runtime.policyRevision || sha256Canonical(assessment.binding) !== sha256Canonical(binding)) throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact assessment policy or candidate binding is stale.");
  const expectedRefs = [...request.evidenceRefs].sort();
  const actualRefs = [...assessment.evidenceRefs].sort();
  const expectedReceipts = [...request.evidenceReceipts].sort((left, right) => left.ref.localeCompare(right.ref));
  const actualReceipts = [...assessment.evidenceReceipts].sort((left, right) => left.ref.localeCompare(right.ref));
  if (assessment.evidenceDigest !== semanticAssessmentEvidenceDigest(request) || new Set(actualRefs).size !== actualRefs.length || sha256Canonical(actualRefs) !== sha256Canonical(expectedRefs) || sha256Canonical(actualReceipts) !== sha256Canonical(expectedReceipts)) throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact assessment evidence receipts or digest do not match the assembled candidate.");
  const judgment = assessment.judgment;
  if (sha256Canonical([...new Set(judgment.changedFiles.map(normalizePath))].sort()) !== sha256Canonical(changedFiles)) throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact judgment changedFiles do not exactly match the assembled ChangeSet.");
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
    const changed = await runExecutable("git", ["diff", "--cached", "--name-only", "--no-renames", "-z", baseTree.stdout.trim(), "--"], { cwd: root, timeoutMs: 30_000, env });
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

function projectCandidateImpact(changedFiles: readonly string[], assessment?: CandidateImpactProjectionV1): CandidateImpactV1 {
  const normalized = [...new Set(changedFiles.map(normalizePath))].sort();
  if (!assessment) {
    const payload = { version: 1 as const, changedFiles: normalized, changeKinds: [], reviewDimensions: [], requiresIndependentReview: true, interpretation: "BLOCKED" as const, unknowns: ["No evidence-bound candidate impact assessment was supplied."] };
    return { ...payload, digest: sha256Canonical(payload) };
  }
  const parsed = candidateImpactProjectionSchema.safeParse(assessment);
  if (!parsed.success) throw new AehError("CANDIDATE_IMPACT_INVALID", parsed.error.issues.map((issue) => `${issue.path.join(".") || "assessment"}: ${issue.message}`).join("; "));
  const value = parsed.data;
  const assessedFiles = [...new Set(value.changedFiles.map(normalizePath))].sort();
  if (JSON.stringify(assessedFiles) !== JSON.stringify(normalized)) throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact changedFiles do not match the observed ChangeSet paths.");
  const allowedRefs = new Set(normalized.map((file) => `candidate:file:${file}`));
  if (value.evidenceRefs.some((ref) => !allowedRefs.has(ref)) || normalized.some((file) => !value.evidenceRefs.includes(`candidate:file:${file}`))) throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact evidenceRefs are not bound to every observed changed file.");
  if (value.assessmentDigest !== candidateImpactProjectionDigest(value)) throw new AehError("CANDIDATE_IMPACT_INVALID", "candidate impact projection digest does not match its typed claims.");
  const payload = { version: 1 as const, changedFiles: normalized, changeKinds: [...new Set(value.changeKinds)].sort(), reviewDimensions: [...new Set(value.reviewDimensions)].sort(), requiresIndependentReview: true, interpretation: value.mechanism, unknowns: [...new Set(value.unknowns)].sort(), ...(value.semanticAssessmentDigest ? { semanticAssessmentDigest: value.semanticAssessmentDigest } : {}) };
  return { ...payload, digest: sha256Canonical(payload) };
}

function normalizePath(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\//, ""); }
function matchesAny(file: string, patterns: readonly string[]): boolean { return patterns.some((pattern) => pattern === "**" || minimatch(file, pattern, { dot: true })); }
