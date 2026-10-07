import os from "node:os";
import { describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../../src/core/types.js";
import { GenericBddExecutionProvider } from "../../src/providers/validation/bddExecution.js";
import { PactContractTestingProvider } from "../../src/providers/validation/pact.js";
import { ValidationCapabilityRegistry } from "../../src/providers/validation/registry.js";
import { ProjectNativeTestExecutionProvider } from "../../src/providers/validation/testExecution.js";
import type { ProviderExecution, ValidationProviderContext } from "../../src/providers/validation/types.js";

const config: HarnessProjectConfig = { version: 1, project: { name: "empty-evidence-repro" } };
const contract: TaskContract = { version: 1, task: { id: "EMPTY-1", title: "empty" } };

function context(capability: ValidationProviderContext["capability"]): ValidationProviderContext {
  return { root: os.tmpdir(), config, contract, capability, rawArtifactDirectory: ".harness/evidence/raw" };
}

function execution(command: string, capability: ValidationProviderContext["capability"]): ProviderExecution {
  return {
    plan: { provider: "empty-fixture", capability, command, cwd: os.tmpdir() },
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    rawArtifact: "",
  };
}

function structuredExecution(stdout: string, capability: ValidationProviderContext["capability"]): ProviderExecution {
  return {
    plan: { provider: "structured-fixture", capability, command: "true", cwd: os.tmpdir() },
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
    rawArtifact: "",
  };
}

describe("empty output fails closed (I-NEW-1)", () => {
  it("test normalizer fails closed on empty output with exit 0", async () => {
    const result = await new ProjectNativeTestExecutionProvider().normalize(context("unit-test"), execution("true", "unit-test"));
    expect(result.status).toBe("FAIL");
    expect(result.summary.total).toBe(0);
    expect(JSON.stringify(result.failures)).toContain("EMPTY_TEST_EVIDENCE");
  });

  it("bdd normalizer fails closed on empty output with exit 0", async () => {
    const result = await new GenericBddExecutionProvider().normalize(context("bdd"), execution("true", "bdd"));
    expect(result.status).toBe("FAIL");
    expect(result.summary.failed).toBe(1);
    expect(JSON.stringify(result)).toContain("EMPTY_TEST_EVIDENCE");
  });

  it("pact normalizer fails closed on empty output with exit 0", async () => {
    const result = await new PactContractTestingProvider().normalize(context("contract-test"), execution("true", "contract-test"));
    expect(result.status).toBe("FAIL");
    expect(result.summary.total).toBe(0);
    expect(JSON.stringify(result.failures)).toContain("EMPTY_TEST_EVIDENCE");
  });
});

describe("structured zero-test evidence fails closed (Luna blocker)", () => {
  it("test normalizer fails closed on structured PASS with total:0 and nonempty failures", async () => {
    const stdout = JSON.stringify({ version: 1, provider: "structured-fixture", status: "PASS", summary: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 1 }, failures: [{ message: "boom" }] });
    const result = await new ProjectNativeTestExecutionProvider().normalize(context("unit-test"), structuredExecution(stdout, "unit-test"));
    expect(result.status).toBe("FAIL");
    expect(result.summary.total).toBe(0);
    expect(JSON.stringify(result.failures)).toContain("EMPTY_TEST_EVIDENCE");
  });

  it("test normalizer fails closed on structured PASS with total:0 and empty failures", async () => {
    const stdout = JSON.stringify({ version: 1, provider: "structured-fixture", status: "PASS", summary: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 1 }, failures: [] });
    const result = await new ProjectNativeTestExecutionProvider().normalize(context("unit-test"), structuredExecution(stdout, "unit-test"));
    expect(result.status).toBe("FAIL");
    expect(result.summary.total).toBe(0);
    expect(JSON.stringify(result.failures)).toContain("EMPTY_TEST_EVIDENCE");
  });

  it("pact normalizer fails closed on a total:0 claim with failures present", async () => {
    const stdout = JSON.stringify({ total: 0, failures: [{ message: "boom" }] });
    const result = await new PactContractTestingProvider().normalize(context("contract-test"), structuredExecution(stdout, "contract-test"));
    expect(result.status).toBe("FAIL");
    expect(JSON.stringify(result.failures)).toContain("boom");
  });

  it("bdd normalizer fails closed on a structured PASS claim with zero scenarios", async () => {
    const stdout = JSON.stringify({ version: 1, status: "PASS", summary: { total: 0 }, scenarios: [] });
    const result = await new GenericBddExecutionProvider().normalize(context("bdd"), structuredExecution(stdout, "bdd"));
    expect(result.status).toBe("FAIL");
    expect(JSON.stringify(result)).toContain("EMPTY_TEST_EVIDENCE");
  });
});

describe("explicit provider miss fails closed (I-NEW-2)", () => {
  it("resolve() returns undefined for an unknown explicit provider", async () => {
    const registry = new ValidationCapabilityRegistry();
    const resolved = await registry.resolve({
      ...context("unit-test"),
      providerSpec: { id: "bad", capability: "unit-test", provider: "does-not-exist", command: "true" },
    });
    expect(resolved).toBeUndefined();
  });

  it("resolve() never labels a fallback as explicit", async () => {
    const registry = new ValidationCapabilityRegistry();
    const resolved = await registry.resolve({
      ...context("unit-test"),
      providerSpec: { id: "bad", capability: "unit-test", provider: "does-not-exist", command: "true" },
    });
    if (resolved !== undefined) {
      expect(resolved.source).not.toBe("explicit");
    }
  });
});
