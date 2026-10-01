import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256Canonical } from "../core/digest.js";

/**
 * S14 self-hosting composite gate (TARGET section 16).
 *
 * A deterministic evidence aggregator. It verifies versioned slice evidence (S1-S13) and
 * current-candidate runtime evidence (S14 disposable campaign / stability / adversarial) against
 * a frozen policy and a versioned evidence manifest, then computes readiness only from those
 * deterministic checks. Model output is recorded and never evaluated for readiness.
 */

export type SelfHostingCompositeVersion = 1;
export type CompositeEvidenceBinding = "versioned" | "runtime";
export type CompositeMechanism = "DETERMINISTIC" | "MODEL" | "HYBRID";

export interface CompositeAssertionV1 {
  path: string;
  op: "exists" | "equals" | "not-equals" | "oneOf" | "contains" | "array-contains" | "gte" | "lte" | "matches";
  value?: unknown;
  type?: "string" | "number" | "boolean" | "object" | "array";
  match?: Record<string, unknown>;
}

export interface CompositeArtifactSpecV1 {
  key: string;
  path: string;
  binding: CompositeEvidenceBinding;
  expectedSha256?: string;
  assertions: readonly CompositeAssertionV1[];
}

export interface CompositeItemV1 {
  id: string;
  title: string;
  target: string;
  mechanism: CompositeMechanism;
  required: boolean;
  artifactKeys: readonly string[];
}

export interface SelfHostingCompositePolicyV1 {
  version: SelfHostingCompositeVersion;
  id: string;
  readinessAuthority: "DETERMINISTIC_COMPOSITE";
  items: readonly CompositeItemV1[];
  artifacts: Readonly<Record<string, CompositeArtifactSpecV1>>;
}

export interface SelfHostingEvidenceManifestV1 {
  version: 1;
  id: string;
  generatedAt: string;
  policyDigest: string;
  artifacts: Record<string, string>;
}

export interface SelfHostingCompositeRequestV1 {
  repoRoot: string;
  manifestPath: string;
  candidateBuildDigest: string;
  generatedAt: string;
  modelReadinessClaims?: readonly { source: string; claim: unknown }[];
}

export interface CompositeArtifactReportV1 {
  key: string;
  path: string;
  binding: CompositeEvidenceBinding;
  sha256: string;
  status: "PASS" | "FAIL";
  failures: string[];
}

export interface CompositeItemReportV1 {
  id: string;
  title: string;
  target: string;
  mechanism: CompositeMechanism;
  required: boolean;
  status: "PASS" | "FAIL";
  artifacts: CompositeArtifactReportV1[];
}

export interface SelfHostingCompositeReportV1 {
  version: 1;
  gateId: string;
  policyId: string;
  policyDigest: string;
  manifestPath: string;
  manifestSha256: string | null;
  candidateBuildDigest: string;
  generatedAt: string;
  readinessAuthority: "DETERMINISTIC_COMPOSITE";
  modelAuthority: "NONE";
  modelReadinessClaims: { received: number; sources: string[]; evaluated: false };
  ready: boolean;
  items: CompositeItemReportV1[];
  failures: { itemId: string | null; artifactKey: string | null; code: string; message: string }[];
  summary: {
    requiredItems: number;
    passedItems: number;
    failedItems: number;
    verifiedArtifacts: number;
    failedArtifacts: number;
    versionedArtifacts: number;
    runtimeArtifacts: number;
  };
}

export const CANDIDATE_BUILD_DIGEST_PLACEHOLDER = "$CANDIDATE_BUILD_DIGEST";

const VERSIONED = "versioned" as const;
const RUNTIME = "runtime" as const;

const S13_BUILD_DIGEST = "599ed363223ff2dd85e17296c9f34c4134bf83e363916c4c57d7e7492ccbdf45";
const S13_TRACKED_DIGEST = "3f9b7fd8767afe27c833a1a6580c362856b911c4d04dcd5f7833eaaa631634d8";

function versioned(key: string, relativePath: string, sha256: string, assertions: CompositeAssertionV1[]): CompositeArtifactSpecV1 {
  return { key, path: relativePath, binding: VERSIONED, expectedSha256: sha256, assertions };
}

function runtime(key: string, relativePath: string, assertions: CompositeAssertionV1[]): CompositeArtifactSpecV1 {
  return { key, path: relativePath, binding: RUNTIME, assertions };
}

const TERMINAL_SUCCEEDED: CompositeAssertionV1[] = [{ path: "terminalRecord.status", op: "equals", value: "SUCCEEDED" }];
const CHECKOUT_UNTOUCHED: CompositeAssertionV1[] = [{ path: "checkoutProof.checkoutUntouched", op: "equals", value: true }];
const RESULT_PASS: CompositeAssertionV1[] = [{ path: "result", op: "equals", value: "PASS" }];
const CANDIDATE_BOUND_CHECK: CompositeAssertionV1 = { path: "oracle.checks", op: "array-contains", match: { id: "operation.candidate-bound", status: "PASS" } };
const RECEIPTS_CHECK: CompositeAssertionV1 = { path: "oracle.checks", op: "array-contains", match: { id: "operation.participant-receipts", status: "PASS" } };

