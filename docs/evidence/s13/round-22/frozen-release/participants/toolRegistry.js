import { sha256Canonical } from "../core/digest.js";
import { AehError } from "../core/errors.js";
export function authorizeToolPack(input) {
    const available = new Set(input.availableTools.filter((tool) => tool.available).map((tool) => tool.id));
    const required = [...new Set(input.toolPack.required)].sort();
    const optional = [...new Set(input.toolPack.optional)].filter((tool) => !required.includes(tool)).sort();
    const forbidden = new Set(input.toolPack.forbidden);
    const missing = required.filter((tool) => !available.has(tool));
    if (missing.length)
        throw new AehError("TOOL_AUTHORIZATION_REJECTED", `required tools unavailable: ${missing.join(", ")}.`);
    const exposed = [...new Set([...required, ...optional.filter((tool) => available.has(tool))])].filter((tool) => !forbidden.has(tool)).sort();
    if (exposed.length !== required.length + optional.filter((tool) => available.has(tool)).filter((tool) => !forbidden.has(tool)).length)
        throw new AehError("TOOL_AUTHORIZATION_REJECTED", "tool pack overlaps its forbidden set.");
    const denied = [...new Set([...available].filter((tool) => !exposed.includes(tool) || forbidden.has(tool)))].sort();
    const payload = { version: 1, role: input.role, available: [...available].sort(), exposed, denied };
    return { ...payload, digest: sha256Canonical(payload) };
}
//# sourceMappingURL=toolRegistry.js.map