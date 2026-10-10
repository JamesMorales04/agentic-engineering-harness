import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256Canonical } from "../core/digest.js";
import { isAehSourceCheckout } from "../core/sourceCheckout.js";
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

export interface SelfHostingCharterV1 {
  version: 1;
  /** Canonical realpath of the isolated target control root this charter covers. */
  targetRoot: string;
  controller: { aehVersion: string };
  authorizedBy: string;
  authorizedAt: string;
  expiresAt: string;
  scope: { kinds: string[] };
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
    const failure = charterRejection(parsed, file, kind, nowMs);
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

function charterRejection(
  parsed: Record<string, unknown>,
  file: string,
  kind: string,
  nowMs: number,
): string | undefined {
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
  return undefined;
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
