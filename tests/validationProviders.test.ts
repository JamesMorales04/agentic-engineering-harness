import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract, ValidatorSpec } from "../src/core/types.js";
import { buildRequirementEvidenceGraph } from "../src/evidence/graph.js";
import { runBddExecution } from "../src/providers/validation/bddExecution.js";
import { IntegrationEnvironmentProvider } from "../src/providers/validation/integrationEnvironment.js";
import { runPactVerification } from "../src/providers/validation/pact.js";
import { resultCheck } from "../src/providers/validation/protocol.js";
import { runTestExecution } from "../src/providers/validation/testExecution.js";
import type { ValidationProviderContext } from "../src/providers/validation/types.js";
import { commandExists } from "../src/utils/process.js";

const root = path.resolve(process.cwd());
const config: HarnessProjectConfig = { version: 1, project: { name: "provider-fixtures" }, evidence: { outputDir: ".harness/evidence" } };
const contract: TaskContract = { version: 1, task: { id: "PROVIDER-1", title: "provider fixtures" }, requirements: [{ id: "REQ-TEST", capabilities: ["unit-test"] }, { id: "REQ-BDD", capabilities: ["bdd"] }, { id: "REQ-PACT", capabilities: ["contract-test"] }] };

function context(capability: "unit-test" | "bdd" | "integration-test" | "contract-test", spec: ValidatorSpec, fixtureRoot = root): ValidationProviderContext { return { root: fixtureRoot, config, contract, capability, spec, rawArtifactDirectory: ".harness/evidence/raw", baseRef: "main" }; }

