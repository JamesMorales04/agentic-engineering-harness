import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { computeWorktreeDigest, listWorktreeDigestPaths } from "../core/git.js";
import {
  createSemanticEvidenceReceiptV1,
  semanticAssessmentBindingV1Schema,
  semanticAssessmentEvidenceDigest,
  semanticCapabilityPolicyRevisionV1,
  semanticEvidenceBoundaryDigest,
  semanticEvidenceReceiptDigest,
  type SemanticAssessmentBindingV1,
  type SemanticAssessmentRequestV1,
  type SemanticAssessmentV1,
  type SemanticEvidenceReceiptV1,
  type SemanticStackJudgmentV1
} from "../semantic/assessment.js";

export type ProjectLanguageV1 = string;

export interface StackSignalV1 {
  id: string;
  source: string;
}

export type StackInterpretationV1 = "MODEL";

export interface ProjectStackProfileV1 {
  version: 1;
  interpretation: StackInterpretationV1;
  languages: readonly ProjectLanguageV1[];
  frameworks: readonly string[];
  packageManagers: readonly string[];
  databases: readonly string[];
  toolchains: readonly string[];
  signals: readonly StackSignalV1[];
  testFrameworks?: readonly string[];
  migrationMechanisms?: readonly string[];
  buildSystems?: readonly string[];
  versions?: Readonly<Record<string, string>>;
  projectSkillRoots?: readonly string[];
  unknowns?: readonly string[];
  inputDigest?: string;
  assessmentDigest?: string;
  bindingDigest?: string;
  policyRevision?: string;
  assessorDigest?: string;
}

export interface ProjectStackFileEvidenceV1 {
  path: string;
  content: string;
}

export interface ProjectStackEvidencePacketV1 {
  version: 1;
  items: readonly ProjectStackFileEvidenceV1[];
  receipts: readonly SemanticEvidenceReceiptV1[];
  digest: string;
  scannedFiles: number;
  truncated: boolean;
}

export interface ProjectStackEvidenceBoundsV1 {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxScannedEntries: number;
  maxDepth: number;
  deadlineMs: number;
}

export const defaultProjectStackEvidenceBoundsV1: Readonly<ProjectStackEvidenceBoundsV1> = {
  maxFiles: 16,
  maxFileBytes: 4_000,
  maxTotalBytes: 24_000,
  maxScannedEntries: 2_048,
  maxDepth: 6,
  deadlineMs: 30_000
};

export interface ProjectStackSemanticAssessorV1 {
  assess(request: SemanticAssessmentRequestV1): Promise<SemanticAssessmentV1>;
}

export interface ProjectStackSemanticAssessmentInjectionV1 {
  service: ProjectStackSemanticAssessorV1;
  binding: SemanticAssessmentBindingV1;
}

export interface ProjectStackDiscoveryOptionsV1 {
  semanticAssessment?: ProjectStackSemanticAssessmentInjectionV1;
  bounds?: Partial<ProjectStackEvidenceBoundsV1>;
}

const excludedInventoryDirectoryNames = new Set([".git", ".harness", "node_modules", "dist", ".aeh-build"]);

function invalid(detail: string, options?: { cause?: unknown }): AehError {
  return new AehError("STACK_ASSESSMENT_INVALID", detail, options);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseBinding(binding: SemanticAssessmentBindingV1): SemanticAssessmentBindingV1 {
  const parsed = semanticAssessmentBindingV1Schema.safeParse(binding);
  if (!parsed.success) throw invalid("project stack assessment requires a valid repository-bound semantic assessment binding.", { cause: parsed.error });
  if (!parsed.data.repositoryRootDigest) throw invalid("project stack assessment requires repositoryRootDigest bound to the canonical realpath.");
  return parsed.data;
}

function resolveBounds(bounds?: Partial<ProjectStackEvidenceBoundsV1>): ProjectStackEvidenceBoundsV1 {
  const merged = { ...defaultProjectStackEvidenceBoundsV1, ...bounds };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid(`project stack evidence bound '${name}' must be a non-negative integer.`);
  }
  if (merged.maxFiles < 1 || merged.maxFileBytes < 1 || merged.maxTotalBytes < 1 || merged.maxScannedEntries < 1) throw invalid("project stack evidence file, byte, and scan bounds must be positive.");
  return {
    maxFiles: Math.min(merged.maxFiles, 16),
    maxFileBytes: Math.min(merged.maxFileBytes, 4_000),
    maxTotalBytes: Math.min(merged.maxTotalBytes, 24_000),
    maxScannedEntries: Math.min(merged.maxScannedEntries, defaultProjectStackEvidenceBoundsV1.maxScannedEntries),
    maxDepth: Math.min(merged.maxDepth, defaultProjectStackEvidenceBoundsV1.maxDepth),
    deadlineMs: Math.min(merged.deadlineMs, defaultProjectStackEvidenceBoundsV1.deadlineMs)
  };
}

