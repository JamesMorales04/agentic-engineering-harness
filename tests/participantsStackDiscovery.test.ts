import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { sha256Canonical, sha256Utf8 } from "../src/core/digest.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import {
  collectProjectStackEvidence,
  discoverProjectStackProfile,
  type ProjectStackDiscoveryOptionsV1,
  type ProjectStackSemanticAssessorV1
} from "../src/participants/stack.js";
import {
  createSemanticAssessmentServiceV1,
  semanticAssessmentBindingV1Schema,
  semanticAssessmentEvidenceDigest,
  semanticCapabilityPolicyRevisionV1,
  semanticEvidenceBoundaryDigest,
  semanticEvidenceReceiptDigest,
  type ResolvedSemanticAssessorV1,
  type SemanticAssessmentBindingV1,
  type SemanticAssessmentPayloadV1,
  type SemanticAssessmentRequestV1,
  type SemanticAssessmentRunnerV1,
  type SemanticAssessmentV1,
  type SemanticStackJudgmentV1
} from "../src/semantic/assessment.js";

async function repositoryBinding(root: string): Promise<SemanticAssessmentBindingV1> {
  const realRoot = await fs.realpath(root);
  return {
    projectId: "project-stack",
    repositoryDigest: await computeWorktreeDigest(realRoot),
    repositoryRootDigest: sha256Canonical(realRoot),
    candidateId: "candidate-1",
    candidateRevision: 1,
    candidateDigest: "candidate-digest-1"
  };
}

function testAssessor(): ResolvedSemanticAssessorV1 {
  const identityBase = {
    version: 1 as const,
    role: "Semantic Assessor" as const,
    logicalAgent: "semantic-assessor-test",
    modelAlias: "test-model",
    modelId: "test-model-id",
    modelName: "Test Model",
    runtimeName: "opencode",
    runtimeAdapter: "opencode",
    paseoProvider: "opencode"
  };
  const selection: AgentExecutionSelection = {
    logicalAgent: identityBase.logicalAgent,
    role: identityBase.role,
    domains: [],
    runtimeName: identityBase.runtimeName,
    runtimeAdapter: identityBase.runtimeAdapter,
    paseoProvider: identityBase.paseoProvider,
    modelAlias: identityBase.modelAlias,
    modelId: identityBase.modelId,
    modelName: identityBase.modelName,
    transport: "paseo",
    skills: [],
    mcps: [],
    permissions: {},
    args: [],
    runtimeCapabilities: {}
  };
  return { identity: { ...identityBase, identityDigest: sha256Canonical(identityBase) }, selection };
}

const assessor = testAssessor();

function stackJudgment(request: SemanticAssessmentRequestV1, overrides: Partial<SemanticStackJudgmentV1> = {}): SemanticStackJudgmentV1 {
  const ref = request.evidenceRefs[0]!;
  return {
    type: "STACK",
    languages: [],
    frameworks: [],
    packageManagers: [],
    databases: [],
    toolchains: [],
    signals: [{ id: "semantic:stack", evidenceRef: ref }],
    testFrameworks: [],
    migrationMechanisms: [],
    buildSystems: [],
    versions: {},
    projectSkillRoots: [],
    evidenceRefs: [ref],
    unknowns: [],
    ...overrides
  };
}

function stackPayload(request: SemanticAssessmentRequestV1, overrides: Partial<SemanticStackJudgmentV1> = {}, unknowns: string[] = []): SemanticAssessmentPayloadV1 {
  return { judgment: stackJudgment(request, overrides), claims: [], assumptions: [], unknowns, recommendations: [], knowledgeGaps: [] };
}

function runnerFor(payload: (request: SemanticAssessmentRequestV1) => unknown, onRequest?: (request: SemanticAssessmentRequestV1) => void): SemanticAssessmentRunnerV1 {
  return {
    assess: async ({ request }) => {
      onRequest?.(request);
      return { payload: payload(request), paseoSession: { provider: "opencode", agentId: "paseo-semantic-test-1", workspaceId: "workspace-test", transport: "sdk" } };
    }
  };
}

function canonicalService(payload: (request: SemanticAssessmentRequestV1) => unknown, onRequest?: (request: SemanticAssessmentRequestV1) => void) {
  return createSemanticAssessmentServiceV1({ assessor, runner: runnerFor(payload, onRequest), policyRevision: semanticCapabilityPolicyRevisionV1 });
}

