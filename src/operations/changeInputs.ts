import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { operationArtifactDir, resolveOperationStateRoot } from "./state.js";

export interface ChangeInputReference {
  kind: "audit";
  id: string;
  sourceArtifact: string;
  artifact: string;
  sha256: string;
  summary: Record<string, unknown>;
}

interface ChangeInputEnvelope {
  version: 1;
  kind: "change-input";
  operationId: string;
  input: Omit<ChangeInputReference, "artifact" | "summary">;
  capturedAt: string;
  payload: unknown;
}

const AUDIT_ID = /\bAUDIT-\d{8}T\d{6}Z-[A-Za-z0-9._-]+\b/g;

/**
 * Canonical audit id: strips a trailing .json extension so references written
 * with or without the suffix resolve to the same `.harness/audits/<id>.json`
 * artifact without duplicating the extension.
 */
function canonicalAuditId(raw: string): string {
  return raw.replace(/\.json$/i, "");
}

export async function resolveChangeInputs(controlRoot: string, operationId: string, request: string): Promise<ChangeInputReference[]> {
  const ids = [...new Set((request.match(AUDIT_ID) ?? []).map(canonicalAuditId))];
  const result: ChangeInputReference[] = [];
  for (const id of ids) result.push(await freezeAuditInput(controlRoot, operationId, id));
  return result;
}

export function changeInputsPrompt(inputs: ChangeInputReference[]): string {
  if (!inputs.length) return "Controller-resolved durable inputs: none.";
  return [
    "Controller-resolved durable inputs (authoritative provenance; artifact paths are relative to AEH_CONTROL_ROOT):",
    JSON.stringify(inputs, null, 2)
  ].join("\n");
}

async function freezeAuditInput(controlRoot: string, operationId: string, auditId: string): Promise<ChangeInputReference> {
  const stateRoot = resolveOperationStateRoot(controlRoot);
  const auditsRoot = path.resolve(stateRoot, ".harness", "audits");
  const source = path.resolve(auditsRoot, `${auditId}.json`);
  if (!inside(auditsRoot, source)) throw new Error(`CHANGE_INPUT_INVALID_PATH: ${auditId}`);
  let raw: string;
  try { raw = await fs.readFile(source, "utf8"); }
  catch (error) { throw new Error(`CHANGE_INPUT_ARTIFACT_MISSING: referenced audit '${auditId}' is not available at ${path.relative(stateRoot, source)}: ${String(error)}`); }
  let payload: unknown;
  try { payload = JSON.parse(raw); }
  catch (error) { throw new Error(`CHANGE_INPUT_ARTIFACT_INVALID: referenced audit '${auditId}' is not valid JSON: ${String(error)}`); }
  const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
  const dir = path.join(operationArtifactDir(stateRoot, operationId), "inputs");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safe(auditId)}.json`);
  const sourceArtifact = path.relative(stateRoot, source).replaceAll("\\", "/");
  const envelope: ChangeInputEnvelope = {
    version: 1,
    kind: "change-input",
    operationId,
    input: { kind: "audit", id: auditId, sourceArtifact, sha256 },
    capturedAt: new Date().toISOString(),
    payload
  };
  await writeAtomic(file, envelope);
  return {
    kind: "audit",
    id: auditId,
    sourceArtifact,
    artifact: path.relative(stateRoot, file).replaceAll("\\", "/"),
    sha256,
    summary: auditSummary(payload)
  };
}

function auditSummary(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { type: typeof payload };
  const record = payload as Record<string, unknown>;
  const findings = Array.isArray(record.consolidatedFindings)
    ? record.consolidatedFindings
    : Array.isArray(record.findings)
      ? record.findings
      : [];
  const findingIds = findings
    .map((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string" ? (item as Record<string, unknown>).id as string : undefined)
    .filter((item): item is string => Boolean(item));
  return {
    status: typeof record.status === "string" ? record.status : undefined,
    summary: typeof record.summary === "string" ? record.summary : undefined,
    findingCount: findings.length,
    findingIds,
    missingEvidence: Array.isArray(record.missingEvidence) ? record.missingEvidence : undefined,
    unresolved: Array.isArray(record.unresolved) ? record.unresolved : undefined
  };
}

function inside(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function safe(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, "-"); }
async function writeAtomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  try { await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}
