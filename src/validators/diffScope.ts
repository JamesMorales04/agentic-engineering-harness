import { minimatch } from "minimatch";
import type { TaskContract, ValidationCheck } from "../core/types.js";
import { isManagedProvisionedPath } from "../core/git.js";
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

/**
 * D8 (Luna review MEDIUM, round 3): explicit user scope rules win over
 * machine-generated validation ignores. Uses the SAME matches() semantics as
 * validateDiffScope above (raw-traversal rejection, single scope-string
 * identity, minimatch with dot:true) — never a divergent predicate — so
 * every explicit rule covering the generated path re-exposes it, including
 * glob forms like `.harness/*.json`, redundant separators, and `**`.
 * Unsafe rules (traversal/absolute) never match, so they cannot re-expose.
 * Pure DETERMINISTIC helper (no I/O).
 */
export function generatedIgnoreYieldedToExplicitRule(generatedPath: string, explicitRules: readonly string[]): boolean {
  if (typeof generatedPath !== "string") return false;
  return explicitRules.some((rule) => typeof rule === "string" && matches(generatedPath, [rule]));
}

export function validateDiffScope(changedFiles: string[], contract: TaskContract, globalFrozen: string[] = []): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const allowed = contract.scope?.allowed ?? [];
  const forbidden = contract.scope?.forbidden ?? [];
  const frozen = [...globalFrozen, ...(contract.scope?.frozen ?? [])];

  // D22 managed-provisioned hygiene (DETERMINISTIC): toolchain/provider
  // droppings (`.serena`, `graphify-out`, `.config/mise`) are
  // exclude-from-accounting — never worker-attributable, NOT authorizable —
  // so they are removed from scope accounting before every check below
  // (allowed, forbidden AND frozen). Unlike the D8
  // `.harness/managed-assets.json` ignore (which yields to explicit scope
  // rules via generatedIgnoreYieldedToExplicitRule), this filter is
  // unconditional: no explicit allow/forbid/freeze rule can re-expose a
  // dropping, and an explicit rule can never be satisfied BY a dropping.
  // The D8 protected-manifest class is disjoint from the managed set, so its
  // denials are unchanged.
  const effectiveFiles = changedFiles.filter((f) => !isManagedProvisionedPath(f));

  // Fail-closed empty allowlist (C2): an empty/missing `allowed` denies all
  // changes (outsideAllowed = all changed files). Only an explicit `["**"]`
  // allowlist opens scope. This mirrors repair-scope fail-closed defaults:
  // `run.ts` assembly defaults to `["**"]` only when `scope.allowed` is
  // undefined, but validation treats missing/empty as closed so an
  // unscoped contract cannot silently pass. Documented: closed by default,
  // open only via explicit `["**"]`.
  const outsideAllowed = allowed.length > 0
    ? effectiveFiles.filter((f) => !matches(f, allowed))
    : [...effectiveFiles];
  checks.push({
    id: "diff.allowed-scope",
    category: "diff",
    status: outsideAllowed.length ? "FAIL" : "PASS",
    message: outsideAllowed.length ? `Files outside allowed scope: ${outsideAllowed.join(", ")}` : "All changed files are within allowed scope.",
    details: { outsideAllowed }
  });

  const forbiddenChanged = forbidden.length ? effectiveFiles.filter((f) => matches(f, forbidden)) : [];
  checks.push({
    id: "diff.forbidden-paths",
    category: "diff",
    status: forbiddenChanged.length ? "FAIL" : "PASS",
    message: forbiddenChanged.length ? `Forbidden paths changed: ${forbiddenChanged.join(", ")}` : "No forbidden paths changed.",
    details: { forbiddenChanged }
  });

  const frozenChanged = frozen.length ? effectiveFiles.filter((f) => matches(f, frozen)) : [];
  checks.push({
    id: "diff.frozen-paths",
    category: "trust-boundary",
    status: frozenChanged.length ? "FAIL" : "PASS",
    message: frozenChanged.length ? `Frozen validation/contract paths changed: ${frozenChanged.join(", ")}` : "Frozen paths were not modified.",
    details: { frozenChanged }
  });

  return checks;
}