export const SELF_HOSTING_COMPOSITE_ARTIFACTS: Readonly<Record<string, CompositeArtifactSpecV1>> = {
  "s13.review-final": versioned("s13.review-final", "docs/evidence/s13/review-final-r23.json", "fe3bc3d1b507c4c4bab36f32deabdc1c98defedcb1dd12b1006b366a19bd4f8a", [
    { path: "verdict", op: "equals", value: "SLICE_ACCEPTED" },
    { path: "digestRecomputation", op: "equals", value: "MATCH" },
    { path: "gitState.targetByteIdentical", op: "equals", value: true }
  ]),
  "s13.frozen-release-manifest": versioned("s13.frozen-release-manifest", "docs/evidence/s13/round-22/frozen-release-manifest.json", "ac134c331984f013eadac860987973333ae2c56a3fa2132e4a27471b87564286", [
    { path: "buildDigest", op: "equals", value: S13_BUILD_DIGEST },
    { path: "trackedDigestAtBuild", op: "equals", value: S13_TRACKED_DIGEST },
    { path: "fileCount", op: "gte", value: 800 }
  ]),
  "s13.certification": versioned("s13.certification", "docs/evidence/s13/s13-real-provider-certification.json", "5446493ecf7e1b002aa97cb1ae4fe4d544c8273c50e42034e7e0ede27f8978af", [
    ...CHECKOUT_UNTOUCHED,
    { path: "executableRows", op: "contains", value: "startup" },
    { path: "executableRows", op: "contains", value: "informational" },
    { path: "executableRows", op: "contains", value: "project-home" },
    { path: "executableRows", op: "contains", value: "multi-project" },
    { path: "lanes", op: "array-contains", match: { capability: "informational", result: "PASS" } }
  ]),
  "s13.lifecycle": versioned("s13.lifecycle", "docs/evidence/s13/s13-real-paseo-lifecycle-round-22-r22-lifecycle-1.json", "3fcc039e0a03adc3973b3d3643e11e89f71303f6ecd96f3f7d20243db204dad9", [
    ...RESULT_PASS,
    ...CHECKOUT_UNTOUCHED,
    { path: "lanes", op: "array-contains", match: { capability: "cancel", result: "PASS" } },
    { path: "lanes", op: "array-contains", match: { capability: "recovery", result: "PASS" } }
  ]),
  "s13.gov.audit": versioned("s13.gov.audit", "docs/evidence/s13/governed-lanes/round-22/r22-gov-1/audit.json", "973772b79c316d2a0d68c14ac4d4a474754fdc6cbdcd118677384ce91e936362", [
    ...RESULT_PASS,
    ...TERMINAL_SUCCEEDED,
    ...CHECKOUT_UNTOUCHED,
    RECEIPTS_CHECK
  ]),
  "s13.gov.change-multifile": versioned("s13.gov.change-multifile", "docs/evidence/s13/governed-lanes/round-22/r22-gov-1/change-multifile.json", "b3f931ad0bc188e95caa9f96b7ffd03f10a42e4bae381b79f39084c0f120b787", [
    ...RESULT_PASS,
    ...TERMINAL_SUCCEEDED,
    ...CHECKOUT_UNTOUCHED,
    CANDIDATE_BOUND_CHECK,
    { path: "operation.result.acceptanceOracle.disposition", op: "equals", value: "ACCEPTED" },
    { path: "oracle.rowResults.change", op: "equals", value: "PASS" },
    { path: "oracle.rowResults.direct-change", op: "equals", value: "PASS" }
  ]),
  "s13.gov.change-direct": versioned("s13.gov.change-direct", "docs/evidence/s13/governed-lanes/round-22/r22-gov-1/change-direct.json", "0002a79678fa86f30e24df2bdb46a34f8509a53f523424d48c380d4ae804ccd3", [
    ...RESULT_PASS,
    ...TERMINAL_SUCCEEDED,
    ...CHECKOUT_UNTOUCHED,
    CANDIDATE_BOUND_CHECK,
    { path: "operation.result.acceptanceOracle.disposition", op: "equals", value: "ACCEPTED" }
  ]),
  "s13.gov.change-delegated": versioned("s13.gov.change-delegated", "docs/evidence/s13/governed-lanes/round-22/r22-gov-1/change-delegated.json", "e21de775d76f32d33cbef5ed9c2622c0d14c571c5f7e52ce00c1a14fcc07ffaf", [
    ...RESULT_PASS,
    ...TERMINAL_SUCCEEDED,
    ...CHECKOUT_UNTOUCHED,
    RECEIPTS_CHECK,
    { path: "operation.result.acceptanceOracle.disposition", op: "equals", value: "ACCEPTED" },
    { path: "oracle.rowResults.delegated-change", op: "equals", value: "PASS" }
  ]),
  "s13.gov.multi-worker": versioned("s13.gov.multi-worker", "docs/evidence/s13/governed-lanes/round-22/r22-gov-2/multi-worker.json", "47693c99de958e747811cec1cfe3ea591a3d474e0e5a1457ecd73da9759a2f88", [
    ...RESULT_PASS,
    ...TERMINAL_SUCCEEDED,
    ...CHECKOUT_UNTOUCHED,
    RECEIPTS_CHECK,
    { path: "oracle.rowResults.multi-worker", op: "equals", value: "PASS" }
  ]),
  "s13.gov.change-formal": versioned("s13.gov.change-formal", "docs/evidence/s13/governed-lanes/round-22/r22-gov-2/change-formal.json", "a91a49e63241a315b44b3f9b8c16774aa07635a9551ad17cd01efb04bd8f1d71", [
    ...RESULT_PASS,
    ...TERMINAL_SUCCEEDED,
    ...CHECKOUT_UNTOUCHED,
    { path: "operation.result.acceptanceOracle.disposition", op: "equals", value: "ACCEPTED" },
    { path: "oracle.rowResults.formal-sdd", op: "equals", value: "PASS" }
  ]),
  "s13.gov.distributed": versioned("s13.gov.distributed", "docs/evidence/s13/governed-lanes/round-21/r21-dist-14/distributed.json", "69b735d04a75f1d37795e6d930854a20d2da7822caf9f44b5b2e59268e1042d0", [
    ...RESULT_PASS,
    ...TERMINAL_SUCCEEDED,
    { path: "oracle.checks", op: "array-contains", match: { id: "distributed-execution.lease", status: "PASS" } },
    { path: "oracle.checks", op: "array-contains", match: { id: "distributed-execution.worker-receipt", status: "PASS" } }
  ]),
  "s13.gov.repair": versioned("s13.gov.repair", "docs/evidence/s13/governed-lanes/round-23/r23-gov-9/repair.json", "20621848a613e921038fc81d503b1457dcf75c68c75029623d4af72b841dbd5c", [
    ...RESULT_PASS,
    ...TERMINAL_SUCCEEDED,
    ...CHECKOUT_UNTOUCHED,
    { path: "oracle.rowResults.repair", op: "equals", value: "PASS" },
    { path: "oracle.rowResults.product-repair", op: "equals", value: "PASS" },
    { path: "oracle.checks", op: "array-contains", match: { id: "product-repair.scope-check", status: "PASS" } }
  ]),
  "s13.gh.authority": versioned("s13.gh.authority", "docs/evidence/s13/github-lanes/round-22/r22-gh-1/authority.json", "7fbed79965bc0003eb186ecee310120f31581fc2f90ee5907e5caf0f04abca6a", [
    ...RESULT_PASS,
    { path: "humanGate.status", op: "equals", value: "HUMAN_REQUIRED" },
    { path: "checks", op: "array-contains", match: { id: "authority.human-gate", ok: true } },
    { path: "checks", op: "array-contains", match: { id: "authority.external-authorization", ok: true } },
    { path: "remoteRef.exitCode", op: "equals", value: 0 }
  ]),
  "s13.gh.delivery": versioned("s13.gh.delivery", "docs/evidence/s13/github-lanes/round-22/r22-gh-1/delivery.json", "7afdde1111a1e57cadd4a1363160cb9f8baaa804804b317192afb8abec2fd71b", [
    ...RESULT_PASS,
    { path: "finalized.status", op: "equals", value: "FINALIZED" },
    { path: "provenance.gate.ok", op: "equals", value: true },
    { path: "reconciliation.remoteRefSha", op: "equals", value: "6f890cdce290889784a6b3e1d929dd05d4bab795" },
    { path: "reconciliation.localHead", op: "equals", value: "6f890cdce290889784a6b3e1d929dd05d4bab795" },
    { path: "checks", op: "array-contains", match: { id: "delivery.accepted-candidate", ok: true } },
    { path: "checks", op: "array-contains", match: { id: "delivery.external-authorization", ok: true } }
  ]),
  "s13.gh.issue-driven": versioned("s13.gh.issue-driven", "docs/evidence/s13/github-lanes/round-22/r22-gh-1/issue-driven.json", "701c2cdb7355a270d77308257130afea2ad44dce9813aeae3b6c01f22ff0fcdb", [
    ...RESULT_PASS,
    { path: "checks", op: "array-contains", match: { id: "issue.snapshot", ok: true } },
    { path: "checks", op: "array-contains", match: { id: "issue.drift-gate", ok: true } },
    { path: "checks", op: "array-contains", match: { id: "issue.operation-import", ok: true } }
  ]),
  "s13.journey.issue": versioned("s13.journey.issue", "docs/evidence/s13/issue-journey-lanes/round-22/r22-journey-1/issue-driven.json", "6aab2cf158e22c1a2d0775d81d3f956787429595866f7539080f99cd3e4d9381", [
    ...RESULT_PASS,
    ...CHECKOUT_UNTOUCHED,
    { path: "checks", op: "array-contains", match: { id: "issue-driven.human-gate", ok: true } },
    { path: "checks", op: "array-contains", match: { id: "issue-driven.delivery-operation-terminal", ok: true } },
    { path: "checks", op: "array-contains", match: { id: "issue-driven.issue-untouched", ok: true } }
  ]),
  "s13.ctx.context-handoff": versioned("s13.ctx.context-handoff", "docs/evidence/s13/context-permission-lanes/round-22/r22-ctxperm-1/context-handoff.json", "33a125e6347c26af89208b67b4e1748c73891afa27c5372ffa4788dc278e1f95", [
    ...RESULT_PASS,
    { path: "rowResult.context-handoff", op: "equals", value: "PASS" },
    { path: "checks", op: "array-contains", match: { id: "context-handoff.addressable-refs", ok: true } },
    { path: "checks", op: "array-contains", match: { id: "context-handoff.continuation-binding", ok: true } }
  ]),
  "s13.ctx.permission-delegation": versioned("s13.ctx.permission-delegation", "docs/evidence/s13/context-permission-lanes/round-22/r22-ctxperm-1/permission-delegation.json", "e26176dcf85e30014be3f9fd6e9147b3ca4b958591d7fb491551bf52f0884015", [
    ...RESULT_PASS,
    { path: "rowResult.permission-delegation", op: "equals", value: "PASS" },
    { path: "checks", op: "array-contains", match: { id: "permission-delegation.parent-lease", ok: true } },
    { path: "checks", op: "array-contains", match: { id: "permission-delegation.ceiling-denial", ok: true } }
  ]),
  "s13.certification-repair": versioned("s13.certification-repair", "docs/evidence/s13/s13-certification-repair-round-22-r22-certrepair-1.json", "2e10c4d4d433ba5506f42a09440ff2e75432176de876d0c047abba9b32c3f5ad", [
    ...RESULT_PASS,
    { path: "lanes", op: "array-contains", match: { capability: "certification-repair", result: "PASS", accepted: true } }
  ]),
  "s10.sast": versioned("s10.sast", "docs/evidence/s10/real-sast-campaign.json", "3a106006801c7b03e79795b8beedc4af240facd16ee78675d8f8194fd7848779", [
    ...RESULT_PASS,
    { path: "assertions.isolationExercised", op: "equals", value: true },
    { path: "assertions.candidateBoundExactly", op: "equals", value: true },
    { path: "assertions.firstEvidenceStaleForRevisionTwo", op: "equals", value: true },
    { path: "assertions.noFabricatedPass", op: "equals", value: true }
  ]),
  "s14.campaign": runtime("s14.campaign", "docs/evidence/closure/disposable-self-modification-campaign.json", [
    ...RESULT_PASS,
    { path: "campaign", op: "equals", value: "disposable-self-modification" },
    { path: "sourceLane.result", op: "equals", value: "PASS" },
    { path: "sourceLane.terminalRecord.status", op: "equals", value: "SUCCEEDED" },
    { path: "sourceLane.checkoutProof.checkoutUntouched", op: "equals", value: true },
    { path: "sourceLane.operation.result.acceptanceOracle.disposition", op: "equals", value: "ACCEPTED" },
    { path: "sourceLane.candidateBinding.packedBuild.buildDigest", op: "equals", value: CANDIDATE_BUILD_DIGEST_PLACEHOLDER },
    { path: "containment.fixtureRoot", op: "matches", value: "^/tmp/" },
    { path: "containment.checkoutOutsideMutationRoots", op: "equals", value: true },
    { path: "containment.mutationRootsDisposable", op: "equals", value: true },
    { path: "containment.changedPathsRepositoryRelative", op: "equals", value: true },
    { path: "containment.candidateWorkspaceObservationsMatched", op: "equals", value: true },
    { path: "effects.publicEffects", op: "equals", value: [] },
    { path: "cleanup.accounting.accounted", op: "equals", value: true },
    { path: "cleanup.accounting.unaccounted", op: "equals", value: [] },
    { path: "cleanup.campaignSideCleanup", op: "equals", value: "NONE" },
    { path: "cleanup.productResourceReconciliation.cleanupComplete", op: "equals", value: true },
    { path: "cleanup.productResourceReconciliation.receiptSha256", op: "matches", value: "^[0-9a-f]{64}$" },
    { path: "cleanup.productResourceReconciliation.classification.liveOwned", op: "equals", value: 0 },
    { path: "cleanup.productResourceReconciliation.errors", op: "equals", value: [] },
    { path: "sourceLaneSha256", op: "matches", value: "^[0-9a-f]{64}$" },
    { path: "sourceLanePath", op: "equals", value: "docs/evidence/closure/raw/disposable-campaign-lane.json" }
  ]),
  "s14.campaign-raw": runtime("s14.campaign-raw", "docs/evidence/closure/raw/disposable-campaign-lane.json", [
    ...RESULT_PASS,
    ...TERMINAL_SUCCEEDED,
    ...CHECKOUT_UNTOUCHED,
    { path: "candidateBinding.packedBuild.buildDigest", op: "equals", value: CANDIDATE_BUILD_DIGEST_PLACEHOLDER },
    { path: "candidateBinding.fixtureTreeDigest", op: "matches", value: "^[0-9a-f]{64}$" }
  ]),
  "s14.stability": runtime("s14.stability", "docs/evidence/closure/resource-stability-product.json", [
    ...RESULT_PASS,
    { path: "campaign", op: "equals", value: "resource-stability-product" },
    { path: "iterations.length", op: "gte", value: 2 },
    { path: "candidateBuildDigest", op: "equals", value: CANDIDATE_BUILD_DIGEST_PLACEHOLDER },
    { path: "productReconciliation.applied", op: "equals", value: true },
    { path: "reconciliation.baselineReturned", op: "equals", value: true },
    { path: "reconciliation.preservedIntact", op: "equals", value: true },
    { path: "reconciliation.productOwned", op: "equals", value: true },
    { path: "reconciliation.campaignSideCleanup", op: "equals", value: "NONE" },
    { path: "trend.postReconciliationNoGrowth", op: "equals", value: true },
    { path: "classification.aehV2_0130", op: "equals", value: "CLOSED_BY_PRODUCT" }
  ]),
  "s14.lifecycle-current": runtime("s14.lifecycle-current", "docs/evidence/closure/paseo-lifecycle-cancel-recovery.json", [
    ...RESULT_PASS,
    ...CHECKOUT_UNTOUCHED,
    { path: "lanes", op: "array-contains", match: { capability: "cancel", result: "PASS" } },
    { path: "lanes", op: "array-contains", match: { capability: "recovery", result: "PASS" } }
  ]),
  "s14.adversarial": runtime("s14.adversarial", "docs/evidence/closure/adversarial-negative-checks.json", [
    ...RESULT_PASS,
    { path: "campaign", op: "equals", value: "adversarial-negative-checks" },
    { path: "failedChecks", op: "equals", value: [] },
    { path: "checks.length", op: "gte", value: 8 },
    { path: "modelAuthority", op: "equals", value: "NONE" },
    { path: "candidateBuildDigest", op: "equals", value: CANDIDATE_BUILD_DIGEST_PLACEHOLDER }
  ])
};

