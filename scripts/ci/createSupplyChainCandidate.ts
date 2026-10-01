import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { startDetachedOperation, executeOperation } from "../../src/operations/controller.js";
import { loadOperation } from "../../src/operations/state.js";
import { loadProjectConfig } from "../../src/core/config.js";
import { createControlPlaneSnapshot } from "../../src/core/controlPlane.js";
import { sealTask } from "../../src/core/seal.js";
import { buildRequirementEvidenceGraph } from "../../src/evidence/graph.js";
import type { AuditReport } from "../../src/audit/run.js";
import type { TaskContract, ValidationReport } from "../../src/core/types.js";
import { DETERMINISTIC_RUNTIME_ENV } from "../../src/paseo/deterministicRuntime.js";

const root = path.resolve(process.cwd());
const runnerTemp = process.env.RUNNER_TEMP ? path.resolve(process.env.RUNNER_TEMP) : undefined;
const workspace = process.env.GITHUB_WORKSPACE ? path.resolve(process.env.GITHUB_WORKSPACE) : undefined;
const gitRoot = path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim());
if (!runnerTemp || gitRoot !== root || root === workspace || !root.startsWith(runnerTemp + path.sep)) {
  throw new Error("SUPPLY_CHAIN_DISPOSABLE_WORKTREE_REQUIRED: controller-owned candidate fixture must run in a dedicated disposable Git worktree under RUNNER_TEMP.");
}
const config = await loadProjectConfig(root);
const artifactPath = config.provenance?.artifact;
if (!artifactPath || artifactPath !== process.env.AEH_PACKED_ARTIFACT) {
  throw new Error("SUPPLY_CHAIN_ARTIFACT_POLICY_MISMATCH: the fixture environment and project policy must name the same packed artifact.");
}
const artifactFile = path.resolve(root, artifactPath);
const artifactHash = await sha256File(artifactFile);
const artifactStat = await fs.stat(artifactFile);
if (!artifactStat.isFile() || artifactStat.size === 0) throw new Error("SUPPLY_CHAIN_ARTIFACT_REQUIRED: the packed candidate must be a non-empty file.");

