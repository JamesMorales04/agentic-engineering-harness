export const CONTROL_CENTER_CONTRACT_VERSION = 1;
export function controlCenterResourceId(kind, value) {
    const normalized = value.trim();
    if (!normalized)
        throw new Error(`Control Center ${kind} identifier must not be empty.`);
    return normalized;
}
//# sourceMappingURL=contracts.js.map