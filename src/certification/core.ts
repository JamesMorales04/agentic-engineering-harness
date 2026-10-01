import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { mergeUsageMetrics } from "../metrics/usage.js";
import { createCertificationOracleResult, oracleCanAccept } from "./oracle.js";
import { validateCertificationPolicy } from "./policy.js";
import type {
  AgentProviderRequest,
  AgentProviderResult,
  CandidateRevision,
  CertificationAttempt,
  CertificationBudgetSnapshot,
  CertificationFailure,
  CertificationFailurePacket,
  CertificationOracle,
  CertificationOracleResult,
  CertificationPolicy,
  CertificationReport,
  CertificationRequest,
  CertificationState,
  CertificationCapabilityResult,
  CertificationNetworkPolicy,
  ProviderEvent
} from "./types.js";
import { CERTIFICATION_CAPABILITY_MATRIX } from "./types.js";
import { getBuildIdentity } from "../build/identity.js";
import { assertWorkspaceSourceDigest } from "../candidates/identity.js";

export interface AgentProvider {
  readonly name: string;
  /** The provider must explicitly prove OS-level network isolation before denied-network requests run. */
  readonly networkIsolation: "enforced" | "unavailable";
  execute(request: AgentProviderRequest): Promise<AgentProviderResult>;
}

export class CertificationCore {
  constructor(private readonly oracle: CertificationOracle, private readonly provider?: AgentProvider) {}

