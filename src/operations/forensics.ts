import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { runExecutable, type ProcessResult } from "../utils/process.js";
import { readOperationEfficiencyObservations } from "../telemetry/efficiency.js";
import { currentOperationContext, loadOperation, operationArtifactDir, resolveOperationStateRoot, type OperationRecordV2 } from "./state.js";

export interface CommandDiagnosticV1 {
  version: 1;
  kind: "command-diagnostic";
  operationId: string;
  candidate: { candidateId: string; revision: number; digest: string } | null;
  command: { display: string; digest: string };
  cwd: string;
  workspaceIdentity: string;
  exitCode: number;
  stdout: { digest: string; bytes: number; diagnosticTail: string };
  stderr: { digest: string; bytes: number; diagnosticTail: string };
  environment: { platform: string; nodeVersion: string; keys: string[]; digest: string };
  tool: { name: string; version: string | null };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timedOut: boolean;
}

export interface CandidateForensicsV1 {
  version: 1;
  kind: "failed-candidate-forensics";
  operationId: string;
  operationStatus: OperationRecordV2["status"];
  candidate: { candidateId: string; revision: number; digest: string } | null;
  workspace: string | null;
  changedFiles: string[];
  changedFilesTruncated: boolean;
  diffDigest: string | null;
  diffDigestCoverage: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  validationReferences: Array<{ phase: string; status: string; artifact?: string }>;
  validationDiagnostics: Array<{ reference: string; digest: string; bytes: number; diagnosticTail: string }>;
  lastActivity: { at: string | null; participantId: string | null; role: string | null; phase: string | null; source: "PARTICIPANT_RECORD" | "USAGE_OBSERVATION" | "TOOL_OBSERVATION" | "EXECUTION_ACTIVITY" | "OPERATION_PROGRESS" };
  lastSuccessfulTool: { toolName: string; callId: string | null; finishedAt: string | null; participantId: string; sessionId: string } | null;
  capturedAt: string;
}

const COMMAND_TAIL_BYTES = 48 * 1024;
const MAX_CHANGED_FILES = 1_000;
const MAX_CHANGED_CONTENT_BYTES = 64 * 1024 * 1024;

/** Persist bounded command diagnostics under the durable operation identity. */
export async function persistCommandDiagnosticV1(input: {
  root: string;
  operationId?: string;
  command: string;
  cwd: string;
  result: ProcessResult;
  toolName: string;
  toolVersion?: string;
  environment?: Record<string, string | undefined>;
  startedAt?: string;
  finishedAt?: string;
}): Promise<string | undefined> {
  const operationId = input.operationId?.trim() || currentOperationContext().id;
  if (!operationId) return undefined;
  const stateRoot = resolveOperationStateRoot(input.root);
  const operation = await loadOperation(stateRoot, operationId).catch(() => undefined);
  const candidate = operation?.candidateRevision;
  const finishedAt = input.finishedAt ?? new Date().toISOString();
  const startedAt = input.startedAt ?? new Date(Date.parse(finishedAt) - input.result.durationMs).toISOString();
  const environment = sanitizeEnvironment({ ...process.env, ...(input.environment ?? {}) });
  const body: CommandDiagnosticV1 = {
    version: 1,
    kind: "command-diagnostic",
    operationId,
    candidate: candidate ? { candidateId: candidate.candidateId, revision: candidate.revision, digest: candidate.identityDigest } : null,
    command: { display: redactCommand(input.command).slice(0, 2_000), digest: sha256Utf8(input.command) },
    cwd: path.resolve(input.cwd),
    workspaceIdentity: sha256Canonical({ cwd: path.resolve(input.cwd), candidateId: candidate?.candidateId ?? null, candidateDigest: candidate?.identityDigest ?? null }),
    exitCode: input.result.exitCode,
    stdout: {
      digest: input.result.stdoutDigest ?? sha256Utf8(input.result.stdout),
      bytes: input.result.stdoutBytes ?? Buffer.byteLength(input.result.stdout),
      diagnosticTail: redactDiagnostic(tailUtf8(input.result.stdout, COMMAND_TAIL_BYTES))
    },
    stderr: {
      digest: input.result.stderrDigest ?? sha256Utf8(input.result.stderr),
      bytes: input.result.stderrBytes ?? Buffer.byteLength(input.result.stderr),
      diagnosticTail: redactDiagnostic(tailUtf8(input.result.stderr, COMMAND_TAIL_BYTES))
    },
    environment,
    tool: { name: input.toolName.slice(0, 120), version: input.toolVersion?.slice(0, 200) ?? null },
    startedAt,
    finishedAt,
    durationMs: Math.max(0, input.result.durationMs),
    timedOut: input.result.timedOut === true
  };
  const file = path.join(operationArtifactDir(stateRoot, operationId), "diagnostics", `command-${Date.parse(finishedAt)}-${randomUUID()}.json`);
  await writeJsonAtomic(file, body);
  return path.relative(stateRoot, file).replaceAll("\\", "/");
}

