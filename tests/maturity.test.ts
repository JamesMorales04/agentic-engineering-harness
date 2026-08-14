import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("component maturity inventory", () => {
  it("classifies every original architecture component without treating roadmap checks as maturity", async () => {
    const root = path.resolve(process.cwd());
    const document = await fs.readFile(path.join(root, "docs/COMPONENT_MATURITY.md"), "utf8");
    const evidence = JSON.parse(await fs.readFile(path.join(root, "docs/component-maturity.json"), "utf8")) as { version: number; levels: string[]; components: Record<string, { claimed: string; evidence: string[] }> };
    expect(evidence.version).toBe(1);
    const components = ["Paseo", "Codex CLI", "OpenCode", "Engram", "Graphify", "OpenSpec", "AEH SDD", "TaskContracts", "Gherkin", "Reqnroll", ".NET/xUnit integration", "Testcontainers capability", "Playwright", "Pact", "OPA", "Opengrep", "Trivy", "Podman", "OpenTelemetry", "Engineering Evals", "SBOM", "Cosign", "in-toto/SLSA", "ContextBudgetGateway", "Serena", "Headroom", "Repository Context Map", "aeh_context_retrieve"];
    for (const component of components) expect(document).toContain(component === "aeh_context_retrieve" ? "| `aeh_context_retrieve` |" : `| ${component} |`);
    expect(document).toContain("A roadmap checkbox means that a capability exists");
    expect(Object.keys(evidence.components)).toHaveLength(components.length);
    for (const component of components) { expect(evidence.components[component]?.claimed).toBeTruthy(); expect(evidence.components[component]?.evidence.length).toBeGreaterThan(0); }
  });
});