  async certify(input: CertificationRequest): Promise<CertificationReport> {
    const startedAt = new Date().toISOString();
    const policy = validateCertificationPolicy(input.policy);
    assertCertificationEntryAllowed(policy);
    const candidate = await normalizeCandidate(input.candidate);
    const certificationId = `cert-${candidate.id}-${crypto.randomUUID()}`;
    const attempts: CertificationAttempt[] = [];
    const providerResults: AgentProviderResult[] = [];
    let usage: ReturnType<typeof mergeUsageMetrics> = {};
    let durationMs = 0;
    let usageKnown = true;
    let oracleResult = emptyOracle(this.oracle.id);
    let reviewer: AgentProviderResult | undefined;
    const networkPolicy = directNetworkPolicy(policy);
    await this.oracle.prepare?.({ candidate, policy, attempt: 0 });

    const invoke = async (request: AgentProviderRequest): Promise<AgentProviderResult | undefined> => {
      if (!this.provider) return undefined;
      assertProviderRequest(request, candidate, policy);
      const budgetFailure = budgetFailureReason(policy, attempts, durationMs, usage, usageKnown);
      if (budgetFailure) return undefined;
      const prepared = withCertificationEnvironment(request);
      const began = Date.now();
      let result: AgentProviderResult;
      if (!prepared.allowNetwork && this.provider.networkIsolation !== "enforced") {
        result = failedProviderResult(prepared, "Certification provider cannot prove network isolation for a denied-network request.", 0);
      } else {
        try {
          result = await this.provider.execute(prepared);
        } catch (error) {
          result = failedProviderResult(prepared, String(error), Date.now() - began);
        }
      }
      attempts.push({ attempt: attempts.length + 1, role: result.role, status: result.status, startedAt: new Date(began).toISOString(), finishedAt: nowIso(), durationMs: result.durationMs, usage: result.usage, message: result.stderr || undefined });
      providerResults.push(result);
      usage = mergeUsageMetrics(usage, result.usage);
      durationMs += result.durationMs;
      usageKnown = usageKnown && result.usageKnown;
      return result;
    };

    const evaluateOracle = async (attempt: number): Promise<CertificationOracleResult> => {
      const remaining = policy.budget.maxDurationMs - durationMs;
      if (remaining <= 0) throw new Error("Certification duration budget exhausted before oracle evaluation.");
      await assertCandidateWorkspaceCurrent(candidate);
      const controller = new AbortController();
      const began = Date.now();
      const startedAt = new Date(began).toISOString();
      let timer: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          this.oracle.evaluate({ candidate, policy, attempt, signal: controller.signal, actor: actorResult }),
          new Promise<CertificationOracleResult>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Certification oracle timed out.")); }, remaining); })
        ]);
        await assertCandidateWorkspaceCurrent(candidate);
        const finishedAt = nowIso();
        attempts.push({ attempt: attempts.length + 1, role: "oracle", status: result.status, startedAt, finishedAt, durationMs: Date.now() - began, message: result.failures.length ? result.failures.map((failure) => failure.message).join("; ") : undefined });
        return result;
      } catch (error) {
        const finishedAt = nowIso();
        attempts.push({ attempt: attempts.length + 1, role: "oracle", status: "FAILED", startedAt, finishedAt, durationMs: Date.now() - began, message: String(error) });
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        durationMs += Date.now() - began;
      }
    };

    const actorResult = input.actor ? await invoke(input.actor) : undefined;
    try {
      oracleResult = await evaluateOracle(0);
      assertOracleResult(oracleResult, policy, this.oracle);
    } catch (error) {
      oracleResult = emptyOracle(this.oracle.id, [{ id: "oracle.crash", category: "oracle", message: String(error) }]);
    }

    let state: CertificationState | undefined;
    let failureReason: CertificationFailurePacket["reason"] | undefined;
    let failures = oracleResult.failures;
    const budgetEvidenceMissing = providerResults.length ? budgetEvidenceUnavailable(policy, usage, usageKnown) : undefined;
    const modelE2E = modelE2ELane(actorResult, oracleResult, input.requireModelE2E === true || input.requireModelEvidence === true);
    const modelRequired = input.requireModelE2E === true;
    if (policy.security.requireNetworkIsolation && !networkPolicy.enforced) {
      state = "BLOCKED";
      failureReason = "SAFETY_FAILURE";
      failures = [{ id: "security.network-isolation", category: "security", message: "Certification requires network isolation, but the direct provider transport cannot enforce it." }];
    } else if (actorResult && (actorResult.status !== "COMPLETED" || actorResult.exitCode !== 0)) {
      state = modelRequired ? "BLOCKED" : "HUMAN_REQUIRED";
      failureReason = "PROVIDER_FAILURE";
      failures = [{ id: "provider.actor", category: "provider", message: "The actor provider did not complete successfully." }];
    } else if (modelRequired && modelE2E.status !== "PASS") {
      state = "BLOCKED";
      failureReason = "PROVIDER_FAILURE";
      failures = [{ id: "provider.model-e2e", category: "provider", message: "Required model-driven E2E execution was not proven by a started provider receipt." }];
    } else if (budgetEvidenceMissing) {
      state = "HUMAN_REQUIRED";
      failureReason = "BUDGET_EXHAUSTED";
      failures = [{ id: "budget.usage", category: "budget", message: budgetEvidenceMissing }];
    } else if (oracleResult.status === "PASS" && oracleCanAccept(oracleResult, policy.assurance)) {
      if (policy.review.enabled && input.reviewer && this.provider) {
        reviewer = await invoke(input.reviewer.create(candidate, oracleResult));
        const reviewOk = reviewer?.status === "COMPLETED" && reviewer.exitCode === 0;
        const reviewBudgetMissing = budgetEvidenceUnavailable(policy, usage, usageKnown);
        if (reviewBudgetMissing) { state = "HUMAN_REQUIRED"; failureReason = "BUDGET_EXHAUSTED"; failures = [{ id: "budget.usage", category: "budget", message: reviewBudgetMissing }]; }
        else if (!reviewOk && policy.review.required) { state = "HUMAN_REQUIRED"; failureReason = "REVIEW_FAILURE"; failures = [{ id: "review.failed", category: "review", message: "Required external review did not complete successfully." }]; }
        else state = "ACCEPTED";
      } else if (policy.review.required) {
        state = "HUMAN_REQUIRED"; failureReason = "REVIEW_FAILURE"; failures = [{ id: "review.missing", category: "review", message: "A required external review was not provided." }];
      } else state = "ACCEPTED";
    } else {
      failureReason = oracleResult.status === "FAIL" ? "ORACLE_FAILURE" : "SAFETY_FAILURE";
      while (policy.repair.enabled && input.repair && this.provider && failures.length && attempts.filter((item) => item.role === "repair").length < policy.repair.maxAttempts) {
        const request = input.repair.create(attempts.filter((item) => item.role === "repair").length + 1, failures, candidate);
        const result = await invoke(request);
        if (!result) break;
        if (result.status !== "COMPLETED" || result.exitCode !== 0) {
          failures = [{ id: "provider.repair", category: "provider", message: "The repair provider did not complete successfully." }];
          failureReason = "PROVIDER_FAILURE";
          break;
        }
        try {
          oracleResult = await evaluateOracle(attempts.filter((item) => item.role === "repair").length);
          assertOracleResult(oracleResult, policy, this.oracle);
        } catch (error) {
          oracleResult = emptyOracle(this.oracle.id, [{ id: "oracle.crash", category: "oracle", message: String(error) }]);
          failures = oracleResult.failures;
          failureReason = "SAFETY_FAILURE";
          break;
        }
        failures = oracleResult.failures;
        if (!budgetEvidenceUnavailable(policy, usage, usageKnown) && oracleCanAccept(oracleResult, policy.assurance)) { state = "ACCEPTED"; failureReason = undefined; break; }
      }
      if (!state) {
        const repairAttempts = attempts.filter((item) => item.role === "repair").length;
        const budgetBlocked = Boolean(budgetFailureReason(policy, attempts, durationMs, usage, usageKnown));
        state = budgetBlocked || (repairAttempts >= policy.repair.maxAttempts && policy.repair.humanOnExhaustion) ? "HUMAN_REQUIRED" : "REPAIR_REQUIRED";
        if (budgetBlocked) failureReason = "BUDGET_EXHAUSTED";
      }
    }

    try {
      await assertCandidateWorkspaceCurrent(candidate);
    } catch (error) {
      state = "BLOCKED";
      failureReason = "SAFETY_FAILURE";
      failures = [{ id: "candidate.identity", category: "candidate", message: String(error) }];
    }

    const capability = input.capability ? buildCapabilityResult(input.capability, oracleResult, modelE2E, modelRequired) : undefined;
    if (state === "ACCEPTED" && capability && capability.overall !== "PASS") {
      state = "HUMAN_REQUIRED";
      failureReason = "SAFETY_FAILURE";
      failures = [{ id: "capability.evidence", category: "certification", message: `Capability '${input.capability}' lacks complete required contract/model evidence.` }];
    }
    const accepted = state === "ACCEPTED";
    const packet = !accepted ? makeFailurePacket(certificationId, candidate, failureReason ?? "ORACLE_FAILURE", failures, attempts.filter((item) => item.role === "repair").length) : undefined;
    const report: CertificationReport = {
      version: 1,
      buildIdentity: getBuildIdentity(),
      certificationId,
      candidate,
      policyId: policy.id,
      state,
      lifecycle: "COMPLETED",
      accepted,
      assurance: accepted ? reviewer?.status === "COMPLETED" && reviewer.exitCode === 0 ? "DETERMINISTIC_WITH_EXTERNAL_REVIEW" : "DETERMINISTIC" : "INSUFFICIENT",
      oracle: oracleResult,
      reviewer,
      providerResults,
      attempts,
      failurePacket: packet,
      budget: budgetSnapshot(policy, attempts, durationMs, usage, usageKnown),
      startedAt,
      finishedAt: nowIso(),
      capability,
      networkPolicy
    };
    await this.oracle.dispose?.();
    return report;
  }
}