/** Snapshot candidate facts before terminal resource reconciliation removes workspaces. */
export async function persistCandidateForensicsV1(root: string, operation: OperationRecordV2): Promise<{ path: string; artifact: CandidateForensicsV1 }> {
  const stateRoot = resolveOperationStateRoot(root);
  const candidate = operation.candidateRevision;
  const key = candidate ? candidate.candidateId : "candidate-unknown";
  const file = path.join(operationArtifactDir(stateRoot, operation.id), "forensics", `candidate-${safe(key)}.json`);
  const existing = await fs.readFile(file, "utf8").then((content) => JSON.parse(content) as CandidateForensicsV1).catch(() => undefined);
  if (existing?.version === 1 && existing.kind === "failed-candidate-forensics" && existing.operationId === operation.id) {
    return { path: path.relative(stateRoot, file).replaceAll("\\", "/"), artifact: existing };
  }
  const workspace = candidate?.worktree ?? operation.root;
  let changedFiles: string[] = [];
  let changedFilesTruncated = false;
  let diffDigest: string | null = null;
  let diffDigestCoverage: CandidateForensicsV1["diffDigestCoverage"] = "UNAVAILABLE";
  if (workspace && await isDirectory(workspace)) {
    try {
      const [tracked, untracked, diff] = await Promise.all([
        runExecutable("git", ["diff", "--name-only", "-z", "HEAD", "--"], { cwd: workspace, timeoutMs: 30_000, captureOutputLimitBytes: 1024 * 1024 }),
        runExecutable("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: workspace, timeoutMs: 30_000, captureOutputLimitBytes: 1024 * 1024 }),
        runExecutable("git", ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"], { cwd: workspace, timeoutMs: 60_000, captureOutputLimitBytes: 16 * 1024 })
      ]);
      const all = [...new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean))].sort();
      changedFilesTruncated = all.length > MAX_CHANGED_FILES;
      changedFiles = all.slice(0, MAX_CHANGED_FILES).map((file) => file.slice(0, 2_000));
      const trackedOk = tracked.exitCode === 0;
      const untrackedOk = untracked.exitCode === 0;
      const diffOk = diff.exitCode === 0 && !diff.timedOut;
      const contentDigests: Array<{ path: string; digest: string | null; bytes: number | null }> = [];
      let contentBytes = 0;
      let contentComplete = true;
      for (const relative of all.slice(0, MAX_CHANGED_FILES)) {
        const absolute = path.resolve(workspace, relative);
        if (!absolute.startsWith(`${path.resolve(workspace)}${path.sep}`)) { contentComplete = false; continue; }
        try {
          const stat = await fs.lstat(absolute);
          if (!stat.isFile() || stat.size > MAX_CHANGED_CONTENT_BYTES - contentBytes) { contentComplete = false; contentDigests.push({ path: relative, digest: null, bytes: stat.size }); continue; }
          const content = await fs.readFile(absolute);
          contentBytes += content.byteLength;
          contentDigests.push({ path: relative, digest: sha256Utf8(content), bytes: content.byteLength });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") contentDigests.push({ path: relative, digest: null, bytes: null });
          else { contentComplete = false; contentDigests.push({ path: relative, digest: null, bytes: null }); }
        }
      }
      const trackedDigest = diff.stdoutDigest ?? sha256Utf8(diff.stdout);
      diffDigest = sha256Canonical({ trackedDiffDigest: trackedDigest, changedContent: contentDigests });
      diffDigestCoverage = trackedOk && untrackedOk && diffOk && contentComplete && !changedFilesTruncated ? "COMPLETE" : "PARTIAL";
    } catch { /* forensic capture must not interfere with cleanup */ }
  }

  const validationReferences = validationArtifactReferences(operation);
  const validationDiagnostics = await captureValidationDiagnostics(stateRoot, workspace, validationReferences);
  const participants = Object.values(operation.participants ?? {});
  type ActivityObservation = { at: string; participantId: string | null; role: string | null; phase: string | null; source: CandidateForensicsV1["lastActivity"]["source"] };
  const participantActivities: ActivityObservation[] = participants.map((participant) => ({
    at: participant.executionLiveness?.lastActivityAt ?? participant.finishedAt ?? participant.startedAt ?? participant.registeredAt,
    participantId: participant.id,
    role: participant.role ?? null,
    phase: participant.phase ?? participant.stage ?? null,
    source: "PARTICIPANT_RECORD" as const
  }));
  let lastSuccessfulTool: CandidateForensicsV1["lastSuccessfulTool"] = null;
  const activityCandidates: ActivityObservation[] = [...participantActivities];
  try {
    const observations = await readOperationEfficiencyObservations(stateRoot, operation.id);
    for (const observation of observations.participants) {
      const at = observation.finishedAt ?? observation.startedAt;
      if (at) activityCandidates.push({ at, participantId: observation.participantId, role: observation.role, phase: observation.phase, source: "USAGE_OBSERVATION" });
    }
    for (const observation of observations.tools) {
      const at = observation.finishedAt ?? observation.startedAt;
      if (at) activityCandidates.push({ at, participantId: observation.participantId, role: observation.role, phase: observation.phase, source: "TOOL_OBSERVATION" });
    }
    for (const event of observations.activity) activityCandidates.push({ at: event.observedAt, participantId: event.participantId, role: event.role, phase: event.phase, source: "EXECUTION_ACTIVITY" });
    const success = observations.tools.filter((item) => item.outcome === "SUCCESS")
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0];
    if (success) lastSuccessfulTool = { toolName: success.toolName, callId: success.callId, finishedAt: success.finishedAt, participantId: success.participantId, sessionId: success.sessionId };
    if (!lastSuccessfulTool) {
      const successfulActivity = observations.activity.filter((item) => item.kind === "TOOL_SUCCESS_NONREDUNDANT")
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
      if (successfulActivity?.toolName) lastSuccessfulTool = { toolName: successfulActivity.toolName, callId: successfulActivity.toolCallId ?? null, finishedAt: successfulActivity.observedAt, participantId: successfulActivity.participantId, sessionId: successfulActivity.sessionId };
    }
  } catch { /* tool evidence is explicitly absent when unavailable */ }
  const mostRecent = activityCandidates.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))[0];
  const artifact: CandidateForensicsV1 = {
    version: 1,
    kind: "failed-candidate-forensics",
    operationId: operation.id,
    operationStatus: operation.status,
    candidate: candidate ? { candidateId: candidate.candidateId, revision: candidate.revision, digest: candidate.identityDigest } : null,
    workspace: workspace ?? null,
    changedFiles,
    changedFilesTruncated,
    diffDigest,
    diffDigestCoverage,
    validationReferences,
    validationDiagnostics,
    lastActivity: {
      at: mostRecent?.at ?? operation.lastProgressAt ?? null,
      participantId: mostRecent?.participantId ?? null,
      role: mostRecent?.role ?? null,
      phase: mostRecent?.phase ?? operation.phase ?? null,
      source: mostRecent?.source ?? "OPERATION_PROGRESS"
    },
    lastSuccessfulTool,
    capturedAt: new Date().toISOString()
  };
  await writeJsonAtomic(file, artifact);
  return { path: path.relative(stateRoot, file).replaceAll("\\", "/"), artifact };
}

