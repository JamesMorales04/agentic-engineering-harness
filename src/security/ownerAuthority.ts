import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lock } from "proper-lockfile";
import { loadProjectConfig } from "../core/config.js";
import { canonicalSerialize, sha256Canonical } from "../core/digest.js";

/**
 * Canonical Owner authority model (MECHANISM: DETERMINISTIC).
 *
 * Principals:
 * - `HUMAN_OWNER` — an authenticated human Owner (`human:<id>`). Existing
 *   ledger, Control Center pairing, and CLI entry points already authenticate
 *   this principal at the human surfaces; this module only classifies it.
 * - `DELEGATED_OWNER` — an AI/runtime principal (`delegate:<id>`) acting on
 *   behalf of an authenticated human grantor under a persisted, verifiable,
 *   revocable grant. Never a prompt instruction, never inferred from model
 *   output, operation text, or environment variables.
 *
 * A delegation grant is a keyed capability artifact:
 * - `mac` = HMAC-SHA256(projectDelegationKey, canonical(grant body)). The
 *   project delegation key lives at `.harness/security/owner-delegation.key`
 *   (0600, never logged, never embedded in decisions). A self-reported
 *   `authorizedBy` string or an unkeyed digest alone is NOT proof.
 * - The grant binds the delegated principal, the human grantor, the project,
 *   the `FULL_PROJECT_OWNER` authority profile (or an explicit capability
 *   subset), creation/expiry instants, and a revocation identity.
 * - Issuance is allowed ONLY through an authenticated Owner entry point:
 *   direct human CLI (managed worker contexts are refused deterministically
 *   via `AEH_MANAGED_AGENT` / `AEH_INTERACTIVE_LEAD` /
 *   `AEH_ORCHESTRATION_ALLOWED`, mirroring `src/main.ts`
 *   `AEH_CLI_OWNER_AUTHORITY_DENIED`) or a paired Control Center session
 *   (the server authenticates pairing before calling issuance). Workers can
 *   never mint or widen delegations: issuance throws
 *   `DELEGATION_ISSUANCE_CONTEXT_INVALID` inside managed contexts, and
 *   repository text / prompt injection / tool output is never consulted.
 * - Verification is project-scoped (`projectId` match, optional repository
 *   match), capability-checked, expiry-checked, and revocation-checked on
 *   every use. Delegated decisions are recorded under the delegate actorId
 *   with `delegatedFrom` provenance — never falsely attributed to a human.
 *
 * Threat model: identical in structure to the self-hosting charter and owner
 * exemption gates. A lead with arbitrary filesystem access can already mutate
 * its own checkout; filesystem-local artifacts cannot stop a Byzantine lead
 * (nothing local can). These gates convert compliant leads into explicit,
 * auditable, expiry-bounded governed behavior with fail-closed denial on
 * every unverifiable path.
 *
 * Mechanism classification: DETERMINISTIC. HMAC verification, prefix
 * classification, scope/capability/expiry/revocation gates. No model judgment.
 */

export const OWNER_AUTHORITY_VERSION = 1 as const;
export const DELEGATED_OWNER_GRANT_KIND = "DELEGATED_OWNER_GRANT" as const;
export const FULL_PROJECT_OWNER_PROFILE = "FULL_PROJECT_OWNER" as const;

export const HUMAN_OWNER_PREFIX = "human:" as const;
export const DELEGATED_OWNER_PREFIX = "delegate:" as const;

/** Owner capabilities delegable under FULL_PROJECT_OWNER. Closed vocabulary. */
export const OWNER_CAPABILITIES_V1 = [
  "operation.initiate",
  "scope.amend",
  "decision.resolve",
  "charter.authorize",
  "test.acceptance-modify",
  "policy.change",
  "continuation.economic",
  "recovery.authorize",
  "result.accept",
  "delivery.authorize",
  "pr.create",
  "merge.automatic",
  "experiment.restart",
  "repair.continue",
] as const;

export type OwnerCapabilityV1 = (typeof OWNER_CAPABILITIES_V1)[number];
export type OwnerAuthorityProfileV1 = typeof FULL_PROJECT_OWNER_PROFILE;

export type OwnerPrincipalKindV1 = "HUMAN_OWNER" | "DELEGATED_OWNER";

export interface OwnerPrincipalV1 {
  kind: OwnerPrincipalKindV1;
  /** `human:<id>` or `delegate:<id>` — never a display name. */
  actorId: string;
  /** Present only for DELEGATED_OWNER. */
  delegationId?: string;
  /** Present only for DELEGATED_OWNER: the authenticating human grantor. */
  grantorOwnerId?: string;
  /** Present only for DELEGATED_OWNER. */
  profile?: OwnerAuthorityProfileV1;
}

