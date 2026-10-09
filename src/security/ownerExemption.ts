import crypto from "node:crypto";
import { canonicalSerialize, sha256Canonical } from "../core/digest.js";
import {
  assertCandidateAssemblyReceiptV1,
  type CandidateAssemblyReceiptV1,
} from "../operations/v2Contracts.js";
import type { ResolvedOperationPolicyV2 } from "../architecture/executionIdentity.js";

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
 * - The MAC body binds `operationId` + `controllerEpoch` + the ANCHORED
 *   operation identities (`anchoredCandidateId` + `candidateRevision` +
 *   `candidateIdentityDigest` + anchored exact `policyDigest` +
 *   `operationExecutionRevision`) plus the liveness-compatible identities
 *   (`policyStableDigest` + lineage root). Replay across operations, reuse
 *   after a controller takeover (epoch increment), or reuse after expiry
 *   fails the MAC/binding check. Terminal operations strip their grants (and
 *   every verifier independently refuses terminal records), so lifetime is
 *   bounded by the operation's terminal state.
 *
 * LINEAGE binding (H-NEW-12, LIVE-PROVEN liveness fix): the pre-lineage
 * exact-match honor (`candidateRevision` + `candidateIdentityDigest` +
 * exact `policyDigest` + `operationExecutionRevision` all equal LIVE state)
 * dies during the repair flow it authorizes — normal op progress advances
 * all four within minutes (grant anchored 04:15:27Z, op terminal 04:29:40Z
 * with binding mismatch, only 14 min, expiry NOT lapsed). A grant now covers
 * the ANCHORED revision AND its candidate-lineage DESCENDANTS:
 *
 * - `anchoredCandidateId` roots the lineage (the `candidateId` at anchor,
 *   `candidate:<operationId>:r<revision>`). Honor requires the LIVE
 *   candidate to BE the anchored revision (exact `candidateId` + `revision`
 *   + `identityDigest`) OR to descend from it via the durable
 *   `parentCandidateId` + `candidateAssemblyReceipts` chain
 *   (`isOwnerExemptionLineageDescendant`), verified via the revision CHAIN,
 *   never by revision numbers alone. Siblings (same parent, different child,
 *   same revision number, different digest) share the parent but are NOT
 *   descendants of the anchored revision and are refused.
 * - `policyStableDigest` binds the STABLE policy components instead of the
 *   per-revision exact `policyDigest`. PROOF that exact matching can never
 *   survive (from `compileResolvedOperationPolicy`,
 *   `src/architecture/executionIdentity.ts:206-225`): `operationExecutionRevision`,
 *   `candidateRevision`, `candidateDigest` and `controllerEpoch` are compiled
 *   INTO the policy body hashed into `digest`. Every candidate bind
 *   (`src/operations/state.ts:bindOperationCandidate:687`,
 *   `bindOperationCandidateWithAssemblyReceipt:776,780`) increments
 *   `operationExecutionRevision` and clears `resolvedOperationPolicy`,
 *   forcing a recompile with new revision-varying fields → new exact digest
 *   even when stable config is identical. `ownerExemptionStablePolicyDigest`
 *   therefore hashes every policy field EXCEPT the revision-varying ones
 *   (`operationExecutionRevision`, `candidateRevision`, `candidateDigest`,
 *   `controllerEpoch`, `digest`), each excluded with justification below.
 *   Any stable-config change (route/assurance/policy versions/digests,
 *   validation/review/delivery/knowledge/context policy, liveness/envelope,
 *   allowed effects/requirements) changes the stable digest and kills the
 *   grant fail-closed.
 * - `operationExecutionRevision` live-exact matching is DROPPED (the anchored
 *   value stays MAC-bound for provenance + ledger-decision cross-check, but
 *   honor never compares it to LIVE). Safety: lineage roots scope to one op
 *   lineage (monotonic advance within the same `operationId`), epoch kills
 *   takeovers (takeover increments `controllerEpoch`, retained as an exact
 *   honor check), expiry bounds lifetime, terminal kills the grant. The same
 *   triple covers the dropped candidate/policy exact matches: lineage roots
 *   scope, epoch kills takeovers, expiry bounds lifetime.
 *
 * Excluded-from-stable justification (each dropped field + why safe):
 * - `operationExecutionRevision`: revision-varying, compiled into exact
 *   digest (see proof above); dropped from live honor because lineage +
 *   epoch + expiry + terminal cover it (see above).
 * - `candidateRevision` / `candidateDigest`: revision-varying, compiled into
 *   exact digest; dropped from live exact honor because LINEAGE covers them
 *   (descendant proof via `parentCandidateId` + assembly chain, not revision
 *   numbers; siblings excluded; cross-op refused via `operationId` + lineage
 *   root `candidate:<operationId>:rN`).
 * - `controllerEpoch`: revision-varying, compiled into exact digest; EXCLUDED
 *   from stable BUT RETAINED as a separate exact honor check, so takeovers
 *   still kill grants (post-epoch reuse refused).
 * - `digest`: circular output hash of the body, excluded because it is
 *   derived; the stable digest is recomputed from the stable subset and bound
 *   by the MAC + stable comparison.
 *
 * Threat model (proven in code + tests, `tests/grantLineage*`):
 * - cross-op replay refused (different `operationId` + lineage root
 *   `candidate:<otherOp>:rN` never matches);
 * - post-epoch-takeover refused (exact `controllerEpoch` check retained);
 * - expired refused (`expiresAt` + ledger-decision `expiresAt` retained);
 * - sibling-branch refused (same parent, different child, same revision
 *   number, different digest — NOT a descendant of the anchored revision);
 * - descendant-of-anchored accepted (anchored revision + lineage children).
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
 * Migration (no-backward-compat invariant): pre-lineage v1 grants lack
 * `anchoredCandidateId` + `policyStableDigest` and fail closed with
 * `OWNER_EXEMPTION_GRANT_INVALID` (explicit migration error); they are never
 * honored. The superseded exact-only honor path is deleted.
 *
 * Mechanism classification: DETERMINISTIC. HMAC verification, lineage-chain
 * verification, stable-digest comparison, exact-match path coverage,
 * epoch/terminal/expiry gates. No model judgment anywhere.
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
  /** Lineage root: the `candidateId` at anchor (`candidate:<operationId>:r<revision>`). Honor covers this revision AND its lineage descendants. */
  anchoredCandidateId: string;
  /** ANCHORED candidate revision (exact at anchor; live uses lineage, not exact). */
  candidateRevision: number;
  /** ANCHORED candidate identityDigest (exact at anchor; live uses lineage, not exact). */
  candidateIdentityDigest: string;
  /** ANCHORED exact frozen policy digest (exact at anchor for ledger-decision cross-check; live uses `policyStableDigest`, not exact). */
  policyDigest: string;
  /** STABLE policy digest at anchor (all policy fields except revision-varying ones; live stable must match). */
  policyStableDigest: string;
  /** ANCHORED operation execution revision (MAC-bound provenance + decision cross-check; live exact match DROPPED — covered by lineage + epoch + expiry + terminal). */
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

