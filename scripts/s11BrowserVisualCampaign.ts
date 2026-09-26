import fs from "node:fs/promises";
import path from "node:path";
import { computeWorktreeDigest } from "../src/core/git.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { runExternalToolValidator } from "../src/validators/external.js";
import type { HarnessProjectConfig, TaskContract, ValidatorSpec } from "../src/core/types.js";
import {
  loadProviderLaneEvidenceV1,
  providerLaneEvidenceDirectory,
  verifyProviderLaneEvidenceV1,
  type ProviderEvidenceLaneV1
} from "../src/validation/laneEvidence.js";

const root = path.resolve(process.cwd());
const config: HarnessProjectConfig = { version: 1, project: { name: "aeh-self" }, evidence: { outputDir: ".harness/evidence" } };
const contract: TaskContract = { version: 1, task: { id: "S11-BROWSER-VISUAL", title: "S11 browser and visual campaign" } };
const playwright = path.join(root, "node_modules", ".bin", "playwright");
// The machine summary is runtime evidence output and stays inside the ignored
// evidence directory so the campaign never mutates the candidate source tree.
const summaryPath = path.join(root, ".harness", "evidence", "s11", "browser-visual-campaign.json");
const playwrightOutputRoot = path.join(root, ".harness", "evidence", "playwright-s11-output");
const visualBaseline = path.join(
  "tests", "browser", "s11-control-center-browser-visual.e2e.ts-snapshots",
  `s11-control-center-heading-chromium-${process.platform}.png`
);
const visualComparison = {
  tool: "playwright-toHaveScreenshot",
  name: "s11-control-center-heading.png",
  options: { animations: "disabled", maxDiffPixelRatio: 0.05 }
};

interface LaneRun {
  lane: ProviderEvidenceLaneV1;
  checkId: string;
  grep: string;
  referenceBaseline?: string;
  comparison?: typeof visualComparison;
}

const runs: LaneRun[] = [
  { lane: "BROWSER", checkId: "s11-browser-journey", grep: "S11 browser" },
  { lane: "VISUAL", checkId: "s11-visual-journey", grep: "S11 visual", referenceBaseline: visualBaseline, comparison: visualComparison }
];

interface LaneRecord {
  lane: ProviderEvidenceLaneV1;
  checkId: string;
  outputDirectory: string;
  command: string;
  status: string;
  message: string;
  blocker?: unknown;
  findingCount?: unknown;
  verified: boolean;
  verificationBlockers: string[];
  evidence?: {
    artifact: string;
    digest: string;
    provider: unknown;
    comparison?: unknown;
    commandDigest: string;
    workspaceSourceDigest: string;
    artifacts: Array<{ kind: string; path: string; digest: string; bytes: number; sanitized: boolean }>;
  };
}

