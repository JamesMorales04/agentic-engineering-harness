import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileExecutionBinding, compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { sha256Canonical, sha256Utf8 } from "../src/core/digest.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { ContextBudgetGateway, contextEnvelopePath } from "../src/context/gateway.js";
import { buildContextEnvelope, verifyContextEnvelope } from "../src/context/envelope.js";
import { resolveContextPolicy } from "../src/context/policy.js";
import type { ContextEnvelope, ContextFragment, ContextPolicy } from "../src/context/types.js";
import { assertContextRetrievalEvidence, closeContextRetrievalForResult, contextRetrievalEvidenceForResult, issueContextRefAuthorization, recordContextContinuation, retrieveAuthorizedContext } from "../src/context/authorizationV2.js";
import { bindOperationParticipantExecution, bindResolvedOperationPolicy, loadOperation, registerOperationAgent } from "../src/operations/state.js";
import { prepareExecutionAuthority } from "../src/security/executionLease.js";

const roots: string[] = [];
const originalEnv = Object.fromEntries(["AEH_OPERATION_ID", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT", "AEH_CONTROLLER_TOKEN", "AEH_CONTROLLER_EPOCH"].map((key) => [key, process.env[key] as string | undefined]));
const budget = { maxRequestsPerTurn: 1, maxTokensPerRequest: 30, maxTotalTokensPerTurn: 30 };

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("controller-issued ContextRefAuthorizationV1 lifecycle", () => {
  it("binds source retrieval, continuation, budget, and result evidence to the current candidate and session", async () => {
    const state = await fixture();
    const { root, operationId, participantId, config } = state;
    const fragments: ContextFragment[] = [{ id: "evidence", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 10, content: "candidate-bound evidence\nsecond line\n" }];
    const prepared = await new ContextBudgetGateway(root, config, { telemetry: false }).prepare({
      operationId,
      logicalAgent: "reviewer",
      role: "Reviewer",
      phase: "review",
      fragments
    });
    const manifest = launchContextManifest(state, fragments, prepared.envelope);
    const binding = await bindLaunchManifest(state, manifest);
    const receipt = await issueWithLaunchManifest(state, manifest);
    expect(receipt?.grant.allowedRefs.map((ref) => ref.refId)).toContain("evidence");
    expect(receipt?.grant.retrievalBudget).toEqual(budget);
    expect(receipt?.executionBindingDigest).toBe(binding.digest);
    expect(prepared.envelope.budget.estimatedDelivered).toBeGreaterThan(0);

    await expect(retrieveAuthorizedContext(root, root, operationId, participantId, "another-session", "reviewer", "review", { refId: "evidence", requestId: "wrong-session" })).rejects.toThrow("actual session");
    const ref = receipt!.grant.allowedRefs.find((entry) => entry.refId === "evidence")!;
    const artifact = path.join(root, ref.artifactPath);
    const original = await fs.readFile(artifact, "utf8");
    await fs.writeFile(artifact, "changed after grant\n");
    await expect(retrieveAuthorizedContext(root, root, operationId, participantId, binding.runtime.sessionId, "reviewer", "review", { refId: "evidence", requestId: "source-drift" })).rejects.toThrow("SOURCE_DIGEST_MISMATCH");
    await fs.writeFile(artifact, original);

    const result = await retrieveAuthorizedContext(root, root, operationId, participantId, binding.runtime.sessionId, "reviewer", "review", { refId: "evidence", requestId: "request-one" });
    expect(result.content).toBe(original);
    expect(result.receipt).toMatchObject({
      operationId,
      candidateRevision: binding.candidateRevision,
      candidateRevisionDigest: binding.candidateDigest,
      participantId,
      participantGeneration: binding.participantGeneration,
      executionBindingDigest: binding.digest,
      sessionId: binding.runtime.sessionId,
      sourceDigest: ref.sourceDigest,
      deliveredContentDigest: sha256Utf8(result.content)
    });
    await expect(retrieveAuthorizedContext(root, root, operationId, participantId, binding.runtime.sessionId, "reviewer", "review", { refId: "evidence", requestId: "request-one" })).rejects.toThrow("REPLAY_REJECTED");
    await expect(retrieveAuthorizedContext(root, root, operationId, participantId, binding.runtime.sessionId, "reviewer", "review", { refId: "unknown", requestId: "request-two" })).rejects.toThrow("not permitted");
    await expect(retrieveAuthorizedContext(root, root, operationId, participantId, binding.runtime.sessionId, "reviewer", "review", { refId: "evidence", requestId: "budget-exhausted" })).rejects.toThrow("CONTEXT_RETRIEVAL_BUDGET_EXCEEDED");

    const continuationRequest = {
      continuationId: "continuation-current-binding",
      operationId,
      projectId: state.projectId,
      operationExecutionRevision: binding.operationExecutionRevision,
      candidateRevision: binding.candidateRevision,
      candidateRevisionDigest: binding.candidateDigest,
      participantId,
      participantGeneration: binding.participantGeneration,
      executionBindingDigest: binding.digest,
      controllerEpoch: binding.controllerEpoch,
      contextManifestDigest: binding.contextManifestDigest,
      promptManifestDigest: binding.promptManifestDigest
    };
    const continuation = await recordContextContinuation(root, operationId, participantId, continuationRequest);
    expect(continuation).toMatchObject({ sequence: 2, contextRefIds: ["evidence"], retrievalReceiptIds: [result.receipt.receiptId], previousSessionId: binding.runtime.sessionId, nextSessionId: binding.runtime.sessionId });
    await expect(recordContextContinuation(root, operationId, participantId, continuationRequest)).rejects.toThrow("continuation id already exists");
    await expect(recordContextContinuation(root, operationId, participantId, { ...continuationRequest, executionBindingDigest: "f".repeat(64) })).rejects.toThrow("current durable session binding");

    const evidence = await closeContextRetrievalForResult(root, binding);
    assertContextRetrievalEvidence(evidence, binding);
    expect(evidence).toMatchObject({ retrievalBudget: budget, requests: 1, totalTokens: result.estimatedTokens, receiptIds: [result.receipt.receiptId] });
    expect(evidence.progressiveManifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertContextRetrievalEvidence({ ...evidence, progressiveManifestDigest: "f".repeat(64) }, binding)).toThrow("does not match its ExecutionBinding");
    expect(await contextRetrievalEvidenceForResult(root, binding)).toEqual(evidence);
    await expect(retrieveAuthorizedContext(root, root, operationId, participantId, binding.runtime.sessionId, "reviewer", "review", { refId: "evidence", requestId: "after-result" })).rejects.toThrow("closed after StructuredResult acceptance");
  });

  it("requires the current controller owner and rejects candidate/session state after takeover", async () => {
    const state = await fixture();
    const { root, operationId, participantId, config } = state;
    const fragments: ContextFragment[] = [{ id: "evidence", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 1, content: "owned source" }];
    const prepared = await new ContextBudgetGateway(root, config, { telemetry: false }).prepare({ operationId, logicalAgent: "reviewer", role: "Reviewer", phase: "review", fragments });
    const manifest = launchContextManifest(state, fragments, prepared.envelope);
    const binding = await bindLaunchManifest(state, manifest);
    const controllerToken = process.env.AEH_CONTROLLER_TOKEN;
    process.env.AEH_CONTROLLER_TOKEN = "not-the-controller-token";
    await expect(issueWithLaunchManifest(state, manifest)).rejects.toThrow("current controller token");
    process.env.AEH_CONTROLLER_TOKEN = controllerToken;

    await issueWithLaunchManifest(state, manifest);
    await expect(retrieveAuthorizedContext(root, root, operationId, participantId, binding.runtime.sessionId, "other-agent", "review", { refId: "evidence", requestId: "wrong-agent" })).rejects.toThrow("logical participant");
    await expect(retrieveAuthorizedContext(root, root, operationId, participantId, binding.runtime.sessionId, "reviewer", "review", { refId: "evidence", requestId: "one" })).resolves.toMatchObject({ receipt: { sessionId: binding.runtime.sessionId } });

    const { claimControllerEpoch } = await import("../src/operations/state.js");
    await claimControllerEpoch(root, operationId, "controller:takeover-context-test");
    await expect(retrieveAuthorizedContext(root, root, operationId, participantId, binding.runtime.sessionId, "reviewer", "review", { refId: "evidence", requestId: "after-takeover" })).rejects.toThrow("current operation candidate, policy, and execution revision are required");
  });

  it("rejects a modified envelope before the controller can issue an addressable reference", async () => {
    const state = await fixture();
    const { root, operationId, config } = state;
    const fragments: ContextFragment[] = [{ id: "evidence", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 1, content: "trusted bytes" }];
    const prepared = await new ContextBudgetGateway(root, config, { telemetry: false }).prepare({ operationId, logicalAgent: "reviewer", role: "Reviewer", phase: "review", fragments });
    const manifest = launchContextManifest(state, fragments, prepared.envelope);
    await bindLaunchManifest(state, manifest);
    const envelopePath = contextEnvelopePath(root, operationId, "reviewer", "review");
    const envelope = JSON.parse(await fs.readFile(envelopePath, "utf8")) as { fragments: Array<{ source?: { artifact?: string } }> };
    envelope.fragments[0]!.source = { artifact: "untrusted.txt" };
    await fs.writeFile(envelopePath, `${JSON.stringify(envelope)}\n`);
    expect(verifyContextEnvelope(envelope as never)).toBe(false);
    await expect(issueWithLaunchManifest(state, manifest)).rejects.toThrow("durable context envelope is corrupt");
  });
});

describe("controller-issued ContextRefAuthorizationV1 launch manifest binding", () => {
  it("rejects a re-digested durable envelope that adds a retrievable ref outside the frozen launch manifest", async () => {
    const state = await fixture();
    const { root, operationId, config } = state;
    const gateway = new ContextBudgetGateway(root, config, { telemetry: false });
    const evidence: ContextFragment = { id: "evidence", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 10, content: "candidate-bound evidence\n" };
    const frozen = await gateway.prepare({ operationId, logicalAgent: "reviewer", role: "Reviewer", phase: "review", fragments: [evidence] });
    const manifest = launchContextManifest(state, [evidence], frozen.envelope);
    await bindLaunchManifest(state, manifest);

    await gateway.prepare({ operationId, logicalAgent: "reviewer", role: "Reviewer", phase: "review", fragments: [evidence, { id: "smuggled", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 90, content: "unbound evidence\n" }] });
    const durable = JSON.parse(await fs.readFile(contextEnvelopePath(root, operationId, "reviewer", "review"), "utf8")) as ContextEnvelope;
    expect(verifyContextEnvelope(durable)).toBe(true);
    expect([...durable.retrieval.allowedFragmentIds].sort()).toEqual(["evidence", "smuggled"]);
    expect(manifest.fragments.map((fragment) => fragment.id)).toEqual(["evidence"]);

    const outcome = await issueOutcome(() => issueWithLaunchManifest(state, manifest));
    expect(outcome, outcome.issued ? `issuer authorized refs absent from the frozen launch manifest: ${outcome.refIds.join(", ")}` : undefined).toMatchObject({ issued: false, error: expect.stringMatching(/^CONTEXT_RUNTIME_V2_/) });
  });

  it("rejects a rebuilt durable envelope whose valid provenance digest differs from the frozen launch manifest envelopeDigest", async () => {
    const state = await fixture();
    const { root, operationId, config } = state;
    const evidence: ContextFragment = { id: "evidence", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 10, content: "candidate-bound evidence\n" };
    const frozen = await new ContextBudgetGateway(root, config, { telemetry: false }).prepare({ operationId, logicalAgent: "reviewer", role: "Reviewer", phase: "review", fragments: [evidence] });
    const manifest = launchContextManifest(state, [evidence], frozen.envelope);
    await bindLaunchManifest(state, manifest);

    const { provenance: _provenance, ...envelopeBody } = frozen.envelope;
    const rebuild = buildContextEnvelope({ ...envelopeBody, budget: { ...envelopeBody.budget, maximum: envelopeBody.budget.maximum + 1 } });
    expect(verifyContextEnvelope(rebuild)).toBe(true);
    expect(rebuild.provenance.sha256).not.toBe(manifest.envelopeDigest);
    expect(rebuild.retrieval.allowedFragmentIds).toEqual(frozen.envelope.retrieval.allowedFragmentIds);
    expect(launchContextManifest(state, [evidence], rebuild).addressableRefs).toEqual(manifest.addressableRefs);
    await fs.writeFile(contextEnvelopePath(root, operationId, "reviewer", "review"), `${JSON.stringify(rebuild, null, 2)}\n`);

    const outcome = await issueOutcome(() => issueWithLaunchManifest(state, manifest));
    expect(outcome, outcome.issued ? `issuer ignored the frozen launch manifest envelopeDigest while authorizing: ${outcome.refIds.join(", ")}` : undefined).toMatchObject({ issued: false, error: expect.stringMatching(/^CONTEXT_RUNTIME_V2_/) });
  });

  it.each<{ label: string; mutate: (ref: LaunchManifestRef) => LaunchManifestRef }>([
    { label: "artifact path", mutate: (ref) => ({ ...ref, artifactPath: ".harness/context/RUN-CONTEXT-AUTH/other.raw" }) },
    { label: "source digest", mutate: (ref) => ({ ...ref, sourceDigest: "0".repeat(64) }) }
  ])("rejects a frozen launch manifest whose $label disagrees with the durable envelope", async ({ mutate }) => {
    const state = await fixture();
    const { root, operationId, config } = state;
    const evidence: ContextFragment = { id: "evidence", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 10, content: "candidate-bound evidence\n" };
    const prepared = await new ContextBudgetGateway(root, config, { telemetry: false }).prepare({ operationId, logicalAgent: "reviewer", role: "Reviewer", phase: "review", fragments: [evidence] });
    const manifest = launchContextManifest(state, [evidence], prepared.envelope);
    const mismatched: LaunchContextManifestV1 = { ...manifest, addressableRefs: manifest.addressableRefs.map((ref) => ref.refId === "evidence" ? mutate(ref) : ref) };
    const binding = await bindLaunchManifest(state, mismatched);
    expect(binding.contextManifestDigest).toBe(sha256Canonical(mismatched));
    expect(verifyContextEnvelope(prepared.envelope)).toBe(true);

    const outcome = await issueOutcome(() => issueWithLaunchManifest(state, mismatched));
    expect(outcome, outcome.issued ? `issuer authorized refs that disagree with the frozen launch manifest: ${outcome.refIds.join(", ")}` : undefined).toMatchObject({ issued: false, error: expect.stringMatching(/^CONTEXT_RUNTIME_V2_/) });
  });

  it("issues exactly the retrievable refs declared by an exactly matching manifest, envelope, and durable sources", async () => {
    const state = await fixture();
    const { root, operationId, config } = state;
    const fragments: ContextFragment[] = [
      { id: "evidence", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 10, content: "candidate-bound evidence\n" },
      { id: "annotations", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 5, content: "secondary retrievable evidence\n" }
    ];
    const prepared = await new ContextBudgetGateway(root, config, { telemetry: false }).prepare({ operationId, logicalAgent: "reviewer", role: "Reviewer", phase: "review", fragments });
    const manifest = launchContextManifest(state, fragments, prepared.envelope);
    const binding = await bindLaunchManifest(state, manifest);

    const receipt = await issueWithLaunchManifest(state, manifest);
    expect(receipt).toBeDefined();
    expect(receipt).toMatchObject({ executionBindingDigest: binding.digest, contextManifestDigest: sha256Canonical(manifest), promptManifestDigest: binding.promptManifestDigest });
    const refs = receipt!.grant.allowedRefs;
    expect(refs.map((ref) => ref.refId)).toEqual(["annotations", "evidence"]);
    expect(new Set(refs.map((ref) => ref.refId)).size).toBe(refs.length);
    expect(refs.map((ref) => ({ refId: ref.refId, artifactPath: ref.artifactPath, sourceDigest: ref.sourceDigest }))).toEqual([...manifest.addressableRefs].sort((left, right) => left.refId.localeCompare(right.refId)));
  });
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

type LaunchContextManifestV1 = {
  version: 1;
  operationId: string;
  projectId: string;
  candidateDigest: string;
  participantId: string;
  retrievalBudget: ContextPolicy["retrieval"];
  fragments: Array<{ id: string; kind: string; preservation: ContextFragment["preservation"]; contentDigest: string; source?: { artifact?: string; file?: string; sha256?: string }; metadata?: Record<string, unknown> }>;
  envelopeDigest: string;
  deliveredFragments: Array<{ id: string; contentDigest: string; source?: { artifact?: string; file?: string; sha256?: string } }>;
  addressableRefs: Array<{ refId: string; artifactPath: string; sourceDigest: string }>;
};

type LaunchManifestRef = LaunchContextManifestV1["addressableRefs"][number];

type IssueContextRefAuthorizationOptions = Parameters<typeof issueContextRefAuthorization>[4];

function issueWithLaunchManifest(state: Fixture, manifest: LaunchContextManifestV1) {
  const options: IssueContextRefAuthorizationOptions = { logicalAgent: "reviewer", phase: "review", retrievalBudget: budget, capabilityAuthority: state.authority, contextManifest: manifest };
  return issueContextRefAuthorization(state.root, state.root, state.operationId, state.participantId, options);
}

async function issueOutcome(issue: () => Promise<Awaited<ReturnType<typeof issueContextRefAuthorization>>>): Promise<{ issued: true; refIds: string[] } | { issued: false; error: string }> {
  return issue().then(
    (receipt) => ({ issued: true as const, refIds: receipt?.grant.allowedRefs.map((ref) => ref.refId) ?? [] }),
    (error: unknown) => ({ issued: false as const, error: error instanceof Error ? error.message : String(error) })
  );
}

function launchContextManifest(state: Fixture, fragments: readonly ContextFragment[], envelope: ContextEnvelope): LaunchContextManifestV1 {
  const fragmentById = new Map(envelope.fragments.map((fragment) => [fragment.id, fragment]));
  return {
    version: 1,
    operationId: envelope.operationId,
    projectId: state.projectId,
    candidateDigest: state.binding.candidateDigest,
    participantId: state.participantId,
    retrievalBudget: resolveContextPolicy(state.config).retrieval,
    fragments: fragments.map((fragment) => ({ id: fragment.id, kind: fragment.kind, preservation: fragment.preservation, contentDigest: sha256Canonical(fragment.content), source: fragment.source, metadata: fragment.metadata })),
    envelopeDigest: envelope.provenance.sha256,
    deliveredFragments: envelope.fragments.map((fragment) => ({ id: fragment.id, contentDigest: sha256Canonical(fragment.content), source: fragment.source })),
    addressableRefs: envelope.retrieval.allowedFragmentIds.map((refId) => {
      const source = fragmentById.get(refId)?.source;
      if (!source?.artifact || !source.sha256) throw new Error(`launch manifest fixture: ref '${refId}' has no durable source provenance.`);
      return { refId, artifactPath: source.artifact, sourceDigest: source.sha256 };
    })
  };
}

async function bindLaunchManifest(state: Fixture, manifest: LaunchContextManifestV1): Promise<ReturnType<typeof compileExecutionBinding>> {
  const { version: _version, digest: _digest, ...current } = state.binding;
  const binding = compileExecutionBinding({ ...current, contextManifestDigest: sha256Canonical(manifest) });
  await bindOperationParticipantExecution(state.root, state.operationId, { participantId: state.participantId, logicalAgent: "reviewer", role: "Reviewer", binding });
  return binding;
}

async function fixture(): Promise<{ root: string; operationId: string; participantId: string; projectId: string; binding: ReturnType<typeof compileExecutionBinding>; authority: NonNullable<Awaited<ReturnType<typeof prepareExecutionAuthority>>>; config: HarnessProjectConfig }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-context-authorization-v2-"));
  roots.push(root);
  const operationId = "RUN-CONTEXT-AUTH";
  const participantId = "participant:reviewer";
  const now = new Date().toISOString();
  await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "review", root, payload: { taskId: "TASK-CONTEXT-AUTH" }, createdAt: now, updatedAt: now, operationExecutionRevision: 1 } as never);
  await registerOperationAgent(root, operationId, { id: participantId, logicalAgent: "reviewer", role: "Reviewer", phase: "review" });
  let operation = await loadOperation(root, operationId);
  const candidate = operation.candidateRevision!;
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId!, operationId,
    operationExecutionRevision: operation.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: operation.controller?.epoch ?? 0,
    intent: "test bounded context retrieval", route: "DIRECT", minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "1" }, policyDigests: {},
    validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {},
    allowedExternalEffects: [], humanDecisionRequirements: []
  });
  operation = await bindResolvedOperationPolicy(root, operationId, policy);
  const selection: AgentExecutionSelection = {
    logicalAgent: "reviewer", role: "Reviewer", domains: [], runtimeName: "paseo", runtimeAdapter: "paseo", paseoProvider: "test", modelAlias: "test-model", modelId: "test-model", modelName: "test-model", modelProvider: "test", transport: "paseo", skills: [], mcps: [],
    permissions: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" }, outputContract: "reviewer", args: [], runtimeCapabilities: { structuredOutput: true, sessions: true, mcp: true, stdioMcp: true, localMcp: true }
  };
  const authority = await prepareExecutionAuthority(root, selection, { participantId, phase: "review", required: true });
  if (!authority) throw new Error("test requires a current controller-issued read lease");
  const digest = (label: string) => sha256Canonical({ label, operationId, participantId });
  const binding = compileExecutionBinding({
    operationId,
    operationExecutionRevision: operation.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: operation.controller?.epoch ?? 0,
    executionBlueprintDigest: digest("blueprint"),
    operationPolicyDigest: policy.digest,
    participantId,
    participantGeneration: "generation:1",
    roleInvocationPolicyDigest: digest("role-policy"),
    skillManifestDigest: digest("skills"),
    runtime: { runtimeId: "paseo", provider: "test", modelId: "test-model", model: "test-model", sessionId: "paseo-session-context-test" },
    contextManifestDigest: digest("context"),
    promptManifestDigest: digest("prompt"),
    outputContract: "reviewer",
    leaseIdentities: authority.leases.map((lease) => lease.leaseId)
  });
  await bindOperationParticipantExecution(root, operationId, { participantId, logicalAgent: "reviewer", role: "Reviewer", binding });
  const config: HarnessProjectConfig = {
    version: 1,
    project: { name: candidate.projectId! },
    telemetry: { enabled: false },
    context: { mode: "enforce", budgets: { default: { inputTokens: 12_000 } }, retrieval: budget, compression: { provider: "headroom", required: false, minTokens: 2 } }
  };
  return { root, operationId, participantId, projectId: candidate.projectId!, binding, authority, config };
}