async function resolveRoot(root: string): Promise<string> {
  if (typeof root !== "string" || !root.trim()) throw invalid("project stack discovery requires a repository root.");
  let resolved: string;
  try {
    resolved = await fs.realpath(path.resolve(root));
    if (!(await fs.stat(resolved)).isDirectory()) throw invalid("project stack discovery root is not a directory.");
  } catch (error) {
    if (error instanceof AehError) throw error;
    throw invalid("project stack discovery root is not a readable directory.", { cause: error });
  }
  return resolved;
}

async function assertCurrentRepository(root: string, binding: SemanticAssessmentBindingV1): Promise<string> {
  const canonicalRoot = await resolveRoot(root);
  const rootDigest = sha256Canonical(canonicalRoot);
  if (binding.repositoryRootDigest !== rootDigest) throw invalid("project stack repositoryRootDigest does not match the scanned canonical realpath.");
  let repositoryDigest: string;
  try {
    repositoryDigest = await computeWorktreeDigest(canonicalRoot);
  } catch (error) {
    throw invalid("unable to verify current repository content against the STACK binding.", { cause: error });
  }
  if (repositoryDigest !== binding.repositoryDigest) throw invalid("project stack repository content has drifted from the bound repositoryDigest.");
  return canonicalRoot;
}

interface ScannedEvidenceFileV1 {
  path: string;
  depth: number;
}