export function assertCertificationEntryAllowed(policy: Pick<CertificationPolicy, "security">): void {
  const depth = Number(process.env.AEH_CERTIFICATION_DEPTH ?? "0");
  if (!policy.security.allowRecursiveCertification && Number.isFinite(depth) && depth > 0) throw new Error("Recursive certification is forbidden.");
}

export function assertProviderRequest(request: AgentProviderRequest, candidate: CandidateRevision, policy: CertificationPolicy): void {
  if (request.allowNetwork && !policy.security.allowNetwork) throw new Error("Provider request asks for network access that certification policy forbids.");
  if (request.maxOutputBytes > policy.security.maxOutputBytes) throw new Error("Provider output limit exceeds certification policy.");
  if (!samePath(request.cwd, candidate.root)) throw new Error("Provider cwd must be the candidate root.");
  if ((request.credentialEnvAllowlist ?? []).some((name) => !policy.security.credentialEnvAllowlist.includes(name))) throw new Error("Provider requested a credential environment variable outside certification policy.");
  if ((request.environmentAllowlist ?? []).some((name) => !policy.security.environmentAllowlist.includes(name))) throw new Error("Provider requested an environment variable outside certification policy.");
}

function assertOracleResult(result: CertificationOracleResult, policy: CertificationPolicy, oracle: CertificationOracle): void {
  if (policy.assurance.requireDeterministicOracle && result.deterministic !== true) throw new Error("Certification oracle did not declare deterministic evidence.");
  if (policy.assurance.requireIndependentOracle && oracle.independent !== true) throw new Error("Certification policy requires an independent oracle.");
}