export const SELF_HOSTING_COMPOSITE_ITEMS: readonly CompositeItemV1[] = [
  { id: "candidate-truth", title: "Candidate truth and immutable assembly", target: "§16 candidate truth; §2 candidate truth", mechanism: "DETERMINISTIC", required: true, artifactKeys: ["s13.frozen-release-manifest", "s13.gov.change-multifile", "s13.gov.change-direct"] },
  { id: "controller-fencing", title: "Controller fencing and exact-current authority", target: "§16 controller fencing; §9 authority", mechanism: "DETERMINISTIC", required: true, artifactKeys: ["s13.gh.authority", "s13.lifecycle"] },
  { id: "capability-authority", title: "Capability authority and human-gated effects", target: "§16 capability authority; §12 authority", mechanism: "HYBRID", required: true, artifactKeys: ["s13.gh.authority", "s13.ctx.permission-delegation", "s13.gov.change-delegated"] },
  { id: "policy-freeze", title: "Frozen policy identity across the governed lifecycle", target: "§16 policy freeze; §3 policy", mechanism: "DETERMINISTIC", required: true, artifactKeys: ["s13.gov.change-formal", "s13.gov.change-delegated"] },
  { id: "execution-identity-provenance", title: "Execution identity, provenance and worker receipts", target: "§16 execution identity and provenance; §5", mechanism: "DETERMINISTIC", required: true, artifactKeys: ["s13.gov.distributed", "s13.gov.multi-worker"] },
  { id: "skillmanifest-context", title: "SkillManifest and authorized context delivery", target: "§16 SkillManifest and context; §6", mechanism: "HYBRID", required: true, artifactKeys: ["s13.ctx.context-handoff", "s13.ctx.permission-delegation"] },
  { id: "paseo-session-identity", title: "Paseo session identity and lifecycle", target: "§16 Paseo session identity; §6", mechanism: "DETERMINISTIC", required: true, artifactKeys: ["s13.lifecycle", "s13.certification"] },
  { id: "impact-driven-assurance", title: "Impact-driven assurance recompilation", target: "§16 impact-driven assurance; §4", mechanism: "HYBRID", required: true, artifactKeys: ["s13.gov.change-direct", "s13.gov.change-multifile"] },
  { id: "validation", title: "Validation requirements and candidate-bound evidence", target: "§16 validation; §8", mechanism: "DETERMINISTIC", required: true, artifactKeys: ["s13.gov.change-multifile", "s13.gov.change-delegated"] },
  { id: "independent-review", title: "Independent review evidence", target: "§16 independent review; §7", mechanism: "HYBRID", required: true, artifactKeys: ["s13.gov.change-delegated", "s13.journey.issue"] },
  { id: "acceptance-oracle", title: "AcceptanceOracle and objective completion", target: "§16 acceptance/oracle; §10", mechanism: "DETERMINISTIC", required: true, artifactKeys: ["s13.gov.change-direct", "s13.gov.change-formal"] },
  { id: "repair-replan", title: "Bounded repair/replan with oracle re-check", target: "§16 repair/replan; §8", mechanism: "HYBRID", required: true, artifactKeys: ["s13.gov.repair", "s13.certification-repair"] },
  { id: "human-exception-handling", title: "Human exception handling and external authorization", target: "§16 human exception handling; §12", mechanism: "HYBRID", required: true, artifactKeys: ["s13.journey.issue", "s13.gh.authority"] },
  { id: "delivery-reconciliation", title: "Delivery intents, receipts and reconciliation", target: "§16 delivery reconciliation; §11", mechanism: "HYBRID", required: true, artifactKeys: ["s13.gh.delivery", "s13.journey.issue"] },
  { id: "runtime-recovery", title: "Runtime supervision, cancellation and recovery", target: "§16 runtime recovery; §9", mechanism: "DETERMINISTIC", required: true, artifactKeys: ["s13.lifecycle", "s14.lifecycle-current", "s13.gov.distributed"] },
  { id: "sandbox-security", title: "Sandbox/security isolation and candidate-bound SAST", target: "§16 sandbox/security; §12", mechanism: "DETERMINISTIC", required: true, artifactKeys: ["s10.sast", "s13.ctx.permission-delegation"] },
  { id: "supply-chain", title: "Supply-chain provenance gate", target: "§16 supply chain; §11/§15", mechanism: "DETERMINISTIC", required: true, artifactKeys: ["s13.gh.delivery", "s13.review-final"] },
  { id: "real-provider-certification", title: "Real-provider certification matrix", target: "§16 real-provider certification; §15", mechanism: "HYBRID", required: true, artifactKeys: ["s13.certification", "s13.review-final"] },
  { id: "adversarial-fault-injection", title: "Adversarial and fault-injection evidence", target: "§16 adversarial/fault injection", mechanism: "DETERMINISTIC", required: true, artifactKeys: ["s14.adversarial", "s13.gov.distributed"] },
  { id: "resource-lifecycle-reconciliation", title: "Resource lifecycle reconciliation and stability (AEH-V2-0130)", target: "§16 + CAMPAIGN RESOURCE-LIFECYCLE AMENDMENT", mechanism: "HYBRID", required: true, artifactKeys: ["s14.stability", "s14.campaign", "s14.campaign-raw"] },
  { id: "disposable-self-modification", title: "Disposable self-modification campaign", target: "§16 disposable self-modification campaign", mechanism: "HYBRID", required: true, artifactKeys: ["s14.campaign", "s14.campaign-raw", "s13.review-final"] }
];

