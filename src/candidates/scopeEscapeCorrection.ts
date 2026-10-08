import { AehError } from "../core/errors.js";

/**
 * Bounded single-correction turn for ChangeSet scope escapes.
 *
 * SECURITY-SENSITIVE context ((a) verification outcome: FALSE as literally
 * stated — see below). This module is DETERMINISTIC infrastructure: detection,
 * detail extraction and prompt building are pure deterministic gates. The
 * correction execution itself is MODEL (worker re-invoked), but it is gated
 * deterministically (exactly one turn, full re-validation, budget-counted).
 *
 * (a) VERIFICATION OUTCOME (exact lines, post-#146):
 * - `src/workers/prompt.ts:4` buildWorkerPrompt contains NO allowed/forbidden
 *   lists — only generic "Respect allowed/forbidden paths and
 *   dependency/schema constraints." plus sources/requirements.
 * - `src/workers/prompt.ts:5` buildRepairPrompt contains NO lists — only
 *   generic frozen-scope language plus failure details.
 * - `src/agents/waveExecutor.ts:508` buildDelegationPrompt DOES contain
 *   "Allowed task scope: ..." (allowed only, NO forbidden).
 * - Forbidden patterns NEVER appear in any prompt text; they live in the
 *   TaskContract file (copied via copyTaskContext), the repository-map
 *   context fragment (agentPrompt.ts allowedPaths), and the deterministic
 *   assembly deny lists (run.ts directForbiddenScope, repairProtectedPaths).
 *
 * Therefore claim (a) "Participants RECEIVE allowed/forbidden paths in their
 * prompts (check buildWorkerPrompt/buildRepairPrompt content)" is FALSE as
 * literally stated for those two functions (partially true for wave allowed
 * only). Per task protocol we proceed with the bounded variant ONLY with an
 * additional guard, justified here:
 *
 * ADDITIONAL GUARD (justification): the correction diagnostic echoes ONLY the
 * participant's OWN escaped paths (already known to the participant — they
 * wrote them — and already revealed by the terminal rejection message at
 * assembler.ts:368 today) plus the PUBLIC hard/amendable classification
 * (derived from REPAIR_AMENDABLE_MANIFEST_PATHS, a public dependency-manifest
 * list, via assemblerScopeEscapeDiffV1, capped at 10). It NEVER echoes full
 * allowed/forbidden patterns, NEVER lists non-escaped scope, and reuses the
 * existing stable escape prefix. Oracle amplification is bounded to 2 verdicts
 * per participant-attempt (initial + one correction) instead of 1, counted
 * against existing repair/turn budgets (no new budget knob), with full
 * re-validation (never apply unapproved content). A probing attacker learns
 * only allow/deny for files they already chose — the same verdict the
 * terminal rejection already reveals — with no new boundary disclosure.
 *
 * (b) VERIFICATION (protection vs punishment):
 * - assembler.ts:359-383 scope/forbidden checks run BEFORE any `git apply`
 *   (apply at :387-389). On escape it throws WITHOUT applying (nothing
 *   applied) + emits best-effort trace. Workspace unchanged (see
 *   candidateScopeEscape.test.ts rollback assertions).
 * - Terminal kill is the PROPAGATION of that throw (run.ts DIRECT has no
 *   catch; waveExecutor converts to FAIL wave summary). Rejection is the
 *   protection; kill is punishment. A single bounded correction preserves
 *   rejection (re-validates fully) while fixing usability.
 *
 * Mechanism: DETERMINISTIC (detection, prompt, bound) + MODEL (correction
 * execution, gated). Model reasoning never grants authority, selects tools,
 * or bypasses gates; assembly re-validates fully.
 */

/** Exactly one correction turn per participant-attempt. No new budget knob. */
export const SCOPE_ESCAPE_CORRECTION_MAX_TURNS_V1 = 1;