function budgetFailureReason(policy: CertificationPolicy, attempts: CertificationAttempt[], durationMs: number, usage: ReturnType<typeof mergeUsageMetrics>, usageKnown: boolean): string | undefined {
  if (attempts.filter((item) => item.role !== "oracle").length >= policy.budget.maxAttempts) return "attempt budget exhausted";
  if (durationMs >= policy.budget.maxDurationMs) return "duration budget exhausted";
  if (policy.budget.maxTotalTokens !== undefined && (!usageKnown && policy.budget.requireUsageForTokenBudget !== false)) return "token usage is unknown";
  if (policy.budget.maxTotalTokens !== undefined && (usage.totalTokens ?? 0) > policy.budget.maxTotalTokens) return "token budget exhausted";
  if (policy.budget.maxCostUsd !== undefined && (usage.costUsd ?? 0) > policy.budget.maxCostUsd) return "cost budget exhausted";
  return undefined;
}

function budgetEvidenceUnavailable(policy: CertificationPolicy, usage: ReturnType<typeof mergeUsageMetrics>, usageKnown: boolean): string | undefined {
  if (policy.budget.maxTotalTokens !== undefined && (!usageKnown || usage.totalTokens === undefined)) return "Configured token budget cannot be proven because provider usage is incomplete.";
  if (policy.budget.maxCostUsd !== undefined && usage.costUsd === undefined) return "Configured cost budget cannot be proven because provider cost usage is unavailable.";
  return undefined;
}

function budgetSnapshot(policy: CertificationPolicy, attempts: CertificationAttempt[], durationMs: number, usage: ReturnType<typeof mergeUsageMetrics>, usageKnown: boolean): CertificationBudgetSnapshot {
  return { attempts: attempts.filter((item) => item.role !== "oracle").length, durationMs, usage, remaining: { attempts: Math.max(0, policy.budget.maxAttempts - attempts.filter((item) => item.role !== "oracle").length), durationMs: Math.max(0, policy.budget.maxDurationMs - durationMs), costUsd: policy.budget.maxCostUsd === undefined || usage.costUsd === undefined ? undefined : Math.max(0, policy.budget.maxCostUsd - usage.costUsd), totalTokens: policy.budget.maxTotalTokens === undefined || usage.totalTokens === undefined ? undefined : Math.max(0, policy.budget.maxTotalTokens - usage.totalTokens) }, usageKnown };
}