async function releaseIdentity(): Promise<Record<string, unknown> | undefined> {
  try {
    const releaseId = (await fs.readFile(path.join(root, "dist", "current"), "utf8")).trim();
    const identity = JSON.parse(await fs.readFile(path.join(root, "dist", "releases", releaseId, "build-identity.json"), "utf8")) as Record<string, unknown>;
    return { releaseId, ...identity };
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const release = await releaseIdentity();
  if (!release) throw new Error("BROWSER_PROVIDER_UNAVAILABLE: no built candidate release exists (run `npm run build` first).");
  try {
    await fs.access(playwright);
  } catch {
    throw new Error("BROWSER_PROVIDER_UNAVAILABLE: the pinned candidate node_modules/.bin/playwright executable is absent.");
  }
  const sourceDigest = await computeWorktreeDigest(root);
  const candidate = createCandidateRevisionV1({ operationId: "OP-S11-BROWSER-VISUAL", candidateId: "CAND-S11-BROWSER-VISUAL", revision: 1, sourceDigest });
  const report: Record<string, unknown> = {
    slice: "S11",
    generatedAt: new Date().toISOString(),
    summaryKind: "machine",
    candidate: { candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest, sourceDigest },
    release,
    boundary: "real built candidate + real Control Center UI/server/controller + real Playwright Chromium through the candidate-bound validator path; the Paseo model conversation is the file-scripted deterministic boundary (BROWSER/VISUAL evidence, not REAL_PROVIDER certification)",
    runs: []
  };
  let failed = false;
  const records: LaneRecord[] = [];
  // Output directories are candidate-scoped so a later campaign run against a
  // different candidate cannot delete this candidate's screenshot artifacts.
  const candidateSegment = `${candidate.candidateId}-r${candidate.revision}-${candidate.identityDigest.slice(0, 12)}`;
  for (const run of runs) {
    const outputDirectory = path.join(playwrightOutputRoot, run.lane.toLowerCase(), candidateSegment);
    await fs.rm(providerLaneEvidenceDirectory(root, config, run.lane, candidate), { recursive: true, force: true });
    await fs.rm(outputDirectory, { recursive: true, force: true });
    const command = `${quote(playwright)} test --config tests/browser/playwright.config.ts --grep "${run.grep}" --output ${quote(outputDirectory)} --reporter=json`;
    const spec: ValidatorSpec = {
      id: run.checkId,
      adapter: run.lane === "BROWSER" ? "playwright" : "visual",
      required: true,
      timeoutSeconds: 900,
      command,
      options: {
        requireCandidateBoundEvidence: true,
        ...(run.referenceBaseline ? { referenceBaseline: run.referenceBaseline } : {}),
        ...(run.comparison ? { comparison: run.comparison } : {})
      }
    };
    const check = await runExternalToolValidator({ root, config, contract, spec, baseRef: "HEAD", changedFiles: [], candidate });
    const record: LaneRecord = {
      lane: run.lane,
      checkId: run.checkId,
      outputDirectory: path.relative(root, outputDirectory).replaceAll("\\", "/"),
      command,
      status: check.status,
      message: check.message,
      blocker: check.details?.blocker,
      findingCount: check.details?.findingCount,
      verified: false,
      verificationBlockers: []
    };
    if (check.status !== "PASS") failed = true;
    records.push(record);
    (report.runs as unknown[]).push(record);
  }
  // Post-campaign verification: both lanes must independently verify with all
  // artifacts present, recomputed digests, and a matching candidate/workspace
  // binding. The campaign fails if either lane is not ok.
  for (const run of runs) {
    const record = records.find((item) => item.lane === run.lane)!;
    const evidence = await loadProviderLaneEvidenceV1(root, config, run.lane, candidate, run.checkId);
    if (!evidence) {
      failed = true;
      record.status = "FAIL";
      record.message = `${run.lane} evidence is absent after the campaign.`;
      record.verificationBlockers = [`PROVIDER_LANE_EVIDENCE_REQUIRED: required ${run.lane} evidence '${run.checkId}' is absent after the full campaign.`];
      continue;
    }
    const verification = await verifyProviderLaneEvidenceV1(root, config, evidence, candidate);
    record.verified = verification.ok;
    record.verificationBlockers = verification.blockers;
    record.evidence = {
      artifact: evidence.artifact,
      digest: evidence.digest,
      provider: evidence.provider,
      ...(evidence.comparison ? { comparison: evidence.comparison } : {}),
      commandDigest: evidence.commandDigest,
      workspaceSourceDigest: evidence.workspace.observedSourceDigest,
      artifacts: evidence.artifacts.map((artifact) => ({ kind: artifact.kind, path: artifact.path, digest: artifact.digest, bytes: artifact.bytes, sanitized: artifact.sanitized }))
    };
    if (!verification.ok) {
      failed = true;
      record.status = "FAIL";
      record.message = `${run.lane} evidence failed post-campaign verification: ${verification.blockers.join("; ")}`;
    }
    if (!evidence.artifacts.some((artifact) => artifact.kind === "screenshot")) {
      failed = true;
      record.status = "FAIL";
      record.message = `${run.lane} evidence contains no screenshot artifact; visual/browser evidence must retain rendered artifacts.`;
      record.verificationBlockers = [...record.verificationBlockers, `${run.lane} evidence contains no screenshot artifact.`];
    }
  }
  // The campaign must not invalidate its own candidate: recompute the worktree
  // source digest before and after the summary write.
  const digestBeforeSummary = await computeWorktreeDigest(root);
  const stableBeforeSummary = digestBeforeSummary === sourceDigest;
  if (!stableBeforeSummary) failed = true;
  report.worktreeDigest = { candidateSourceDigest: sourceDigest, recomputedBeforeSummary: digestBeforeSummary, stableBeforeSummary };
  report.status = failed ? "FAIL" : "PASS";
  report.sanitized = true;
  report.credentialsCookiesCsrfHeadersAndNoncesPersisted = false;
  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  await fs.writeFile(summaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const digestAfterSummary = await computeWorktreeDigest(root);
  const stableAfterSummary = digestAfterSummary === sourceDigest;
  (report.worktreeDigest as Record<string, unknown>).recomputedAfterSummary = digestAfterSummary;
  (report.worktreeDigest as Record<string, unknown>).stableAfterSummary = stableAfterSummary;
  if (!stableAfterSummary) report.status = "FAIL";
  await fs.writeFile(summaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ status: report.status, summary: path.relative(root, summaryPath), runs: report.runs }, null, 2));
  if (report.status !== "PASS") process.exit(1);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
