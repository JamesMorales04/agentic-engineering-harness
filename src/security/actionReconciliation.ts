import { sha256Canonical } from "../core/digest.js";
import { resolveGithubTokenOptional } from "../delivery/handoff.js";
import { runExecutable, type ProcessOptions, type ProcessResult } from "../utils/process.js";
import type { ActionIntentV1, ToolActionKindV1 } from "./toolActionGate.js";

/**
 * Deterministic reconciliation of externally observable tool-action effects.
 *
 * Decision mechanism: DETERMINISTIC. This module only inspects local Git state
 * or a provider HTTP API and reports what it observed. It never guesses and it
 * never treats missing evidence as success:
 * - a conclusive external fact -> SUCCEEDED or FAILED;
 * - missing payload evidence, transport failures or ambiguous responses -> UNKNOWN;
 * - no deterministic identity or no confirmed inspection contract -> HUMAN_REQUIRED.
 *
 * The module is intentionally read-only: it never mutates repository state and
 * never calls `recordToolActionReceipt`. The caller decides whether a
 * reconciled outcome may be persisted as a terminal receipt by using
 * `reconciliationReceiptOutcome`.
 *
 * Gaps in required files change the fail-closed behavior of a gate. Per the
 * repository validation invariant, audit/gate outputs must remain
 * machine-readable and reproducible; every result therefore carries a typed
 * `evidence` object and its canonical `evidenceDigest`.
 */

export type ActionReconciliationOutcomeV1 = "SUCCEEDED" | "FAILED" | "UNKNOWN" | "HUMAN_REQUIRED";

export interface ActionReconciliationResultV1 {
  version: 1;
  intentId: string;
  action: ToolActionKindV1;
  outcome: ActionReconciliationOutcomeV1;
  detail: string;
  /** `sha256Canonical(evidence)`; always a 64-character lowercase hex digest. */
  evidenceDigest: string;
  evidence: Record<string, unknown>;
  reconciledAt: string;
}