/** Stable assembler prefix (assembler.ts:368, PR88 convention). */
const SCOPE_ESCAPE_PREFIX = "ChangeSet escaped its assigned scope:";

export interface ScopeEscapeDetailsV1 {
  escapedFiles: string[];
  escapedCount: number;
  amendableManifests: string[];
  amendableCount: number;
  hardProtected: string[];
  hardProtectedCount: number;
  operationId?: string;
  taskId?: string;
}

/**
 * DETERMINISTIC escape detector. Matches ONLY scope escapes (stable prefix +
 * PARTICIPANT_PLAN_INVALID). Symlink escapes ("ChangeSet patch creates a
 * symlink..."), empty-patch, digest, stale and all other codes stay terminal
 * with NO correction (fail-closed for attack-like classes).
 */
export function isScopeEscapeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!message.includes(SCOPE_ESCAPE_PREFIX)) return false;
  if (error instanceof AehError) return error.code === "PARTICIPANT_PLAN_INVALID";
  // Non-AehError wrappers (rethrown across boundaries) still count iff they
  // preserve both the code marker and the stable prefix — never on prefix
  // alone without the code, and never for model-controlled session text
  // (sessions are return values, never thrown errors here).
  return message.includes("PARTICIPANT_PLAN_INVALID");
}

/**
 * DETERMINISTIC detail extractor. Returns undefined for non-escapes or
 * malformed details (fail-closed: caller rethrows original with NO
 * correction rather than building a prompt from untrusted shape).
 */
export function getScopeEscapeDetails(error: unknown): ScopeEscapeDetailsV1 | undefined {
  if (!isScopeEscapeError(error)) return undefined;
  const raw = (error as { details?: unknown }).details as
    | Partial<ScopeEscapeDetailsV1>
    | undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const asArray = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? [...value]
      : undefined;
  const escapedFiles = asArray(raw.escapedFiles);
  const amendableManifests = asArray(raw.amendableManifests);
  const hardProtected = asArray(raw.hardProtected);
  const counts = [raw.escapedCount, raw.amendableCount, raw.hardProtectedCount];
  if (!escapedFiles || !amendableManifests || !hardProtected) return undefined;
  if (!counts.every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) {
    return undefined;
  }
  // Bound enforcement (defense-in-depth; assembler already caps at 10):
  // truncate lists deterministically, preserve total counts from source.
  const cap = (list: string[]): string[] => list.slice(0, 10);
  const details: ScopeEscapeDetailsV1 = {
    escapedFiles: cap(escapedFiles),
    escapedCount: raw.escapedCount as number,
    amendableManifests: cap(amendableManifests),
    amendableCount: raw.amendableCount as number,
    hardProtected: cap(hardProtected),
    hardProtectedCount: raw.hardProtectedCount as number,
  };
  if (typeof raw.operationId === "string" && raw.operationId) details.operationId = raw.operationId;
  if (typeof raw.taskId === "string" && raw.taskId) details.taskId = raw.taskId;
  return details;
}

/**
 * DETERMINISTIC precise diagnostic. Contains ONLY:
 * - escaped files + counts (participant's own input, already revealed by the
 *   terminal rejection message today),
 * - hard/amendable classification + counts (public manifest list),
 * - explicit declare-via-filesNeededOutsideScope instruction,
 * - note that a second escape is terminal,
 * - budget + re-validation notes.
 *
 * NEVER contains full allowed/forbidden patterns (guard for (a)=FALSE).
 * Bounded: escaped lists capped at 10 by construction.
 */
