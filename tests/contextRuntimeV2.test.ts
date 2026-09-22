import { describe, expect, it } from "vitest";
import {
  assertContinuationBinding,
  bindContinuation,
  consumeExecutionBudget,
  createContextRef,
  createContextAuthorizationGrant,
  createContextShard,
  createExecutionBudget,
  createPromptManifest,
  deliverContextPayload,
  rangeShardLocator,
  stablePrefixDigest,
  symbolShardLocator
} from "../src/context/runtimeV2.js";

function authorization(operationId: string, shardId: string, sessionId?: string) {
  return createContextAuthorizationGrant({ grantId: `grant-${operationId}-${shardId}`, operationId, participantId: "participant-1", allowedShardIds: [shardId], ...(sessionId ? { sessionId } : {}), issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" });
}

describe("Context Runtime v2 contracts", () => {
  it("keeps JIT retrieval addressable without treating it as delivered payload", () => {
    const shard = createContextShard({ shardId: "auth", file: "src/auth.ts", content: "export function login() {\n  return true;\n}\n", locator: rangeShardLocator("src/auth.ts", { startLine: 1, endLine: 3 }) });
    const ref = createContextRef({ operationId: "op-1", sessionId: "s-1", shardId: shard.shardId, locator: symbolShardLocator("src/auth.ts", "login", { startLine: 1, endLine: 3 }), authorization: authorization("op-1", shard.shardId, "s-1") });
    expect(ref.addressable).toBe(true);
    expect(ref.delivered).toBe(false);
    expect(ref.payload).toBeUndefined();
    const delivered = deliverContextPayload(ref, shard);
    expect(delivered.delivered).toBe(true);
    expect(delivered.payload?.content).toContain("return true");
  });

  it("selects a deep symbol range instead of the enclosing symbol range", () => {
    const shard = createContextShard({
      shardId: "service",
      file: "src/service.ts",
      content: ["class Service {", "  async handle() {", "    return await load();", "  }", "}", ""].join("\n"),
      locator: rangeShardLocator("src/service.ts", { startLine: 1, endLine: 5 }),
      symbols: [
        { symbol: "Service", symbolPath: ["Service"], range: { startLine: 1, endLine: 5 } },
        { symbol: "handle", symbolPath: ["Service", "handle"], range: { startLine: 2, endLine: 4 } }
      ]
    });
    const selected = deliverContextPayload(createContextRef({ operationId: "op-1", shardId: "service", locator: symbolShardLocator("src/service.ts", "handle", undefined, ["Service", "handle"]), authorization: authorization("op-1", "service") }), shard);
    expect(selected.payload?.range).toEqual({ startLine: 2, endLine: 4 });
    expect(selected.payload?.content).toBe("  async handle() {\n    return await load();\n  }");
  });

  it("binds continuations and rejects operation, ref, and tamper mismatches", () => {
    const ref = createContextRef({ operationId: "op-1", shardId: "a", locator: rangeShardLocator("a.ts", { startLine: 1, endLine: 1 }), authorization: authorization("op-1", "a") });
    const continuation = bindContinuation({ operationId: "op-1", previousSessionId: "s-1", nextSessionId: "s-2", previousTurnId: "t-1", sequence: 2, contextRefIds: [ref.refId] });
    expect(() => assertContinuationBinding(continuation, { operationId: "op-1", availableRefs: [ref] })).not.toThrow();
    expect(() => assertContinuationBinding(continuation, { operationId: "op-2" })).toThrow(/does not match/);
    expect(() => assertContinuationBinding({ ...continuation, bindingDigest: "0".repeat(64) })).toThrow(/digest is invalid/);
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

  it("does not self-authorize a context reference", () => {
    expect(() => createContextRef({ operationId: "op-1", shardId: "untrusted", locator: rangeShardLocator("src/a.ts", { startLine: 1, endLine: 1 }) })).toThrow("AUTHORIZATION_REQUIRED");
  });
});