export const SELF_HOSTING_COMPOSITE_POLICY_V1: SelfHostingCompositePolicyV1 = {
  version: 1,
  id: "aeh-self-hosting-composite-v1",
  readinessAuthority: "DETERMINISTIC_COMPOSITE",
  items: SELF_HOSTING_COMPOSITE_ITEMS,
  artifacts: SELF_HOSTING_COMPOSITE_ARTIFACTS
};

export function selfHostingCompositePolicyDigestV1(policy: SelfHostingCompositePolicyV1 = SELF_HOSTING_COMPOSITE_POLICY_V1): string {
  return sha256Canonical(policy as unknown as Record<string, unknown>);
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readAtPath(value: unknown, dotted: string): { found: boolean; value?: unknown } {
  let current: unknown = value;
  for (const segment of dotted.split(".")) {
    if (current === null || typeof current !== "object") return { found: false };
    if (Array.isArray(current)) {
      if (segment === "length") { current = current.length; continue; }
      if (!/^\d+$/.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return { found: false };
    current = record[segment];
  }
  return { found: true, value: current };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => deepEqual(entry, right[index]));
  }
  if (typeof left === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined).sort();
    const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined).sort();
    if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
    return leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
  }
  return false;
}

function partialMatch(candidate: unknown, match: Record<string, unknown>): boolean {
  if (candidate === null || typeof candidate !== "object") return false;
  const record = candidate as Record<string, unknown>;
  return Object.entries(match).every(([key, expected]) => deepEqual(record[key], expected));
}