async function scanEvidenceFiles(root: string, bounds: ProjectStackEvidenceBoundsV1): Promise<{ files: ScannedEvidenceFileV1[]; truncated: boolean }> {
  const startedAt = performance.now();
  const checkDeadline = (): void => {
    if (performance.now() - startedAt >= bounds.deadlineMs) throw invalid("bounded stack evidence scan exceeded its deadline.");
  };
  let inventory: string[];
  try {
    inventory = await listWorktreeDigestPaths(root);
  } catch (error) {
    throw invalid("Git could not establish the authorized non-ignored repository evidence inventory.", { cause: error });
  }
  checkDeadline();
  const candidates: ScannedEvidenceFileV1[] = [];
  let truncated = false;
  for (const file of inventory) {
    checkDeadline();
    const segments = file.split("/");
    if (
      !file || path.posix.isAbsolute(file) || path.win32.isAbsolute(file) ||
      file.includes("\\") || segments.some((part) => !part || part === "." || part === "..")
    ) { truncated = true; continue; }
    if (segments.some((part) => excludedInventoryDirectoryNames.has(part))) continue;
    const depth = segments.length - 1;
    if (depth > bounds.maxDepth) { truncated = true; continue; }
    candidates.push({ path: file, depth });
  }
  candidates.sort((left, right) => left.depth - right.depth || compareStrings(left.path, right.path));
  truncated ||= candidates.length > bounds.maxScannedEntries;
  return { files: candidates.slice(0, bounds.maxScannedEntries), truncated };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function readBoundedFile(root: string, relative: string, maxBytes: number): Promise<{ content: string; truncated: boolean } | undefined> {
  const absolute = path.join(root, relative);
  let resolved: string;
  let before: import("node:fs").Stats;
  try {
    resolved = await fs.realpath(absolute);
    before = await fs.lstat(absolute);
    if (!isWithinRoot(root, resolved) || before.isSymbolicLink() || !before.isFile()) return undefined;
  } catch {
    return undefined;
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const nonBlocking = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
  let handle: import("node:fs/promises").FileHandle;
  try {
    handle = await fs.open(absolute, fsConstants.O_RDONLY | noFollow | nonBlocking);
  } catch {
    return undefined;
  }
  try {
    const opened = await handle.stat();
    const current = await fs.lstat(absolute);
    const after = await fs.realpath(absolute);
    if (!opened.isFile() || current.isSymbolicLink() || opened.dev !== before.dev || opened.ino !== before.ino || current.dev !== opened.dev || current.ino !== opened.ino || !isWithinRoot(root, after)) return undefined;
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    const bytes = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    if (bytes.includes(0)) return undefined;
    const decoded = decodeUtf8Prefix(bytes);
    if (!decoded) return undefined;
    return { content: decoded.content, truncated: bytesRead > maxBytes || decoded.droppedBytes > 0 };
  } catch {
    return undefined;
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

export async function collectProjectStackEvidence(root: string, input: { binding: SemanticAssessmentBindingV1; bounds?: Partial<ProjectStackEvidenceBoundsV1> }): Promise<ProjectStackEvidencePacketV1> {
  if (!input?.binding) throw invalid("project stack evidence collection requires a repository-bound assessment binding.");
  const binding = parseBinding(input.binding);
  const bounds = resolveBounds(input.bounds);
  const resolvedRoot = await assertCurrentRepository(root, binding);
  const scan = await scanEvidenceFiles(resolvedRoot, bounds);
  const items: ProjectStackFileEvidenceV1[] = [];
  const receipts: SemanticEvidenceReceiptV1[] = [];
  let totalBytes = 0;
  let truncated = scan.truncated;
  for (const file of scan.files) {
    if (items.length >= bounds.maxFiles || totalBytes >= bounds.maxTotalBytes) {
      truncated = true;
      break;
    }
    const ref = `file:${file.path}`;
    if (ref.length > 200) { truncated = true; continue; }
    const remaining = bounds.maxTotalBytes - totalBytes;
    const read = await readBoundedFile(resolvedRoot, file.path, Math.min(bounds.maxFileBytes, remaining));
    if (read === undefined) { truncated = true; continue; }
    if (read.content.length === 0) continue;
    if (read.truncated) truncated = true;
    const contentBytes = Buffer.byteLength(read.content, "utf8");
    if (contentBytes > remaining) continue;
    totalBytes += contentBytes;
    items.push({ path: file.path, content: read.content });
    receipts.push(createSemanticEvidenceReceiptV1({ binding, ref, content: read.content, kind: "REPOSITORY_FILE", path: file.path }));
  }
  await assertCurrentRepository(resolvedRoot, binding);
  const evidenceRefs = items.map((item) => `file:${item.path}`);
  const digest = semanticAssessmentEvidenceDigest({
    evidenceRefs,
    compactEvidence: items.map((item) => ({ ref: `file:${item.path}`, content: item.content })),
    evidenceReceipts: receipts
  });
  return { version: 1, items, receipts, digest, scannedFiles: scan.files.length, truncated };
}

function projectStackAssessmentRequest(packet: ProjectStackEvidencePacketV1, binding: SemanticAssessmentBindingV1): SemanticAssessmentRequestV1 {
  return {
    version: 1,
    assessmentType: "STACK",
    evidenceRefs: packet.receipts.map((receipt) => receipt.ref),
    compactEvidence: packet.items.map((item) => ({ ref: `file:${item.path}`, content: item.content })),
    evidenceReceipts: [...packet.receipts],
    requiredOutputSchema: "semantic-assessment-v1",
    reasoningRequirement: {
      reasoningClass: "STANDARD",
      structuredOutputRequired: true,
      independenceRequired: false,
      externalKnowledgeRequired: false,
      maxContextClass: "LARGE",
      riskClass: "HIGH"
    },
    binding,
    budget: { maxInputTokens: 8_000, maxOutputTokens: 2_000, deadlineMs: 45_000 },
    policyRevision: semanticCapabilityPolicyRevisionV1
  };
}

export async function discoverProjectStackProfile(root: string, options: ProjectStackDiscoveryOptionsV1 = {}): Promise<ProjectStackProfileV1> {
  const injection = options.semanticAssessment;
  if (!injection?.service || typeof injection.service.assess !== "function") throw invalid("project stack discovery requires an injected AEH Semantic Assessor service; there is no deterministic fallback.");
  if (!injection.binding) throw invalid("project stack discovery requires a repository-bound semantic assessment binding.");
  const binding = parseBinding(injection.binding);
  const packet = await collectProjectStackEvidence(root, { binding, ...(options.bounds ? { bounds: options.bounds } : {}) });
  if (!packet.items.length) throw invalid("bounded stack evidence scan found no readable repository evidence.");
  const request = projectStackAssessmentRequest(packet, binding);
  let assessment: SemanticAssessmentV1;
  try {
    assessment = await injection.service.assess(request);
  } catch (error) {
    if (error instanceof AehError) throw error;
    throw invalid("AEH Semantic Assessor STACK assessment failed.", { cause: error });
  }
  const canonicalRoot = await assertCurrentRepository(root, binding);
  const profile = await projectStackProfileFromAssessment(canonicalRoot, request, packet, assessment);
  await assertCurrentRepository(canonicalRoot, binding);
  return profile;
}

async function projectStackProfileFromAssessment(root: string, request: SemanticAssessmentRequestV1, packet: ProjectStackEvidencePacketV1, assessment: SemanticAssessmentV1): Promise<ProjectStackProfileV1> {
  if (!assessment || assessment.version !== 1 || assessment.assessmentType !== "STACK" || assessment.mechanism !== "MODEL") throw invalid("a canonical MODEL STACK semantic assessment is required.");
  if (!assessment.judgment || assessment.judgment.type !== "STACK") throw invalid("STACK semantic assessment did not return a typed STACK judgment.");
  if (!/^[a-f0-9]{64}$/.test(assessment.assessmentDigest) || assessment.assessor?.role !== "Semantic Assessor" || !/^[a-f0-9]{64}$/.test(assessment.assessor.identityDigest) || !assessment.paseoSession?.agentId || assessment.paseoSession.provider !== assessment.assessor.paseoProvider || !["sdk", "cli"].includes(assessment.paseoSession.transport) || !/^[a-f0-9]{64}$/.test(assessment.cacheIdentity) || !["FRESH", "HIT"].includes(assessment.cacheDisposition)) throw invalid("STACK semantic assessment provenance or cache identity is incomplete.");
  if (assessment.policyRevision !== request.policyRevision) throw invalid("STACK semantic assessment policy revision is stale.");
  if (sha256Canonical(assessment.binding) !== sha256Canonical(request.binding)) throw invalid("STACK semantic assessment is not bound to the requested repository/candidate boundary.");
  if (assessment.evidenceDigest !== packet.digest || assessment.evidenceDigest !== semanticAssessmentEvidenceDigest(request)) throw invalid("STACK semantic assessment evidence digest does not match the supplied bounded evidence packet.");
  validateAssessmentReceipts(request, packet, assessment);

  const judgment: SemanticStackJudgmentV1 = assessment.judgment;
  const suppliedRefs = new Set(request.evidenceRefs);
  const judgmentRefs = [...judgment.evidenceRefs, ...judgment.signals.map((signal) => signal.evidenceRef)];
  if (judgmentRefs.some((ref) => !suppliedRefs.has(ref))) throw invalid("STACK judgment referenced evidence outside the supplied bounded evidence packet.");
  const judgmentEvidence = new Set(judgment.evidenceRefs);
  if (judgment.signals.some((signal) => !judgmentEvidence.has(signal.evidenceRef))) throw invalid("STACK judgment signals must cite the judgment's own evidence references.");
  const receiptsByRef = new Map(packet.receipts.map((receipt) => [receipt.ref, receipt]));
  const signals: StackSignalV1[] = judgment.signals.map((signal) => {
    const receipt = receiptsByRef.get(signal.evidenceRef);
    if (!receipt?.path) throw invalid(`STACK signal '${signal.id}' does not map to a supplied repository file evidence receipt.`);
    return { id: signal.id, source: receipt.path };
  });
  const projectSkillRoots = await validateProjectSkillRoots(root, judgment.projectSkillRoots);

  return {
    version: 1,
    interpretation: "MODEL",
    languages: dedupeExact(judgment.languages),
    frameworks: dedupeExact(judgment.frameworks),
    packageManagers: dedupeExact(judgment.packageManagers),
    databases: dedupeExact(judgment.databases),
    toolchains: dedupeExact(judgment.toolchains),
    signals: orderSignals(signals),
    testFrameworks: dedupeExact(judgment.testFrameworks),
    migrationMechanisms: dedupeExact(judgment.migrationMechanisms),
    buildSystems: dedupeExact(judgment.buildSystems),
    versions: Object.fromEntries(Object.entries(judgment.versions).sort(([left], [right]) => compareStrings(left, right))),
    projectSkillRoots,
    unknowns: [...new Set([
      ...assessment.unknowns,
      ...judgment.unknowns,
      ...(packet.truncated ? ["Repository evidence was incomplete because the bounded stack read reached a configured limit."] : [])
    ])].sort(),
    inputDigest: packet.digest,
    assessmentDigest: assessment.assessmentDigest,
    bindingDigest: semanticEvidenceBoundaryDigest(request.binding),
    policyRevision: assessment.policyRevision,
    assessorDigest: assessment.assessor.identityDigest
  };
}

async function validateProjectSkillRoots(root: string, proposed: readonly string[]): Promise<string[]> {
  const validated: string[] = [];
  for (const value of dedupeExact(proposed)) {
    if (
      !value || value !== value.trim() || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value) ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || path.win32.parse(value).root ||
      path.posix.normalize(value) !== value || value.split("/").some((part) => !part || part === "." || part === "..")
    ) throw invalid(`STACK projectSkillRoots contains a non-normalized repository-relative path: '${value}'.`);
    const absolute = path.resolve(root, ...value.split("/"));
    if (!isWithinRoot(root, absolute)) throw invalid(`STACK project skill root '${value}' escapes the bound repository.`);
    let resolved: string;
    try {
      resolved = await fs.realpath(absolute);
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) throw new Error("project skill root is not a directory");
    } catch (error) {
      throw invalid(`STACK project skill root '${value}' does not resolve to an existing directory.`, { cause: error });
    }
    if (!isWithinRoot(root, resolved)) throw invalid(`STACK project skill root '${value}' resolves outside the bound repository.`);
    validated.push(value);
  }
  return validated;
}

function validateAssessmentReceipts(request: SemanticAssessmentRequestV1, packet: ProjectStackEvidencePacketV1, assessment: SemanticAssessmentV1): void {
  const suppliedReceipts = new Map(packet.receipts.map((receipt) => [receipt.ref, receipt]));
  const suppliedContent = new Map(packet.items.map((item) => [`file:${item.path}`, item.content]));
  const expectedRefs = new Set(request.evidenceRefs);
  if (assessment.evidenceRefs.length !== request.evidenceRefs.length || new Set(assessment.evidenceRefs).size !== request.evidenceRefs.length || assessment.evidenceRefs.some((ref) => !expectedRefs.has(ref))) throw invalid("STACK semantic assessment evidence refs do not match the supplied bounded evidence packet.");
  if (assessment.evidenceReceipts.length !== packet.receipts.length) throw invalid("STACK semantic assessment evidence receipts do not match the supplied bounded evidence packet.");
  if (new Set(assessment.evidenceReceipts.map((receipt) => receipt.ref)).size !== packet.receipts.length) throw invalid("STACK semantic assessment contains duplicated evidence receipts.");
  for (const receipt of assessment.evidenceReceipts) {
    const supplied = suppliedReceipts.get(receipt.ref);
    const content = suppliedContent.get(receipt.ref);
    if (!supplied || content === undefined || sha256Canonical(receipt) !== sha256Canonical(supplied)) throw invalid(`STACK semantic assessment evidence receipt ${receipt.ref} does not match a supplied repository evidence receipt.`);
    if (receipt.kind !== "REPOSITORY_FILE" || !receipt.path || receipt.ref !== `file:${receipt.path}`) throw invalid(`STACK semantic assessment evidence receipt ${receipt.ref} is not a repository file receipt.`);
    if (receipt.contentDigest !== sha256Utf8(content) || receipt.contentBytes !== Buffer.byteLength(content, "utf8")) throw invalid(`STACK semantic assessment evidence receipt ${receipt.ref} does not bind the exact supplied bytes.`);
    if (receipt.boundaryDigest !== semanticEvidenceBoundaryDigest(request.binding)) throw invalid(`STACK semantic assessment evidence receipt ${receipt.ref} is outside the bound repository/candidate boundary.`);
    if (receipt.receiptDigest !== semanticEvidenceReceiptDigest(receipt)) throw invalid(`STACK semantic assessment evidence receipt ${receipt.ref} digest is invalid.`);
  }
}

function dedupeExact(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function orderSignals(signals: readonly StackSignalV1[]): StackSignalV1[] {
  return [...signals]
    .sort((left, right) => `${left.id}\0${left.source}` < `${right.id}\0${right.source}` ? -1 : `${left.id}\0${left.source}` > `${right.id}\0${right.source}` ? 1 : 0)
    .filter((signal, index, all) => index === 0 || signal.id !== all[index - 1]!.id || signal.source !== all[index - 1]!.source);
}
