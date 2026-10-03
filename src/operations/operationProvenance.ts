import { z } from "zod";
import { sha256Canonical } from "../core/digest.js";

export interface OperationOwnerResolutionRefV1 {
  kind: "OWNER_ECONOMIC_BOUNDARY" | "OWNER_HARD_DEADLINE" | "FAILED_TASK_CHAIN" | "CANCELLED_TASK_CHAIN";
  operationId: string;
  operationRevision: number;
  evidenceDigest: string;
}

export interface OperationOriginV1 {
  version: 1;
  kind: "USER_REQUEST" | "LEAD_ACTION" | "FAILED_OPERATION_RECOVERY" | "EXPLICIT_CLI";
  leadAgentId?: string;
  controllerOwnerId?: string;
  requestEventId?: string;
  /** Exact pending Owner boundaries/task chains explicitly resolved by this CLI request. */
  ownerResolutionRefs?: OperationOwnerResolutionRefV1[];
  authorizationDigest: string;
  userTurnId?: string;
  parentOperationId?: string;
  parentTerminalRevision?: number;
  triggerEventId: string;
  requestDigest: string;
  inheritedAuthorityDigest?: string;
  inheritedEconomicUsageDigest?: string;
  recoveryDepth: number;
  rootHardDeadlineAt: string;
  reason: string;
  createdAt: string;
  digest: string;
}

const originBodySchema = z.object({
  version: z.literal(1),
  kind: z.enum(["USER_REQUEST", "LEAD_ACTION", "FAILED_OPERATION_RECOVERY", "EXPLICIT_CLI"]),
  leadAgentId: z.string().min(1).optional(),
  controllerOwnerId: z.string().min(1).optional(),
  requestEventId: z.string().min(1).optional(),
  ownerResolutionRefs: z.array(z.object({
    kind: z.enum(["OWNER_ECONOMIC_BOUNDARY", "OWNER_HARD_DEADLINE", "FAILED_TASK_CHAIN", "CANCELLED_TASK_CHAIN"]),
    operationId: z.string().min(1),
    operationRevision: z.number().int().positive(),
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict()).max(500).optional(),
  authorizationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  userTurnId: z.string().min(1).optional(),
  parentOperationId: z.string().min(1).optional(),
  parentTerminalRevision: z.number().int().positive().optional(),
  triggerEventId: z.string().min(1),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  inheritedAuthorityDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  inheritedEconomicUsageDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  recoveryDepth: z.number().int().nonnegative(),
  rootHardDeadlineAt: z.string().datetime(),
  reason: z.string().min(1).max(1000),
  createdAt: z.string().datetime()
}).strict();

export function compileOperationOriginV1(input: Omit<OperationOriginV1, "version" | "digest">): OperationOriginV1 {
  const body = { version: 1 as const, ...input };
  assertOperationOriginV1({ ...body, digest: sha256Canonical(body) });
  return { ...body, digest: sha256Canonical(body) };
}

export function assertOperationOriginV1(value: unknown): asserts value is OperationOriginV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OPERATION_ORIGIN_INVALID: expected an object.");
  const record = value as OperationOriginV1;
  const parsed = originBodySchema.safeParse(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "digest")));
  if (!parsed.success) throw new Error(`OPERATION_ORIGIN_INVALID: ${parsed.error.issues.map((item) => `${item.path.join(".")}: ${item.message}`).join("; ")}`);
  if (record.kind === "FAILED_OPERATION_RECOVERY" && (!record.parentOperationId || !record.parentTerminalRevision || !record.inheritedAuthorityDigest || !record.inheritedEconomicUsageDigest)) throw new Error("OPERATION_ORIGIN_INVALID: recovery continuations require a terminal parent, inherited authority, and exact parent economic-usage snapshot digest.");
  if (record.kind !== "FAILED_OPERATION_RECOVERY" && (record.parentOperationId || record.parentTerminalRevision || record.inheritedAuthorityDigest || record.inheritedEconomicUsageDigest)) throw new Error("OPERATION_ORIGIN_INVALID: only recovery continuations may carry parent authority.");
  if (record.ownerResolutionRefs?.length && record.kind !== "EXPLICIT_CLI") throw new Error("OPERATION_ORIGIN_INVALID: only an explicit Owner CLI origin may resolve pending Owner boundaries or failed task chains.");
  if (record.ownerResolutionRefs && new Set(record.ownerResolutionRefs.map((item) => `${item.kind}:${item.operationId}`)).size !== record.ownerResolutionRefs.length) throw new Error("OPERATION_ORIGIN_INVALID: Owner resolution references must be unique by kind and operation.");
  if (record.kind === "USER_REQUEST" && !record.userTurnId) throw new Error("OPERATION_ORIGIN_INVALID: USER_REQUEST requires the durable originating userTurnId; use LEAD_ACTION when only a tool event is known.");
  if (record.kind === "LEAD_ACTION" && (!record.leadAgentId || !record.requestEventId)) throw new Error("OPERATION_ORIGIN_INVALID: LEAD_ACTION requires the bound Lead identity and exact request event id.");
  if (!/^[a-f0-9]{64}$/.test(record.digest) || sha256Canonical(parsed.data) !== record.digest) throw new Error("OPERATION_ORIGIN_INVALID: digest is inconsistent.");
}