function modelE2ELane(result: AgentProviderResult | undefined, oracle: CertificationOracleResult, requireEvidence: boolean): { status: "PASS" | "BLOCKED" | "NOT_TESTED" | "FAIL" | "INSUFFICIENT"; evidence: Record<string, unknown> } {
  if (!result) return { status: "NOT_TESTED", evidence: { reason: "no model provider invocation" } };
  if (result.executionEvidence?.started !== true) return { status: "BLOCKED", evidence: { reason: "provider did not prove startup", providerStatus: result.status, stderr: result.stderr.slice(-2_000) } };
  if (result.status === "COMPLETED" && result.exitCode === 0 && result.structuredOutput !== undefined && !result.outputTruncated) {
    const evidenceCheck = oracle.checks.find((check) => check.id === "model.evidence");
    if (requireEvidence && evidenceCheck?.status !== "PASS") return { status: "INSUFFICIENT", evidence: { reason: "deterministic oracle did not verify model journey evidence", execution: result.executionEvidence } };
    return { status: "PASS", evidence: { execution: result.executionEvidence, usage: result.usage, usageKnown: result.usageKnown } };
  }
  return { status: "FAIL", evidence: { execution: result.executionEvidence, providerStatus: result.status, exitCode: result.exitCode, stderr: result.stderr.slice(-2_000) } };
}

function buildCapabilityResult(capability: NonNullable<CertificationRequest["capability"]>, oracle: CertificationOracleResult, modelE2E: ReturnType<typeof modelE2ELane>, requiredModelE2E: boolean): CertificationCapabilityResult {
  const requirement = CERTIFICATION_CAPABILITY_MATRIX.find((item) => item.capability === capability);
  const missingEvidence = requirement?.requiredEvidence.filter((id) => !oracle.evidence[id] && !oracle.checks.some((check) => check.id === id && check.status === "PASS" && check.evidence !== undefined)) ?? [];
  const contractStatus = oracle.status !== "PASS" ? "FAIL" as const : missingEvidence.length ? "INSUFFICIENT" as const : "PASS" as const;
  const contract = { status: contractStatus, evidence: { oracleId: oracle.oracleId, checks: oracle.checks, requiredEvidence: requirement?.requiredEvidence ?? [], missingEvidence } };
  const overall = contract.status !== "PASS" ? "FAIL" as const : modelE2E.status === "PASS" ? "PASS" as const : "PARTIAL" as const;
  return { capability, contract, modelE2E, overall, requiredModelE2E };
}

function directNetworkPolicy(policy: CertificationPolicy): CertificationNetworkPolicy {
  if (policy.security.allowNetwork) return { requested: "ALLOW", enforced: false, enforcement: "provider-allowed" };
  return { requested: "DENY", enforced: false, enforcement: "unavailable" };
}

