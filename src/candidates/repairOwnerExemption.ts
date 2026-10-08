import {
  isExactRepairScopeFilePath,
  isSafeRepairScopePath,
  normalizeRepairScopePath,
} from "./repairScope.js";
import { AehError } from "../core/errors.js";

/** Re-exported authority gates (implemented alongside the amendment gates to
 * avoid a candidates-layer import cycle; see src/candidates/repairScope.ts). */
export {
  applyOwnerExemptedRepairScopeAmendment,
  findCoveringOwnerHardProtectionExemption,
  mintOwnerHardProtectionExemptionFromProductChoice,
  verifyOwnerHardProtectionExemption,
} from "./repairScope.js";

/**
 * Owner-scoped hard-protection exemption via suspend/decide/resume.
 * See src/candidates/repairScope.ts for the controller mint
 * (`mintOwnerHardProtectionExemptionFromProductChoice`) and the
 * suspend/decide/resume resolver. Standalone request/anchor-on-ledger-scan,
 * the CC exemption endpoint, and HARD_PROTECTION_EXEMPTION purpose routing
 * were deleted as unsound (post-hoc ledger state cannot distinguish
 * CC-issued from shell-forged decisions); stale callers fail explicitly on
 * import/migration.
 */

/**
 * Normalize + bound exemption paths. Exact named files only (no globs);
 * new-file paths are allowed (declared upfront — existence is never
 * required). Callers pass ONLY controller-validated blocker paths
 * (deterministic from the durable receipt); agent output never flows here.
 */
export function normalizeOwnerExemptionPaths(paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 8) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_PATH_INVALID: an exemption requires 1 to 8 exact file paths.");
  }
  const normalized: string[] = [];
  for (const entry of paths) {
    const raw = typeof entry === "string" ? entry.trim() : "";
    if (!raw || !isSafeRepairScopePath(raw)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `OWNER_EXEMPTION_PATH_INVALID: exemption path '${String(entry)}' is not a safe repository-relative path.`);
    }
    if (!isExactRepairScopeFilePath(raw)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `OWNER_EXEMPTION_PATH_INVALID: exemption path '${raw}' is not an exact file path; scope exemptions allow exact paths only (no wildcards).`);
    }
    const filePath = normalizeRepairScopePath(raw);
    if (!filePath || !isSafeRepairScopePath(filePath) || !isExactRepairScopeFilePath(filePath)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `OWNER_EXEMPTION_PATH_INVALID: exemption path '${raw}' is not an exact safe file path.`);
    }
    normalized.push(filePath);
  }
  const sorted = [...new Set(normalized)].sort((a, b) => a.localeCompare(b));
  if (!sorted.length || sorted.length > 8) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_PATH_INVALID: an exemption requires 1 to 8 unique exact file paths.");
  }
  return sorted;
}
