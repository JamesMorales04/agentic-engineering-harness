import { describe, expect, it } from "vitest";
import {
  assertContinuationBinding,
  assertContextRefAuthorization,
  bindContinuation,
  compileContextRefAuthorization,
  compileContextRefAuthorizationReceipt,
  consumeExecutionBudget,
  createContextRef,
  createContextShard,
  createExecutionBudget,
  createPromptManifest,
  deliverContextPayload,
  digestText,
  rangeShardLocator,
  selectContextShard,
  stablePrefixDigest,
  symbolShardLocator,
  type ContextRefAuthorizationExpectationV1
} from "../src/context/runtimeV2.js";

const DIGEST = "a".repeat(64);
const EXPECTED: ContextRefAuthorizationExpectationV1 = {
  operationId: "op-1",
  projectId: "project-1",
  operationExecutionRevision: 1,
  candidateRevision: 1,
  candidateRevisionDigest: "b".repeat(64),
  participantId: "participant-1",
  participantGeneration: "generation-1",
  executionBlueprintDigest: "c".repeat(64),
  operationPolicyDigest: "d".repeat(64),
  controllerEpoch: 1,
  sessionId: "paseo-session-1",
  executionBindingDigest: "e".repeat(64),
  contextManifestDigest: "f".repeat(64),
  promptManifestDigest: "0".repeat(64)
};

function authorizedRef(shard: ReturnType<typeof createContextShard>, locator = shard.locator) {
  const selection = selectContextShard(shard, locator);
  const grant = compileContextRefAuthorization({
    grantId: "controller-grant-1",
    operationId: EXPECTED.operationId,
    projectId: EXPECTED.projectId,
    operationExecutionRevision: EXPECTED.operationExecutionRevision,
    candidateRevision: EXPECTED.candidateRevision,
    candidateRevisionDigest: EXPECTED.candidateRevisionDigest,
    participantId: EXPECTED.participantId,
    participantGeneration: EXPECTED.participantGeneration,
    executionBlueprintDigest: EXPECTED.executionBlueprintDigest,
    operationPolicyDigest: EXPECTED.operationPolicyDigest,
    controllerEpoch: EXPECTED.controllerEpoch,
    sessionId: EXPECTED.sessionId,
    retrievalBudget: { maxRequestsPerTurn: 8, maxTokensPerRequest: 6_000, maxTotalTokensPerTurn: 20_000 },
    allowedRefs: [{
      refId: shard.shardId,
      fragmentId: shard.shardId,
      shardId: shard.shardId,
      artifactPath: `.harness/context/${shard.shardId}.raw`,
      sourceFile: shard.file,
      sourceDigest: shard.sourceDigest!,
      contentDigest: selection.digest,
      locator,
      estimatedTokens: 40
    }],
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z"
  });
  const receipt = compileContextRefAuthorizationReceipt(grant, EXPECTED);
  const ref = createContextRef({ refId: shard.shardId, authorizationReceipt: receipt, expected: EXPECTED });
  return { ref, receipt, selection };
}

