export function validateDiffBudget(contract, stats) {
    const c = contract.constraints ?? {};
    const checks = [];
    if (c.maxFilesChanged !== undefined) {
        checks.push({
            id: "budget.files",
            category: "diff-budget",
            status: stats.files <= c.maxFilesChanged ? "PASS" : "FAIL",
            message: `${stats.files}/${c.maxFilesChanged} changed files.`
        });
    }
    if (c.maxLinesAdded !== undefined) {
        checks.push({
            id: "budget.lines-added",
            category: "diff-budget",
            status: stats.added <= c.maxLinesAdded ? "PASS" : "FAIL",
            message: `${stats.added}/${c.maxLinesAdded} lines added.`
        });
    }
    if (c.maxLinesDeleted !== undefined) {
        checks.push({
            id: "budget.lines-deleted",
            category: "diff-budget",
            status: stats.deleted <= c.maxLinesDeleted ? "PASS" : "FAIL",
            message: `${stats.deleted}/${c.maxLinesDeleted} lines deleted.`
        });
    }
    return checks;
}
//# sourceMappingURL=constraints.js.map