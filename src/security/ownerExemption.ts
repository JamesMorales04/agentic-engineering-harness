import crypto from "node:crypto";
import { canonicalSerialize } from "../core/digest.js";

/**
 * Owner-scoped hard-protection exemption grant (DETERMINISTIC mechanism).
 *
 * Authority model: model output must not grant authority — only verify gates.
 * The HumanDecision ledger file carrying the exemption intent is writable by
 * any shell with state-root filesystem access and its `human:*` actorId is
 * self-declared at the ledger layer (authentication happens at the
 * human surfaces: paired Control Center session, managed-CLI refusal). This
 * grant is the OWNER-BINDING a shell caller cannot forge:
 *
 * - `mac` = HMAC-SHA256(controllerToken, canonical(grant body)). The
 *   controller token (32 random bytes minted at claimControllerEpoch) is
 *   NEVER inherited by managed children: managed agent environments are
 *   fresh-built (operations/executionContext.ts), direct worker environments
 *   are allowlisted (workers/directProcess.ts SAFE_RUNTIME_ENVIRONMENT), and
 *   managed-child scrubbing removes AEH_CONTROLLER_TOKEN/EPOCH
 *   (utils/process.ts MANAGED_CHILD_ENV_SCRUB_KEYS). Only the live
 *   controller process holding the token can mint or verify a grant.
 * - The MAC body binds `operationId` + `controllerEpoch` + live operation
 *   identities (`candidateRevision`, `candidateIdentityDigest`, `policyDigest`,
 *   `operationExecutionRevision`): replay across operations, reuse after a
 *   controller takeover (epoch increment), or reuse after a same-epoch
 *   candidate/policy/revision advance fails the MAC/binding check. Terminal
 *   operations strip their grants (and every verifier independently refuses
 *   terminal records), so lifetime is bounded by the operation's terminal
 *   state.
 *
 * TRUST ASSUMPTION (explicit): the controller token stays secret to the
 * controller process. If it leaks, ALL controller authority (not just this
 * exemption) is compromised — the exemption adds no new weakness. Ledger
 * files are intent evidence, never authority: every use re-verifies the MAC
 * against the live token plus operation binding, expiry, ledger cross-check
 * (consumed PRODUCT_CHOICE approval bound to its WAITING continuation),
 * and exact-path coverage.
 *
 * Issuance (DETERMINISTIC, no model judgment): grants are minted ONLY by the
 * controller after a bounded suspend/decide/resume for hard-protected repair
 * paths (approve-exact-set/decline generated deterministically from the
 * declared blocker). Standalone ledger-scan issuance was deleted as unsound.
 *
 * Mechanism classification: DETERMINISTIC. HMAC verification, exact-match
 * path coverage, epoch/terminal/expiry gates. No model judgment anywhere.
 */

export const OWNER_HARD_PROTECTION_EXEMPTION_VERSION = 1 as const;
export const OWNER_EXEMPTION_ID_PATTERN = /^exemption:[0-9a-f-]{36}$/i;

export interface OwnerHardProtectionExemptionGrantV1 {
  version: 1;
  kind: "OWNER_HARD_PROTECTION_EXEMPTION";
  /** DETERMINISTIC mechanism marker: verified cryptographically, never model authority. */
  mechanism: "DETERMINISTIC";
  exemptionId: string;
  operationId: string;
  controllerEpoch: number;
  /** Live candidate revision bound at anchor; same-epoch advance invalidates. */
  candidateRevision: number;
  /** Live candidate identityDigest bound at anchor; same-epoch advance invalidates. */
  candidateIdentityDigest: string;
  /** Live frozen policy digest bound at anchor; same-epoch advance invalidates. */
  policyDigest: string;
  /** Live operation execution revision bound at anchor; same-epoch advance invalidates. */
  operationExecutionRevision: number;
  /** Exact files only (sorted, unique, no globs); new-file paths allowed. */
  paths: string[];
  /** Ledger provenance: the consumed CHOOSE/PRODUCT_CHOICE approval (bound to its WAITING continuation) this controller-minted grant anchors. */
  decisionId: string;
  decisionDigest: string;
  decidedActor: string;
  decisionReason: string;
  createdAt: string;
  expiresAt?: string;
  /** HMAC-SHA256(controllerToken, canonical(body without mac)), lowercase hex. */
  mac: string;
}

export type OwnerExemptionGrantBodyV1 = Omit<OwnerHardProtectionExemptionGrantV1, "mac">;

export function ownerExemptionGrantBody(grant: OwnerHardProtectionExemptionGrantV1): OwnerExemptionGrantBodyV1 {
  const { mac: _discarded, ...body } = grant;
  void _discarded;
  return body;
}

/** Mint a grant body MAC. Token must be the live controller token (hex). */
export function computeOwnerExemptionMac(token: string, body: OwnerExemptionGrantBodyV1): string {
  if (!token || !token.trim()) throw new Error("OWNER_EXEMPTION_TOKEN_REQUIRED: minting an owner exemption requires the live controller token.");
  return crypto.createHmac("sha256", token.trim()).update(canonicalSerialize(body), "utf8").digest("hex");
}

