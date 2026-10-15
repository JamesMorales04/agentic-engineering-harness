import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig } from "../core/config.js";
import { sha256Canonical } from "../core/digest.js";
import { isAehSourceCheckout } from "../core/sourceCheckout.js";
import { assertDelegationIssuanceContext, verifyDelegatedOwnerGrantV1 } from "../security/ownerAuthority.js";
import { VERSION } from "../version.js";
import { operationArtifactDir } from "./state.js";

/**
 * Isolated self-hosting charter gate (MECHANISM: DETERMINISTIC).
 *
 * AEH source checkouts refuse mutating CHANGE/RUN operations by default:
 * the development authority for AEH itself is the external controller,
 * shell, TypeScript and tests. A narrow, Owner-authorized exception exists
 * for bounded isolated self-hosting experiments, established by a
 * digest-pinned charter file that lives in the EXTERNAL CONTROLLER
 * checkout's protected control plane
 * (`<controller>/.harness/self-hosting-charters/*.json`) — never in the
 * target worktree, so a target lead cannot self-authorize by minting a
 * charter beside the code it wants to change. Target-local charter files
 * are ignored.
 *
 * Authority resolution is structural, not prose: for a git control root,
 * `git rev-parse --git-common-dir` identifies the checkout the root
 * belongs to. A main checkout is its own authority (live controller —
 * frozen). A worktree's authority is the common-dir parent (the controller
 * checkout the worktree was branched from). The gate, the execution
 * re-check, and the operation binding all resolve the same way, and the
 * accepted charter digest is bound to the operation at start and
 * re-verified on every execution (charter rotation/expiry strands
 * in-flight self-hosting operations fail-closed by design).
 *
 * Model output (intent text, requested outcomes, lead prose) can never
 * satisfy this gate; only the controller-side Owner-written artifact
 * counts. Threat model: a lead with arbitrary filesystem access can already
 * mutate its own checkout directly — this gate does not defend against a
 * Byzantine lead (nothing filesystem-local can). It converts compliant
 * leads from improvised ungoverned edits into explicit, auditable,
 * expiry-bounded governed operations, and gives the Owner a durable
 * record plus fail-closed behavior on every path.
 */

export const SELF_HOSTING_CHARTERS_DIR = ".harness/self-hosting-charters";
export const SELF_HOSTING_BINDING_FILE = "charter.json";

export type SelfHostingCharterIssuerV1 = "HUMAN_OWNER" | "DELEGATED_OWNER";

export interface SelfHostingCharterProvenanceV1 {
  /** HUMAN_OWNER: issued directly by the human Owner. DELEGATED_OWNER: issued by an authorized delegate. */
  issuedBy: SelfHostingCharterIssuerV1;
  /** Present only for DELEGATED_OWNER: the authenticating human grantor. */
  grantorOwnerId?: string;
  /** Present only for DELEGATED_OWNER: the grant authorizing issuance. */
  delegationId?: string;
}

export interface SelfHostingCharterV1 {
  version: 1;
  /** Canonical realpath of the isolated target control root this charter covers. */
  targetRoot: string;
  controller: { aehVersion: string };
  authorizedBy: string;
  authorizedAt: string;
  expiresAt: string;
  scope: { kinds: string[] };
  /**
   * Charter provenance. Absent means a legacy human-Owner charter. Delegated
   * charters carry the issuing delegate, grantor, and delegation id; the
   * delegation itself is re-verified (MAC/scope/expiry/revocation) at every
   * gate, so revocation or expiry strands delegated charters fail-closed.
   */
  provenance?: SelfHostingCharterProvenanceV1;
  charterDigest: string;
}

export interface SelfHostingAuthorityOptions {
  /** Test seam: replaces `git -C <root> rev-parse --git-common-dir`. */
  resolveCommonDir?: (controlRoot: string) => string | undefined;
  /** Test seam: pins the controller checkout root, skipping git resolution. */
  controllerRoot?: string;
  /** Test seam: clock override for expiry checks. */
  nowMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Canonical digest over the charter body (everything except charterDigest itself). */
export function canonicalCharterDigest(body: Record<string, unknown>): string {
  const { charterDigest: _ignored, ...rest } = body;
  void _ignored;
  return sha256Canonical(sortKeys(rest));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

async function realpathOrResolve(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function defaultCommonDir(controlRoot: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", controlRoot, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 15_000,
    }).trim();
    if (!out) return undefined;
    return path.resolve(controlRoot, out);
  } catch {
    return undefined;
  }
}

export type SelfHostingAuthority =
  | { kind: "consumer" }
  | { kind: "controller-live"; controllerRoot: string }
  | { kind: "isolated-target"; controllerRoot: string };

