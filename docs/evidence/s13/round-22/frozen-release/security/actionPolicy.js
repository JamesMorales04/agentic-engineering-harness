/** Deterministic allowlist for externally observable delivery effects. */
export function configuredExternalEffects(config, kind) {
    if (kind === "audit")
        return [];
    const effects = [];
    const github = config.delivery?.github;
    if (github?.enabled === true) {
        effects.push("github.issue.create", "github.branch.create");
        if (github.finalizeOnAcceptance === true) {
            effects.push("git.push");
            // Requested and authorized effects are enumerated in frozen policy (TARGET 11): a
            // delivery policy may finalize push-only when pull requests are not requested.
            if (github.pullRequests !== false)
                effects.push("github.pull-request.create");
        }
    }
    return [...new Set(effects)].sort();
}
/** External publication and non-idempotent creation always need exact human action authorization. */
export function requiredHumanActionAuthorizations(effects) {
    const requiresHuman = new Set(["git.push", "github.issue.create", "github.pull-request.create"]);
    return [...new Set(effects)].filter((action) => requiresHuman.has(action)).sort().map((action) => ({ kind: "ACTION_AUTHORIZATION", action }));
}
//# sourceMappingURL=actionPolicy.js.map