function evaluateAssertion(artifact: unknown, assertion: CompositeAssertionV1, candidateBuildDigest: string): string | null {
  const located = readAtPath(artifact, assertion.path);
  if (!located.found) return `assertion ${assertion.op} ${assertion.path} failed: path is missing`;
  const actual = located.value;
  const expected = assertion.value === CANDIDATE_BUILD_DIGEST_PLACEHOLDER ? candidateBuildDigest : assertion.value;
  switch (assertion.op) {
    case "exists": {
      if (assertion.type === "array") return Array.isArray(actual) ? null : `assertion exists ${assertion.path} failed: expected array but found ${typeof actual}`;
      if (assertion.type && typeof actual !== assertion.type) return `assertion exists ${assertion.path} failed: expected type ${assertion.type} but found ${typeof actual}`;
      return null;
    }
    case "equals":
      return deepEqual(actual, expected) ? null : `assertion equals ${assertion.path} failed: expected ${JSON.stringify(expected)} but found ${JSON.stringify(actual)}`;
    case "not-equals":
      return !deepEqual(actual, expected) ? null : `assertion not-equals ${assertion.path} failed: value is ${JSON.stringify(actual)}`;
    case "oneOf":
      return Array.isArray(expected) && expected.some((entry) => deepEqual(actual, entry)) ? null : `assertion oneOf ${assertion.path} failed: found ${JSON.stringify(actual)}`;
    case "contains": {
      if (Array.isArray(actual)) return actual.some((entry) => deepEqual(entry, expected)) ? null : `assertion contains ${assertion.path} failed: ${JSON.stringify(expected)} absent`;
      if (typeof actual === "string" && typeof expected === "string") return actual.includes(expected) ? null : `assertion contains ${assertion.path} failed: ${expected} absent`;
      return `assertion contains ${assertion.path} failed: unsupported value type`;
    }
    case "array-contains": {
      if (!Array.isArray(actual) || !assertion.match) return `assertion array-contains ${assertion.path} failed: not an array or missing match`;
      return actual.some((entry) => partialMatch(entry, assertion.match!)) ? null : `assertion array-contains ${assertion.path} failed: no entry matches ${JSON.stringify(assertion.match)}`;
    }
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected ? null : `assertion gte ${assertion.path} failed: ${JSON.stringify(actual)} < ${JSON.stringify(expected)}`;
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected ? null : `assertion lte ${assertion.path} failed: ${JSON.stringify(actual)} > ${JSON.stringify(expected)}`;
    case "matches":
      return typeof actual === "string" && typeof expected === "string" && new RegExp(expected).test(actual) ? null : `assertion matches ${assertion.path} failed: ${JSON.stringify(actual)} does not match ${JSON.stringify(expected)}`;
    default:
      return `assertion ${(assertion as { op: string }).op} is unsupported`;
  }
}

