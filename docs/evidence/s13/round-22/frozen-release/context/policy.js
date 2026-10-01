const defaultModes = {
    Explorer: "terse",
    Planner: "compact",
    "Spec Manager": "compact",
    Implementer: "compact",
    Reviewer: "compact",
    "Operation Supervisor": "terse"
};
export function resolveContextPolicy(config) {
    const value = "context" in (config ?? {}) ? config.context : config;
    const compression = value?.compression;
    return {
        mode: value?.mode ?? "enforce",
        defaultBudget: value?.budgets?.default ?? { inputTokens: 16_000 },
        agentBudgets: value?.budgets?.agents ?? {},
        phaseBudgets: value?.budgets?.phases ?? {},
        repositoryMap: { enabled: value?.repositoryMap?.enabled ?? true, tokenBudget: value?.repositoryMap?.tokenBudget ?? 2_000, maxGraphHops: value?.repositoryMap?.maxGraphHops ?? 2 },
        semanticRetrieval: { provider: value?.semanticRetrieval?.provider ?? "serena", required: value?.semanticRetrieval?.required ?? true, editing: value?.semanticRetrieval?.editing ?? false },
        compression: { provider: compression?.provider ?? "headroom", required: compression?.required ?? true, minTokens: compression?.minTokens ?? 2_000, reversible: compression?.reversible ?? true, command: compression?.command },
        retrieval: { maxRequestsPerTurn: value?.retrieval?.maxRequestsPerTurn ?? 8, maxTokensPerRequest: value?.retrieval?.maxTokensPerRequest ?? 6_000, maxTotalTokensPerTurn: value?.retrieval?.maxTotalTokensPerTurn ?? 20_000 },
        outputPolicy: { enabled: value?.outputPolicy?.enabled ?? true, modes: { ...defaultModes, ...(value?.outputPolicy?.modes ?? {}) } }
    };
}
export function outputMode(policy, role) {
    return policy.outputPolicy.modes[role ?? ""] ?? "compact";
}
export function isCompressionConfigured(policy) {
    return policy.compression.provider === "headroom";
}
export function outputPolicyInstruction(policy, role) {
    if (!policy.outputPolicy.enabled)
        return undefined;
    const mode = outputMode(policy, role);
    if (mode === "terse")
        return "Output policy: terse. Do not restate the assignment or narrate trivial successful tool calls. Prefer durable artifact references; preserve evidence, uncertainty, blockers and exact structured-result contracts.";
    if (mode === "compact")
        return "Output policy: compact. Explain meaningful decisions and blockers, omit ceremony and repetitive summaries, and preserve everything required for safe implementation/review. Never shorten structured-result JSON.";
    return "Output policy: normal. Be concise but complete; preserve exact evidence and structured-result contracts.";
}
//# sourceMappingURL=policy.js.map