export interface ActionReconciliationHttpInitV1 {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ActionReconciliationDependenciesV1 {
  runExecutable?: typeof runExecutable;
  fetchJson?: (url: string, init?: ActionReconciliationHttpInitV1) => Promise<{ status: number; body: unknown }>;
  /** Explicit GitHub token; when omitted the standard delivery token environment is consulted. */
  token?: string;
  now?: Date;
}

interface ResolvedDependenciesV1 {
  run: typeof runExecutable;
  fetchJson: NonNullable<ActionReconciliationDependenciesV1["fetchJson"]>;
  token?: string;
  now: Date;
}

type PayloadRecord = Record<string, unknown>;

type HttpObservation =
  | { kind: "response"; status: number; body: unknown }
  | { kind: "error"; message: string };

type ExecObservation =
  | { kind: "result"; result: ProcessResult }
  | { kind: "error"; message: string };

const GITHUB_API_BASE_DEFAULT = "https://api.github.com";
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Reconciliation compares object names for exact equality, so only full Git
// object names are acceptable evidence: SHA-1 (40 hex) or SHA-256 (64 hex).
// Abbreviated names are rejected as missing evidence instead of risking a
// false FAILED from a prefix comparison.
const GIT_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const GIT_TIMEOUT_MS = 30_000;
const MAX_SNIPPET_LENGTH = 500;

/**
 * Reconcile one tool action against externally observable state.
 *
 * `payload` is the action payload that the caller intends to verify; it is the
 * same value whose canonical digest the gate stored as `intent.payloadDigest`,
 * and it is a separate parameter because payloads are not embedded in the
 * persisted intent. Reconciliation validates only the fields it needs per
 * action; it never re-derives the intent identity from the payload.
 *
 * `root` is the repository root used for local Git observations
 * (`git rev-parse`, `git ls-remote`). Provider actions (`github.*`,
 * `paseo.workspace.create`) do not touch the local working tree.
 */
export async function reconcileToolAction(
  root: string,
  intent: ActionIntentV1,
  payload: unknown,
  dependencies: ActionReconciliationDependenciesV1 = {}
): Promise<ActionReconciliationResultV1> {
  assertReconcilableIntent(intent);
  const resolved = resolveDependenciesV1(dependencies);
  switch (intent.action as string) {
    case "git.branch.create":
      return reconcileGitBranchCreate(root, intent, payload, resolved);
    case "git.commit":
      return reconcileGitCommit(root, intent, payload, resolved);
    case "git.push":
      return reconcileGitPush(root, intent, payload, resolved);
    case "github.branch.create":
      return reconcileGithubBranchCreate(intent, payload, resolved);
    case "github.pull-request.create":
      return reconcileGithubPullRequestCreate(intent, payload, resolved);
    case "github.issue.create":
      return reconcileGithubIssueCreate(intent, payload, resolved);
    case "paseo.workspace.create":
      return reconcilePaseoWorkspaceCreate(intent, payload, resolved);
    default:
      throw new Error(`ACTION_RECONCILIATION_ACTION_UNSUPPORTED: '${String(intent.action)}' is not a registered tool action.`);
  }
}

/**
 * Map a reconciliation result to the status that may be persisted as a
 * terminal `ActionReceipt`. UNKNOWN and HUMAN_REQUIRED are deliberately not
 * persistable: an unresolved external effect must remain at the intent stage
 * so a later reconciliation can still change the conclusion.
 */
export function reconciliationReceiptOutcome(result: ActionReconciliationResultV1): "SUCCEEDED" | "FAILED" | "UNKNOWN" | undefined {
  if (result.outcome === "SUCCEEDED" || result.outcome === "FAILED") return result.outcome;
  return undefined;
}

async function reconcileGitBranchCreate(root: string, intent: ActionIntentV1, payload: unknown, dependencies: ResolvedDependenciesV1): Promise<ActionReconciliationResultV1> {
  const record = asPayloadRecord(payload);
  if (!record) return buildResult(intent, "UNKNOWN", "payload-missing-evidence", invalidPayloadEvidence(payload, ["payload"]), dependencies.now);
  const branch = nonEmptyString(record.branch);
  const expectedCommit = nonEmptyString(record.expectedCommit);
  const invalid: string[] = [];
  if (!branch || branch.startsWith("refs/") || !isValidGitRef(branch)) invalid.push("branch");
  if (!expectedCommit || !GIT_COMMIT_PATTERN.test(expectedCommit)) invalid.push("expectedCommit");
  if (invalid.length || !branch || !expectedCommit) return buildResult(intent, "UNKNOWN", "payload-missing-evidence", invalidPayloadEvidence(payload, invalid), dependencies.now);

  const ref = `refs/heads/${branch}`;
  const observed = await tryExecutable(dependencies.run, "git", ["show-ref", "--verify", "--hash", ref], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
  if (observed.kind === "error") return buildResult(intent, "UNKNOWN", "git-unavailable", { branch, expectedCommit, error: observed.message }, dependencies.now);
  if (observed.result.exitCode === 1) return buildResult(intent, "FAILED", "local-branch-absent", { branch, expectedCommit }, dependencies.now);
  if (observed.result.exitCode !== 0 || observed.result.timedOut) return buildResult(intent, "UNKNOWN", "local-branch-unreadable", { branch, expectedCommit, exitCode: observed.result.exitCode, timedOut: observed.result.timedOut === true, stderr: snippet(observed.result.stderr) }, dependencies.now);
  const observedCommit = observed.result.stdout.trim().toLowerCase();
  if (!GIT_COMMIT_PATTERN.test(observedCommit)) return buildResult(intent, "UNKNOWN", "local-branch-unreadable", { branch, expectedCommit, stdout: snippet(observed.result.stdout) }, dependencies.now);
  const evidence = { branch, expectedCommit: expectedCommit.toLowerCase(), observedCommit };
  return buildResult(intent, observedCommit === expectedCommit.toLowerCase() ? "SUCCEEDED" : "FAILED", "local-branch-compared", evidence, dependencies.now);
}

async function reconcileGitCommit(root: string, intent: ActionIntentV1, payload: unknown, dependencies: ResolvedDependenciesV1): Promise<ActionReconciliationResultV1> {
  const record = asPayloadRecord(payload);
  if (!record) return buildResult(intent, "UNKNOWN", "payload-missing-evidence", invalidPayloadEvidence(payload, ["payload"]), dependencies.now);
  if (record.expectedHead === undefined) {
    const message = nonEmptyString(record.message);
    if (!message) return buildResult(intent, "UNKNOWN", "expected-head-absent", { expectedHeadPresent: false, messagePresent: false, payloadType: describedType(payload) }, dependencies.now);
    const observed = await tryExecutable(dependencies.run, "git", ["log", "-1", "--pretty=%s"], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
    if (observed.kind === "error") return buildResult(intent, "UNKNOWN", "git-unavailable", { message, error: observed.message }, dependencies.now);
    if (observed.result.exitCode !== 0) return buildResult(intent, "UNKNOWN", "commit-unreadable", { message, exitCode: observed.result.exitCode, stderr: snippet(observed.result.stderr) }, dependencies.now);
    const subject = observed.result.stdout.trim();
    return buildResult(intent, subject === message ? "SUCCEEDED" : "FAILED", "commit-subject-observed", { expectedSubject: message, observedSubject: subject }, dependencies.now);
  }
  const expectedHead = nonEmptyString(record.expectedHead);
  if (!expectedHead || !GIT_COMMIT_PATTERN.test(expectedHead)) {
    return buildResult(intent, "UNKNOWN", "payload-missing-evidence", invalidPayloadEvidence(payload, ["expectedHead"]), dependencies.now);
  }

  const observed = await tryExecutable(dependencies.run, "git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
  if (observed.kind === "error") {
    return buildResult(intent, "UNKNOWN", "git-unavailable", { expectedHead, error: observed.message }, dependencies.now);
  }
  if (observed.result.exitCode !== 0) {
    return buildResult(intent, "UNKNOWN", "head-unreadable", { expectedHead, exitCode: observed.result.exitCode, stderr: snippet(observed.result.stderr) }, dependencies.now);
  }
  const head = observed.result.stdout.trim();
  if (!GIT_COMMIT_PATTERN.test(head)) {
    return buildResult(intent, "UNKNOWN", "head-unreadable", { expectedHead, stdout: snippet(observed.result.stdout) }, dependencies.now);
  }
  const evidence = { expectedHead: expectedHead.toLowerCase(), observedHead: head.toLowerCase() };
  return buildResult(intent, head.toLowerCase() === expectedHead.toLowerCase() ? "SUCCEEDED" : "FAILED", "head-observed", evidence, dependencies.now);
}

async function reconcileGitPush(root: string, intent: ActionIntentV1, payload: unknown, dependencies: ResolvedDependenciesV1): Promise<ActionReconciliationResultV1> {
  const record = asPayloadRecord(payload);
  if (!record) return buildResult(intent, "UNKNOWN", "payload-missing-evidence", invalidPayloadEvidence(payload, ["payload"]), dependencies.now);

  const invalid: string[] = [];
  const remote = nonEmptyString(record.remote);
  if (!remote || !isValidGitRemote(remote)) invalid.push("remote");
  const ref = nonEmptyString(record.ref);
  if (!ref || !isValidGitRef(ref)) invalid.push("ref");
  const expectedCommit = nonEmptyString(record.expectedCommit);
  if (!expectedCommit || !GIT_COMMIT_PATTERN.test(expectedCommit)) invalid.push("expectedCommit");
  if (invalid.length > 0 || !remote || !ref || !expectedCommit) {
    return buildResult(intent, "UNKNOWN", "payload-missing-evidence", invalidPayloadEvidence(payload, invalid), dependencies.now);
  }

  const normalizedCommit = expectedCommit.toLowerCase();
  const observed = await tryExecutable(dependencies.run, "git", ["ls-remote", "--", remote, ref], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
  if (observed.kind === "error") {
    return buildResult(intent, "UNKNOWN", "remote-inspection-unavailable", { remote, ref, expectedCommit: normalizedCommit, error: observed.message }, dependencies.now);
  }
  if (observed.result.exitCode !== 0 || observed.result.timedOut) {
    return buildResult(intent, "UNKNOWN", "remote-inspection-failed", { remote, ref, expectedCommit: normalizedCommit, exitCode: observed.result.exitCode, timedOut: observed.result.timedOut === true, stderr: snippet(observed.result.stderr) }, dependencies.now);
  }

  const entries = parseLsRemote(observed.result.stdout);
  const exact = entries.filter((entry) => entry.ref === ref);
  const candidates = exact.length > 0 ? exact : entries.filter((entry) => entry.ref.endsWith(`/${ref}`));
  const observedShas = [...new Set(candidates.map((entry) => entry.sha.toLowerCase()))].sort();
  if (observedShas.length === 0) {
    return buildResult(intent, "FAILED", "remote-ref-absent", { remote, ref, expectedCommit: normalizedCommit, observedShas }, dependencies.now);
  }
  if (observedShas.length > 1) {
    return buildResult(intent, "UNKNOWN", "remote-ref-ambiguous", { remote, ref, expectedCommit: normalizedCommit, observedShas }, dependencies.now);
  }
  const observedSha = observedShas[0];
  const evidence = { remote, ref, expectedCommit: normalizedCommit, observedSha };
  return buildResult(intent, observedSha === normalizedCommit ? "SUCCEEDED" : "FAILED", "remote-ref-compared", evidence, dependencies.now);
}

async function reconcileGithubBranchCreate(intent: ActionIntentV1, payload: unknown, dependencies: ResolvedDependenciesV1): Promise<ActionReconciliationResultV1> {
  const record = asPayloadRecord(payload);
  if (!record) return buildResult(intent, "UNKNOWN", "payload-missing-evidence", invalidPayloadEvidence(payload, ["payload"]), dependencies.now);

  const invalid: string[] = [];
  const repository = nonEmptyString(record.repository);
  if (!repository || !GITHUB_REPOSITORY_PATTERN.test(repository)) invalid.push("repository");
  const branch = nonEmptyString(record.branch);
  if (!branch) invalid.push("branch");
  const sha = nonEmptyString(record.sha);
  if (!sha) invalid.push("sha");
  if (invalid.length > 0 || !repository || !branch || !sha) {
    return buildResult(intent, "UNKNOWN", "payload-missing-evidence", invalidPayloadEvidence(payload, invalid), dependencies.now);
  }

  const apiBase = normalizeApiBase(record.apiBase);
  const expectedSha = sha.toLowerCase();
  const token = dependencies.token;
  if (!token) {
    return buildResult(intent, "HUMAN_REQUIRED", "github-token-unavailable", { repository, branch, expectedSha, apiBase }, dependencies.now);
  }

  const url = `${apiBase}/repos/${encodeRepository(repository)}/git/ref/heads/${encodeRef(branch)}`;
  const observed = await observeGithub(dependencies.fetchJson, url, token);
  if (observed.kind === "error") {
    return buildResult(intent, "UNKNOWN", "github-api-unavailable", { repository, branch, expectedSha, apiBase, error: observed.message }, dependencies.now);
  }
  if (observed.status === 200) {
    const observedSha = branchRefSha(observed.body);
    if (!observedSha) {
      return buildResult(intent, "UNKNOWN", "github-response-uninterpretable", { repository, branch, expectedSha, apiBase, status: 200 }, dependencies.now);
    }
    const evidence = { repository, branch, expectedSha, observedSha: observedSha.toLowerCase(), apiBase, status: 200 };
    return buildResult(intent, observedSha.toLowerCase() === expectedSha ? "SUCCEEDED" : "FAILED", "github-branch-compared", evidence, dependencies.now);
  }
  if (observed.status === 404) {
    return buildResult(intent, "FAILED", "github-branch-absent", { repository, branch, expectedSha, apiBase, status: 404 }, dependencies.now);
  }
  return buildResult(intent, "UNKNOWN", "github-api-unexpected-status", { repository, branch, expectedSha, apiBase, status: observed.status }, dependencies.now);
}

async function reconcileGithubPullRequestCreate(intent: ActionIntentV1, payload: unknown, dependencies: ResolvedDependenciesV1): Promise<ActionReconciliationResultV1> {
  const record = asPayloadRecord(payload);
  if (!record) return buildResult(intent, "UNKNOWN", "payload-missing-evidence", invalidPayloadEvidence(payload, ["payload"]), dependencies.now);

  const invalid: string[] = [];
  const repository = nonEmptyString(record.repository);
  if (!repository || !GITHUB_REPOSITORY_PATTERN.test(repository)) invalid.push("repository");
  const head = nonEmptyString(record.head);
  if (!head) invalid.push("head");
  const base = nonEmptyString(record.base);
  if (!base) invalid.push("base");
  if (invalid.length > 0 || !repository || !head || !base) {
    return buildResult(intent, "UNKNOWN", "payload-missing-evidence", invalidPayloadEvidence(payload, invalid), dependencies.now);
  }

  const apiBase = normalizeApiBase(record.apiBase);
  const headQualifier = head.includes(":") ? head : `${repository.split("/")[0]}:${head}`;
  const headRef = head.includes(":") ? head.slice(head.indexOf(":") + 1) : head;
  const token = dependencies.token;
  if (!token) {
    return buildResult(intent, "HUMAN_REQUIRED", "github-token-unavailable", { repository, head: headQualifier, base, apiBase }, dependencies.now);
  }

  const query = new URLSearchParams({ state: "open", head: headQualifier, base });
  const url = `${apiBase}/repos/${encodeRepository(repository)}/pulls?${query.toString()}`;
  const observed = await observeGithub(dependencies.fetchJson, url, token);
  if (observed.kind === "error") {
    return buildResult(intent, "UNKNOWN", "github-api-unavailable", { repository, head: headQualifier, base, apiBase, error: observed.message }, dependencies.now);
  }
  if (observed.status !== 200) {
    return buildResult(intent, "UNKNOWN", "github-api-unexpected-status", { repository, head: headQualifier, base, apiBase, status: observed.status }, dependencies.now);
  }
  if (!Array.isArray(observed.body)) {
    return buildResult(intent, "UNKNOWN", "github-response-uninterpretable", { repository, head: headQualifier, base, apiBase, status: 200 }, dependencies.now);
  }

  const matches = observed.body.map(asPayloadRecord).filter((item): item is PayloadRecord => Boolean(item)).filter((item) => {
    const observedHead = asPayloadRecord(item.head)?.ref;
    const observedBase = asPayloadRecord(item.base)?.ref;
    return observedHead === headRef && observedBase === base;
  });
  if (matches.length > 0) {
    const first = matches[0];
    const evidence = {
      repository,
      head: headQualifier,
      base,
      apiBase,
      status: 200,
      matchCount: matches.length,
      pullRequestNumber: numberValue(first.number) ?? null,
      pullRequestUrl: stringValue(first.html_url) ?? stringValue(first.url) ?? null
    };
    return buildResult(intent, "SUCCEEDED", "open-pull-request-observed", evidence, dependencies.now);
  }
  if (observed.body.length === 0) {
    return buildResult(intent, "FAILED", "open-pull-request-not-observed", { repository, head: headQualifier, base, apiBase, status: 200, matchCount: 0 }, dependencies.now);
  }
  return buildResult(intent, "UNKNOWN", "github-response-mismatch", { repository, head: headQualifier, base, apiBase, status: 200, returned: observed.body.length }, dependencies.now);
}

async function reconcileGithubIssueCreate(intent: ActionIntentV1, payload: unknown, dependencies: ResolvedDependenciesV1): Promise<ActionReconciliationResultV1> {
  const record = asPayloadRecord(payload);
  if (!record) return buildResult(intent, "UNKNOWN", "payload-missing-evidence", invalidPayloadEvidence(payload, ["payload"]), dependencies.now);

  const repository = nonEmptyString(record.repository);
  const marker = nonEmptyString(record.marker, false);
  if (!marker) {
    const evidence: Record<string, unknown> = { markerPresent: false };
    if (repository) evidence.repository = repository;
    return buildResult(intent, "HUMAN_REQUIRED", "issue-identity-marker-required", evidence, dependencies.now);
  }
  if (!repository || !GITHUB_REPOSITORY_PATTERN.test(repository)) {
    return buildResult(intent, "UNKNOWN", "payload-missing-evidence", invalidPayloadEvidence(payload, ["repository"]), dependencies.now);
  }

  const apiBase = normalizeApiBase(record.apiBase);
  const token = dependencies.token;
  if (!token) {
    return buildResult(intent, "HUMAN_REQUIRED", "github-token-unavailable", { repository, marker, apiBase }, dependencies.now);
  }

  const query = new URLSearchParams({ state: "all", per_page: "100" });
  const url = `${apiBase}/repos/${encodeRepository(repository)}/issues?${query.toString()}`;
  const observed = await observeGithub(dependencies.fetchJson, url, token);
  if (observed.kind === "error") {
    return buildResult(intent, "UNKNOWN", "github-api-unavailable", { repository, marker, apiBase, error: observed.message }, dependencies.now);
  }
  if (observed.status !== 200) {
    return buildResult(intent, "UNKNOWN", "github-api-unexpected-status", { repository, marker, apiBase, status: observed.status }, dependencies.now);
  }
  if (!Array.isArray(observed.body)) {
    return buildResult(intent, "UNKNOWN", "github-response-uninterpretable", { repository, marker, apiBase, status: 200 }, dependencies.now);
  }

  const match = observed.body.map(asPayloadRecord).filter((item): item is PayloadRecord => Boolean(item)).find((item) => typeof item.body === "string" && item.body.includes(marker));
  if (match) {
    const evidence = {
      repository,
      marker,
      apiBase,
      status: 200,
      scanned: observed.body.length,
      issueNumber: numberValue(match.number) ?? null,
      issueUrl: stringValue(match.html_url) ?? stringValue(match.url) ?? null
    };
    return buildResult(intent, "SUCCEEDED", "issue-marker-observed", evidence, dependencies.now);
  }
  return buildResult(intent, "UNKNOWN", "issue-marker-not-observed", { repository, marker, apiBase, status: 200, scanned: observed.body.length }, dependencies.now);
}

async function reconcilePaseoWorkspaceCreate(intent: ActionIntentV1, payload: unknown, dependencies: ResolvedDependenciesV1): Promise<ActionReconciliationResultV1> {
  const record = asPayloadRecord(payload);
  const workspaceId = record ? nonEmptyString(record.workspaceId) : undefined;
  if (!workspaceId) {
    return buildResult(intent, "HUMAN_REQUIRED", "provider-identity-missing", invalidPayloadEvidence(payload, ["workspaceId"]), dependencies.now);
  }
  // Paseo workspace reconciliation boundary.
  //
  // The repository confirms exactly two Paseo workspace CLI contracts:
  // - `paseo workspace create --isolation <mode> --path <root> ... --json`
  //   (src/delivery/handoff.ts, src/operations/controller.ts)
  // - `paseo workspace ls --json`
  //   (src/delivery/handoff.ts, src/operations/controller.ts)
  //
  // Neither is a single-workspace inspection contract: `ls` output is an
  // unbounded listing, not a durable identity lookup, and there is no
  // `paseo workspace show <id> --json` (or SDK equivalent under src/paseo/**)
  // that could prove a caller-supplied workspaceId exists. Inventing such a
  // CLI contract here would make reconciliation non-deterministic, so a
  // workspaceId alone is not treated as proof of external state.
  return buildResult(intent, "HUMAN_REQUIRED", "provider-identity-inspection-unavailable", { workspaceId }, dependencies.now);
}

function resolveDependenciesV1(dependencies: ActionReconciliationDependenciesV1): ResolvedDependenciesV1 {
  const providedToken = dependencies.token?.trim();
  return {
    run: dependencies.runExecutable ?? runExecutable,
    fetchJson: dependencies.fetchJson ?? defaultFetchJson,
    token: providedToken || resolveGithubTokenOptional(),
    now: dependencies.now ?? new Date()
  };
}

async function defaultFetchJson(url: string, init?: ActionReconciliationHttpInitV1): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { method: init?.method ?? "GET", headers: init?.headers, body: init?.body });
  const text = await response.text();
  let body: unknown;
  if (text) {
    try { body = JSON.parse(text) as unknown; } catch { body = text; }
  }
  return { status: response.status, body };
}

async function observeGithub(fetchJson: NonNullable<ActionReconciliationDependenciesV1["fetchJson"]>, url: string, token: string): Promise<HttpObservation> {
  try {
    const response = await fetchJson(url, { method: "GET", headers: githubHeaders(token) });
    return { kind: "response", status: response.status, body: response.body };
  } catch (error) {
    return { kind: "error", message: errorMessage(error) };
  }
}

async function tryExecutable(run: typeof runExecutable, executable: string, args: readonly string[], options: ProcessOptions): Promise<ExecObservation> {
  try {
    return { kind: "result", result: await run(executable, args, options) };
  } catch (error) {
    return { kind: "error", message: errorMessage(error) };
  }
}

function githubHeaders(token: string): Record<string, string> {
  // The token is a secret: it is sent to the provider but never included in
  // reconciliation evidence or digests.
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`
  };
}

function buildResult(intent: ActionIntentV1, outcome: ActionReconciliationOutcomeV1, detail: string, evidence: Record<string, unknown>, reconciledAt: Date): ActionReconciliationResultV1 {
  return {
    version: 1,
    intentId: intent.intentId,
    action: intent.action,
    outcome,
    detail,
    evidenceDigest: sha256Canonical(evidence),
    evidence,
    reconciledAt: reconciledAt.toISOString()
  };
}

function assertReconcilableIntent(intent: ActionIntentV1): void {
  if (!intent || typeof intent !== "object" || intent.version !== 2 || typeof intent.intentId !== "string" || !intent.intentId.trim() || typeof intent.action !== "string") {
    throw new Error("ACTION_RECONCILIATION_INTENT_INVALID: a version 2 ActionIntent with intentId and action is required.");
  }
}

function asPayloadRecord(payload: unknown): PayloadRecord | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload as PayloadRecord;
}

function nonEmptyString(value: unknown, trim = true): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = trim ? value.trim() : value;
  return text.length > 0 ? text : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return nonEmptyString(value);
}

function invalidPayloadEvidence(payload: unknown, invalidFields: string[]): Record<string, unknown> {
  return { invalidFields, payloadType: describedType(payload) };
}

function describedType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function normalizeApiBase(value: unknown): string {
  const configured = nonEmptyString(value);
  return (configured ?? GITHUB_API_BASE_DEFAULT).replace(/\/+$/, "");
}

function encodeRepository(repository: string): string {
  return repository.split("/").map(encodeURIComponent).join("/");
}

function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function branchRefSha(body: unknown): string | undefined {
  const record = asPayloadRecord(body);
  const object = record ? asPayloadRecord(record.object) : undefined;
  return object ? nonEmptyString(object.sha) : undefined;
}

function parseLsRemote(output: string): Array<{ sha: string; ref: string }> {
  const entries: Array<{ sha: string; ref: string }> = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [sha, ref] = trimmed.split(/\s+/);
    if (sha && ref) entries.push({ sha, ref });
  }
  return entries;
}

function isValidGitRemote(remote: string): boolean {
  // Reject option-looking remotes and remote-helper URL schemes (`ext::` can
  // execute a program). Real transports (ssh/https/file paths) never use `::`.
  return !remote.startsWith("-") && !/\s/.test(remote) && !/^[a-z][a-z0-9+.-]*::/i.test(remote);
}

function isValidGitRef(ref: string): boolean {
  if (ref.startsWith("-") || ref.endsWith("/") || ref.endsWith(".") || ref.includes("//")) return false;
  if (ref.includes("..") || ref.includes("@{") || /[\x00-\x20~^:?*\\[]/.test(ref)) return false;
  return true;
}

function snippet(value: string): string {
  const text = value.trim();
  return text.length > MAX_SNIPPET_LENGTH ? `${text.slice(0, MAX_SNIPPET_LENGTH)}...` : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