/** Recompute-and-compare a grant MAC in constant time. Pure sync: usable in sync gates. */
export function verifyOwnerExemptionMac(token: string | undefined, grant: OwnerHardProtectionExemptionGrantV1): boolean {
  if (!token || !token.trim()) return false;
  if (!/^[a-f0-9]{64}$/.test(grant.mac)) return false;
  let expected: string;
  try {
    expected = computeOwnerExemptionMac(token, ownerExemptionGrantBody(grant));
  } catch {
    return false;
  }
  const actual = Buffer.from(grant.mac, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

function requiredText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`OWNER_EXEMPTION_GRANT_INVALID: ${name} must not be empty.`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`OWNER_EXEMPTION_GRANT_INVALID: ${name} exceeds ${maxLength} characters.`);
  return text;
}

function instant(value: unknown, name: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`OWNER_EXEMPTION_GRANT_INVALID: ${name} must be a valid instant.`);
  return value;
}

/**
 * Structural assert for a durable grant (shape only — no token needed, so it
 * is safe at operation-record load time). MAC validity is checked at every
 * USE, never at rest.
 */
export function assertOwnerHardProtectionExemptionGrant(value: unknown): asserts value is OwnerHardProtectionExemptionGrantV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: grant must be an object.");
  const record = value as Record<string, unknown>;
  const allowed = ["version", "kind", "mechanism", "exemptionId", "operationId", "controllerEpoch", "candidateRevision", "candidateIdentityDigest", "policyDigest", "operationExecutionRevision", "paths", "decisionId", "decisionDigest", "decidedActor", "decisionReason", "createdAt", "expiresAt", "mac"];
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`OWNER_EXEMPTION_GRANT_INVALID: unsupported fields: ${extra.join(", ")}.`);
  const grant = value as OwnerHardProtectionExemptionGrantV1;
  if (grant.version !== OWNER_HARD_PROTECTION_EXEMPTION_VERSION || grant.kind !== "OWNER_HARD_PROTECTION_EXEMPTION" || grant.mechanism !== "DETERMINISTIC") {
    throw new Error("OWNER_EXEMPTION_GRANT_INVALID: grant requires version 1 with DETERMINISTIC mechanism.");
  }
  if (!OWNER_EXEMPTION_ID_PATTERN.test(requiredText(grant.exemptionId, "exemptionId", 64))) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: exemptionId must be 'exemption:<uuid>'.");
  requiredText(grant.operationId, "operationId", 200);
  if (!Number.isSafeInteger(grant.controllerEpoch) || grant.controllerEpoch < 0) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: controllerEpoch must be a non-negative safe integer.");
  if (!Number.isSafeInteger(grant.candidateRevision) || grant.candidateRevision < 1) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: candidateRevision must be a positive safe integer.");
  if (!/^[a-f0-9]{64}$/.test(grant.candidateIdentityDigest)) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: candidateIdentityDigest must be a lowercase SHA-256 digest.");
  if (!/^[a-f0-9]{64}$/.test(grant.policyDigest)) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: policyDigest must be a lowercase SHA-256 digest.");
  if (!Number.isSafeInteger(grant.operationExecutionRevision) || grant.operationExecutionRevision < 1) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: operationExecutionRevision must be a positive safe integer.");
  if (!Array.isArray(grant.paths) || grant.paths.length < 1 || grant.paths.length > 8) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: grant paths must contain 1 to 8 exact files.");
  for (const entry of grant.paths) requiredText(entry, "grant path", 500);
  const sorted = [...new Set(grant.paths)].sort((a, b) => a.localeCompare(b));
  if (sorted.length !== grant.paths.length || sorted.some((entry, index) => entry !== grant.paths[index])) {
    throw new Error("OWNER_EXEMPTION_GRANT_INVALID: grant paths must be sorted and unique.");
  }
  if (!/^decision:[0-9a-f-]{36}$/i.test(requiredText(grant.decisionId, "decisionId", 64))) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: decisionId must be the ledger HumanDecision id.");
  if (!/^[a-f0-9]{64}$/.test(grant.decisionDigest)) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: decisionDigest must be a lowercase SHA-256 digest.");
  const actor = requiredText(grant.decidedActor, "decidedActor", 200);
  if (!actor.startsWith("human:")) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: decidedActor must be a human authority.");
  requiredText(grant.decisionReason, "decisionReason", 2000);
  instant(grant.createdAt, "createdAt");
  if (grant.expiresAt !== undefined) {
    const expiresAt = instant(grant.expiresAt, "expiresAt");
    if (new Date(expiresAt).getTime() <= new Date(grant.createdAt).getTime()) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: expiresAt must be after createdAt.");
  }
  if (!/^[a-f0-9]{64}$/.test(grant.mac)) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: mac must be a lowercase SHA-256 hex digest.");
}