async function normalizeCandidate(input: CandidateRevision): Promise<CandidateRevision> {
  if (!input.id || input.version !== 1) throw new Error("Invalid CandidateRevision.");
  const root = await fs.realpath(path.resolve(input.root));
  const stat = await fs.stat(root); if (!stat.isDirectory()) throw new Error("CandidateRevision.root must be a directory.");
  if (input.artifactPath) {
    const artifact = await fs.realpath(path.resolve(input.artifactPath));
    if (!isWithin(root, artifact)) throw new Error("Candidate artifact escapes its certification workspace.");
    const expectedArtifactDigest = input.packedArtifactDigest ?? input.sourceDigest;
    if (!isDigest(expectedArtifactDigest)) throw new Error("Candidate artifact requires a frozen packedArtifactDigest or sourceDigest.");
    const observedArtifactDigest = await sha256File(artifact);
    if (observedArtifactDigest !== expectedArtifactDigest) throw new Error(`CANDIDATE_WORKSPACE_MISMATCH: packed artifact digest differs from CandidateRevision ${input.id}.`);
    if (!isDigest(input.treeDigest)) throw new Error("Packed CandidateRevision requires a frozen treeDigest for its observed certification workspace.");
    await assertWorkspaceSourceDigest(root, input.treeDigest, { candidateId: input.id, candidateRevision: input.revision ?? 0, candidateIdentityDigest: input.candidateRevisionId ?? input.id });
    return { ...input, root, artifactPath: artifact };
  }
  const expectedTreeDigest = input.treeDigest ?? input.sourceDigest;
  if (!isDigest(expectedTreeDigest)) throw new Error("CandidateRevision requires a frozen sourceDigest/treeDigest before certification.");
  await assertWorkspaceSourceDigest(root, expectedTreeDigest, { candidateId: input.id, candidateRevision: input.revision ?? 0, candidateIdentityDigest: input.candidateRevisionId ?? input.id });
  return { ...input, root };
}

async function sha256File(file: string): Promise<string> { return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"); }
function isDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }

async function assertCandidateWorkspaceCurrent(candidate: CandidateRevision): Promise<void> {
  if (candidate.artifactPath) {
    const expectedArtifactDigest = candidate.packedArtifactDigest ?? candidate.sourceDigest;
    if (!isDigest(expectedArtifactDigest) || await sha256File(candidate.artifactPath) !== expectedArtifactDigest) {
      throw new Error(`CANDIDATE_WORKSPACE_MISMATCH: packed artifact for CandidateRevision ${candidate.id} changed during certification.`);
    }
  }
  const expectedTreeDigest = candidate.treeDigest ?? (!candidate.artifactPath ? candidate.sourceDigest : undefined);
  if (!isDigest(expectedTreeDigest)) {
    throw new Error(`CANDIDATE_WORKSPACE_MISMATCH: certification workspace changed during observation of CandidateRevision ${candidate.id}.`);
  }
  await assertWorkspaceSourceDigest(candidate.root, expectedTreeDigest, { candidateId: candidate.id, candidateRevision: candidate.revision ?? 0, candidateIdentityDigest: candidate.candidateRevisionId ?? candidate.id });
}

function withCertificationEnvironment(request: AgentProviderRequest): AgentProviderRequest { return { ...request, environment: { ...(request.environment ?? {}), AEH_CERTIFICATION_ACTIVE: "1", AEH_CERTIFICATION_DEPTH: "1" } }; }
function samePath(a: string, b: string): boolean { return path.resolve(a) === path.resolve(b); }
function isWithin(parent: string, child: string): boolean { const relative = path.relative(path.resolve(parent), path.resolve(child)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function nowIso(): string { return new Date().toISOString(); }
function emptyOracle(oracleId: string, failures: CertificationFailure[] = []): CertificationOracleResult { return createCertificationOracleResult({ oracleId, checks: failures.map((failure) => ({ id: failure.id, status: "FAIL", required: true, message: failure.message, evidence: failure.details })), evidence: { failure: true } }); }
function makeFailurePacket(certificationId: string, candidate: CandidateRevision, reason: CertificationFailurePacket["reason"], failures: CertificationFailure[], repairAttempt: number): CertificationFailurePacket { return { version: 1, certificationId, candidateId: candidate.id, createdAt: nowIso(), reason, failures, repairAttempt, deterministic: true }; }
function failedProviderResult(request: AgentProviderRequest, message: string, durationMs: number): AgentProviderResult { const event: ProviderEvent = { at: nowIso(), type: "error", data: message }; return { version: 1, provider: "unknown", requestId: request.requestId, role: request.role, status: "FAILED", exitCode: 1, stdout: "", stderr: message, events: [event], usage: {}, usageKnown: false, durationMs, outputTruncated: false }; }
