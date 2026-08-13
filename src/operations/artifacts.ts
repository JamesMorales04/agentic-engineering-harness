import fs from "node:fs/promises";
import path from "node:path";
import { operationArtifactDir } from "./state.js";

export type OperationArtifactKind = "agent" | "consolidation" | "supervisor-checkpoint";

export interface OperationArtifactEnvelope<T = unknown> {
  version: 1;
  operationId: string;
  kind: OperationArtifactKind;
  key: string;
  createdAt: string;
  payload: T;
}

export async function persistOperationAgentArtifact<T>(
  root: string,
  operationId: string,
  key: string,
  payload: T
): Promise<string> {
  return persistArtifact(root, operationId, "agent", "agents", key, payload);
}

export async function persistOperationConsolidation<T>(
  root: string,
  operationId: string,
  key: string,
  payload: T
): Promise<string> {
  return persistArtifact(root, operationId, "consolidation", "consolidations", key, payload);
}

export async function persistSupervisorCheckpoint<T>(
  root: string,
  operationId: string,
  generation: number,
  payload: T
): Promise<string> {
  return persistArtifact(root, operationId, "supervisor-checkpoint", "supervisors", `generation-${generation}`, payload);
}

export async function loadOperationArtifact<T = unknown>(root: string, relativePath: string): Promise<OperationArtifactEnvelope<T>> {
  return JSON.parse(await fs.readFile(path.resolve(root, relativePath), "utf8")) as OperationArtifactEnvelope<T>;
}

async function persistArtifact<T>(
  root: string,
  operationId: string,
  kind: OperationArtifactKind,
  directory: string,
  key: string,
  payload: T
): Promise<string> {
  const safe = safeKey(key);
  const dir = path.join(operationArtifactDir(root, operationId), directory);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safe}.json`);
  const envelope: OperationArtifactEnvelope<T> = {
    version: 1,
    operationId,
    kind,
    key,
    createdAt: new Date().toISOString(),
    payload
  };
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(envelope, null, 2)}\n`);
  try {
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
  return path.relative(root, file).replaceAll("\\", "/");
}

function safeKey(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("operation artifact key is required");
  return normalized;
}
