import fs from "node:fs";

const feature = fs.readFileSync(new URL("./greeting.feature", import.meta.url), "utf8");
const featureName = feature.match(/^Feature:\s*(.+)$/m)?.[1];
const scenarioMatch = feature.match(/^\s*Scenario:\s*(.+)$/m);
const tags = [...feature.matchAll(/^@(\S+)/gm)].map((match) => `@${match[1]}`);
const steps = feature.split(/\r?\n/).filter((line) => /^\s*(Given|When|Then|And|But)\b/.test(line));
const passed = featureName === "greeting" && scenarioMatch?.[1] === "a greeting is returned" && steps.length === 3;

console.log(JSON.stringify({
  version: 1,
  provider: "node-gherkin-fixture",
  scenarios: [{ feature: featureName ?? "unknown", scenario: scenarioMatch?.[1] ?? "unknown", tags, status: passed ? "PASS" : "FAIL", source: { file: "tests/fixtures/bdd/greeting.feature", line: 4 }, requirementIds: ["REQ-BDD"], ...(passed ? {} : { error: "feature parsing or step execution failed" }) }]
}));
process.exitCode = passed ? 0 : 1;
