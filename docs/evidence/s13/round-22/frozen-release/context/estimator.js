/** Deterministic, dependency-free estimate used for selection. Provider token usage remains authoritative when available. */
export function estimateTokens(value) {
    if (!value)
        return 0;
    return Math.max(1, Math.ceil(value.replace(/\r\n/g, "\n").length / 4));
}
export function estimateBytes(value) {
    return Buffer.byteLength(value, "utf8");
}
//# sourceMappingURL=estimator.js.map