export interface DelegatedOwnerGrantV1 {
  version: 1;
  kind: typeof DELEGATED_OWNER_GRANT_KIND;
  /** DETERMINISTIC mechanism marker: verified cryptographically, never model authority. */
  mechanism: "DETERMINISTIC";
  delegationId: string;
  /** Authenticated human grantor (`human:*`). */
  grantorOwnerId: string;
  /** Bound delegated principal (`delegate:*`). */
  delegatePrincipalId: string;
  /** Project scope binding: must equal the resolving control root's project id. */
  projectId: string;
  /** Optional repository binding (`owner/repo`): enforced when both sides present. */
  repository?: string;
  authorityProfile: OwnerAuthorityProfileV1;
  /** Explicit capability subset; FULL_PROJECT_OWNER grants the full vocabulary. */
  capabilities: OwnerCapabilityV1[];
  createdAt: string;
  /** Unattended operation requires an explicit expiry; bounded to 366 days. */
  expiresAt: string;
  /** HMAC-SHA256(projectDelegationKey, canonical(body without mac)), lowercase hex. */
  mac: string;
}

export type DelegatedOwnerGrantBodyV1 = Omit<DelegatedOwnerGrantV1, "mac">;

export interface OwnerAuthorityVerdictV1 {
  principal: OwnerPrincipalV1;
  /** True when the principal may exercise Owner authority for the capability. */
  authorized: boolean;
  denialCode?: string;
  denialDetail?: string;
}

export interface DelegationStatusV1 {
  delegationId: string;
  grantorOwnerId: string;
  delegatePrincipalId: string;
  projectId: string;
  repository?: string;
  authorityProfile: OwnerAuthorityProfileV1;
  capabilities: OwnerCapabilityV1[];
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  revokedAt?: string;
  revokeReason?: string;
  validNow: boolean;
}

const DELEGATION_ID_PATTERN = /^delegation:[0-9a-f-]{36}$/i;
const MAX_DELEGATION_TTL_MS = 366 * 24 * 60 * 60_000;

export function isHumanOwnerActor(actorId: unknown): boolean {
  return typeof actorId === "string" && actorId.startsWith(HUMAN_OWNER_PREFIX) && actorId.length > HUMAN_OWNER_PREFIX.length;
}

export function isDelegatedOwnerActor(actorId: unknown): boolean {
  return typeof actorId === "string" && actorId.startsWith(DELEGATED_OWNER_PREFIX) && actorId.length > DELEGATED_OWNER_PREFIX.length;
}

/** Classify a principal string without granting anything. DETERMINISTIC. */
export function classifyOwnerActor(actorId: string): OwnerPrincipalKindV1 {
  if (isHumanOwnerActor(actorId)) return "HUMAN_OWNER";
  if (isDelegatedOwnerActor(actorId)) return "DELEGATED_OWNER";
  throw new Error("OWNER_ACTOR_INVALID: Owner actor must start with 'human:' or 'delegate:'.");
}

function delegationKeyFile(root: string): string {
  return path.join(path.resolve(root), ".harness", "security", "owner-delegation.key");
}

function delegationGrantsDir(root: string): string {
  return path.join(path.resolve(root), ".harness", "security", "delegated-owner", "grants");
}

function delegationRevocationsFile(root: string): string {
  return path.join(path.resolve(root), ".harness", "security", "delegated-owner", "revocations.json");
}

export interface DelegationStoreOptions {
  /** Explicit authority root (e.g. the controller checkout owning an isolated target). */
  authorityRoot?: string;
  /** Test seam: replaces git common-dir resolution. */
  resolveCommonDir?: (controlRoot: string) => string | undefined;
}

async function storeHasContent(root: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(delegationGrantsDir(root));
    if (entries.some((entry) => entry.endsWith(".json"))) return true;
  } catch { /* absent */ }
  try {
    await fs.access(delegationRevocationsFile(root));
    return true;
  } catch { /* absent */ }
  return false;
}

function defaultCommonDir(controlRoot: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", controlRoot, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 15_000 }).trim();
    if (!out) return undefined;
    return path.resolve(controlRoot, out);
  } catch {
    return undefined;
  }
}

function controllerRootFor(commonDir: string): string {
  const resolved = path.resolve(commonDir);
  const dotGit = `${path.sep}.git`;
  const idx = resolved.indexOf(dotGit);
  const checkout = idx >= 0 ? resolved.slice(0, idx) : resolved;
  return checkout || path.sep;
}