const previousDeterministicRuntime = process.env[DETERMINISTIC_RUNTIME_ENV];
process.env[DETERMINISTIC_RUNTIME_ENV] = "1";
try {
  const queued = await startDetachedOperation(root, "audit", {
    request: "Verify packed candidate " + artifactPath + " exists with its recorded SHA-256.",
    files: ["dist/main.js"],
    risk: "low"
  }, {
    nodeExecutable: process.execPath,
    entryFile: path.join(root, "dist", "main.js"),
    spawnProcess: (() => ({ pid: process.pid, unref: () => undefined }) as never) as never
  });

  const final = await executeOperation(root, queued.id, {
    startWatchdog: () => () => undefined,
    runAudit: async (executionRoot, executionConfig, input) => {
      const taskId = input.auditId ?? queued.id;
      if (taskId !== queued.id) throw new Error("SUPPLY_CHAIN_TASK_ID_MISMATCH: audit identity changed inside the controller.");
      const current = await loadOperation(root, queued.id);
      if (!current.candidateRevision) throw new Error("SUPPLY_CHAIN_CANDIDATE_REQUIRED: controller did not issue a current CandidateRevision.");

      const specPath = path.posix.join(".harness", "supply-chain", taskId + ".md");
      const contract: TaskContract = {
        version: 1,
        task: { id: taskId, title: "CI packed-artifact identity fixture" },
        source: { spec: specPath },
        scope: { allowed: ["dist/**", artifactPath, specPath] },
        routing: {
          intent: "verify packed candidate identity",
          route: "DELEGATED",
          assurance: "STANDARD",
          routeEvidence: [{ route: "DELEGATED", source: "supply-chain-fixture", statement: "The controller owns this read-only packed-artifact identity audit." }]
        },
        requirements: [{ id: "PACKED-ARTIFACT", description: "The packed candidate exists with a recorded SHA-256.", validators: ["packed-artifact-integrity"] }]
      };
      const specFile = path.join(root, contract.source!.spec!);
      await fs.mkdir(path.dirname(specFile), { recursive: true });
      await fs.writeFile(specFile, "# Packed candidate identity\n\nThe packed deliverable is " + artifactPath + " with SHA-256 " + artifactHash + ".\n");
      const contractFile = path.resolve(root, executionConfig.sdd?.contractsDir ?? ".harness/contracts", taskId + ".yaml");
      await fs.mkdir(path.dirname(contractFile), { recursive: true });
      await fs.writeFile(contractFile, YAML.stringify(contract));
      await sealTask(root, executionConfig, contract);

      const startedAt = new Date().toISOString();
      const check = {
        id: "packed-artifact-integrity",
        category: "supply-chain",
        status: "PASS" as const,
        message: "Packed candidate " + artifactPath + " is a non-empty file with SHA-256 " + artifactHash + ".",
        details: { artifact: artifactPath, sha256: artifactHash, size: artifactStat.size }
      };
      const report: ValidationReport = {
        version: 1,
        taskId,
        status: "PASS",
        startedAt,
        finishedAt: new Date().toISOString(),
        checks: [check],
        changedFiles: ["dist/main.js"],
        candidate: current.candidateRevision,
        metadata: { project: executionConfig.project.name, baseRef: executionConfig.validation?.baseRef ?? "HEAD" }
      };
      const reportFile = path.resolve(root, executionConfig.sdd?.reportsDir ?? ".harness/reports", taskId + ".json");
      await fs.mkdir(path.dirname(reportFile), { recursive: true });
      await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");

      const evidence = await buildRequirementEvidenceGraph({ root, config: executionConfig, contract, report });
      if (!evidence.complete) throw new Error("SUPPLY_CHAIN_EVIDENCE_INCOMPLETE: " + evidence.reasons.join("; "));
      const controlPlane = await createControlPlaneSnapshot(root, executionConfig, taskId);
      const auditReport = createAuditReport({ root, taskId, request: input.request, check });
      const auditFile = path.resolve(root, ".harness/audits", taskId + ".json");
      await fs.mkdir(path.dirname(auditFile), { recursive: true });
      await fs.writeFile(auditFile, JSON.stringify(auditReport, null, 2) + "\n");

      const runFile = path.resolve(root, executionConfig.sdd?.runsDir ?? ".harness/runs", taskId + ".json");
      await fs.mkdir(path.dirname(runFile), { recursive: true });
      await fs.writeFile(runFile, JSON.stringify({
        version: 1,
        taskId,
        operationId: queued.id,
        status: "PASS",
        report: path.relative(root, reportFile).replaceAll(path.sep, "/"),
        evidence: { complete: evidence.complete, sha256: evidence.sha256 },
        controlPlane: { sha256: controlPlane.compositeSha256 },
        packageArtifact: { path: artifactPath, sha256: artifactHash }
      }, null, 2) + "\n");
      return auditReport;
    }
  });

  if (final.status !== "SUCCEEDED") throw new Error("SUPPLY_CHAIN_CANDIDATE_OPERATION_FAILED: " + final.status + ": " + (final.error ?? "unknown failure"));
  const envFile = process.env.GITHUB_ENV;
  if (envFile) await fs.appendFile(envFile, "AEH_SUPPLY_TASK_ID=" + queued.id + "\n");
  process.stdout.write(JSON.stringify({ status: final.status, taskId: queued.id, candidate: final.candidateRevision?.identityDigest, artifact: artifactPath, artifactSha256: artifactHash }) + "\n");
} finally {
  if (previousDeterministicRuntime === undefined) delete process.env[DETERMINISTIC_RUNTIME_ENV];
  else process.env[DETERMINISTIC_RUNTIME_ENV] = previousDeterministicRuntime;
}

function createAuditReport(input: { root: string; taskId: string; request: string; check: ValidationReport["checks"][number] }): AuditReport {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, note: 0 };
  const now = new Date().toISOString();
  const dirtyPaths = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: input.root, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
  return {
    version: 1,
    auditId: input.taskId,
    intent: "audit",
    request: input.request,
    status: "CLEAN",
    startedAt: now,
    finishedAt: now,
    repository: { root: input.root, baseRef: "HEAD", dirtyPaths },
    reviewers: ["deterministic-artifact-integrity-check"],
    validationChecks: [{ ...input.check, failureClass: "NONE" }],
    findings: [],
    counts,
    debtPoints: 0,
    debtScore: 0,
    qualityGate: { pass: true, reasons: [], counts, debtPoints: 0, debtScore: 0 },
    productionSafe: false,
    sessions: [],
    restoredPaths: []
  };
}

async function sha256File(file: string): Promise<string> {
  const content = await fs.readFile(file);
  return crypto.createHash("sha256").update(content).digest("hex");
}