describe("technology-neutral validation providers", () => {
  it("normalizes project-native Node and Python test commands to the same protocol", async () => {
    const node = await runTestExecution(context("unit-test", { id: "node-test", adapter: "test-execution", command: `node ${path.join(root, "tests/fixtures/providers/node/runner.mjs")}` }));
    const python = await runTestExecution(context("unit-test", { id: "python-test", adapter: "test-execution", command: `python3 ${path.join(root, "tests/fixtures/providers/python/runner.py")}` }));
    expect(node.result).toMatchObject({ status: "PASS", summary: { total: 2, passed: 2 }, rawArtifact: expect.stringContaining("node-test") });
    expect(node.result.provider).toBe("node-native-fixture"); expect(python.result.provider).toBe("python-native-fixture"); expect(python.result.summary).toMatchObject({ total: 2, passed: 2, failed: 0, skipped: 0 }); expect(node.result.summary.durationMs).toBeGreaterThanOrEqual(0); expect(python.result.summary.durationMs).toBeGreaterThanOrEqual(0);
    await expect(fs.stat(path.join(root, node.result.rawArtifact))).resolves.toBeDefined();
  });

  it("normalizes two independent BDD runners into common scenario evidence", async () => {
    const node = await runBddExecution(context("bdd", { id: "node-bdd", adapter: "bdd", command: `node ${path.join(root, "tests/fixtures/bdd/node-runner.mjs")}` }));
    const python = await runBddExecution(context("bdd", { id: "python-bdd", adapter: "bdd", command: `python3 ${path.join(root, "tests/fixtures/bdd/python-runner.py")}` }));
    expect(node.result.scenarios[0]).toMatchObject({ feature: "greeting", scenario: "a greeting is returned", status: "PASS", requirementIds: ["REQ-BDD"] });
    expect(python.result.scenarios[0]).toMatchObject({ feature: "greeting", scenario: "a greeting is returned", status: "PASS", requirementIds: ["REQ-BDD"] });
  });

  it("executes a non-Testcontainers ephemeral lifecycle with explicit security requirements", async () => {
    const fixture = path.join(root, "tests/fixtures/integration/lifecycle.mjs"); const spec: ValidatorSpec = { id: "integration", adapter: "integration-environment", options: { provider: "project-lifecycle", provisionCommand: `node ${fixture} provision`, readinessCommand: `node ${fixture} ready`, testCommand: `node ${fixture} test`, cleanupCommand: `node ${fixture} cleanup`, connectionData: { SERVICE_URL: "http://127.0.0.1:1234" }, network: "isolated", ephemeral: true } };
    const provider = new IntegrationEnvironmentProvider(); const result = await provider.detect(context("integration-test", spec)); const plan = await provider.plan(context("integration-test", spec), result); const execution = await provider.execute(context("integration-test", spec), plan); const normalized = await provider.normalize(context("integration-test", spec), execution);
    expect(normalized).toMatchObject({ status: "PASS", lifecycle: { provisioned: true, ready: true, tested: true, cleaned: true }, connectionData: { SERVICE_URL: "http://127.0.0.1:1234" }, requirements: [{ network: "isolated", ephemeral: true }] });
    expect((await provider.doctor(context("integration-test", { ...spec, options: { ...spec.options, privileged: true } }))).available).toBe(false);
  });

  it("connects normalized capability evidence to the RequirementEvidenceGraph", async () => {
    const execution = await runTestExecution(context("unit-test", { id: "unit-check", adapter: "test-execution", command: `node ${path.join(root, "tests/fixtures/providers/node/runner.mjs")}` })); const check = resultCheck("unit-check", "test", execution.result, true);
    const graph = await buildRequirementEvidenceGraph({ root, config: { ...config, evidence: { ...config.evidence, requireComplete: true } }, contract: { ...contract, requirements: [{ id: "REQ-TEST", capabilities: ["unit-test"] }] }, report: { version: 1, taskId: contract.task.id, status: "PASS", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), checks: [check], changedFiles: ["src/provider.ts"], metadata: { project: "provider-fixtures", baseRef: "main" } } });
    expect(graph.complete).toBe(true); expect(graph.requirements[0].requiredCapabilities).toEqual(["unit-test"]); expect(graph.nodes.find((node) => node.id === "check:unit-check")?.data?.details).toMatchObject({ capability: "unit-test" });
  });

  it("uses an actual Pact verifier when the official CLI is installed", async () => {
    if (!(await commandExists("pact", root)) && !(await commandExists("pact_verifier_cli", root))) return;
    const port = 4545 + Math.floor(Math.random() * 200); const provider = spawn(process.execPath, [path.join(root, "tests/fixtures/pact/provider.mjs"), String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("fixture provider did not start")), 10_000); provider.stdout.on("data", (chunk) => { if (String(chunk).includes("ready:")) { clearTimeout(timer); resolve(); } }); provider.on("error", reject); });
      const spec: ValidatorSpec = { id: "pact-real", adapter: "contract-test", options: { pactFile: path.relative(root, path.join(root, "tests/fixtures/pact/pact.json")), hostname: "127.0.0.1", port } }; const execution = await runPactVerification(context("contract-test", spec));
      expect(execution.result.status).toBe("PASS"); expect(execution.result.summary.total).toBeGreaterThan(0); expect(execution.result.rawArtifact).toContain("pact-real");
      const check = resultCheck("pact-real", "contract", execution.result, true);
      const graph = await buildRequirementEvidenceGraph({ root, config: { ...config, evidence: { ...config.evidence, requireComplete: true } }, contract: { ...contract, requirements: [{ id: "REQ-PACT", capabilities: ["contract-test"] }] }, report: { version: 1, taskId: contract.task.id, status: "PASS", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), checks: [check], changedFiles: ["src/provider.ts"], metadata: { project: "provider-fixtures", baseRef: "main" } } });
      expect(graph.complete).toBe(true); expect(graph.requirements[0].passingValidators).toContain("pact-real"); expect(graph.nodes.find((node) => node.id === "check:pact-real")?.data?.details).toMatchObject({ capability: "contract-test" });
    } finally { provider.kill("SIGTERM"); }
  });
});
