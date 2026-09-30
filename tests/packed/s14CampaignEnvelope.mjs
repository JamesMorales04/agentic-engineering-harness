import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * S14 disposable self-modification campaign envelope.
 *
 * Post-processes the S13 governed-operation lane artifact for an S14 run into the S14 evidence
 * artifact consumed by the self-hosting composite gate:
 *
 *   node tests/packed/s14CampaignEnvelope.mjs [checkout] [runId] [lane] [round]
 *
 * Defaults: checkout=cwd, runId=s14-campaign-1, lane=change-multifile, round=14.
 */

const checkout = path.resolve(process.argv[2] ?? process.cwd());
const runId = (process.argv[3] ?? process.env.S14_CAMPAIGN_RUN_ID ?? "s14-campaign-1").trim();
const lane = (process.argv[4] ?? process.env.S14_CAMPAIGN_LANE ?? "change-multifile").trim();
const round = Number(process.argv[5] ?? process.env.S13_ROUND ?? "14");
if (!/^[A-Za-z0-9-]{1,80}$/.test(runId)) throw new Error("runId must contain only letters, digits, and hyphens.");

const evidenceRoot = path.join(checkout, "docs", "evidence", "s14");
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

const workspaceInventory = Array.isArray(laneEvidence.workspaceInventory) ? laneEvidence.workspaceInventory : [];
const observations = Array.isArray(laneEvidence.candidateWorkspaceObservations?.observations) ? laneEvidence.candidateWorkspaceObservations.observations : [];
const transitions = Array.isArray(laneEvidence.workspaceWatch?.transitions) ? laneEvidence.workspaceWatch.transitions : [];

const fixtureRoots = workspaceInventory
  .filter((workspace) => /^lane-.*-fixture$/.test(String(workspace.project ?? "")) && typeof workspace.cwd === "string")
  .map((workspace) => path.resolve(workspace.cwd));
const fixtureRoot = fixtureRoots[0] ?? null;

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
const candidateWorkspaceObservationsMatched = observations.length > 0 && observations.every((observation) => observation.status === "MATCH");

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
  watchedChanges: watchedChanges.slice(0, 200)
};
const cleanup = {
  accounting,
  remaining: workspaceCleanup.remaining ?? null,
  archived: Array.isArray(workspaceCleanup.archived) ? workspaceCleanup.archived.length : null,
  workspaceCleanupError: laneEvidence.workspaceCleanupError ?? null,
  leadAgentCleanup: laneEvidence.leadAgentCleanup ?? null,
  postCampaignOperationRead: laneEvidence.postCampaignOperationRead ?? null
};
const effects = {
  publicEffects,
  externalEffects: [],
  note: "The governed change lane performs controller-owned local assembly and delivery only; no public/external effect is requested or executed. Public-effect reconciliation is aggregated from the versioned S13 GitHub/journey lanes."
};

const result = laneEvidence.result === "PASS"
  && laneEvidence.terminalRecord?.status === "SUCCEEDED"
  && laneEvidence.checkoutProof?.checkoutUntouched === true
  && Boolean(fixtureRoot)
  && containmentChecks.mutationRootsDisposable
  && containmentChecks.checkoutOutsideMutationRoots
  && containmentChecks.changedPathsRepositoryRelative
  && containmentChecks.candidateWorkspaceObservationsMatched
  && accounting?.accounted === true
  && Array.isArray(accounting?.unaccounted) && accounting.unaccounted.length === 0
  && !laneEvidence.workspaceCleanupError
  ? "PASS"
  : "FAIL";

const envelope = {
  version: 1,
  slice: "S14",
  campaign: "disposable-self-modification",
  generatedAt: new Date().toISOString(),
  runId,
  lane,
  round,
  checkout,
  sourceCommit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).stdout.trim(),
  candidateBuildDigest: laneEvidence.candidateBinding?.packedBuild?.buildDigest ?? null,
  sourceLanePath: "docs/evidence/s14/raw/disposable-campaign-lane.json",
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
  rawLane: path.relative(checkout, rawLanePath),
  rawLaneSha256: sourceLaneSha256,
  candidateBuildDigest: envelope.candidateBuildDigest,
  containment: { fixtureRoot, mutationRoots: mutationRoots.length, mutationRootsDisposable, checkoutOutsideMutationRoots, changedPathsRepositoryRelative },
  cleanup: { accounting, workspaceCleanupError: cleanup.workspaceCleanupError }
}, null, 2));
if (result !== "PASS") process.exitCode = 1;