function sanitizeEnvironment(environment: Record<string, string | undefined>): CommandDiagnosticV1["environment"] {
  const keys = Object.keys(environment).sort();
  const safeValues = ["CI", "LANG", "LC_ALL", "NODE_ENV"].map((key) => [key, environment[key] ?? null]);
  return { platform: process.platform, nodeVersion: process.version, keys: keys.slice(0, 300), digest: sha256Canonical({ keys, safeValues }) };
}

function redactCommand(command: string): string {
  return redactAuthorization(command)
    .replace(/((?:[A-Za-z0-9_-]*(?:password|passwd|token|secret|credential|cookie|api[_-]?key|access[_-]?key|private[_-]?key|authorization)[A-Za-z0-9_-]*)\s*(?:=|:)\s*)([^\s]+)/gi, "$1[REDACTED]")
    .replace(/(--(?:password|passwd|token|secret|api-key|authorization))(?:=|\s+)([^\s]+)/gi, "$1=[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function tailUtf8(value: string, limit: number): string {
  const bytes = Buffer.from(value, "utf8");
  return (bytes.byteLength <= limit ? bytes : bytes.subarray(bytes.byteLength - limit)).toString("utf8");
}

function validationArtifactReferences(operation: OperationRecordV2): CandidateForensicsV1["validationReferences"] {
  const references: CandidateForensicsV1["validationReferences"] = [];
  for (const stage of Object.values(operation.stages ?? {})) {
    if (stage.artifact || /valid|test|build|review|acceptance/i.test(stage.name)) references.push({ phase: stage.name, status: stage.status, ...(stage.artifact ? { artifact: stage.artifact } : {}) });
  }
  for (const participant of Object.values(operation.participants ?? {})) {
    if (participant.resultArtifact && /valid|test|build|review|acceptance/i.test(`${participant.role ?? ""} ${participant.phase ?? participant.stage ?? ""}`)) {
      references.push({ phase: participant.phase ?? participant.stage ?? participant.role ?? "participant", status: participant.status, artifact: participant.resultArtifact });
    }
  }
  return references.slice(0, 200);
}

async function captureValidationDiagnostics(
  stateRoot: string,
  workspace: string | undefined,
  references: CandidateForensicsV1["validationReferences"]
): Promise<CandidateForensicsV1["validationDiagnostics"]> {
  const result: CandidateForensicsV1["validationDiagnostics"] = [];
  for (const reference of references) {
    if (!reference.artifact || result.length >= 50) continue;
    const candidates = [...new Set([path.resolve(stateRoot, reference.artifact), ...(workspace ? [path.resolve(workspace, reference.artifact)] : [])])]
      .filter((candidate) => isInside(candidate, stateRoot) || (workspace !== undefined && isInside(candidate, workspace)));
    let file: string | undefined;
    for (const candidate of candidates) { if (await fs.stat(candidate).then((stat) => stat.isFile()).catch(() => false)) { file = candidate; break; } }
    if (!file) continue;
    const digest = createHash("sha256");
    let byteLength = 0;
    let tail: Buffer = Buffer.alloc(0);
    try {
      for await (const chunkValue of createReadStream(file)) {
        const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
        digest.update(chunk);
        byteLength += chunk.byteLength;
        tail = appendTail(tail, chunk, 12 * 1024);
      }
      result.push({ reference: reference.artifact, digest: digest.digest("hex"), bytes: byteLength, diagnosticTail: redactDiagnostic(tail.toString("utf8")) });
    } catch { /* missing or unreadable referenced reports remain visible as references */ }
  }
  return result;
}

function isInside(file: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function appendTail(previous: Buffer, next: Buffer, limit: number): Buffer {
  if (next.byteLength >= limit) return Buffer.from(next.subarray(next.byteLength - limit));
  const combined = previous.byteLength ? Buffer.concat([previous, next]) : Buffer.from(next);
  return combined.byteLength <= limit ? combined : Buffer.from(combined.subarray(combined.byteLength - limit));
}

function redactDiagnostic(value: string): string {
  return redactAuthorization(value)
    .replace(/((?:[A-Za-z0-9_-]*(?:password|passwd|token|secret|credential|cookie|api[_-]?key|access[_-]?key|private[_-]?key|authorization)[A-Za-z0-9_-]*)\s*[:=]\s*)[^\s,;"']+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function redactAuthorization(value: string): string {
  return value
    .replace(/((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;"']+/gi, "$1[REDACTED]")
    .replace(/((?:proxy-)?authorization\s+)(?:bearer|basic)\s+[^\s,;"']+/gi, "$1[REDACTED]");
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}

async function isDirectory(directory: string): Promise<boolean> {
  try { return (await fs.stat(directory)).isDirectory(); } catch { return false; }
}

function safe(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 180); }
