import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
export const MATURITY_LEVELS = ["DECLARED", "ADAPTER", "EXECUTABLE", "WORKFLOW_INTEGRATED", "DOGFOODED", "EVAL_VALIDATED", "PRODUCTION_GRADE"];
const levelRequirements = {
    DECLARED: ["documentation", "design"],
    ADAPTER: ["adapter-source", "unit-contract"],
    EXECUTABLE: ["provider-contract"],
    WORKFLOW_INTEGRATED: ["workflow-test"],
    DOGFOODED: ["dogfood-lane"],
    EVAL_VALIDATED: ["eval-result"],
    PRODUCTION_GRADE: ["reliability-gate", "security-gate"]
};
export async function loadMaturityInventory(root, file = "maturity/components.yaml") {
    return YAML.parse(await fs.readFile(path.resolve(root, file), "utf8"));
}
export async function validateMaturityInventory(root, inventory) {
    const issues = [];
    const supported = [];
    for (const component of inventory.components ?? []) {
        const evidence = Array.isArray(component.evidence) ? component.evidence : [];
        const validEvidence = [];
        for (const item of evidence) {
            if (!item || !item.type || !item.id || !item.path) {
                issues.push(`${component.component}: every evidence item requires type, id and path.`);
                continue;
            }
            if (!MATURITY_LEVELS.includes(component.claimed))
                issues.push(`${component.component}: unknown claimed level '${component.claimed}'.`);
            try {
                await fs.access(path.resolve(root, item.path));
                validEvidence.push(item);
            }
            catch {
                issues.push(`${component.component}: evidence path does not exist: ${item.path}.`);
            }
        }
        const computed = highestSupportedLevel(validEvidence);
        supported.push({ component: component.component, claimed: component.claimed, supported: computed });
        if (rank(component.claimed) > rank(computed))
            issues.push(`${component.component}: claimed ${component.claimed} exceeds evidence-supported ${computed}.`);
    }
    return { ok: issues.length === 0, issues, supported };
}
function highestSupportedLevel(evidence) {
    let supported = "DECLARED";
    for (const level of MATURITY_LEVELS)
        if (levelRequirements[level].every((type) => evidence.some((item) => item.type === type)))
            supported = level;
    return supported;
}
function rank(level) { return MATURITY_LEVELS.indexOf(level); }
//# sourceMappingURL=inventory.js.map