import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Closure disposable self-modification campaign envelope (AEH-V2-0130 / AEH-V2-0135).
 *
 * Post-processes the S13 governed-operation lane artifact into the closure evidence artifact:
 * source checkout byte-identical, mutations confined to disposable roots, terminal acceptance,
 * and PRODUCT-owned terminal resource reconciliation (`resource-reconciliation.json`) with exact
 * operation/resource identity binding. No campaign-side archiving is involved.
 *
 * Usage: node tests/packed/closureCampaignEnvelope.mjs [checkout] [runId] [lane] [round]
 */

const checkout = path.resolve(process.argv[2] ?? process.cwd());
const runId = (process.argv[3] ?? process.env.CLOSURE_CAMPAIGN_RUN_ID ?? "closure-campaign-1").trim();
const lane = (process.argv[4] ?? process.env.CLOSURE_CAMPAIGN_LANE ?? "change-multifile").trim();
const round = Number(process.argv[5] ?? process.env.S13_ROUND ?? "25");
if (!/^[A-Za-z0-9-]{1,80}$/.test(runId)) throw new Error("runId must contain only letters, digits, and hyphens.");

const evidenceRoot = path.join(checkout, "docs", "evidence", "closure");
const rawRoot = path.join(evidenceRoot, "raw");
const sourceLanePath = path.join(checkout, "docs", "evidence", "s13", "governed-lanes", `round-${round}`, runId, `${lane}.json`);
const sourceSummaryPath = path.join(checkout, "docs", "evidence", "s13", `s13-governed-operations-round-${round}-${runId}.json`);
const rawLanePath = path.join(rawRoot, "disposable-campaign-lane.json");
const rawSummaryPath = path.join(rawRoot, "disposable-campaign-summary.json");
const envelopePath = path.join(evidenceRoot, "disposable-self-modification-campaign.json");

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function isUnder(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

const laneBytes = await fs.readFile(sourceLanePath);
const laneEvidence = JSON.parse(laneBytes.toString("utf8"));
const sourceLaneSha256 = sha256(laneBytes);

const fixtureRoot = typeof laneEvidence.fixtureRoot === "string" ? path.resolve(laneEvidence.fixtureRoot) : null;
const operationId = laneEvidence.operation?.id ?? laneEvidence.start?.operationId ?? null;

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return undefined; }
}

const operationRecord = fixtureRoot && operationId
  ? await readJson(path.join(fixtureRoot, ".harness", "operations", `${operationId}.json`))
  : undefined;
const receiptPath = fixtureRoot && operationId
  ? path.join(fixtureRoot, ".harness", "operations", operationId, "resource-reconciliation.json")
  : null;
const receiptBytes = receiptPath ? await fs.readFile(receiptPath).catch(() => undefined) : undefined;
const receipt = receiptBytes ? JSON.parse(receiptBytes.toString("utf8")) : undefined;

const registryPath = fixtureRoot && operationId
  ? path.join(fixtureRoot, ".harness", "operations", operationId, "resources.json")
  : null;
const registry = registryPath ? await readJson(registryPath) : undefined;
const registryByIdentity = new Map((registry?.resources ?? []).map((item) => [item.identity, item]));
const reconciledResources = (receipt?.dispositions ?? []).filter((item) => item.outcome === "reconciled");
const reconciledWorkspaces = reconciledResources
  .filter((item) => item.kind === "paseo-workspace")
  .map((item) => ({ ...item, path: registryByIdentity.get(item.identity)?.path ?? null, state: registryByIdentity.get(item.identity)?.state ?? null }));
const preservedUnproven = (receipt?.dispositions ?? []).filter((item) => item.classification === "UNKNOWN_OR_UNOWNED");
const productResourceReconciliation = {
  receipt: receiptPath ? path.relative(checkout, receiptPath) : null,
  receiptSha256: receiptBytes ? sha256(receiptBytes) : null,
  operationId: receipt?.operationId ?? null,
  operationStatus: receipt?.operationStatus ?? null,
  cleanupComplete: receipt?.cleanupComplete === true,
  candidateDigest: receipt?.candidateDigest ?? null,
  durableOperationStatus: operationRecord?.status ?? null,
  classification: receipt?.classification ?? null,
  dispositionCounts: {
    total: (receipt?.dispositions ?? []).length,
    reconciled: reconciledResources.length,
    alreadyReconciled: (receipt?.dispositions ?? []).filter((item) => item.alreadyReconciled === true).length,
    failed: (receipt?.errors ?? []).length
  },
  reconciledIdentities: reconciledResources.map((item) => ({ kind: item.kind, identity: item.identity, action: item.action })),
  errors: receipt?.errors ?? []
};
const productReconciliationPass = productResourceReconciliation.cleanupComplete
  && productResourceReconciliation.operationId === operationId
  && productResourceReconciliation.receiptSha256 !== null
  && productResourceReconciliation.classification?.liveOwned === 0
  && productResourceReconciliation.errors.length === 0;

const workspaceInventory = Array.isArray(laneEvidence.workspaceInventory) ? laneEvidence.workspaceInventory : [];
const observations = Array.isArray(laneEvidence.candidateWorkspaceObservations?.observations) ? laneEvidence.candidateWorkspaceObservations.observations : [];
const transitions = Array.isArray(laneEvidence.workspaceWatch?.transitions) ? laneEvidence.workspaceWatch.transitions : [];

const mutationRoots = [...new Set([
  ...workspaceInventory.map((workspace) => (typeof workspace.cwd === "string" ? path.resolve(workspace.cwd) : null)),
  ...observations.map((observation) => (typeof observation.root === "string" ? path.resolve(observation.root) : null)),
  ...transitions.map((transition) => (typeof transition.cwd === "string" ? path.resolve(transition.cwd) : null))
].filter(Boolean))];

