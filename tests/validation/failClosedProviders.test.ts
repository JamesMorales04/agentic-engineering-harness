import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../../src/core/types.js";
import { computeWorktreeDigest } from "../../src/core/git.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import { requireProviderLaneEvidenceV1 } from "../../src/validation/laneEvidence.js";
import { runConfiguredValidators } from "../../src/validators/registry.js";

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-fail-closed-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node -e \"process.exit(0)\"" } }));
  return root;
}

async function bddFixture(): Promise<{ root: string; candidate: CandidateRevisionV1 }> {
  const root = await fixture();
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    scripts: {
      test: "node -e \"process.exit(0)\"",
      bdd: "node -e \"require('node:fs').mkdirSync('.harness/package-bdd',{recursive:true});require('node:fs').writeFileSync('.harness/package-bdd/ran.txt','1')\""
    }
  }));
  await fs.writeFile(path.join(root, "configured-bdd.mjs"), [
    "import fs from 'node:fs';",
    "fs.mkdirSync('.harness/configured-bdd', { recursive: true });",
    "fs.writeFileSync('.harness/configured-bdd/ran.txt', '1');",
    "console.log(JSON.stringify({ version: 1, provider: 'configured-bdd-fixture', scenarios: [{ feature: 'checkout', scenario: 'configured runner', status: 'PASS' }] }));"
  ].join("\n"));
  const sourceDigest = await computeWorktreeDigest(root);
  const candidate = createCandidateRevisionV1({ operationId: "OP-FC-BDD", candidateId: "CAND-FC-BDD", revision: 1, sourceDigest });
  return { root, candidate };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const config: HarnessProjectConfig = { version: 1, project: { name: "fail-closed" }, evidence: { outputDir: ".harness/evidence" } };