async function realpathOrSelf(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

/**
 * Resolve the delegation store root for verification (MECHANISM: DETERMINISTIC).
 *
 * Delegations are project-bound, not directory-bound: an isolated target
 * worktree inherits the delegation store of its owning controller checkout,
 * so one Owner grant covers the controller and its authorized targets, and
 * one revocation ends authority everywhere. A target-local store takes
 * precedence when present (explicit provisioning wins); otherwise the
 * controller store is used when it exists; otherwise the local root stands
 * alone (fail-closed: no grants verify). Issuance and revocation always
 * write to the explicit root they are invoked with.
 */
export async function resolveDelegationStoreRoot(root: string, options: DelegationStoreOptions = {}): Promise<string> {
  const absoluteRoot = path.resolve(root);
  if (options.authorityRoot) return path.resolve(options.authorityRoot);
  if (await storeHasContent(absoluteRoot)) return absoluteRoot;
  let commonDir: string | undefined;
  try {
    await fs.access(path.join(absoluteRoot, ".git"));
  } catch {
    return absoluteRoot;
  }
  commonDir = options.resolveCommonDir ? options.resolveCommonDir(absoluteRoot) : defaultCommonDir(absoluteRoot);
  if (!commonDir) return absoluteRoot;
  const controllerRoot = controllerRootFor(commonDir);
  const [rootReal, controllerReal] = await Promise.all([realpathOrSelf(absoluteRoot), realpathOrSelf(controllerRoot)]);
  if (rootReal === controllerReal) return absoluteRoot;
  if (await storeHasContent(controllerReal)) return controllerReal;
  return absoluteRoot;
}

function grantFile(root: string, delegationId: string): string {
  const digest = sha256Canonical(delegationId);
  return path.join(delegationGrantsDir(root), `${digest}.json`);
}

export function delegatedOwnerGrantBody(grant: DelegatedOwnerGrantV1): DelegatedOwnerGrantBodyV1 {
  const { mac: _discarded, ...body } = grant;
  void _discarded;
  return body;
}

/** Mint-or-load the project delegation key. Minting happens ONLY on the issuance path. */
async function loadOrMintDelegationKey(root: string, mint: boolean): Promise<string> {
  const file = delegationKeyFile(root);
  try {
    const raw = (await fs.readFile(file, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error("DELEGATION_KEY_CORRUPT: project delegation key is malformed; rotate it explicitly.");
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!mint) throw new Error("DELEGATION_UNKNOWN: no delegation key exists for this project; no delegation can verify.");
    const key = crypto.randomBytes(32).toString("hex");
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, `${key}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return key;
  }
}

async function readDelegationKey(root: string): Promise<string> {
  return loadOrMintDelegationKey(root, false);
}

export function computeDelegatedOwnerMac(key: string, body: DelegatedOwnerGrantBodyV1): string {
  if (!key || !key.trim()) throw new Error("DELEGATION_KEY_REQUIRED: computing a delegation MAC requires the project delegation key.");
  return crypto.createHmac("sha256", key.trim()).update(canonicalSerialize(body), "utf8").digest("hex");
}

export function verifyDelegatedOwnerMac(key: string | undefined, grant: DelegatedOwnerGrantV1): boolean {
  if (!key || !key.trim()) return false;
  if (!/^[a-f0-9]{64}$/.test(grant.mac)) return false;
  let expected: string;
  try {
    expected = computeDelegatedOwnerMac(key, delegatedOwnerGrantBody(grant));
  } catch {
    return false;
  }
  const actual = Buffer.from(grant.mac, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

function requiredText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`DELEGATION_INVALID: ${name} must not be empty.`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`DELEGATION_INVALID: ${name} exceeds ${maxLength} characters.`);
  return text;
}

function instant(value: unknown, name: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`DELEGATION_INVALID: ${name} must be a valid instant.`);
  return value;
}

/** Structural assert for a durable grant (shape only — MAC validity is checked at every USE). */
export function assertDelegatedOwnerGrant(value: unknown): asserts value is DelegatedOwnerGrantV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DELEGATION_INVALID: grant must be an object.");
  const record = value as Record<string, unknown>;
  const allowed = ["version", "kind", "mechanism", "delegationId", "grantorOwnerId", "delegatePrincipalId", "projectId", "repository", "authorityProfile", "capabilities", "createdAt", "expiresAt", "mac"];
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`DELEGATION_INVALID: unsupported fields: ${extra.join(", ")}.`);
  const grant = value as DelegatedOwnerGrantV1;
  if (grant.version !== OWNER_AUTHORITY_VERSION || grant.kind !== DELEGATED_OWNER_GRANT_KIND || grant.mechanism !== "DETERMINISTIC") {
    throw new Error("DELEGATION_INVALID: grant requires version 1 with DETERMINISTIC mechanism.");
  }
  if (!DELEGATION_ID_PATTERN.test(requiredText(grant.delegationId, "delegationId", 64))) throw new Error("DELEGATION_INVALID: delegationId must be 'delegation:<uuid>'.");
  const grantor = requiredText(grant.grantorOwnerId, "grantorOwnerId", 200);
  if (!grantor.startsWith(HUMAN_OWNER_PREFIX)) throw new Error("DELEGATION_INVALID: grantorOwnerId must be an authenticated human Owner ('human:*').");
  const delegate = requiredText(grant.delegatePrincipalId, "delegatePrincipalId", 200);
  if (!delegate.startsWith(DELEGATED_OWNER_PREFIX)) throw new Error("DELEGATION_INVALID: delegatePrincipalId must be a delegated principal ('delegate:*').");
  if (grantor === delegate) throw new Error("DELEGATION_INVALID: grantor and delegate must differ.");
  requiredText(grant.projectId, "projectId", 200);
  if (grant.repository !== undefined) {
    const repository = requiredText(grant.repository, "repository", 200);
    if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error("DELEGATION_INVALID: repository must be 'owner/repo'.");
  }
  if (grant.authorityProfile !== FULL_PROJECT_OWNER_PROFILE) throw new Error("DELEGATION_INVALID: authorityProfile must be FULL_PROJECT_OWNER.");
  if (!Array.isArray(grant.capabilities) || grant.capabilities.length < 1) throw new Error("DELEGATION_INVALID: capabilities must list at least one Owner capability.");
  for (const capability of grant.capabilities) {
    if (!OWNER_CAPABILITIES_V1.includes(capability as OwnerCapabilityV1)) throw new Error(`DELEGATION_INVALID: unknown Owner capability '${String(capability)}'.`);
  }
  if (new Set(grant.capabilities).size !== grant.capabilities.length) throw new Error("DELEGATION_INVALID: capabilities must be unique.");
  const createdAt = instant(grant.createdAt, "createdAt");
  const expiresAt = instant(grant.expiresAt, "expiresAt");
  if (new Date(expiresAt).getTime() <= new Date(createdAt).getTime()) throw new Error("DELEGATION_INVALID: expiresAt must be after createdAt.");
  if (new Date(expiresAt).getTime() - new Date(createdAt).getTime() > MAX_DELEGATION_TTL_MS) {
    throw new Error("DELEGATION_INVALID: delegation lifetime exceeds the 366-day maximum; renew with a fresh grant.");
  }
  if (!/^[a-f0-9]{64}$/.test(grant.mac)) throw new Error("DELEGATION_INVALID: mac must be a lowercase SHA-256 hex digest.");
}

export type DelegationIssuanceContextV1 =
  | { via: "cli-direct" }
  | { via: "control-center-paired"; pairedActorId: string }
  | { via: "test"; allowManagedContext?: boolean };

/**
 * DETERMINISTIC issuance-context gate. Managed worker runtimes execute a
 * frozen ExecutionBlueprint and must never mint authority: any managed-agent,
 * interactive-lead, or orchestration-allowed marker in the environment refuses
 * issuance unless the caller is the paired Control Center server itself or an
 * explicit test seam. Model output, operation text, and repository text are
 * never consulted — only this gate and the authenticated entry point.
 */
export function assertDelegationIssuanceContext(context: DelegationIssuanceContextV1): void {
  if (context.via === "control-center-paired") {
    if (!isHumanOwnerActor(context.pairedActorId)) {
      throw new Error("DELEGATION_ISSUANCE_DENIED: paired Control Center issuance requires an authenticated human session.");
    }
    return;
  }
  if (context.via === "test" && context.allowManagedContext === true) return;
  if (process.env.AEH_MANAGED_AGENT === "1" || process.env.AEH_INTERACTIVE_LEAD === "1" || process.env.AEH_ORCHESTRATION_ALLOWED === "1") {
    throw new Error("DELEGATION_ISSUANCE_CONTEXT_INVALID: managed worker contexts cannot issue Owner delegations; the authenticated human Owner issues through direct CLI or a paired Control Center session.");
  }
  if (process.env.AEH_OPERATION_ID?.trim()) {
    throw new Error("DELEGATION_ISSUANCE_CONTEXT_INVALID: operation-bound contexts cannot issue Owner delegations; the authenticated human Owner issues through direct CLI or a paired Control Center session.");
  }
}

export interface IssueDelegatedOwnerGrantInputV1 {
  grantorOwnerId: string;
  delegatePrincipalId: string;
  projectId: string;
  repository?: string;
  /** ISO instant; required. Unattended delegations carry an explicit long expiry. */
  expiresAt: string;
  /** Defaults to the FULL_PROJECT_OWNER vocabulary. A subset narrows the delegate. */
  capabilities?: OwnerCapabilityV1[];
  createdAt?: string;
}

/**
 * Issue (mint + persist) a delegation grant. Caller MUST be an authenticated
 * Owner entry point: direct human CLI or paired Control Center session.
 * No worker may call this — the issuance-context gate refuses fail-closed.
 */
export async function issueDelegatedOwnerGrantV1(
  root: string,
  input: IssueDelegatedOwnerGrantInputV1,
  context: DelegationIssuanceContextV1,
): Promise<DelegatedOwnerGrantV1> {
  assertDelegationIssuanceContext(context);
  const grantorOwnerId = requiredText(input.grantorOwnerId, "grantorOwnerId", 200);
  if (!grantorOwnerId.startsWith(HUMAN_OWNER_PREFIX)) throw new Error("DELEGATION_ISSUANCE_DENIED: only an authenticated human Owner ('human:*') may issue a delegation.");
  if (context.via === "control-center-paired" && context.pairedActorId !== grantorOwnerId) {
    throw new Error("DELEGATION_ISSUANCE_DENIED: paired issuance grantor must equal the paired human session actor.");
  }
  const delegatePrincipalId = requiredText(input.delegatePrincipalId, "delegatePrincipalId", 200);
  if (!delegatePrincipalId.startsWith(DELEGATED_OWNER_PREFIX)) throw new Error("DELEGATION_ISSUANCE_DENIED: delegate principal must use the 'delegate:*' namespace.");
  const projectId = requiredText(input.projectId, "projectId", 200);
  let repository: string | undefined;
  if (input.repository !== undefined) {
    repository = requiredText(input.repository, "repository", 200);
    if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error("DELEGATION_ISSUANCE_DENIED: repository must be 'owner/repo'.");
  }
  const capabilities = input.capabilities ?? [...OWNER_CAPABILITIES_V1];
  if (!capabilities.length) throw new Error("DELEGATION_ISSUANCE_DENIED: at least one capability is required.");
  for (const capability of capabilities) {
    if (!OWNER_CAPABILITIES_V1.includes(capability)) throw new Error(`DELEGATION_ISSUANCE_DENIED: unknown Owner capability '${String(capability)}'.`);
  }
  const createdAt = input.createdAt ? instant(input.createdAt, "createdAt") : new Date().toISOString();
  const expiresAt = instant(input.expiresAt, "expiresAt");
  const body: DelegatedOwnerGrantBodyV1 = {
    version: OWNER_AUTHORITY_VERSION,
    kind: DELEGATED_OWNER_GRANT_KIND,
    mechanism: "DETERMINISTIC",
    delegationId: `delegation:${crypto.randomUUID()}`,
    grantorOwnerId,
    delegatePrincipalId,
    projectId,
    ...(repository ? { repository } : {}),
    authorityProfile: FULL_PROJECT_OWNER_PROFILE,
    capabilities: [...new Set(capabilities)].sort() as OwnerCapabilityV1[],
    createdAt,
    expiresAt,
  };
  const grant: DelegatedOwnerGrantV1 = { ...body, mac: "00".repeat(32) };
  assertDelegatedOwnerGrant(grant);
  const key = await loadOrMintDelegationKey(root, true);
  const minted: DelegatedOwnerGrantV1 = { ...body, mac: computeDelegatedOwnerMac(key, body) };
  const dir = delegationGrantsDir(root);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = grantFile(root, minted.delegationId);
  await fs.writeFile(file, `${JSON.stringify(minted, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return minted;
}

interface DelegationRevocationsV1 {
  version: 1;
  revoked: Record<string, { revokedAt: string; reason: string; revokedBy: string }>;
}

async function readRevocations(root: string): Promise<DelegationRevocationsV1> {
  try {
    const raw = JSON.parse(await fs.readFile(delegationRevocationsFile(root), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as { version?: unknown }).version !== 1 || !(raw as { revoked?: unknown }).revoked || typeof (raw as { revoked?: unknown }).revoked !== "object") {
      throw new Error("DELEGATION_REVOCATIONS_CORRUPT: revocation record is malformed.");
    }
    return raw as DelegationRevocationsV1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revoked: {} };
    throw error;
  }
}

/**
 * Revoke a delegation immediately. Any authenticated human Owner may revoke
 * (revocation only removes authority); the revoker is recorded. Delegated
 * principals can never revoke or re-grant.
 */
export async function revokeDelegatedOwnerGrantV1(
  root: string,
  delegationId: string,
  input: { revokedBy: string; reason?: string },
  context: DelegationIssuanceContextV1,
): Promise<void> {
  assertDelegationIssuanceContext(context);
  if (!DELEGATION_ID_PATTERN.test(delegationId.trim())) throw new Error("DELEGATION_UNKNOWN: delegation id is malformed.");
  const revokedBy = requiredText(input.revokedBy, "revokedBy", 200);
  if (!revokedBy.startsWith(HUMAN_OWNER_PREFIX)) throw new Error("DELEGATION_REVOKE_DENIED: only an authenticated human Owner may revoke a delegation.");
  if (context.via === "control-center-paired" && context.pairedActorId !== revokedBy) {
    throw new Error("DELEGATION_REVOKE_DENIED: paired revocation revoker must equal the paired human session actor.");
  }
  await loadGrantById(root, delegationId.trim());
  const dir = path.dirname(delegationRevocationsFile(root));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Locked read-modify-write: concurrent revocations of different grants must
  // never lose one another (proper-lockfile atomic lock directory).
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(dir, {
      realpath: false,
      lockfilePath: path.join(dir, ".revocations-lock"),
      stale: 30_000,
      update: 10_000,
      retries: { retries: 100, factor: 1, minTimeout: 10, maxTimeout: 50, randomize: true },
    });
    const current = await readRevocations(root);
    if (current.revoked[delegationId.trim()]) return;
    const next: DelegationRevocationsV1 = {
      version: 1,
      revoked: {
        ...current.revoked,
        [delegationId.trim()]: {
          revokedAt: new Date().toISOString(),
          reason: input.reason?.trim() ? input.reason.trim().slice(0, 500) : "Owner revocation.",
          revokedBy,
        },
      },
    };
    await fs.writeFile(delegationRevocationsFile(root), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } finally {
    await release?.();
  }
}

async function loadGrantById(root: string, delegationId: string): Promise<DelegatedOwnerGrantV1> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(grantFile(root, delegationId), "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("DELEGATION_UNKNOWN: no such delegation for this project.");
    throw error;
  }
  assertDelegatedOwnerGrant(raw);
  const grant = raw as DelegatedOwnerGrantV1;
  if (grant.delegationId !== delegationId) throw new Error("DELEGATION_INVALID: stored grant identity mismatch.");
  return grant;
}

async function listGrants(root: string): Promise<DelegatedOwnerGrantV1[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(delegationGrantsDir(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: DelegatedOwnerGrantV1[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(delegationGrantsDir(root), entry), "utf8")) as unknown;
      assertDelegatedOwnerGrant(raw);
      out.push(raw as DelegatedOwnerGrantV1);
    } catch {
      continue;
    }
  }
  return out;
}

export interface VerifyDelegationScopeV1 {
  projectId: string;
  repository?: string;
  requiredCapability?: OwnerCapabilityV1;
  nowMs?: number;
  /** Authority-root override (explicit controller checkout). Auto-inherited otherwise. */
  store?: DelegationStoreOptions;
}

/**
 * DETERMINISTIC grant verification: structure, keyed MAC, project/repository
 * scope, authority profile, capability, expiry, revocation. Throws fail-closed.
 */
export async function verifyDelegatedOwnerGrantV1(root: string, delegationId: string, scope: VerifyDelegationScopeV1): Promise<DelegatedOwnerGrantV1> {
  if (!DELEGATION_ID_PATTERN.test(delegationId.trim())) throw new Error("DELEGATION_UNKNOWN: delegation id is malformed.");
  const storeRoot = await resolveDelegationStoreRoot(root, scope.store);
  const grant = await loadGrantById(storeRoot, delegationId.trim());
  const key = await readDelegationKey(storeRoot);
  if (!verifyDelegatedOwnerMac(key, grant)) throw new Error("DELEGATION_FORGED: delegation MAC does not verify against the project delegation key.");
  if (grant.projectId !== scope.projectId) throw new Error("DELEGATION_PROJECT_MISMATCH: delegation belongs to another project; cross-project authority is rejected.");
  if (grant.repository && !scope.repository) {
    throw new Error("DELEGATION_REPOSITORY_MISMATCH: grant is repository-bound but the resolving control root supplied no repository identity; refusing fail-closed.");
  }
  if (grant.repository && scope.repository && grant.repository !== scope.repository) {
    throw new Error("DELEGATION_REPOSITORY_MISMATCH: delegation repository binding does not match; cross-repository authority is rejected.");
  }
  if (scope.requiredCapability && !grant.capabilities.includes(scope.requiredCapability)) {
    throw new Error(`DELEGATION_CAPABILITY_DENIED: delegation does not grant '${scope.requiredCapability}'.`);
  }
  const nowMs = scope.nowMs ?? Date.now();
  if (Date.parse(grant.expiresAt) <= nowMs) throw new Error("DELEGATION_EXPIRED: delegation has expired; renew with a fresh Owner grant.");
  const revocations = await readRevocations(storeRoot);
  if (revocations.revoked[grant.delegationId]) throw new Error("DELEGATION_REVOKED: delegation was revoked by the Owner; authority ended immediately.");
  return grant;
}

export interface ResolveOwnerAuthorityInputV1 extends VerifyDelegationScopeV1 {
  actorId: string;
  delegationId?: string;
}

/**
 * Central Owner authority resolver (MECHANISM: DETERMINISTIC).
 *
 * - `human:*` → HUMAN_OWNER, authorized (authentication happened at the
 *   paired/CLI surface; this resolver classifies, never authenticates).
 * - `delegate:*` → loads the bound grant (explicit delegationId, or the
 *   unique grant naming this principal — ambiguity denies fail-closed),
 *   verifies MAC/scope/capability/expiry/revocation, and returns
 *   DELEGATED_OWNER provenance on success.
 * - Anything else, or any failed check → `{ authorized: false }` with a
 *   `DELEGATION_*` / `OWNER_*` denial code. Callers must fail closed.
 */
export async function resolveOwnerAuthorityV1(root: string, input: ResolveOwnerAuthorityInputV1): Promise<OwnerAuthorityVerdictV1> {
  const actorId = (input.actorId ?? "").trim();
  let kind: OwnerPrincipalKindV1;
  try {
    kind = classifyOwnerActor(actorId);
  } catch (error) {
    return { principal: { kind: "HUMAN_OWNER", actorId }, authorized: false, denialCode: "OWNER_ACTOR_INVALID", denialDetail: error instanceof Error ? error.message : String(error) };
  }
  if (kind === "HUMAN_OWNER") {
    return { principal: { kind, actorId }, authorized: true };
  }
  try {
    let delegationId = input.delegationId?.trim();
    if (!delegationId) {
      const storeRoot = await resolveDelegationStoreRoot(root, input.store);
      const candidates = (await listGrants(storeRoot)).filter((grant) => grant.delegatePrincipalId === actorId);
      const nowMs = input.nowMs ?? Date.now();
      const live = candidates.filter((grant) => Date.parse(grant.expiresAt) > nowMs);
      if (live.length !== 1) {
        throw new Error(live.length === 0 ? "DELEGATION_UNKNOWN: no live delegation names this principal." : "DELEGATION_AMBIGUOUS: multiple live delegations name this principal; present an explicit delegationId.");
      }
      delegationId = live[0]!.delegationId;
    }
    const grant = await verifyDelegatedOwnerGrantV1(root, delegationId, input);
    if (grant.delegatePrincipalId !== actorId) throw new Error("DELEGATION_PRINCIPAL_MISMATCH: delegation is bound to another delegated principal.");
    return {
      principal: { kind, actorId, delegationId: grant.delegationId, grantorOwnerId: grant.grantorOwnerId, profile: grant.authorityProfile },
      authorized: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.split(":")[0] || "DELEGATION_DENIED";
    return { principal: { kind, actorId }, authorized: false, denialCode: code, denialDetail: message };
  }
}

/** List delegations with live validity for Owner inspection. No key material. */
export async function listDelegatedOwnerGrantsV1(root: string, nowMs?: number, store?: DelegationStoreOptions): Promise<DelegationStatusV1[]> {
  const at = nowMs ?? Date.now();
  const storeRoot = await resolveDelegationStoreRoot(root, store);
  let key: string | undefined;
  try {
    key = await readDelegationKey(storeRoot);
  } catch {
    key = undefined;
  }
  const revocations = await readRevocations(storeRoot);
  const out: DelegationStatusV1[] = [];
  for (const grant of await listGrants(storeRoot)) {
    const revoked = revocations.revoked[grant.delegationId];
    const macOk = key ? verifyDelegatedOwnerMac(key, grant) : false;
    out.push({
      delegationId: grant.delegationId,
      grantorOwnerId: grant.grantorOwnerId,
      delegatePrincipalId: grant.delegatePrincipalId,
      projectId: grant.projectId,
      ...(grant.repository ? { repository: grant.repository } : {}),
      authorityProfile: grant.authorityProfile,
      capabilities: grant.capabilities,
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt,
      revoked: Boolean(revoked),
      ...(revoked ? { revokedAt: revoked.revokedAt, revokeReason: revoked.reason } : {}),
      validNow: macOk && !revoked && Date.parse(grant.expiresAt) > at,
    });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface OwnerActorVerificationV1 {
  actorId: string;
  /** Present only when a delegated principal verified. Attach to the decision record. */
  delegatedFrom?: { grantorOwnerId: string; delegationId: string; profile: OwnerAuthorityProfileV1 };
  principal: OwnerPrincipalV1;
}

/**
 * Shared Owner-action verification used by every authority consumer
 * (Control Center decisions, tool-action authorizations, operation control,
 * self-hosting charter issuance, CLI Owner starts). Human Owners pass
 * through (authentication happened at the paired/CLI surface). Delegated
 * principals must present a currently-valid grant for the required
 * capability; the returned `delegatedFrom` provenance MUST be attached to
 * the resulting decision/charter/origin record. Throws fail-closed.
 */
export async function verifyOwnerActorForCapability(
  root: string,
  input: ResolveOwnerAuthorityInputV1,
): Promise<OwnerActorVerificationV1> {
  const verdict = await resolveOwnerAuthorityV1(root, input);
  if (!verdict.authorized) {
    throw new Error(`${verdict.denialCode ?? "DELEGATION_DENIED"}: ${verdict.denialDetail ?? "Owner authority denied."}`);
  }
  if (verdict.principal.kind === "HUMAN_OWNER") {
    return { actorId: verdict.principal.actorId, principal: verdict.principal };
  }
  return {
    actorId: verdict.principal.actorId,
    delegatedFrom: {
      grantorOwnerId: verdict.principal.grantorOwnerId!,
      delegationId: verdict.principal.delegationId!,
      profile: verdict.principal.profile!,
    },
    principal: verdict.principal,
  };
}

export interface DelegatedUseVerificationV1 {
  actorId: string;
  delegatedFrom?: { grantorOwnerId: string; delegationId: string; profile: OwnerAuthorityProfileV1 };
  projectId: string;
  repository?: string;
  requiredCapability: OwnerCapabilityV1;
  store?: DelegationStoreOptions;
}

/**
 * Re-verification at USE time (MECHANISM: DETERMINISTIC). Recording a
 * decision only reserves it; the grant must verify again immediately before
 * the deferred effect applies (product-choice consume, pause/resume apply,
 * cancellation consume, action consume), so a grant revoked or expired while
 * the decision was pending fails closed instead of authorizing. Binds the
 * stored provenance to the verified grant three ways: delegation id, delegate
 * principal, and human grantor. Human actors pass through. Throws fail-closed.
 */
export async function reverifyDelegatedDecisionForUse(
  root: string,
  input: DelegatedUseVerificationV1,
): Promise<void> {
  if (!isDelegatedOwnerActor(input.actorId)) return;
  if (!input.delegatedFrom) throw new Error("DELEGATION_INVALID: delegated use lacks stored provenance.");
  const grant = await verifyDelegatedOwnerGrantV1(root, input.delegatedFrom.delegationId, {
    projectId: input.projectId,
    ...(input.repository ? { repository: input.repository } : {}),
    requiredCapability: input.requiredCapability,
    ...(input.store ? { store: input.store } : {}),
  });
  if (grant.delegatePrincipalId !== input.actorId) {
    throw new Error("DELEGATION_PRINCIPAL_MISMATCH: stored provenance names a grant bound to another delegated principal.");
  }
  if (grant.grantorOwnerId !== input.delegatedFrom.grantorOwnerId) {
    throw new Error("DELEGATION_GRANTOR_MISMATCH: stored provenance grantor does not match the authorizing grant.");
  }
}

/**
 * Control-root repository identity for delegation scope checks. Absent or
 * unreadable configuration yields undefined, in which case repository-bound
 * grants still verify when the grant itself carries no repository binding;
 * grants WITH a repository binding require the caller to supply it (fail
 * closed below). DETERMINISTIC.
 */
export async function controlRootRepository(root: string): Promise<string | undefined> {
  try {
    await fs.access(path.resolve(root, ".harness", "project.yaml"));
  } catch {
    return undefined;
  }
  try {
    const config = await loadProjectConfig(root);
    return config?.delivery?.github?.repository?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bind a claimed direct-CLI Owner identity to process credentials. The paired
 * Control Center session authenticates via pairing nonce; the direct CLI has
 * no session, so the claimed `human:*` grantor must equal the OS login
 * identity of the invoking shell. Managed worker contexts are refused
 * outright. DETERMINISTIC.
 */
export function assertCliOwnerIdentity(claimed: string): void {
  assertDirectCliContext();
  let username: string;
  try {
    username = os.userInfo().username;
  } catch {
    throw new Error("CLI_OWNER_IDENTITY_UNAVAILABLE: the invoking OS identity could not be determined; use a paired Control Center session to manage delegations.");
  }
  if (!username || claimed !== `${HUMAN_OWNER_PREFIX}${username}`) {
    throw new Error(`CLI_OWNER_MISMATCH: direct-CLI Owner actions attest as '${HUMAN_OWNER_PREFIX}${username || "?"}'; use a paired Control Center session for any other Owner identity.`);
  }
}

/** Refuse delegation CLI inspection/management inside managed worker contexts. DETERMINISTIC. */
export function assertDirectCliContext(): void {
  if (process.env.AEH_MANAGED_AGENT === "1" || process.env.AEH_INTERACTIVE_LEAD === "1" || process.env.AEH_ORCHESTRATION_ALLOWED === "1" || process.env.AEH_OPERATION_ID?.trim()) {
    throw new Error("DELEGATION_CLI_CONTEXT_INVALID: managed worker contexts cannot inspect or manage Owner delegations; the authenticated human Owner acts through direct CLI or a paired Control Center session.");
  }
}

/**
 * Operation-scoped re-verification: like `reverifyDelegatedDecisionForUse`
 * but resolves the control-root repository automatically, so
 * repository-bound grants are enforced at every deferred USE, not only at
 * issuance and session boundaries.
 */
export async function reverifyDelegatedDecisionForOperation(
  root: string,
  input: Omit<DelegatedUseVerificationV1, "repository">,
): Promise<void> {
  const repository = await controlRootRepository(root);
  await reverifyDelegatedDecisionForUse(root, repository ? { ...input, repository } : input);
}