describe("Context Runtime v2 contracts", () => {
  it("keeps controller-authorized JIT references addressable until delivery", () => {
    const content = "export function login() {\n  return true;\n}\n";
    const shard = createContextShard({ shardId: "auth", file: "src/auth.ts", content, sourceDigest: digestText(content), locator: rangeShardLocator("src/auth.ts", { startLine: 1, endLine: 3 }) });
    const locator = symbolShardLocator("src/auth.ts", "login", { startLine: 1, endLine: 3 });
    const { ref, receipt } = authorizedRef(shard, locator);
    expect(ref.addressable).toBe(true);
    expect(ref.delivered).toBe(false);
    expect(ref.payload).toBeUndefined();
    expect(ref.authorizationDigest).toBe(receipt.receiptDigest);
    const delivered = deliverContextPayload(ref, shard, receipt, EXPECTED);
    expect(delivered.delivered).toBe(true);
    expect(delivered.payload?.content).toContain("return true");
  });

  it("selects a deep symbol range instead of the enclosing symbol range", () => {
    const content = ["class Service {", "  async handle() {", "    return await load();", "  }", "}", ""].join("\n");
    const shard = createContextShard({
      shardId: "service",
      file: "src/service.ts",
      content,
      sourceDigest: digestText(content),
      locator: rangeShardLocator("src/service.ts", { startLine: 1, endLine: 5 }),
      symbols: [
        { symbol: "Service", symbolPath: ["Service"], range: { startLine: 1, endLine: 5 } },
        { symbol: "handle", symbolPath: ["Service", "handle"], range: { startLine: 2, endLine: 4 } }
      ]
    });
    const locator = symbolShardLocator("src/service.ts", "handle", undefined, ["Service", "handle"]);
    const selected = authorizedRef(shard, locator);
    const delivered = deliverContextPayload(selected.ref, shard, selected.receipt, EXPECTED);
    expect(delivered.payload?.range).toEqual({ startLine: 2, endLine: 4 });
    expect(delivered.payload?.content).toBe("  async handle() {\n    return await load();\n  }");
  });

  it("rejects a receipt or fragment when operation, session, candidate, or binding identity drifts", () => {
    const content = "line one\n";
    const shard = createContextShard({ shardId: "a", file: "a.ts", content, sourceDigest: digestText(content), locator: rangeShardLocator("a.ts", { startLine: 1, endLine: 1 }) });
    const { ref, receipt } = authorizedRef(shard);
    expect(() => createContextRef({ refId: "a", authorizationReceipt: receipt, expected: { ...EXPECTED, sessionId: "other-session" } })).toThrow(/does not match/);
    expect(() => deliverContextPayload(ref, shard, receipt, { ...EXPECTED, operationId: "other-operation" })).toThrow(/does not match/);
    expect(() => deliverContextPayload(ref, shard, receipt, { ...EXPECTED, candidateRevision: 2 })).toThrow(/does not match/);
    expect(() => deliverContextPayload(ref, shard, { ...receipt, executionBindingDigest: DIGEST }, EXPECTED)).toThrow(/receipt is invalid or stale|receipt shape or digest is invalid/);
    expect(() => deliverContextPayload({ ...ref, participantId: "other-participant" }, shard, receipt, EXPECTED)).toThrow(/does not match/);
  });

  it("checks authorization expiry and every frozen execution identity field deterministically", () => {
    const content = "current authorization target\n";
    const shard = createContextShard({ shardId: "authorized", file: "a.ts", content, sourceDigest: digestText(content), locator: rangeShardLocator("a.ts", { startLine: 1, endLine: 1 }) });
    const { receipt } = authorizedRef(shard);
    const expected = { ...EXPECTED };
    expect(() => assertContextRefAuthorization(receipt.grant, expected, new Date("2100-01-01T00:00:00.000Z"))).toThrow("AUTHORIZATION_EXPIRED");
    for (const [field, value] of [
      ["operationId", "other-operation"],
      ["projectId", "other-project"],
      ["operationExecutionRevision", 2],
      ["candidateRevision", 2],
      ["candidateRevisionDigest", "1".repeat(64)],
      ["participantId", "other-participant"],
      ["participantGeneration", "generation-2"],
      ["executionBlueprintDigest", "2".repeat(64)],
      ["operationPolicyDigest", "3".repeat(64)],
      ["controllerEpoch", 2],
      ["sessionId", "other-session"]
    ] as const) {
      expect(() => assertContextRefAuthorization(receipt.grant, { ...expected, [field]: value }, new Date("2026-01-01T00:00:00.000Z"))).toThrow(`authorization ${field} does not match`);
    }
  });

  it("binds continuation to the complete candidate/session/manifest identity and receipts", () => {
    const content = "continuation target\n";
    const shard = createContextShard({ shardId: "continuation-ref", file: "a.ts", content, sourceDigest: digestText(content), locator: rangeShardLocator("a.ts", { startLine: 1, endLine: 1 }) });
    const { ref } = authorizedRef(shard);
    const continuation = bindContinuation({
      operationId: EXPECTED.operationId,
      projectId: EXPECTED.projectId,
      operationExecutionRevision: EXPECTED.operationExecutionRevision,
      candidateRevision: EXPECTED.candidateRevision,
      candidateRevisionDigest: EXPECTED.candidateRevisionDigest,
      participantId: EXPECTED.participantId,
      participantGeneration: EXPECTED.participantGeneration,
      executionBindingDigest: EXPECTED.executionBindingDigest,
      controllerEpoch: EXPECTED.controllerEpoch,
      contextManifestDigest: EXPECTED.contextManifestDigest,
      promptManifestDigest: EXPECTED.promptManifestDigest,
      previousSessionId: EXPECTED.sessionId,
      nextSessionId: EXPECTED.sessionId,
      previousTurnId: "turn-1",
      sequence: 2,
      contextRefIds: [ref.refId],
      retrievalReceiptIds: ["retrieval-receipt-1"]
    });
    const fullExpected = {
      operationId: EXPECTED.operationId,
      projectId: EXPECTED.projectId,
      operationExecutionRevision: EXPECTED.operationExecutionRevision,
      candidateRevision: EXPECTED.candidateRevision,
      candidateRevisionDigest: EXPECTED.candidateRevisionDigest,
      participantId: EXPECTED.participantId,
      participantGeneration: EXPECTED.participantGeneration,
      executionBindingDigest: EXPECTED.executionBindingDigest,
      controllerEpoch: EXPECTED.controllerEpoch,
      contextManifestDigest: EXPECTED.contextManifestDigest,
      promptManifestDigest: EXPECTED.promptManifestDigest,
      previousSessionId: EXPECTED.sessionId,
      nextSessionId: EXPECTED.sessionId,
      previousTurnId: "turn-1",
      sequence: 2,
      availableRefs: [ref],
      availableReceiptIds: ["retrieval-receipt-1"]
    };
    expect(() => assertContinuationBinding(continuation, fullExpected)).not.toThrow();
    expect(() => assertContinuationBinding(continuation, { ...fullExpected, operationId: "op-2" })).toThrow(/does not match/);
    expect(() => assertContinuationBinding(continuation, { ...fullExpected, availableReceiptIds: [] })).toThrow(/not current/);
    expect(() => assertContinuationBinding({ ...continuation, bindingDigest: "0".repeat(64) }, fullExpected)).toThrow(/digest is invalid/);
  });

  it("accounts against one operation budget across sessions without resetting", () => {
    const firstBudget = createExecutionBudget("op-1", 100, { projectId: "project-1", candidateRevisionDigest: "candidate-digest" });
    expect(firstBudget).toMatchObject({ projectId: "project-1", candidateRevisionDigest: "candidate-digest" });
    const first = consumeExecutionBudget(firstBudget, "s-1", 60);
    const second = consumeExecutionBudget(first, "s-2", 30);
    expect(second.consumedTokens).toBe(90);
    expect(second.remainingTokens).toBe(10);
    expect(second.sessionUsage).toEqual({ "s-1": 60, "s-2": 30 });
    expect(() => consumeExecutionBudget(second, "s-3", 11)).toThrow(/budget exhausted/);
  });

  it("keeps the static prompt prefix digest stable as dynamic content changes", () => {
    const prefix = [{ id: "system", content: "You are an engineering agent.", role: "system" }];
    const one = createPromptManifest({ staticPrefix: prefix, dynamic: [{ id: "turn", content: "first" }] });
    const two = createPromptManifest({ staticPrefix: prefix, dynamic: [{ id: "turn", content: "second" }] });
    expect(one.prefixDigest).toBe(two.prefixDigest);
    expect(one.digest).not.toBe(two.digest);
    expect(stablePrefixDigest(one)).toBe(one.prefixDigest);
  });

  it("refuses a plain self-asserted fragment id and requires the full authorization receipt", () => {
    expect(() => createContextRef({ refId: "untrusted", authorizationReceipt: undefined as never, expected: EXPECTED })).toThrow();
  });
});