/**
 * DETERMINISTIC stable policy digest (H-NEW-12 liveness identity).
 *
 * Hashes every `ResolvedOperationPolicyV2` field EXCEPT the revision-varying
 * ones (`operationExecutionRevision`, `candidateRevision`, `candidateDigest`,
 * `controllerEpoch`, `digest`). PROOF that exact matching can never survive:
 * `compileResolvedOperationPolicy` (`src/architecture/executionIdentity.ts:206-225`)
 * compiles all four revision-varying fields INTO the body hashed into
 * `digest`, and every candidate bind (`src/operations/state.ts:687,776,780`)
 * increments `operationExecutionRevision` and clears `resolvedOperationPolicy`,
 * forcing a recompile → new exact digest even when stable config is
 * identical. Exclusion safety is documented on the grant header
 * (lineage roots candidate scope, epoch check retained for takeovers,
 * expiry + terminal bound lifetime).
 */
export function ownerExemptionStablePolicyDigest(policy: ResolvedOperationPolicyV2): string {
  return sha256Canonical({
    version: policy.version,
    projectId: policy.projectId,
    operationId: policy.operationId,
    intent: policy.intent,
    route: policy.route,
    minimumAssurance: policy.minimumAssurance,
    policyVersions: policy.policyVersions,
    policyDigests: policy.policyDigests,
    validationPolicy: policy.validationPolicy,
    reviewPolicy: policy.reviewPolicy,
    deliveryPolicy: policy.deliveryPolicy,
    knowledgePolicy: policy.knowledgePolicy,
    contextPolicy: policy.contextPolicy,
    executionLiveness: policy.executionLiveness,
    economicEnvelope: policy.economicEnvelope,
    capabilityRegistryDigest: policy.capabilityRegistryDigest,
    allowedExternalEffects: policy.allowedExternalEffects,
    humanDecisionRequirements: policy.humanDecisionRequirements,
  });
}

/**
 * DETERMINISTIC lineage-descendant check (H-NEW-12 authority gate).
 *
 * Returns true iff the LIVE candidate IS the anchored revision (exact
 * `candidateId` + `revision` + `identityDigest`) OR descends from it via the
 * durable `parentCandidateId` + `candidateAssemblyReceipts` chain. Verified
 * via the revision CHAIN (candidateId + revision + digest at every hop),
 * never by revision numbers alone:
 *
 * - same-revision siblings (same parent, different child, same revision
 *   number, different digest, same deterministic `candidateId:rN`) fail the
 *   exact match (digest differs) and fail the descendant walk (the walk from
 *   the sibling reaches the shared parent, never the anchored sibling);
 * - sibling-descendants (child of a sibling) walk through the sibling's
 *   receipt (whose `baseIdentityDigest` is the sibling digest, not the
 *   anchored digest) and never reach the anchored revision;
 * - cross-op candidates fail via the lineage root
 *   (`candidate:<otherOp>:rN` never equals `candidate:<thisOp>:rN`) plus the
 *   caller's explicit `operationId` check.
 *
 * Assembly receipts are digest-validated (`assertCandidateAssemblyReceiptV1`);
 * invalid entries are never usable evidence. Plain candidate binds without an
 * assembly receipt cannot prove their parent digest (the live candidate
 * stores only `parentCandidateId`, not the parent digest, and `candidateId`
 * collides across same-revision siblings), so they fail closed unless they
 * ARE the anchored revision. Repair advances always record receipts via
 * `bindOperationCandidateWithAssemblyReceipt`, so liveness is preserved while
 * forgery fails closed.
 */