/**
 * Resolve which authority governs mutating operations for a control root.
 * Non-source checkouts are consumer roots (charter never needed). Source
 * checkouts resolve to the live controller (frozen) or an isolated target
 * (charter-gated) via git common-dir structure.
 */
export async function resolveSelfHostingAuthority(
  controlRoot: string,
  options: SelfHostingAuthorityOptions = {},
): Promise<SelfHostingAuthority> {
  const absoluteRoot = path.resolve(controlRoot);
  if (options.controllerRoot) {
    return classifyAgainstController(absoluteRoot, path.resolve(options.controllerRoot));
  }
  // Without Git metadata this cannot be a source checkout (packed
  // disposable fixtures, plain consumer dirs): legacy pass-through.
  try {
    await fs.access(path.join(absoluteRoot, ".git"));
  } catch {
    return { kind: "consumer" };
  }
  const commonDir = options.resolveCommonDir
    ? options.resolveCommonDir(absoluteRoot)
    : defaultCommonDir(absoluteRoot);
  if (!commonDir) {
    throw new Error(
      `SELF_HOSTING_CHARTER_REQUIRED: ${absoluteRoot} has Git metadata but its owning checkout is unresolvable, so no charter can be verified. Verify the git toolchain or use the external controller, shell, TypeScript and tests.`,
    );
  }
  return classifyAgainstController(absoluteRoot, controllerRootFor(commonDir));
}

async function classifyAgainstController(
  absoluteRoot: string,
  controllerRoot: string,
): Promise<SelfHostingAuthority> {
  if (!(await isAehSourceCheckout(absoluteRoot, controllerRoot))) return { kind: "consumer" };
  const [rootReal, controllerReal] = await Promise.all([
    realpathOrResolve(absoluteRoot),
    realpathOrResolve(controllerRoot),
  ]);
  if (rootReal === controllerReal) return { kind: "controller-live", controllerRoot: controllerReal };
  return { kind: "isolated-target", controllerRoot: controllerReal };
}

function controllerRootFor(commonDir: string): string {
  // common-dir is `<checkout>/.git` (main) or the `<controller>/.git`
  // shared with worktrees (plus worktrees/<name> bookkeeping inside it).
  const resolved = path.resolve(commonDir);
  const dotGit = `${path.sep}.git`;
  const idx = resolved.indexOf(dotGit);
  const checkout = idx >= 0 ? resolved.slice(0, idx) : resolved;
  return checkout || path.sep;
}