function resolveArtifactPath(repoRoot: string, relativePath: string): { ok: true; absolute: string } | { ok: false; reason: string } {
  if (path.isAbsolute(relativePath)) return { ok: false, reason: "artifact path must be repository-relative" };
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..") || normalized.includes(`..${path.sep}`)) return { ok: false, reason: "artifact path escapes the repository root" };
  if (!normalized.startsWith(`docs${path.sep}evidence${path.sep}`)) return { ok: false, reason: "artifact path must live under docs/evidence" };
  const resolvedRoot = path.resolve(repoRoot);
  const absolute = path.resolve(resolvedRoot, normalized);
  if (!absolute.startsWith(`${resolvedRoot}${path.sep}`)) return { ok: false, reason: "artifact path escapes the repository root" };
  return { ok: true, absolute };
}

export async function generateSelfHostingEvidenceManifestV1(input: {
  repoRoot: string;
  generatedAt: string;
  policy?: SelfHostingCompositePolicyV1;
}): Promise<SelfHostingEvidenceManifestV1> {
  const policy = input.policy ?? SELF_HOSTING_COMPOSITE_POLICY_V1;
  const artifacts: Record<string, string> = {};
  const failures: string[] = [];
  for (const spec of Object.values(policy.artifacts).sort((left, right) => (left.key < right.key ? -1 : 1))) {
    const resolved = resolveArtifactPath(input.repoRoot, spec.path);
    if (!resolved.ok) { failures.push(`${spec.key}: ${resolved.reason}`); continue; }
    let digest: string;
    try {
      digest = sha256Hex(await readFile(resolved.absolute));
    } catch {
      if (spec.binding === RUNTIME) continue;
      failures.push(`${spec.key}: evidence file is missing (${spec.path})`);
      continue;
    }
    if (spec.binding === VERSIONED && spec.expectedSha256 !== digest) {
      failures.push(`${spec.key}: evidence sha256 ${digest} does not match the frozen versioned digest ${spec.expectedSha256}`);
      continue;
    }
    artifacts[spec.key] = digest;
  }
  if (failures.length) throw new Error(`SELF_HOSTING_MANIFEST_GENERATION_FAILED: ${failures.join("; ")}`);
  return {
    version: 1,
    id: policy.id,
    generatedAt: input.generatedAt,
    policyDigest: selfHostingCompositePolicyDigestV1(policy),
    artifacts
  };
}