export function isOwnerExemptionLineageDescendant(input: {
  liveCandidate: { candidateId: string; revision: number; identityDigest: string };
  anchoredCandidateId: string;
  anchoredRevision: number;
  anchoredIdentityDigest: string;
  assemblies?: Record<string, CandidateAssemblyReceiptV1> | readonly CandidateAssemblyReceiptV1[];
}): boolean {
  const { liveCandidate, anchoredCandidateId, anchoredRevision, anchoredIdentityDigest } = input;
  if (
    liveCandidate.candidateId === anchoredCandidateId
    && liveCandidate.revision === anchoredRevision
    && liveCandidate.identityDigest === anchoredIdentityDigest
  ) return true;
  if (!Number.isSafeInteger(liveCandidate.revision) || liveCandidate.revision < anchoredRevision) return false;
  if (liveCandidate.revision === anchoredRevision) return false;
  const raw: readonly CandidateAssemblyReceiptV1[] = Array.isArray(input.assemblies)
    ? input.assemblies
    : Object.values(input.assemblies ?? {});
  const valid: CandidateAssemblyReceiptV1[] = [];
  for (const entry of raw) {
    try {
      assertCandidateAssemblyReceiptV1(entry);
      valid.push(entry);
    } catch { /* invalid lineage entries are never usable evidence */ }
  }
  let cursor = {
    candidateId: liveCandidate.candidateId,
    revision: liveCandidate.revision,
    identityDigest: liveCandidate.identityDigest,
  };
  // Bounded walk: each hop strictly decreases the revision by exactly one
  // (assembly receipts advance exactly one revision), so at most
  // `liveRevision - anchoredRevision + 1` hops can reach the anchor.
  const maxHops = liveCandidate.revision - anchoredRevision + 1;
  for (let hop = 0; hop <= maxHops + valid.length; hop += 1) {
    if (
      cursor.candidateId === anchoredCandidateId
      && cursor.revision === anchoredRevision
      && cursor.identityDigest === anchoredIdentityDigest
    ) return true;
    if (cursor.revision <= anchoredRevision) return false;
    const assembly = valid.find((entry) =>
      entry.candidateId === cursor.candidateId
      && entry.revision === cursor.revision
      && entry.identityDigest === cursor.identityDigest
    );
    if (!assembly) return false;
    cursor = {
      candidateId: assembly.baseCandidateId,
      revision: assembly.baseRevision,
      identityDigest: assembly.baseIdentityDigest,
    };
  }
  return false;
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
  const allowed = ["version", "kind", "mechanism", "exemptionId", "operationId", "controllerEpoch", "anchoredCandidateId", "candidateRevision", "candidateIdentityDigest", "policyDigest", "policyStableDigest", "operationExecutionRevision", "paths", "decisionId", "decisionDigest", "decidedActor", "decisionReason", "createdAt", "expiresAt", "mac"];
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`OWNER_EXEMPTION_GRANT_INVALID: unsupported fields: ${extra.join(", ")}.`);
  const grant = value as OwnerHardProtectionExemptionGrantV1;
  if (grant.version !== OWNER_HARD_PROTECTION_EXEMPTION_VERSION || grant.kind !== "OWNER_HARD_PROTECTION_EXEMPTION" || grant.mechanism !== "DETERMINISTIC") {
    throw new Error("OWNER_EXEMPTION_GRANT_INVALID: grant requires version 1 with DETERMINISTIC mechanism.");
  }
  if (!OWNER_EXEMPTION_ID_PATTERN.test(requiredText(grant.exemptionId, "exemptionId", 64))) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: exemptionId must be 'exemption:<uuid>'.");
  requiredText(grant.operationId, "operationId", 200);
  if (!Number.isSafeInteger(grant.controllerEpoch) || grant.controllerEpoch < 0) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: controllerEpoch must be a non-negative safe integer.");
  requiredText(grant.anchoredCandidateId, "anchoredCandidateId", 200);
  if (!Number.isSafeInteger(grant.candidateRevision) || grant.candidateRevision < 1) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: candidateRevision must be a positive safe integer.");
  if (!/^[a-f0-9]{64}$/.test(grant.candidateIdentityDigest)) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: candidateIdentityDigest must be a lowercase SHA-256 digest.");
  if (!/^[a-f0-9]{64}$/.test(grant.policyDigest)) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: policyDigest must be a lowercase SHA-256 digest.");
  if (!/^[a-f0-9]{64}$/.test(grant.policyStableDigest)) throw new Error("OWNER_EXEMPTION_GRANT_INVALID: policyStableDigest must be a lowercase SHA-256 digest.");
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