async function readCandidateCharters(controllerRoot: string): Promise<Array<{ file: string; parsed: unknown }>> {
  const dir = path.join(controllerRoot, SELF_HOSTING_CHARTERS_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ file: string; parsed: unknown }> = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(dir, entry);
    try {
      out.push({ file, parsed: JSON.parse(await fs.readFile(file, "utf8")) as unknown });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Fail-closed charter gate for mutating operations. Returns the accepted
 * charter (for operation binding) on charter-covered isolated targets, or
 * undefined on consumer roots. Throws otherwise — always before any
 * durable operation write.
 */
export async function assertIsolatedSelfHostingCharterV1(
  controlRoot: string,
  kind: string,
  options: SelfHostingAuthorityOptions = {},
): Promise<SelfHostingCharterV1 | undefined> {
  const absoluteRoot = path.resolve(controlRoot);
  const authority = await resolveSelfHostingAuthority(absoluteRoot, options);
  if (authority.kind === "consumer") return undefined;
  if (authority.kind === "controller-live") {
    throw new Error(
      `SELF_HOSTING_CONTROLLER_FROZEN: ${absoluteRoot} is the live controller checkout for this authority; CHANGE/RUN operations never run against it, with or without a charter. Use an isolated target worktree covered by an Owner-authorized self-hosting charter, or the external controller, shell, TypeScript and tests.`,
    );
  }
  const nowMs = options.nowMs ?? Date.now();
  const rootReal = await realpathOrResolve(absoluteRoot);
  let targetSeen = false;
  for (const { file, parsed } of await readCandidateCharters(authority.controllerRoot)) {
    if (!isRecord(parsed) || typeof parsed.targetRoot !== "string") continue;
    let candidateReal: string;
    try {
      candidateReal = await fs.realpath(parsed.targetRoot);
    } catch {
      candidateReal = path.resolve(parsed.targetRoot);
    }
    if (candidateReal !== rootReal) continue;
    targetSeen = true;
    const failure = await charterRejection(parsed, file, kind, nowMs, authority.controllerRoot);
    if (!failure) return parsed as unknown as SelfHostingCharterV1;
  }
  if (targetSeen) {
    throw new Error(
      `SELF_HOSTING_CHARTER_STALE: a charter names ${absoluteRoot} but is not currently valid (digest mismatch, expiry, version drift, or scope gap). Refusing CHANGE/RUN (fail closed); renew the Owner charter instead of working around this gate.`,
    );
  }
  throw new Error(
    `SELF_HOSTING_CHARTER_REQUIRED: ${absoluteRoot} is an AEH source checkout (or its worktree); CHANGE/RUN operations require an explicit Owner-authorized isolated self-hosting charter in the controller checkout (${authority.controllerRoot}/${SELF_HOSTING_CHARTERS_DIR}). Without one, start is refused: request an Owner charter through HUMAN_REQUIRED instead of working around this gate. Target-local charter files are not authoritative.`,
  );
}

async function charterRejection(
  parsed: Record<string, unknown>,
  file: string,
  kind: string,
  nowMs: number,
  controllerRoot: string,
): Promise<string | undefined> {
  if (parsed.version !== 1) return `${file}: unsupported charter version`;
  if (typeof parsed.charterDigest !== "string" || !/^[0-9a-f]{64}$/.test(parsed.charterDigest)) {
    return `${file}: missing or malformed charterDigest`;
  }
  if (canonicalCharterDigest(parsed) !== parsed.charterDigest) return `${file}: digest mismatch`;
  const controller = parsed.controller;
  if (!isRecord(controller) || controller.aehVersion !== VERSION) {
    return `${file}: controller.aehVersion must equal the running runtime (${VERSION})`;
  }
  if (typeof parsed.authorizedBy !== "string" || parsed.authorizedBy.length === 0) {
    return `${file}: authorizedBy must name the authorizing owner`;
  }
  const expiresAt = Date.parse(typeof parsed.expiresAt === "string" ? parsed.expiresAt : "");
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return `${file}: charter is expired`;
  const scope = parsed.scope;
  if (!isRecord(scope) || !Array.isArray(scope.kinds) || !scope.kinds.includes(kind)) {
    return `${file}: scope does not cover ${JSON.stringify(kind)}`;
  }
  // Delegated charter provenance: a DELEGATED_OWNER charter is honored only
  // while its authorizing delegation verifies (keyed MAC, project scope,
  // `charter.authorize` capability, expiry, revocation). Revocation or expiry
  // strands the charter fail-closed at every gate, including execution
  // re-validation after a controller version change forces re-issuance.
  const provenance = parsed.provenance;
  if (provenance !== undefined) {
    if (!isRecord(provenance) || (provenance.issuedBy !== "HUMAN_OWNER" && provenance.issuedBy !== "DELEGATED_OWNER")) {
      return `${file}: charter provenance is malformed`;
    }
    if (provenance.issuedBy === "DELEGATED_OWNER") {
      const delegationId = provenance.delegationId;
      const grantorOwnerId = provenance.grantorOwnerId;
      if (typeof delegationId !== "string" || typeof grantorOwnerId !== "string" || !grantorOwnerId.startsWith("human:")) {
        return `${file}: delegated charter provenance must name the delegation and human grantor`;
      }
      if (typeof parsed.authorizedBy !== "string" || !parsed.authorizedBy.startsWith("delegate:")) {
        return `${file}: delegated charter authorizedBy must be the issuing delegate principal`;
      }
      try {
        const scope = await controllerProjectScope(controllerRoot);
        const grant = await verifyDelegatedOwnerGrantV1(controllerRoot, delegationId, {
          projectId: scope.projectId,
          ...(scope.repository ? { repository: scope.repository } : {}),
          requiredCapability: "charter.authorize",
          nowMs,
        });
        if (grant.grantorOwnerId !== grantorOwnerId) return `${file}: delegated charter grantor does not match the authorizing grant`;
        if (grant.delegatePrincipalId !== parsed.authorizedBy) return `${file}: delegated charter issuer does not match the authorizing grant`;
      } catch (error) {
        return `${file}: delegated charter authorization invalid (${error instanceof Error ? error.message : String(error)})`;
      }
    }
  }
  return undefined;
}

/** Controller project scope for delegation checks (config name + repository; absent config denies delegated charters only). */
async function controllerProjectScope(controllerRoot: string): Promise<{ projectId: string; repository?: string }> {
  try { await fs.access(path.resolve(controllerRoot, ".harness", "project.yaml")); }
  catch { throw new Error("DELEGATION_PROJECT_MISMATCH: controller has no project identity for delegation scope checks."); }
  const config = await loadProjectConfig(controllerRoot);
  const projectId = config?.project?.name?.trim();
  if (!projectId) throw new Error("DELEGATION_PROJECT_MISMATCH: controller has no project identity for delegation scope checks.");
  const repository = config?.delivery?.github?.repository?.trim() || undefined;
  return repository ? { projectId, repository } : { projectId };
}

export type CharterIssuanceContextV1 =
  | { via: "cli-direct" }
  | { via: "control-center-paired"; pairedActorId: string }
  | { via: "test"; allowManagedContext?: boolean };

export interface IssueSelfHostingCharterInputV1 {
  /** Canonical realpath of the isolated target this charter covers. */
  targetRoot: string;
  kinds: Array<"change" | "run">;
  expiresAt: string;
  /** `human:*` for direct Owner issuance, `delegate:*` for delegated issuance. */
  authorizedBy: string;
  /** Required for delegated issuance: the authorizing grant. */
  delegationId?: string;
  projectId?: string;
  repository?: string;
}

/**
 * Issue (mint + persist) an isolated self-hosting charter in the controller
 * checkout. Human Owners issue directly. A FULL_PROJECT_OWNER delegate whose
 * grant covers `charter.authorize` may issue (and renew after a controller
 * version change, by re-issuing with the running VERSION) without involving
 * the human again — provenance records the delegate, grantor, and grant, and
 * every gate re-verifies the grant. No worker may self-mint: issuance refuses
 * managed contexts fail-closed, and arbitrary workers lack a valid grant.
 */
export async function issueSelfHostingCharterV1(
  controllerRoot: string,
  input: IssueSelfHostingCharterInputV1,
  context: CharterIssuanceContextV1,
): Promise<SelfHostingCharterV1> {
  assertDelegationIssuanceContext(context.via === "test" ? { via: "test", allowManagedContext: context.allowManagedContext } : context);
  const absoluteController = path.resolve(controllerRoot);
  const targetRoot = await realpathOrResolve(path.resolve(input.targetRoot));
  if (!Array.isArray(input.kinds) || input.kinds.length < 1 || input.kinds.some((kind) => kind !== "change" && kind !== "run")) {
    throw new Error("CHARTER_ISSUANCE_DENIED: kinds must list 'change' and/or 'run'.");
  }
  const expiresAt = input.expiresAt;
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) throw new Error("CHARTER_ISSUANCE_DENIED: expiresAt must be a future instant.");
  const authorizedBy = input.authorizedBy.trim();
  const scope = input.projectId?.trim()
    ? { projectId: input.projectId.trim(), ...(input.repository ? { repository: input.repository } : {}) }
    : await controllerProjectScope(absoluteController).catch(() => undefined);
  if (!scope?.projectId) throw new Error("CHARTER_ISSUANCE_DENIED: controller project identity is required for charter scope.");
  const projectId = scope.projectId;
  let provenance: SelfHostingCharterProvenanceV1;
  if (authorizedBy.startsWith("human:")) {
    if (input.delegationId) throw new Error("CHARTER_ISSUANCE_DENIED: human issuance takes no delegationId.");
    if (context.via === "control-center-paired" && context.pairedActorId !== authorizedBy) {
      throw new Error("CHARTER_ISSUANCE_DENIED: paired issuance author must equal the paired human session actor.");
    }
    provenance = { issuedBy: "HUMAN_OWNER" };
  } else if (authorizedBy.startsWith("delegate:")) {
    if (!input.delegationId?.trim()) throw new Error("CHARTER_ISSUANCE_DENIED: delegated issuance requires the authorizing delegationId.");
    const grant = await verifyDelegatedOwnerGrantV1(absoluteController, input.delegationId.trim(), {
      projectId,
      ...(scope.repository || input.repository ? { repository: (input.repository ?? scope.repository)! } : {}),
      requiredCapability: "charter.authorize",
    });
    if (grant.delegatePrincipalId !== authorizedBy) throw new Error("CHARTER_ISSUANCE_DENIED: delegation is bound to another delegated principal.");
    provenance = { issuedBy: "DELEGATED_OWNER", grantorOwnerId: grant.grantorOwnerId, delegationId: grant.delegationId };
  } else {
    throw new Error("CHARTER_ISSUANCE_DENIED: authorizedBy must be a human Owner ('human:*') or delegated principal ('delegate:*').");
  }
  const body = {
    version: 1 as const,
    targetRoot,
    controller: { aehVersion: VERSION },
    authorizedBy,
    authorizedAt: new Date().toISOString(),
    expiresAt,
    scope: { kinds: [...new Set(input.kinds)].sort() },
    provenance,
  };
  const charter: SelfHostingCharterV1 = { ...body, charterDigest: canonicalCharterDigest(body) };
  const dir = path.join(absoluteController, SELF_HOSTING_CHARTERS_DIR);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${charter.charterDigest.slice(0, 16)}.json`);
  await fs.writeFile(file, `${JSON.stringify(charter, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return charter;
}

/** Binding sidecar persisted at start; re-verified on every execution. */
export interface SelfHostingBindingV1 {
  version: 1;
  operationId: string;
  charterDigest: string;
  targetRoot: string;
  boundAt: string;
}

export function selfHostingBindingFile(controlRoot: string, operationId: string): string {
  return path.join(operationArtifactDir(controlRoot, operationId), SELF_HOSTING_BINDING_FILE);
}

export async function bindSelfHostingCharterV1(
  controlRoot: string,
  operationId: string,
  charter: SelfHostingCharterV1,
): Promise<void> {
  const file = selfHostingBindingFile(controlRoot, operationId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const binding: SelfHostingBindingV1 = {
    version: 1,
    operationId,
    charterDigest: charter.charterDigest,
    targetRoot: charter.targetRoot,
    boundAt: new Date().toISOString(),
  };
  await fs.writeFile(file, `${JSON.stringify(binding)}\n`);
}

/**
 * Execution-time re-check: every CHANGE/RUN execution on a source checkout
 * must present the start-time binding AND a currently-valid controller-side
 * charter with the same digest. Charter rotation, expiry, removal, or a
 * missing/forged binding refuses fail-closed before any execution write.
 */export async function assertSelfHostingExecutionV1(
  controlRoot: string,
  record: { id: string; kind: string },
  options: SelfHostingAuthorityOptions = {},
): Promise<void> {
  if (record.kind !== "change" && record.kind !== "run") return;
  const absoluteRoot = path.resolve(controlRoot);
  const authority = await resolveSelfHostingAuthority(absoluteRoot, options);
  if (authority.kind === "consumer") return;
  if (authority.kind === "controller-live") {
    throw new Error(
      `SELF_HOSTING_CONTROLLER_FROZEN: refusing to execute ${record.id} against the live controller checkout ${absoluteRoot}, with or without a charter.`,
    );
  }
  let binding: SelfHostingBindingV1;
  try {
    const raw = await fs.readFile(selfHostingBindingFile(absoluteRoot, record.id), "utf8");
    const parsed = JSON.parse(raw) as Partial<SelfHostingBindingV1>;
    if (parsed?.version !== 1 || parsed.operationId !== record.id || typeof parsed.charterDigest !== "string") {
      throw new Error("malformed");
    }
    binding = parsed as SelfHostingBindingV1;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SELF_HOSTING_CHARTER")) throw error;
    throw new Error(
      `SELF_HOSTING_CHARTER_STALE: operation ${record.id} has no valid self-hosting binding for ${absoluteRoot}; refusing execution (fail closed).`,
    );
  }
  const charter = await assertIsolatedSelfHostingCharterV1(absoluteRoot, record.kind, options);
  if (!charter || charter.charterDigest !== binding.charterDigest) {
    throw new Error(
      `SELF_HOSTING_CHARTER_STALE: operation ${record.id} is bound to charter ${binding.charterDigest.slice(0, 12)}… which is not currently valid for ${absoluteRoot}; refusing execution (fail closed, charter rotation strands in-flight operations by design).`,
    );
  }
}

/**
 * Synchronous `aeh run` entry guard. `aeh run <taskId>` / `aeh run --issue`
 * executes a TaskContract directly via runTask (delivery workspace,
 * deterministic validation, convergence) without an operation record, so
 * the start/execution binding pair cannot cover it. On source checkouts it
 * requires a currently-valid controller-side charter covering kind "run";
 * the synchronous human driver at the terminal is the Owner checkpoint
 * (unlike detached operations, there is no later execution to re-check).
 * The live controller checkout stays frozen.
 */
export async function assertInteractiveRunSelfHostingV1(
  controlRoot: string,
  options: SelfHostingAuthorityOptions = {},
): Promise<void> {
  const absoluteRoot = path.resolve(controlRoot);
  const authority = await resolveSelfHostingAuthority(absoluteRoot, options);
  if (authority.kind === "consumer") return;
  if (authority.kind === "controller-live") {
    throw new Error(
      `SELF_HOSTING_CONTROLLER_FROZEN: aeh run never executes against the live controller checkout ${absoluteRoot}. Use an isolated charter-covered target, or the external controller, shell, TypeScript and tests.`,
    );
  }
  await assertIsolatedSelfHostingCharterV1(absoluteRoot, "run", options);
}