describe("specialized validation capabilities fail closed instead of falling through", () => {
  it("resolves a declared browser-test capability to the Playwright provider and blocks when the pinned provider is absent", async () => {
    const root = await fixture();
    const contract: TaskContract = { version: 1, task: { id: "FC-1", title: "browser" }, verification: { capabilities: ["browser-test"] } };
    const checks = await runConfiguredValidators(root, config, contract, "HEAD", []);
    const check = checks.find((item) => item.id === "capability.browser-test");
    expect(check).toBeDefined();
    expect(check!.status).toBe("FAIL");
    expect(check!.details?.blocker).toBe("BROWSER_PROVIDER_UNAVAILABLE");
    expect(check!.message).toContain("BROWSER_PROVIDER_UNAVAILABLE");
  });

  it("resolves a declared visual-test capability to the visual provider and blocks when the pinned provider is absent", async () => {
    const root = await fixture();
    const contract: TaskContract = { version: 1, task: { id: "FC-2", title: "visual" }, verification: { capabilities: ["visual-test"] } };
    const checks = await runConfiguredValidators(root, config, contract, "HEAD", []);
    const check = checks.find((item) => item.id === "capability.visual-test");
    expect(check).toBeDefined();
    expect(check!.status).toBe("FAIL");
    expect(check!.details?.blocker).toBe("VISUAL_PROVIDER_UNAVAILABLE");
  });

  it("does not run generic unit tests for an unsupported declared capability", async () => {
    const root = await fixture();
    const contract: TaskContract = { version: 1, task: { id: "FC-3", title: "unsupported" }, verification: { capabilities: ["policy"] } };
    const checks = await runConfiguredValidators(root, config, contract, "HEAD", []);
    const check = checks.find((item) => item.id === "capability.policy");
    expect(check).toBeDefined();
    expect(check!.status).toBe("FAIL");
    expect(check!.message).toContain("UNSUPPORTED_VALIDATION_CAPABILITY");
  });

  it("blocks a required Pact contract check with an explicit provider blocker instead of a silent SKIP", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "pact.json"), JSON.stringify({ consumer: { name: "consumer" }, provider: { name: "provider" }, interactions: [] }));
    const configured: HarnessProjectConfig = { ...config, validation: { validators: [{ id: "pact-check", adapter: "pact", required: true, options: { pactFile: "pact.json" } }] } };
    const contract: TaskContract = { version: 1, task: { id: "FC-4", title: "pact" } };
    const checks = await runConfiguredValidators(root, configured, contract, "HEAD", []);
    const check = checks.find((item) => item.id === "pact-check");
    expect(check).toBeDefined();
    expect(check!.status).toBe("FAIL");
    expect(check!.details?.blocker).toBe("CONTRACT_PROVIDER_UNAVAILABLE");
    expect(check!.status).not.toBe("SKIP");
  });

  it("blocks a required OCI integration environment when no container runtime is available", async () => {
    const root = await fixture();
    const configured: HarnessProjectConfig = { ...config, validation: { validators: [{ id: "oci-integration", adapter: "integration-environment", required: true, options: { image: "docker.io/library/alpine:3.20", testCommand: "true" } }] } };
    const contract: TaskContract = { version: 1, task: { id: "FC-5", title: "oci" } };
    const checks = await runConfiguredValidators(root, configured, contract, "HEAD", []);
    const check = checks.find((item) => item.id === "oci-integration");
    expect(check).toBeDefined();
    expect(check!.status).toBe("FAIL");
    const result = check!.details?.result as { blockers?: string[] } | undefined;
    const blocked = check!.details?.blocker === "INTEGRATION_PROVIDER_UNAVAILABLE" || (result?.blockers ?? []).some((blocker) => blocker.startsWith("INTEGRATION_"));
    expect(blocked, `expected an explicit integration blocker, received ${JSON.stringify(check!.details)}`).toBe(true);
  });

  it("fails an integration lifecycle that has no explicit readiness step", async () => {
    const root = await fixture();
    const script = path.join(root, "lifecycle.mjs");
    await fs.writeFile(script, "process.exit(0);\n");
    const configured: HarnessProjectConfig = {
      ...config,
      validation: { validators: [{ id: "no-readiness", adapter: "integration-environment", required: true, options: { provider: "project-lifecycle", provisionCommand: `node ${script}`, testCommand: `node ${script}`, cleanupCommand: `node ${script}` } }] }
    };
    const contract: TaskContract = { version: 1, task: { id: "FC-6", title: "readiness" } };
    const checks = await runConfiguredValidators(root, configured, contract, "HEAD", []);
    const check = checks.find((item) => item.id === "no-readiness");
    expect(check).toBeDefined();
    expect(check!.status).toBe("FAIL");
    const result = check!.details?.result as { blockers: string[]; lifecycle: Record<string, boolean> };
    expect(result.lifecycle.ready).toBe(false);
    expect(result.blockers.some((blocker) => blocker.startsWith("INTEGRATION_READINESS_REQUIRED"))).toBe(true);
  });

  it("does not require cleanup when provisioning failed and no resources were created", async () => {
    const root = await fixture();
    const failing = path.join(root, "failing.mjs");
    await fs.writeFile(failing, "process.exit(1);\n");
    const configured: HarnessProjectConfig = {
      ...config,
      validation: { validators: [{ id: "provision-fails", adapter: "integration-environment", required: true, options: { provider: "project-lifecycle", provisionCommand: `node ${failing}`, readinessCommand: `node ${failing}`, testCommand: `node ${failing}` } }] }
    };
    const contract: TaskContract = { version: 1, task: { id: "FC-8", title: "provision failure" } };
    const checks = await runConfiguredValidators(root, configured, contract, "HEAD", []);
    const check = checks.find((item) => item.id === "provision-fails");
    expect(check).toBeDefined();
    expect(check!.status).toBe("FAIL");
    const result = check!.details?.result as { blockers: string[]; lifecycle: Record<string, boolean> };
    expect(result.lifecycle.provisioned).toBe(false);
    expect(result.lifecycle.cleanupRequired).toBe(false);
    expect(result.blockers.some((blocker) => blocker.startsWith("INTEGRATION_PROVISION_REQUIRED"))).toBe(true);
    expect(result.blockers.some((blocker) => blocker.startsWith("INTEGRATION_CLEANUP_REQUIRED"))).toBe(false);
  });

  it("requires an explicit cleanup mechanism when resources were actually provisioned", async () => {
    const root = await fixture();
    const passing = path.join(root, "passing.mjs");
    await fs.writeFile(passing, "process.exit(0);\n");
    const configured: HarnessProjectConfig = {
      ...config,
      validation: { validators: [{ id: "no-cleanup", adapter: "integration-environment", required: true, options: { provider: "project-lifecycle", provisionCommand: `node ${passing}`, readinessCommand: `node ${passing}`, testCommand: `node ${passing}` } }] }
    };
    const contract: TaskContract = { version: 1, task: { id: "FC-9", title: "cleanup required" } };
    const checks = await runConfiguredValidators(root, configured, contract, "HEAD", []);
    const check = checks.find((item) => item.id === "no-cleanup");
    expect(check).toBeDefined();
    expect(check!.status).toBe("FAIL");
    const result = check!.details?.result as { blockers: string[]; lifecycle: Record<string, boolean> };
    expect(result.lifecycle.provisioned).toBe(true);
    expect(result.lifecycle.cleanupRequired).toBe(true);
    expect(result.blockers.some((blocker) => blocker.startsWith("INTEGRATION_CLEANUP_REQUIRED"))).toBe(true);
  });

  it("blocks a required declared bdd capability with a typed CONTRACT_PROVIDER_UNAVAILABLE instead of a silent skip", async () => {
    const root = await fixture();
    const contract: TaskContract = { version: 1, task: { id: "FC-10", title: "bdd" }, verification: { capabilities: ["bdd"] } };
    const checks = await runConfiguredValidators(root, config, contract, "HEAD", []);
    const check = checks.find((item) => item.id === "capability.bdd");
    expect(check).toBeDefined();
    expect(check!.status).toBe("FAIL");
    expect(check!.details?.blocker).toBe("CONTRACT_PROVIDER_UNAVAILABLE");
    expect(check!.message).toContain("CONTRACT_PROVIDER_UNAVAILABLE");
    expect(check!.message).not.toContain("bdd-runner acceptance was skipped.");
  });

  it("runs a configured bdd provider for a declared bdd capability and persists verifiable candidate-bound CONTRACT evidence", async () => {
    const { root, candidate } = await bddFixture();
    const configured: HarnessProjectConfig = {
      ...config,
      validation: { providers: [{ id: "bdd-provider", capability: "bdd", provider: "configured-bdd-fixture", command: `node ${path.join(root, "configured-bdd.mjs")}` }] }
    };
    const contract: TaskContract = { version: 1, task: { id: "FC-11", title: "bdd configured" }, verification: { capabilities: ["bdd"] } };
    const checks = await runConfiguredValidators(root, configured, contract, "HEAD", [], { candidate });
    const check = checks.find((item) => item.id === "capability.bdd");
    expect(check, JSON.stringify(checks)).toBeDefined();
    expect(check!.status, JSON.stringify(check)).toBe("PASS");
    await expect(fs.access(path.join(root, ".harness", "configured-bdd", "ran.txt"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, ".harness", "package-bdd", "ran.txt"))).rejects.toThrow();
    const evidence = await requireProviderLaneEvidenceV1(root, configured, "CONTRACT", candidate, "capability.bdd");
    expect(evidence.status).toBe("PASS");
    expect(evidence.provider.name).toBe("configured-bdd-fixture");
  });

  it("fails a configured bdd provider whose runner exits non-zero", async () => {
    const { root, candidate } = await bddFixture();
    const configured: HarnessProjectConfig = {
      ...config,
      validation: { providers: [{ id: "bdd-provider", capability: "bdd", provider: "failing-bdd-fixture", command: "node -e \"process.exit(1)\"" }] }
    };
    const contract: TaskContract = { version: 1, task: { id: "FC-12", title: "bdd failing" }, verification: { capabilities: ["bdd"] } };
    const checks = await runConfiguredValidators(root, configured, contract, "HEAD", [], { candidate });
    const check = checks.find((item) => item.id === "capability.bdd");
    expect(check, JSON.stringify(checks)).toBeDefined();
    expect(check!.status, JSON.stringify(check)).toBe("FAIL");
  });

  it("keeps an optional missing provider as SKIP while a required one blocks", async () => {
    const root = await fixture();
    const configured: HarnessProjectConfig = { ...config, validation: { validators: [{ id: "optional-pact", adapter: "pact", required: false, options: { pactFile: "pact.json" } }] } };
    await fs.writeFile(path.join(root, "pact.json"), JSON.stringify({ interactions: [] }));
    const contract: TaskContract = { version: 1, task: { id: "FC-7", title: "optional" } };
    const checks = await runConfiguredValidators(root, configured, contract, "HEAD", []);
    const check = checks.find((item) => item.id === "optional-pact");
    expect(check!.status).toBe("SKIP");
    expect(check!.details?.blocker).toBe("CONTRACT_PROVIDER_UNAVAILABLE");
  });
});
