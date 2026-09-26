import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract, ValidatorSpec } from "../../src/core/types.js";
import { computeWorktreeDigest } from "../../src/core/git.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import { runCapabilityValidator } from "../../src/providers/validation/registry.js";
import { runConfiguredValidators } from "../../src/validators/registry.js";
import { requireProviderLaneEvidenceV1 } from "../../src/validation/laneEvidence.js";

const root = path.resolve(process.cwd());
const fixtureRoots: string[] = [];

const config: HarnessProjectConfig = { version: 1, project: { name: "contract-integration-campaign" }, evidence: { outputDir: ".harness/evidence" } };
const contract: TaskContract = { version: 1, task: { id: "S11-CI", title: "contract and integration campaign" }, requirements: [{ id: "REQ-BDD", capabilities: ["bdd"] }, { id: "REQ-API", capabilities: ["contract-test"] }] };

async function fixture(files: Record<string, string>): Promise<{ directory: string; candidate: CandidateRevisionV1 }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s11-ci-"));
  fixtureRoots.push(directory);
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "s11-ci-fixture", version: "1.0.0" }));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  const sourceDigest = await computeWorktreeDigest(directory);
  const candidate = createCandidateRevisionV1({ operationId: "OP-S11-CI", candidateId: "CAND-S11-CI", revision: 1, sourceDigest });
  return { directory, candidate };
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const openApiBefore = `openapi: 3.0.0
info: { title: pets, version: "1.0.0" }
paths:
  /pets:
    get:
      responses:
        "200": { description: ok }
components:
  schemas:
    Pet:
      type: object
      properties:
        id: { type: string }
      required: [id]
`;

const openApiCompatible = `openapi: 3.0.0
info: { title: pets, version: "1.1.0" }
paths:
  /pets:
    get:
      responses:
        "200": { description: ok }
  /owners:
    get:
      responses:
        "200": { description: ok }
components:
  schemas:
    Pet:
      type: object
      properties:
        id: { type: string }
        nickname: { type: string }
      required: [id]
`;

const openApiBreaking = `openapi: 3.0.0
info: { title: pets, version: "2.0.0" }
paths:
  /pets:
    get:
      responses:
        "200": { description: ok }
components:
  schemas:
    Pet:
      type: object
      properties:
        id: { type: string }
      required: [id, name]
`;

describe("real contract and integration validation campaign", () => {
  it("runs a real OpenAPI comparison through the validator path and persists candidate-bound CONTRACT evidence", async () => {
    const { directory, candidate } = await fixture({ "contracts/before.yaml": openApiBefore, "contracts/after.yaml": openApiCompatible });
    const configured: HarnessProjectConfig = { ...config, validation: { validators: [{ id: "openapi-compat", adapter: "openapi", required: true, options: { baseline: "contracts/before.yaml", current: "contracts/after.yaml" } }] } };
    const checks = await runConfiguredValidators(directory, configured, contract, "HEAD", [], { candidate });
    const check = checks.find((item) => item.id === "openapi-compat");
    expect(check, JSON.stringify(checks)).toBeDefined();
    expect(check!.status).toBe("PASS");
    const evidence = await requireProviderLaneEvidenceV1(directory, configured, "CONTRACT", candidate, "openapi-compat");
    expect(evidence.status).toBe("PASS");
    expect(evidence.lane).toBe("CONTRACT");
    expect(evidence.provider.name).toBe("openapi");
    expect(evidence.artifacts.some((artifact) => artifact.kind === "baseline" && artifact.path.endsWith("contracts/before.yaml"))).toBe(true);
    expect(evidence.workspace.observedSourceDigest).toBe(candidate.sourceDigest);
    await fs.writeFile(path.join(directory, "contracts/after.yaml"), openApiBreaking, "utf8");
    const breaking = await runConfiguredValidators(directory, configured, contract, "HEAD", [], { candidate });
    expect(breaking.find((item) => item.id === "openapi-compat")!.status).toBe("FAIL");
  });

  it("executes a real BDD runner through the capability provider and persists candidate-bound CONTRACT evidence", async () => {
    const { directory, candidate } = await fixture({});
    const spec: ValidatorSpec = { id: "bdd-real", adapter: "bdd", required: true, command: `node ${path.join(root, "tests/fixtures/bdd/node-runner.mjs")}`, options: { provider: "node-bdd-fixture" } };
    const check = await runCapabilityValidator({ root: directory, config, contract, spec, capability: "bdd", rawArtifactDirectory: ".harness/evidence/raw", baseRef: "HEAD", candidate }, spec.id, "bdd", true);
    expect(check.status).toBe("PASS");
    const evidence = await requireProviderLaneEvidenceV1(directory, config, "CONTRACT", candidate, "bdd-real");
    expect(evidence.status).toBe("PASS");
    expect(evidence.findings).toEqual([]);
    expect(evidence.commandDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("provisions, proves readiness for, tests, and cleans up a real isolated service lifecycle with candidate-bound INTEGRATION evidence", async () => {
    const { directory, candidate } = await fixture({});
    const service = path.join(root, "tests/fixtures/integration/http-service.mjs");
    const spec: ValidatorSpec = {
      id: "integration-lifecycle",
      adapter: "integration-environment",
      required: true,
      timeoutSeconds: 120,
      options: {
        provider: "project-lifecycle",
        provisionCommand: `node ${service} provision --root ${directory}`,
        readinessCommand: `node ${service} ready --root ${directory}`,
        testCommand: `node ${service} test --root ${directory}`,
        cleanupCommand: `node ${service} cleanup --root ${directory}`,
        network: "isolated",
        ephemeral: true
      }
    };
    const check = await runCapabilityValidator({ root: directory, config, contract, spec, capability: "integration-test", rawArtifactDirectory: ".harness/evidence/raw", baseRef: "HEAD", candidate }, spec.id, "integration-test", true);
    expect(check.status, JSON.stringify(check.details)).toBe("PASS");
    const result = check.details?.result as { lifecycle: Record<string, boolean> };
    expect(result.lifecycle).toMatchObject({ provisioned: true, ready: true, tested: true, cleaned: true });
    const evidence = await requireProviderLaneEvidenceV1(directory, config, "INTEGRATION", candidate, "integration-lifecycle");
    expect(evidence.status).toBe("PASS");
    expect(evidence.lane).toBe("INTEGRATION");
    const cleaned = JSON.parse(await fs.readFile(path.join(directory, ".harness", "integration", "cleaned.json"), "utf8")) as { pid: number; terminated: boolean };
    expect(cleaned.terminated).toBe(true);
    expect(() => process.kill(cleaned.pid, 0)).toThrow();
    await expect(fs.access(path.join(directory, ".harness", "integration", "service.pid"))).rejects.toThrow();
  }, 120_000);
});
