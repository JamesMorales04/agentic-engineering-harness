import { minimatch } from "minimatch";
import type { TaskContract, ValidationCheck } from "../core/types.js";
import { isSafeRepairScopePath, normalizeRepairScopePath } from "../candidates/repairScope.js";

function matches(file: string, patterns: string[]): boolean {
  const normalizedFile = normalizeRepairScopePath(file.trim());
  return patterns.some((raw) => {
    const trimmed = raw.trim();
    // DETERMINISTIC raw-traversal rejection BEFORE normalization (Luna
    // broadening fix): `src/../**` posix-normalizes to `**`; reject the raw
    // input so it never broadens to open scope. Fail-closed: an unsafe
    // pattern never matches (grants nothing, denies nothing via broadening).
    if (!isSafeRepairScopePath(trimmed)) return false;
    const pattern = normalizeRepairScopePath(trimmed);
    if (!pattern) return false;
    if (pattern === "**") return true;
    if (!normalizedFile) return false;
    return minimatch(normalizedFile, pattern, { dot: true, matchBase: false });
  });
}

export function validateDiffScope(changedFiles: string[], contract: TaskContract, globalFrozen: string[] = []): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const allowed = contract.scope?.allowed ?? [];
  const forbidden = contract.scope?.forbidden ?? [];
  const frozen = [...globalFrozen, ...(contract.scope?.frozen ?? [])];

  // Fail-closed empty allowlist (C2): an empty/missing `allowed` denies all
  // changes (outsideAllowed = all changed files). Only an explicit `["**"]`
  // allowlist opens scope. This mirrors repair-scope fail-closed defaults:
  // `run.ts` assembly defaults to `["**"]` only when `scope.allowed` is
  // undefined, but validation treats missing/empty as closed so an
  // unscoped contract cannot silently pass. Documented: closed by default,
  // open only via explicit `["**"]`.
  const outsideAllowed = allowed.length > 0
    ? changedFiles.filter((f) => !matches(f, allowed))
    : [...changedFiles];
  checks.push({
    id: "diff.allowed-scope",
    category: "diff",
    status: outsideAllowed.length ? "FAIL" : "PASS",
    message: outsideAllowed.length ? `Files outside allowed scope: ${outsideAllowed.join(", ")}` : "All changed files are within allowed scope.",
    details: { outsideAllowed }
  });

  const forbiddenChanged = forbidden.length ? changedFiles.filter((f) => matches(f, forbidden)) : [];
  checks.push({
    id: "diff.forbidden-paths",
    category: "diff",
    status: forbiddenChanged.length ? "FAIL" : "PASS",
    message: forbiddenChanged.length ? `Forbidden paths changed: ${forbiddenChanged.join(", ")}` : "No forbidden paths changed.",
    details: { forbiddenChanged }
  });

  const frozenChanged = frozen.length ? changedFiles.filter((f) => matches(f, frozen)) : [];
  checks.push({
    id: "diff.frozen-paths",
    category: "trust-boundary",
    status: frozenChanged.length ? "FAIL" : "PASS",
    message: frozenChanged.length ? `Frozen validation/contract paths changed: ${frozenChanged.join(", ")}` : "Frozen paths were not modified.",
    details: { frozenChanged }
  });

  return checks;
}