export async function verifySelfHostingCompositeGateV1(request: SelfHostingCompositeRequestV1, policy: SelfHostingCompositePolicyV1 = SELF_HOSTING_COMPOSITE_POLICY_V1): Promise<SelfHostingCompositeReportV1> {
  const policyDigest = selfHostingCompositePolicyDigestV1(policy);
  const failures: SelfHostingCompositeReportV1["failures"] = [];
  const claims = request.modelReadinessClaims ?? [];
  const itemReports: CompositeItemReportV1[] = [];
  let manifest: SelfHostingEvidenceManifestV1 | null = null;
  let manifestSha256: string | null = null;

  const manifestResolved = resolveArtifactPath(request.repoRoot, request.manifestPath);
  if (!manifestResolved.ok) {
    failures.push({ itemId: null, artifactKey: null, code: "COMPOSITE_MANIFEST_UNSAFE_PATH", message: manifestResolved.reason });
  } else {
    try {
      const bytes = await readFile(manifestResolved.absolute);
      manifestSha256 = sha256Hex(bytes);
      const parsed = JSON.parse(bytes.toString("utf8")) as Partial<SelfHostingEvidenceManifestV1>;
      if (parsed.version !== 1) {
        failures.push({ itemId: null, artifactKey: null, code: "COMPOSITE_UNSUPPORTED_VERSION", message: `manifest version ${String(parsed.version)} is unsupported` });
      } else if (parsed.policyDigest !== policyDigest) {
        failures.push({ itemId: null, artifactKey: null, code: "COMPOSITE_POLICY_DIGEST_MISMATCH", message: `manifest policyDigest ${String(parsed.policyDigest)} does not match the frozen policy digest ${policyDigest}` });
      } else if (typeof parsed.artifacts !== "object" || parsed.artifacts === null || Array.isArray(parsed.artifacts)) {
        failures.push({ itemId: null, artifactKey: null, code: "COMPOSITE_MANIFEST_INVALID", message: "manifest artifacts must be an object keyed by artifact id" });
      } else {
        manifest = parsed as SelfHostingEvidenceManifestV1;
      }
    } catch (error) {
      failures.push({ itemId: null, artifactKey: null, code: "COMPOSITE_MANIFEST_MISSING", message: `manifest is unreadable or invalid: ${String(error instanceof Error ? error.message : error)}` });
    }
  }

  for (const item of policy.items) {
    const artifactReports: CompositeArtifactReportV1[] = [];
    for (const key of item.artifactKeys) {
      const spec = policy.artifacts[key];
      if (!spec) {
        artifactReports.push({ key, path: "(undeclared)", binding: "versioned", sha256: "", status: "FAIL", failures: ["artifact key is not declared in the frozen policy"] });
        continue;
      }
      const artifactFailures: string[] = [];
      let sha256 = "";
      if (!manifest) {
        artifactFailures.push("evidence manifest unavailable");
      } else {
        const recorded = manifest.artifacts[key];
        if (typeof recorded !== "string" || !/^[0-9a-f]{64}$/.test(recorded)) {
          artifactFailures.push("manifest has no valid sha256 for this artifact");
        } else {
          sha256 = recorded;
          if (spec.binding === VERSIONED && spec.expectedSha256 !== recorded) {
            artifactFailures.push(`manifest sha256 ${recorded} does not match the frozen versioned digest ${String(spec.expectedSha256)}`);
          }
          const resolved = resolveArtifactPath(request.repoRoot, spec.path);
          if (!resolved.ok) {
            artifactFailures.push(resolved.reason);
          } else {
            try {
              const bytes = await readFile(resolved.absolute);
              const actual = sha256Hex(bytes);
              if (actual !== recorded) artifactFailures.push(`evidence is tampered or stale: file sha256 ${actual} does not match the manifest ${recorded}`);
              if (spec.binding === VERSIONED && spec.expectedSha256 !== actual) artifactFailures.push(`evidence is stale or tampered: file sha256 ${actual} does not match the frozen versioned digest ${String(spec.expectedSha256)}`);
              if (spec.assertions.length) {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(bytes.toString("utf8"));
                } catch (error) {
                  artifactFailures.push(`evidence is not valid JSON: ${String(error instanceof Error ? error.message : error)}`);
                  parsed = undefined;
                }
                if (parsed !== undefined) {
                  for (const assertion of spec.assertions) {
                    const failure = evaluateAssertion(parsed, assertion, request.candidateBuildDigest);
                    if (failure) artifactFailures.push(failure);
                  }
                }
              }
            } catch {
              artifactFailures.push(`evidence file is missing (${spec.path})`);
            }
          }
        }
      }
      artifactReports.push({ key, path: spec.path, binding: spec.binding, sha256, status: artifactFailures.length ? "FAIL" : "PASS", failures: artifactFailures });
      for (const message of artifactFailures) failures.push({ itemId: item.id, artifactKey: key, code: "COMPOSITE_EVIDENCE_FAILED", message });
    }
    itemReports.push({
      id: item.id,
      title: item.title,
      target: item.target,
      mechanism: item.mechanism,
      required: item.required,
      status: artifactReports.every((artifact) => artifact.status === "PASS") ? "PASS" : "FAIL",
      artifacts: artifactReports
    });
  }

  const requiredItems = itemReports.filter((item) => item.required);
  const passedItems = requiredItems.filter((item) => item.status === "PASS").length;
  const verifiedArtifacts = itemReports.flatMap((item) => item.artifacts).filter((artifact) => artifact.status === "PASS").length;
  const failedArtifacts = itemReports.flatMap((item) => item.artifacts).filter((artifact) => artifact.status === "FAIL").length;
  const allArtifacts = Object.values(policy.artifacts);

  return {
    version: 1,
    gateId: policy.id,
    policyId: policy.id,
    policyDigest,
    manifestPath: request.manifestPath,
    manifestSha256,
    candidateBuildDigest: request.candidateBuildDigest,
    generatedAt: request.generatedAt,
    readinessAuthority: "DETERMINISTIC_COMPOSITE",
    modelAuthority: "NONE",
    modelReadinessClaims: { received: claims.length, sources: claims.map((claim) => claim.source), evaluated: false },
    ready: passedItems === requiredItems.length,
    items: itemReports,
    failures,
    summary: {
      requiredItems: requiredItems.length,
      passedItems,
      failedItems: requiredItems.length - passedItems,
      verifiedArtifacts,
      failedArtifacts,
      versionedArtifacts: allArtifacts.filter((artifact) => artifact.binding === VERSIONED).length,
      runtimeArtifacts: allArtifacts.filter((artifact) => artifact.binding === RUNTIME).length
    }
  };
}