const disposablePrefixes = [path.resolve(os.tmpdir()) + path.sep, path.join(os.homedir(), ".paseo", "worktrees") + path.sep];
const mutationRootsDisposable = mutationRoots.every((root) => disposablePrefixes.some((prefix) => root.startsWith(prefix)));
const checkoutOutsideMutationRoots = mutationRoots.every((root) => !isUnder(checkout, root));

const watchedChanges = transitions.flatMap((transition) => [
  ...(Array.isArray(transition.added) ? transition.added.map((entry) => ({ at: transition.at ?? null, cwd: transition.cwd ?? null, kind: "added", path: entry })) : []),
  ...(Array.isArray(transition.removed) ? transition.removed.map((entry) => ({ at: transition.at ?? null, cwd: transition.cwd ?? null, kind: "removed", path: entry })) : [])
]);
const changedPathsRepositoryRelative = watchedChanges.every((change) => typeof change.path === "string" && change.path.length > 0 && !path.isAbsolute(change.path) && !change.path.split("/").includes(".."));

// The product archives operation-owned workspaces at terminalization and removes the worktree;
// such an observation is accepted only when the product receipt proves that exact workspace
// was reconciled. Every other observation must still be a live MATCH.
const observationEvidence = observations.map((observation) => {
  if (observation.status === "MATCH") return { ...observation, accepted: true, acceptance: "live-match" };
  const productArchived = observation.status === "UNAVAILABLE" && reconciledWorkspaces.some((item) => item.identity === observation.root || item.identity === observation.workspaceId || (typeof observation.root === "string" && item.path === observation.root));
  return { ...observation, accepted: productArchived, acceptance: productArchived ? "product-archived" : "rejected" };
});
const candidateWorkspaceObservationsMatched = observationEvidence.length > 0 && observationEvidence.every((observation) => observation.accepted === true);

const workspaceCleanup = laneEvidence.workspaceCleanup ?? {};
const accounting = workspaceCleanup.accounting ?? null;
const publicEffects = laneEvidence.effects?.publicEffects ?? [];
const containmentChecks = {
  fixtureRoot,
  candidateWorktrees: observations.map((observation) => observation.root).filter(Boolean),
  mutationRoots,
  disposablePrefixes,
  checkoutOutsideMutationRoots,
  mutationRootsDisposable,
  changedPathsRepositoryRelative,
  candidateWorkspaceObservationsMatched,
  observationEvidence,
  productOwnedReconciliation: productReconciliationPass,
  watchedChanges: watchedChanges.slice(0, 200)
};
const cleanup = {
  accounting,
  remaining: workspaceCleanup.remaining ?? null,
  archivedByCampaign: Array.isArray(workspaceCleanup.archived) ? workspaceCleanup.archived.length : null,
  workspaceCleanupError: laneEvidence.workspaceCleanupError ?? null,
  leadAgentCleanup: laneEvidence.leadAgentCleanup ?? null,
  campaignSideCleanup: "NONE",
  productResourceReconciliation
};
const effects = {
  publicEffects,
  externalEffects: [],
  note: "The governed change lane performs controller-owned local assembly and delivery only; no public/external effect is requested or executed. Public-effect reconciliation is aggregated from the versioned S13 GitHub/journey lanes."
};

const result = laneEvidence.result === "PASS"
  && laneEvidence.terminalRecord?.status === "SUCCEEDED"
  && laneEvidence.checkoutProof?.checkoutUntouched === true
  && laneEvidence.operation?.result?.acceptanceOracle?.disposition === "ACCEPTED"
  && Boolean(fixtureRoot)
  && containmentChecks.mutationRootsDisposable
  && containmentChecks.checkoutOutsideMutationRoots
  && containmentChecks.changedPathsRepositoryRelative
  && containmentChecks.candidateWorkspaceObservationsMatched
  && productReconciliationPass
  && preservedUnproven.length === 0
  && accounting?.accounted === true
  && Array.isArray(accounting?.unaccounted) && accounting.unaccounted.length === 0
  && !laneEvidence.workspaceCleanupError
  ? "PASS"
  : "FAIL";

const envelope = {
  version: 1,
  slice: "closure",
  campaign: "disposable-self-modification",
  generatedAt: new Date().toISOString(),
  runId,
  lane,
  round,
  checkout,
  sourceCommit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).stdout.trim(),
  candidateBuildDigest: laneEvidence.candidateBinding?.packedBuild?.buildDigest ?? null,
  sourceLanePath: "docs/evidence/closure/raw/disposable-campaign-lane.json",
  sourceLaneSha256,
  sourceLane: laneEvidence,
  containment: containmentChecks,
  effects,
  cleanup,
  result
};

await fs.mkdir(rawRoot, { recursive: true });
await fs.writeFile(rawLanePath, laneBytes);
try { await fs.copyFile(sourceSummaryPath, rawSummaryPath); } catch { /* summary is optional provenance */ }
await fs.writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`);

const envelopeDigest = sha256(await fs.readFile(envelopePath));
console.log(JSON.stringify({
  result,
  envelope: path.relative(checkout, envelopePath),
  envelopeSha256: envelopeDigest,
  rawLaneSha256: sourceLaneSha256,
  candidateBuildDigest: envelope.candidateBuildDigest,
  productResourceReconciliation,
  containment: { fixtureRoot, mutationRootsDisposable, checkoutOutsideMutationRoots, changedPathsRepositoryRelative, candidateWorkspaceObservationsMatched },
  cleanup: { accounting, campaignSideCleanup: cleanup.campaignSideCleanup }
}, null, 2));
if (result !== "PASS") process.exitCode = 1;
