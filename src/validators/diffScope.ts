import { minimatch } from "minimatch";
import type { TaskContract, ValidationCheck } from "../core/types.js";

function matches(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(file, pattern, { dot: true, matchBase: false }));
}

export function validateDiffScope(changedFiles: string[], contract: TaskContract, globalFrozen: string[] = []): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const allowed = contract.scope?.allowed ?? [];
  const forbidden = contract.scope?.forbidden ?? [];
  const frozen = [...globalFrozen, ...(contract.scope?.frozen ?? [])];

  const outsideAllowed = allowed.length > 0 ? changedFiles.filter((f) => !matches(f, allowed)) : [];
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