function stubAssessment(request: SemanticAssessmentRequestV1, judgment: SemanticStackJudgmentV1, overrides: Partial<SemanticAssessmentV1> = {}): SemanticAssessmentV1 {
  return {
    version: 1,
    assessmentType: "STACK",
    mechanism: "MODEL",
    binding: request.binding,
    policyRevision: request.policyRevision,
    judgment,
    claims: [],
    assumptions: [],
    unknowns: ["stub payload unknown"],
    recommendations: [],
    knowledgeGaps: [],
    evidenceRefs: [...request.evidenceRefs],
    evidenceReceipts: structuredClone(request.evidenceReceipts),
    evidenceDigest: semanticAssessmentEvidenceDigest(request),
    assessor: assessor.identity,
    paseoSession: { provider: "opencode", agentId: "paseo-semantic-test-1", transport: "sdk" },
    assessmentDigest: sha256Canonical({ stub: "assessment" }),
    cacheIdentity: sha256Canonical({ stub: "cache" }),
    cacheDisposition: "FRESH",
    ...overrides
  };
}

function stubService(assessment: (request: SemanticAssessmentRequestV1) => SemanticAssessmentV1, onRequest?: (request: SemanticAssessmentRequestV1) => void): ProjectStackSemanticAssessorV1 {
  return {
    assess: async (request) => {
      onRequest?.(request);
      return assessment(request);
    }
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  return root;
}

async function listTree(root: string, relative = ""): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    result.push(entry.isDirectory() ? `${child}/` : child);
    if (entry.isDirectory()) result.push(...(await listTree(root, child)));
  }
  return result;
}

