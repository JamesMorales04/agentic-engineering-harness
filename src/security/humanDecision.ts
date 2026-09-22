import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertCandidateRevisionV1, candidateRevisionsEqual, type CandidateRevisionV1 } from "../operations/v2Contracts.js";

export type HumanDecisionKindV1 = "APPROVE" | "REJECT" | "OVERRIDE" | "CANCEL" | "RETRY" | "ACKNOWLEDGE";
export const humanDecisionKindValues = ["APPROVE", "REJECT", "OVERRIDE", "CANCEL", "RETRY", "ACKNOWLEDGE"] as const;
export interface HumanDecisionV1 {
  version: 1;
  decisionId: string;
  operationId: string;
  candidate: CandidateRevisionV1;
  kind: HumanDecisionKindV1;
  actorId: string;
  reason: string;
  createdAt: string;
  expiresAt?: string;
}

export class HumanDecisionError extends Error {
  constructor(message: string) { super(message); this.name = "HumanDecisionError"; }
}

function required(value: string, name: string): string {
  if (!value.trim()) throw new HumanDecisionError(`${name} must not be empty.`);
  return value.trim();
}

function instant(value: string, name: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HumanDecisionError(`${name} must be a valid instant.`);
  return date.toISOString();
}

export interface HumanDecisionInputV1 {
  operationId: string;
  candidate: CandidateRevisionV1;
  kind: HumanDecisionKindV1;
  actorId: string;
  reason: string;
  createdAt?: string | Date;
  expiresAt?: string | Date;
}

export class HumanDecisionLedgerV1 {
  constructor(private readonly filePath: string) {}

  async record(input: HumanDecisionInputV1): Promise<HumanDecisionV1> {
    assertCandidateRevisionV1(input.candidate);
    const operationId = required(input.operationId, "operationId");
    if (input.candidate.operationId !== operationId) throw new HumanDecisionError("candidate and decision operation must match.");
    if (!humanDecisionKindValues.includes(input.kind)) throw new HumanDecisionError(`unsupported human decision kind '${String(input.kind)}'.`);
    const actorId = required(input.actorId, "actorId");
    if (actorId.toLowerCase().startsWith("model:") || actorId.toLowerCase().startsWith("agent:")) throw new HumanDecisionError("only an external human authority may record this decision.");
    const createdAt = instant(input.createdAt instanceof Date ? input.createdAt.toISOString() : input.createdAt ?? new Date().toISOString(), "createdAt");
    const expiresAt = input.expiresAt === undefined ? undefined : instant(input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt, "expiresAt");
    if (expiresAt && new Date(expiresAt).getTime() <= new Date(createdAt).getTime()) throw new HumanDecisionError("expiresAt must be after createdAt.");
    const decision: HumanDecisionV1 = { version: 1, decisionId: `decision:${crypto.randomUUID()}`, operationId, candidate: input.candidate, kind: input.kind, actorId, reason: required(input.reason, "reason"), createdAt, ...(expiresAt ? { expiresAt } : {}) };
    const current = await this.list();
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, `${JSON.stringify([...current, decision], null, 2)}\n`, { mode: 0o600 });
    return decision;
  }

  async list(): Promise<HumanDecisionV1[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new HumanDecisionError("human decision ledger is malformed.");
      return parsed as HumanDecisionV1[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async active(operationId: string, candidate: CandidateRevisionV1, now = new Date()): Promise<HumanDecisionV1[]> {
    assertCandidateRevisionV1(candidate);
    const at = now.getTime();
    return (await this.list()).filter((decision) => decision.operationId === operationId && candidateRevisionsEqual(decision.candidate, candidate) && (!decision.expiresAt || new Date(decision.expiresAt).getTime() > at));
  }
}