export function buildScopeEscapeCorrectionPrompt(details: ScopeEscapeDetailsV1): string {
  const lines = [
    "SCOPE ESCAPE CORRECTION (single bounded turn):",
    "Your previous ChangeSet escaped its assigned scope and was REJECTED (nothing was applied).",
    `Escaped files (escapedCount=${details.escapedCount}): ${details.escapedFiles.join(", ") || "(none)"}.`,
    `Amendable dependency manifests (amendableCount=${details.amendableCount}, exemptible ONLY via lead-approved amendment with reseal): ${details.amendableManifests.join(", ") || "(none)"}.`,
    `Hard-protected paths (hardProtectedCount=${details.hardProtectedCount}, never silently expandable): ${details.hardProtected.join(", ") || "(none)"}.`,
    "You have exactly ONE correction turn. A second escape is terminal (the operation fails with the ORIGINAL escape error; no further retries for this attempt).",
    "To self-correct via the declare-first channel you bypassed: return NO file changes and declare needed files via AEH_RESULT_JSON filesNeededOutsideScope[{path, reason}] (one reason per file). Do NOT edit out-of-scope files silently. Only a lead-approved scope amendment with reseal can authorize the retry.",
    "This correction counts against existing repair/turn budgets (no new budget). Assembly re-validates fully on re-attempt; unapproved content is never applied.",
  ];
  return lines.join("\n");
}

/** DETERMINISTIC timeout detector for correction turns (throw path). */
export function isScopeCorrectionTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    /timed out|timeout/i.test(message) ||
    /STALLED_FIRST_ACTIVITY|stalled_first_activity/.test(message) ||
    /exit[^0-9]*124|exitCode[^0-9]*124|exit=124/.test(message) ||
    /\bDEADLINE\b/.test(message)
  );
}

/**
 * DETERMINISTIC single-correction wrapper for THROW-based assembly sites.
 * Assembler itself keeps throwing unchanged; CALLERS use this wrapper.
 *
 * - First escape (isScopeEscapeError + valid details) → ONE correction turn
 *   via executeCorrection(prompt). Exactly one; never two.
 * - Second escape (correction throws scope escape) → ORIGINAL terminal kill
 *   (rethrow first error, preserving forensics).
 * - Correction timeout (throw matches timeout patterns, or isTimeoutResult
 *   true for return-path timeout sessions) → ORIGINAL terminal kill.
 * - Non-escape first errors → rethrow immediately (NO correction).
 * - Non-escape correction failures (e.g. CANDIDATE_STALE, symlink) → rethrow
 *   the CORRECTION error fail-closed (new reason, not original).
 * - Success → { result, correctionUsed } so callers can count against
 *   existing budgets (no new budget knob).
 */
export async function withOneScopeEscapeCorrectionTurnV1<T>(input: {
  attempt: () => Promise<T>;
  buildCorrectionPrompt: (details: ScopeEscapeDetailsV1) => string;
  executeCorrection: (prompt: string) => Promise<T>;
  isTimeoutResult?: (result: T) => boolean;
}): Promise<{ result: T; correctionUsed: boolean }> {
  let firstEscape: unknown;
  let firstDetails: ScopeEscapeDetailsV1 | undefined;
  try {
    const initial = await input.attempt();
    if (input.isTimeoutResult?.(initial)) {
      // First-attempt timeout sessions are NOT escapes: no correction turn
      // for timeouts on the initial attempt (only correction timeouts map to
      // original kill). Return initial so normal FAIL/validation handling
      // applies (no oracle for timeout probes).
      return { result: initial, correctionUsed: false };
    }
    return { result: initial, correctionUsed: false };
  } catch (error) {
    firstEscape = error;
    firstDetails = getScopeEscapeDetails(error);
    if (!firstDetails) throw error;
  }
  // Exactly ONE correction turn (bound enforced here; no loop, no counter).
  const prompt = input.buildCorrectionPrompt(firstDetails!);
  let corrected: T;
  try {
    corrected = await input.executeCorrection(prompt);
  } catch (correctionError) {
    if (isScopeCorrectionTimeoutError(correctionError)) throw firstEscape;
    if (isScopeEscapeError(correctionError)) throw firstEscape;
    throw correctionError;
  }
  if (input.isTimeoutResult?.(corrected)) throw firstEscape;
  return { result: corrected, correctionUsed: true };
}