describe("model-first project stack discovery", () => {
  it("projects a bound MODEL STACK judgment into the profile without deterministic technology recognition", async () => {
    const root = await temporaryRoot("aeh-stack-model-");
    try {
      await fs.writeFile(path.join(root, "package.json"), '{"name":"sample","dependencies":{"next":"15.0.0","vitest":"3.0.0"}}\n');
      await fs.writeFile(path.join(root, "stack.notes"), "custom stack notes\n");
      await fs.mkdir(path.join(root, "custom-skills"), { recursive: true });
      await fs.writeFile(path.join(root, "custom-skills", "README.md"), "descriptive project skill root\n");
      const binding = await repositoryBinding(root);
      let captured: SemanticAssessmentRequestV1 | undefined;
      const service = canonicalService(
        (request) =>
          stackPayload(
            request,
            {
              languages: ["COBOL"],
              frameworks: ["nextjs", "custom-framework"],
              packageManagers: ["custom-pm"],
              databases: ["custom-db"],
              toolchains: ["custom-toolchain"],
              testFrameworks: ["custom-tests"],
              migrationMechanisms: ["custom-migration"],
              buildSystems: ["custom-build"],
              versions: { custom: "1.0.0" },
              projectSkillRoots: ["custom-skills"],
              signals: [{ id: "semantic:custom", evidenceRef: request.evidenceRefs[0]! }],
              evidenceRefs: [request.evidenceRefs[0]!],
              unknowns: ["uncertain version"]
            },
            ["uncertain tooling"]
          ),
        (request) => { captured = request; }
      );
      const profile = await discoverProjectStackProfile(root, { semanticAssessment: { service, binding } });

      expect(profile.interpretation).toBe("MODEL");
      expect(profile.languages).toEqual(["COBOL"]);
      expect(profile.frameworks).toEqual(["nextjs", "custom-framework"]);
      expect(profile.packageManagers).toEqual(["custom-pm"]);
      expect(profile.databases).toEqual(["custom-db"]);
      expect(profile.toolchains).toEqual(["custom-toolchain"]);
      expect(profile.testFrameworks).toEqual(["custom-tests"]);
      expect(profile.migrationMechanisms).toEqual(["custom-migration"]);
      expect(profile.buildSystems).toEqual(["custom-build"]);
      expect(profile.versions).toEqual({ custom: "1.0.0" });
      expect(profile.projectSkillRoots).toEqual(["custom-skills"]);
      expect(profile.unknowns).toEqual(["uncertain tooling", "uncertain version"]);
      expect(profile.signals).toEqual([{ id: "semantic:custom", source: captured!.evidenceReceipts[0]!.path }]);
      expect(profile.inputDigest).toBe(semanticAssessmentEvidenceDigest(captured!));
      expect(profile.inputDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(profile.assessmentDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(profile.bindingDigest).toBe(semanticEvidenceBoundaryDigest(binding));
      expect(profile.policyRevision).toBe(semanticCapabilityPolicyRevisionV1);
      expect(profile.assessorDigest).toBe(assessor.identity.identityDigest);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("supplies exact bounded repository evidence receipts bound to the caller boundary", async () => {
    const root = await temporaryRoot("aeh-stack-request-");
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "alpha.txt"), "alpha content\n");
      await fs.writeFile(path.join(root, "src", "beta.txt"), "beta content\n");
      const binding = await repositoryBinding(root);
      let captured: SemanticAssessmentRequestV1 | undefined;
      const service = canonicalService((request) => stackPayload(request), (request) => { captured = request; });
      await discoverProjectStackProfile(root, { semanticAssessment: { service, binding } });

      const request = captured!;
      expect(request.assessmentType).toBe("STACK");
      expect(request.requiredOutputSchema).toBe("semantic-assessment-v1");
      expect(request.policyRevision).toBe(semanticCapabilityPolicyRevisionV1);
      expect(request.binding).toEqual(binding);
      expect(request.reasoningRequirement).toEqual({
        reasoningClass: "STANDARD",
        structuredOutputRequired: true,
        independenceRequired: false,
        externalKnowledgeRequired: false,
        maxContextClass: "LARGE",
        riskClass: "HIGH"
      });
      expect(request.budget.maxInputTokens).toBeLessThanOrEqual(8_000);
      expect(request.budget.maxOutputTokens).toBeLessThanOrEqual(2_000);
      expect(request.budget.deadlineMs).toBeLessThanOrEqual(45_000);
      expect(request.evidenceRefs).toEqual(["file:alpha.txt", "file:src/beta.txt"]);
      expect(request.evidenceRefs).toEqual(request.compactEvidence.map((item) => item.ref));
      expect(request.evidenceRefs).toEqual(request.evidenceReceipts.map((receipt) => receipt.ref));
      expect(request.compactEvidence.map((item) => item.content)).toEqual(["alpha content\n", "beta content\n"]);
      for (const receipt of request.evidenceReceipts) {
        const content = request.compactEvidence.find((item) => item.ref === receipt.ref)!.content;
        expect(receipt).toMatchObject({ version: 1, reader: "aeh-controller-v1", kind: "REPOSITORY_FILE", ref: `file:${receipt.path}` });
        expect(receipt.boundaryDigest).toBe(semanticEvidenceBoundaryDigest(binding));
        expect(receipt.contentDigest).toBe(sha256Utf8(content));
        expect(receipt.contentBytes).toBe(Buffer.byteLength(content, "utf8"));
        expect(receipt.receiptDigest).toBe(semanticEvidenceReceiptDigest(receipt));
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed without an injected assessor service and repository-bound binding", async () => {
    const root = await temporaryRoot("aeh-stack-injection-");
    try {
      await fs.writeFile(path.join(root, "file.txt"), "content\n");
      const binding = await repositoryBinding(root);
      await expect(discoverProjectStackProfile(root)).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { binding } } as unknown as ProjectStackDiscoveryOptionsV1)).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service: canonicalService((request) => stackPayload(request)) } } as unknown as ProjectStackDiscoveryOptionsV1)).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service: canonicalService((request) => stackPayload(request)), binding: { projectId: "project-stack", repositoryDigest: "" } } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service: canonicalService((request) => stackPayload(request)), binding: { projectId: "project-stack", repositoryDigest: "repository-digest", candidateId: "candidate-1" } } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      await expect(discoverProjectStackProfile(root, { fastPath: true, detectorRegistry: {} } as unknown as ProjectStackDiscoveryOptionsV1)).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the repository has no readable evidence", async () => {
    const root = await temporaryRoot("aeh-stack-empty-");
    try {
      await fs.writeFile(path.join(root, "empty.txt"), "");
      const binding = await repositoryBinding(root);
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service: canonicalService((request) => stackPayload(request)), binding } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("propagates assessor unavailability and invalid payloads without a deterministic fallback", async () => {
    const root = await temporaryRoot("aeh-stack-unavailable-");
    try {
      await fs.writeFile(path.join(root, "file.txt"), "content\n");
      const binding = await repositoryBinding(root);
      const unavailable = createSemanticAssessmentServiceV1({
        assessor,
        policyRevision: semanticCapabilityPolicyRevisionV1,
        runner: { assess: async () => { throw new Error("paseo session failed"); } }
      });
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service: unavailable, binding } })).rejects.toMatchObject({ code: "SEMANTIC_ASSESSMENT_UNAVAILABLE" });
      const invalid = canonicalService(() => ({ not: "an assessment payload" }));
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service: invalid, binding } })).rejects.toMatchObject({ code: "SEMANTIC_ASSESSMENT_INVALID" });
      const stale = createSemanticAssessmentServiceV1({ assessor, policyRevision: "core-semantic-capability-policy-v0", runner: runnerFor((request) => stackPayload(request)) });
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service: stale, binding } })).rejects.toMatchObject({ code: "SEMANTIC_ASSESSMENT_INVALID" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects stale, rebound, ungrounded, or tampered assessments before projecting", async () => {
    const root = await temporaryRoot("aeh-stack-checks-");
    try {
      await fs.writeFile(path.join(root, "file.txt"), "content\n");
      await fs.writeFile(path.join(root, "second.txt"), "second content\n");
      const binding = await repositoryBinding(root);
      const bound = (request: SemanticAssessmentRequestV1) => stubAssessment(request, stackJudgment(request));
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service: stubService((request) => ({ ...bound(request), binding: { ...request.binding, projectId: "other-project" } })), binding } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service: stubService((request) => ({ ...bound(request), policyRevision: "stale-policy" })), binding } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service: stubService((request) => ({ ...bound(request), evidenceDigest: "0".repeat(64) })), binding } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service: stubService((request) => ({ ...bound(request), judgment: { ...stackJudgment(request), type: "INTENT" } as unknown as SemanticStackJudgmentV1 })), binding } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service: stubService((request) => stubAssessment(request, stackJudgment(request, { evidenceRefs: ["file:not-supplied"], signals: [{ id: "semantic:ungrounded", evidenceRef: "file:not-supplied" }] }))), binding } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service: stubService((request) => stubAssessment(request, stackJudgment(request, { evidenceRefs: [request.evidenceRefs[0]!], signals: [{ id: "semantic:nested", evidenceRef: request.evidenceRefs[1]! }] }))), binding } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service: stubService((request) => {
        const receipts = structuredClone(request.evidenceReceipts);
        receipts[0] = { ...receipts[0]!, contentDigest: "0".repeat(64) };
        return stubAssessment(request, stackJudgment(request), { evidenceReceipts: receipts });
      }), binding } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves payload and judgment unknowns in the projected profile", async () => {
    const root = await temporaryRoot("aeh-stack-unknowns-");
    try {
      await fs.writeFile(path.join(root, "file.txt"), "content\n");
      const binding = await repositoryBinding(root);
      const service = stubService((request) => stubAssessment(request, stackJudgment(request, { unknowns: ["judgment unknown"] }), { unknowns: ["payload unknown"] }));
      const profile = await discoverProjectStackProfile(root, { semanticAssessment: { service, binding } });
      expect(profile.unknowns).toEqual(["judgment unknown", "payload unknown"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("enforces file count, per-file byte, total byte, depth, and deadline bounds", async () => {
    const root = await temporaryRoot("aeh-stack-bounds-");
    try {
      await fs.mkdir(path.join(root, "nested"), { recursive: true });
      await fs.writeFile(path.join(root, "big.txt"), "x".repeat(10_000));
      for (let index = 0; index < 20; index += 1) await fs.writeFile(path.join(root, `file-${String(index).padStart(2, "0")}.txt`), `content-${index}\n`);
      await fs.writeFile(path.join(root, "nested", "deep.txt"), "nested content\n");
      const binding = await repositoryBinding(root);

      let captured: SemanticAssessmentRequestV1 | undefined;
      const service = canonicalService((request) => stackPayload(request), (request) => { captured = request; });
      await discoverProjectStackProfile(root, { semanticAssessment: { service, binding }, bounds: { maxFileBytes: 100, maxTotalBytes: 150, maxFiles: 2 } });
      expect(captured!.evidenceRefs).toHaveLength(2);
      expect(Buffer.byteLength(captured!.compactEvidence[0]!.content, "utf8")).toBeLessThanOrEqual(100);
      expect(captured!.compactEvidence.reduce((total, item) => total + Buffer.byteLength(item.content, "utf8"), 0)).toBeLessThanOrEqual(150);

      const depthBound = await collectProjectStackEvidence(root, { binding, bounds: { maxDepth: 0, maxFiles: 1 } });
      expect(depthBound.items.map((item) => item.path)).not.toContain("nested/deep.txt");
      expect(depthBound.items[0]!.path).not.toContain("/");

      const scanBound = await collectProjectStackEvidence(root, { binding, bounds: { maxScannedEntries: 2 } });
      expect(scanBound.scannedFiles).toBe(2);
      expect(scanBound.truncated).toBe(true);

      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service, binding }, bounds: { deadlineMs: 0 } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not follow repository symlinks or read outside the root", async () => {
    const root = await temporaryRoot("aeh-stack-symlink-");
    const outside = await temporaryRoot("aeh-stack-outside-");
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "outside-repository-secret\n");
      await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "linked-file.txt"));
      await fs.symlink(outside, path.join(root, "linked-directory"));
      await fs.writeFile(path.join(root, "inside.txt"), "inside content\n");
      const binding = await repositoryBinding(root);
      let captured: SemanticAssessmentRequestV1 | undefined;
      const service = canonicalService((request) => stackPayload(request), (request) => { captured = request; });
      const profile = await discoverProjectStackProfile(root, { semanticAssessment: { service, binding } });

      expect(captured!.evidenceRefs).toEqual(["file:inside.txt"]);
      expect(captured!.evidenceRefs).not.toContain("file:linked-file.txt");
      expect(captured!.evidenceRefs.some((ref) => ref.includes("linked-directory"))).toBe(false);
      expect(captured!.compactEvidence.some((item) => item.content.includes("outside-repository-secret"))).toBe(false);
      expect(profile.signals).toEqual([{ id: "semantic:stack", source: "inside.txt" }]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("never mutates the repository during discovery", async () => {
    const root = await temporaryRoot("aeh-stack-readonly-");
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "file.txt"), "content\n");
      const binding = await repositoryBinding(root);
      const before = await listTree(root);
      const service = canonicalService((request) => stackPayload(request));
      await discoverProjectStackProfile(root, { semanticAssessment: { service, binding } });
      await discoverProjectStackProfile(root, { semanticAssessment: { service, binding } });
      expect(await listTree(root)).toEqual(before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reuses the injected semantic service cache and invalidates it when repository evidence changes", async () => {
    const root = await temporaryRoot("aeh-stack-cache-");
    try {
      await fs.writeFile(path.join(root, "file.txt"), "first content\n");
      const firstBinding = await repositoryBinding(root);
      let calls = 0;
      const service = canonicalService((request) => { calls += 1; return stackPayload(request); });
      const first = await discoverProjectStackProfile(root, { semanticAssessment: { service, binding: firstBinding } });
      const second = await discoverProjectStackProfile(root, { semanticAssessment: { service, binding: firstBinding } });
      expect(calls).toBe(1);
      expect(second).toEqual(first);

      await fs.writeFile(path.join(root, "file.txt"), "second content\n");
      const editedBinding = await repositoryBinding(root);
      const third = await discoverProjectStackProfile(root, { semanticAssessment: { service, binding: editedBinding } });
      expect(calls).toBe(2);
      expect(third.inputDigest).not.toBe(first.inputDigest);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("exposes no deterministic detector, fast-path, or inference surface", async () => {
    const stackModule = await import("../src/participants/stack.js");
    for (const absent of ["inferProjectStackProfile", "projectStackEvidenceDigest", "stackSemanticAssessmentDigest", "projectStackSemanticAssessmentSchema", "createDefaultStackDetectorRegistry", "StackDetectorRegistryV1", "languageOrder"]) {
      expect(Object.keys(stackModule)).not.toContain(absent);
    }
    const source = await fs.readFile(new URL("../src/participants/stack.ts", import.meta.url), "utf8");
    for (const token of ["DETERMINISTIC_FAST_PATH", "fastPath", "StackDetector", "detectorRegistry", "languageOrder", "deriveObjectiveMetadata", "inferProjectStackProfile"]) {
      expect(source).not.toContain(token);
    }
  });
});

describe("repository evidence binding boundary", () => {
  it("rejects a binding captured for a different identical-content root before scanning or assessor execution", async () => {
    const rootA = await temporaryRoot("aeh-stack-cross-root-a-");
    const rootB = await temporaryRoot("aeh-stack-cross-root-b-");
    try {
      const contents = { "package.json": '{"name":"sample"}\n', "readme.md": "identical content\n" };
      for (const [name, content] of Object.entries(contents)) {
        await fs.writeFile(path.join(rootA, name), content);
        await fs.writeFile(path.join(rootB, name), content);
      }
      const bindingA = await repositoryBinding(rootA);
      const bindingB = await repositoryBinding(rootB);
      expect(bindingB.repositoryDigest).toBe(bindingA.repositoryDigest);
      expect(bindingB.repositoryRootDigest).not.toBe(bindingA.repositoryRootDigest);

      let assessorCalls = 0;
      const service = canonicalService((request) => { assessorCalls += 1; return stackPayload(request); });
      await expect(collectProjectStackEvidence(rootA, { binding: bindingB })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      await expect(discoverProjectStackProfile(rootA, { semanticAssessment: { service, binding: bindingB } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      expect(assessorCalls).toBe(0);
    } finally {
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it("rejects repository content drift after binding and before evidence capture", async () => {
    const root = await temporaryRoot("aeh-stack-drift-before-");
    try {
      await fs.writeFile(path.join(root, "file.txt"), "first content\n");
      const binding = await repositoryBinding(root);
      await fs.writeFile(path.join(root, "file.txt"), "second content\n");
      expect(await computeWorktreeDigest(await fs.realpath(root))).not.toBe(binding.repositoryDigest);

      let assessorCalls = 0;
      const service = canonicalService((request) => { assessorCalls += 1; return stackPayload(request); });
      await expect(collectProjectStackEvidence(root, { binding })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service, binding } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      expect(assessorCalls).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects repository drift performed by the assessor before a ProjectStackProfile is returned", async () => {
    const root = await temporaryRoot("aeh-stack-drift-during-");
    try {
      await fs.writeFile(path.join(root, "file.txt"), "content\n");
      const binding = await repositoryBinding(root);
      let assessorCalls = 0;
      const service: ProjectStackSemanticAssessorV1 = {
        assess: async (request) => {
          assessorCalls += 1;
          await fs.writeFile(path.join(root, "drift.txt"), "written during assessment\n");
          return stubAssessment(request, stackJudgment(request));
        }
      };
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service, binding } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      expect(assessorCalls).toBe(1);
      expect(await computeWorktreeDigest(await fs.realpath(root))).not.toBe(binding.repositoryDigest);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("requires a STACK repository root digest while the shared binding schema keeps it optional", async () => {
    const root = await temporaryRoot("aeh-stack-root-digest-");
    try {
      await fs.writeFile(path.join(root, "file.txt"), "content\n");
      const bindingWithoutRootDigest = await repositoryBinding(root);
      delete bindingWithoutRootDigest.repositoryRootDigest;
      expect(bindingWithoutRootDigest.repositoryRootDigest).toBeUndefined();

      let assessorCalls = 0;
      const service = canonicalService((request) => { assessorCalls += 1; return stackPayload(request); });
      await expect(discoverProjectStackProfile(root, { semanticAssessment: { service, binding: bindingWithoutRootDigest } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      expect(assessorCalls).toBe(0);

      expect(semanticAssessmentBindingV1Schema.safeParse({ projectId: "project-stack", repositoryDigest: "repository-digest" }).success).toBe(true);
      expect(semanticAssessmentBindingV1Schema.safeParse(bindingWithoutRootDigest).success).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("generic stack evidence inventory", () => {
  it("omits git-ignored secret and runtime cache files from the request and rejects assessments that cite them", async () => {
    const root = await temporaryRoot("aeh-stack-ignored-");
    try {
      await fs.writeFile(path.join(root, ".gitignore"), ".env\n.harness/\n");
      await fs.writeFile(path.join(root, ".env"), "AEH_TEST_SECRET=top-secret-env-value\n");
      await fs.mkdir(path.join(root, ".harness", "cache", "semantic-assessments-v1"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "cache", "semantic-assessments-v1", "cached.json"), "runtime cache payload\n");
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "package.json"), '{"name":"sample"}\n');
      await fs.writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n");
      const binding = await repositoryBinding(root);
      const ignoredRefs = ["file:.env", "file:.harness/cache/semantic-assessments-v1/cached.json"];

      let captured: SemanticAssessmentRequestV1 | undefined;
      const service = canonicalService((request) => stackPayload(request), (request) => { captured = request; });
      await discoverProjectStackProfile(root, { semanticAssessment: { service, binding } });

      expect(captured!.evidenceRefs).toEqual(expect.arrayContaining(["file:package.json", "file:src/index.ts"]));
      for (const ignoredRef of ignoredRefs) {
        expect(captured!.evidenceRefs).not.toContain(ignoredRef);
        expect(captured!.compactEvidence.some((item) => item.ref === ignoredRef)).toBe(false);
      }
      expect(captured!.compactEvidence.some((item) => item.content.includes("top-secret-env-value"))).toBe(false);
      expect(captured!.compactEvidence.some((item) => item.content.includes("runtime cache payload"))).toBe(false);

      for (const ignoredRef of ignoredRefs) {
        const citing = stubService((request) => stubAssessment(request, stackJudgment(request, {
          evidenceRefs: [ignoredRef],
          signals: [{ id: "semantic:ignored", evidenceRef: ignoredRef }]
        })));
        await expect(discoverProjectStackProfile(root, { semanticAssessment: { service: citing, binding } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

type SkillRootFixture = { root: string; outside: string; binding: SemanticAssessmentBindingV1 };

async function skillRootFixture(): Promise<SkillRootFixture> {
  const root = await temporaryRoot("aeh-stack-skill-roots-");
  const outside = await temporaryRoot("aeh-stack-skill-outside-");
  await fs.mkdir(path.join(root, "packages", "app"), { recursive: true });
  await fs.writeFile(path.join(root, "packages", "app", "README.md"), "skill root\n");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"sample"}\n');
  await fs.symlink(outside, path.join(root, "linked-skills"));
  const binding = await repositoryBinding(root);
  return { root, outside, binding };
}

describe("project skill root validation", () => {
  it("preserves a normalized existing in-repository project skill root as descriptive output", async () => {
    const root = await temporaryRoot("aeh-stack-skill-valid-");
    try {
      await fs.mkdir(path.join(root, "packages", "app"), { recursive: true });
      await fs.writeFile(path.join(root, "packages", "app", "README.md"), "skill root\n");
      await fs.writeFile(path.join(root, "package.json"), '{"name":"sample"}\n');
      const binding = await repositoryBinding(root);
      const service = stubService((request) => stubAssessment(request, stackJudgment(request, { projectSkillRoots: ["packages/app"] })));
      const profile = await discoverProjectStackProfile(root, { semanticAssessment: { service, binding } });
      expect(profile.projectSkillRoots).toEqual(["packages/app"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  const invalidSkillRootCases: Array<[string, (fixture: SkillRootFixture) => string]> = [
    ["an absolute path", (fixture) => path.join(fixture.root, "packages", "app")],
    ["a parent traversal to an existing outside directory", (fixture) => path.relative(fixture.root, fixture.outside).replaceAll("\\", "/")],
    ["a malformed non-normalized path", () => "packages//app"],
    ["a whitespace-padded non-normalized path", () => " packages/app "],
    ["a nonexistent path", () => "packages/missing"],
    ["a symlink escaping the bound root", () => "linked-skills"]
  ];
  it.each(invalidSkillRootCases)("rejects %s as a project skill root", async (_label, invalidRoot) => {
    const fixture = await skillRootFixture();
    try {
      const service = stubService((request) => stubAssessment(request, stackJudgment(request, { projectSkillRoots: [invalidRoot(fixture)] })));
      await expect(discoverProjectStackProfile(fixture.root, { semanticAssessment: { service, binding: fixture.binding } })).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
      await fs.rm(fixture.outside, { recursive: true, force: true });
    }
  });
});
