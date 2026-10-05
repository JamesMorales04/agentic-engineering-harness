import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../../src/core/types.js";
import { computeWorktreeDigest } from "../../src/core/git.js";
import { createCandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import { contractValidationRequirementsV1 } from "../../src/architecture/validationRequirements.js";
import { runConfiguredValidators } from "../../src/validators/registry.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-capability-trace-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: {} }));
  return root;
}

/**
 * RED regression for the Home verification-pipeline gap (CHANGE-20261005T004245Z-be9f5ac1):
 * the frozen contract trace for a provider capability is `capability:<capability>`
 * (see openSpecBridge + sdd normalizeValidators + contractValidationRequirementsV1),
 * so the executed declared-capability check must carry the identical id.
 * A dot-form id (`capability.<capability>`) is discarded by the AcceptanceOracle's
 * `validationForRequirement` (exact id / candidate.assurance.validation.<id> /
 * candidate-impact-<id> / details.requirementId) and by the evidence requirement
 * graph (`requirement.validators.includes(check.id)`), producing
 * VERIFICATION_VALIDATION_EVIDENCE_INSUFFICIENT with an empty coveredAssertionIds
 * even when the lane itself PASSed.
 */
describe("capability trace identity between contract compilation and validator execution", () => {
  it("executes a declared visual-test capability under the exact capability:visual-test trace id", async () => {
    const root = await fixture();
    const sourceDigest = await computeWorktreeDigest(root);
    const candidate = createCandidateRevisionV1({ operationId: "OP-TRACE", candidateId: "CAND-TRACE", revision: 1, sourceDigest });
    const config: HarnessProjectConfig = { version: 1, project: { name: "trace" }, evidence: { outputDir: ".harness/evidence" } };
    const contract: TaskContract = {
      version: 1,
      task: { id: "TRACE-1", title: "trace" },
      requirements: [{ id: "R1", description: "visual", validators: ["capability:visual-test"] }],
      verification: { capabilities: ["visual-test"] },
    };
    const derived = contractValidationRequirementsV1({
      requirements: contract.requirements!,
      scope: ["**"],
      providers: [{ id: "visual-provider", capability: "visual-test", provider: "playwright" }],
    });
    expect(derived.map((item) => item.id)).toEqual(["capability:visual-test"]);

    const checks = await runConfiguredValidators(root, config, contract, "HEAD", [], { candidate });
    const check = checks.find((item) => item.id === "capability:visual-test");
    expect(check, JSON.stringify(checks.map((item) => item.id))).toBeDefined();
    expect(check!.id).toBe("capability:visual-test");
  });
});
