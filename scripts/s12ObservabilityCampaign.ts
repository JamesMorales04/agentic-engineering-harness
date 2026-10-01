import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { getBuildIdentity } from "../src/build/identity.js";
import { sha256Canonical } from "../src/core/digest.js";
import { loadCurrentAcceptanceOracleArtifactV1, requireAcceptedCurrentOracleV1 } from "../src/architecture/acceptanceOracle.js";
import { compileResolvedOperationPolicy, type ExecutionBindingV2 } from "../src/architecture/executionIdentity.js";
import { resolveImplementationRoute } from "../src/agents/routingV2.js";
import { scanAdvisoryInvariantV1 } from "../src/evals/advisoryInvariant.js";
import { computeEvalCorpusIdentity, runEvalCase } from "../src/evals/runner.js";
import { evalResultComparableV1 } from "../src/evals/scoring.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import {
  bindOperationParticipantExecution,
  bindResolvedOperationPolicy,
  claimControllerEpoch,
  loadOperation,
  registerOperationAgent,
  saveOperation,
  type OperationRecord
} from "../src/operations/state.js";
import { readTelemetryEvents, recordEvent } from "../src/telemetry/events.js";
import { deriveTelemetryCorrelation, telemetryCorrelationDigest, verifyTelemetryCorrelation } from "../src/telemetry/identity.js";
import {
  REQUIRED_METRIC_NAMES,
  flushTelemetryMetrics,
  metricsSnapshotDigest,
  readMetricSnapshots,
  recordOperationTelemetry,
  recordParticipantTelemetry,
  recordRuntimeSessionTelemetry,
  recordValidationTelemetry,
  resetTelemetryMetrics
} from "../src/telemetry/metrics.js";
import { resetTracing } from "../src/telemetry/tracing.js";
import { startOtlpReceiver } from "../tests/helpers/otlpReceiver.js";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(process.cwd());
const OPERATION_ID = "CHANGE-S12-CAMPAIGN";
const TASK_ID = "S12-CAMPAIGN";
const PARTICIPANT_ID = "participant:s12-campaign";
const OUTPUT = path.join(REPO_ROOT, "docs", "evidence", "s12", "s12-observability-evals-campaign.json");
const OPERATION_ENV_KEYS = ["AEH_OPERATION_ID", "AEH_OPERATION_KIND", "AEH_OPERATION_WORKSPACE_ID", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT", "AEH_CONTROLLER_EPOCH", "AEH_CONTROLLER_TOKEN"] as const;

interface CampaignArtifact {
  version: 1;
  campaign: string;
  slice: string;
  generatedAt: string;
  status: "PASS" | "FAIL";
  mechanism: "DETERMINISTIC";
  build: Record<string, unknown>;
  builtRelease: Record<string, unknown> | null;
  sourceCheckout: Record<string, unknown>;
  scenario: Record<string, unknown>;
  traces: Record<string, unknown>;
  metrics: Record<string, unknown>;
  otlp: Record<string, unknown>;
  evals: Record<string, unknown>;
  advisoryInvariant: Record<string, unknown>;
  reproducibility: Record<string, unknown>;
  limits: string[];
  reproduce: Record<string, string>;
}

async function main(): Promise<CampaignArtifact> {
  const previousEnvironment = Object.fromEntries(OPERATION_ENV_KEYS.map((key) => [key, process.env[key]]));
  // Stable, repo-relative ignored roots. Candidate identity binds the source
  // root path, so a random mkdtemp root would make candidate/policy/correlation
  // and canonical metric digests differ across independent executions. A fixed
  // logical scenario root keeps real filesystem execution while making the
  // documented reproduce command canonical and cross-execution reproducible.
  const workRoot = path.join(REPO_ROOT, ".harness", "s12-campaign-scenario");
  const evalRoot = path.join(REPO_ROOT, ".harness", "s12-campaign-evals");
  await fs.rm(workRoot, { recursive: true, force: true });
  await fs.rm(evalRoot, { recursive: true, force: true });
  await fs.mkdir(workRoot, { recursive: true });
  try {
    const build = getBuildIdentity();
    const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    const dirtyEntries = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean);

    process.env.AEH_OPERATION_ID = OPERATION_ID;
    process.env.AEH_CONTROL_ROOT = workRoot;
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    await saveOperation(workRoot, seedRecord(workRoot, OPERATION_ID));
    const owned = await claimControllerEpoch(workRoot, OPERATION_ID, "controller:s12-campaign", { pid: process.pid });
    const candidate = owned.candidateRevision!;
    await bindResolvedOperationPolicy(workRoot, OPERATION_ID, compileResolvedOperationPolicy({
      projectId: candidate.projectId ?? "project:s12-campaign",
      operationId: OPERATION_ID,
      operationExecutionRevision: owned.operationExecutionRevision!,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      controllerEpoch: owned.controller?.epoch ?? 1,
      intent: "S12 observability campaign",
      route: "DIRECT",
      minimumAssurance: "STANDARD",
      policyVersions: {},
      policyDigests: {},
      validationPolicy: {},
      reviewPolicy: {},
      deliveryPolicy: {},
      knowledgePolicy: {},
      contextPolicy: {},
      allowedExternalEffects: [],
      humanDecisionRequirements: []
    }));
    await registerOperationAgent(workRoot, OPERATION_ID, { id: PARTICIPANT_ID, role: "Implementer", phase: "execution", transport: "paseo" });
    await bindOperationParticipantExecution(workRoot, OPERATION_ID, {
      participantId: PARTICIPANT_ID,
      logicalAgent: "Implementer",
      role: "Implementer",
      binding: participantBinding(await loadOperation(workRoot, OPERATION_ID))
    });
    const operation = await loadOperation(workRoot, OPERATION_ID);
    const baseCorrelation = deriveTelemetryCorrelation(operation)!;
    const participantCorrelation = deriveTelemetryCorrelation(operation, { participantId: PARTICIPANT_ID })!;
    const baseCorrelationDigest = telemetryCorrelationDigest(baseCorrelation);
    const correlationDigest = telemetryCorrelationDigest(participantCorrelation);

    const localConfig: HarnessProjectConfig = {
      version: 1,
      project: { name: "s12-campaign" },
      telemetry: { enabled: true, localEventsFile: ".harness/telemetry/events.ndjson", localMetricsFile: ".harness/telemetry/metrics.ndjson" }
    };

    await recordEvent(workRoot, localConfig, "harness.run.start", { taskId: TASK_ID, route: "DIRECT" });
    await recordEvent(workRoot, localConfig, "harness.agent.participant.started", { operationId: OPERATION_ID, participantId: PARTICIPANT_ID, taskId: TASK_ID, transport: "paseo" });
    await recordEvent(workRoot, localConfig, "harness.verify.finish", { taskId: TASK_ID, status: "PASS" });
    const stale = { ...baseCorrelation, candidateRevision: baseCorrelation.candidateRevision + 1, candidateIdentityDigest: "0".repeat(64) };
    await recordEvent(workRoot, localConfig, "harness.adversarial.stale-identity", { taskId: TASK_ID }, stale);
    await recordEvent(workRoot, localConfig, "harness.run.finish", { taskId: TASK_ID, status: "PASS" });
    const events = await readTelemetryEvents(workRoot, localConfig);
    const boundEvents = events.filter((event) => {
      const expected = event.identity?.participantId ? participantCorrelation : baseCorrelation;
      return verifyTelemetryCorrelation(event.identity, expected).ok;
    });
    const staleEvent = events.find((event) => event.name === "harness.adversarial.stale-identity");
    const traceIds = [...new Set(boundEvents.map((event) => event.traceId))];
    if (boundEvents.length !== events.length || !staleEvent?.identityViolation || staleEvent.identityViolation.kind !== "TELEMETRY_IDENTITY_MISMATCH") {
      throw new Error(`S12_CAMPAIGN_TRACE_IDENTITY_FAILED: bound=${boundEvents.length} total=${events.length} stale=${staleEvent?.identityViolation?.kind}`);
    }

    const recordScenario = async (): Promise<void> => {
      const current = deriveTelemetryCorrelation(await loadOperation(workRoot, OPERATION_ID), { participantId: PARTICIPANT_ID })!;
      await recordOperationTelemetry(workRoot, localConfig, current, { kind: "run", route: "DIRECT", assurance: "STANDARD", status: "SUCCEEDED", durationMs: 3000, repairCount: 1, humanInterventions: 0 });
      await recordParticipantTelemetry(workRoot, localConfig, current, { event: "launch", transport: "paseo" });
      await recordParticipantTelemetry(workRoot, localConfig, current, { event: "result", transport: "paseo", status: "COMPLETED", durationMs: 1500 });
      await recordRuntimeSessionTelemetry(workRoot, localConfig, current, "materialized");
      await recordRuntimeSessionTelemetry(workRoot, localConfig, current, "reused");
      await recordRuntimeSessionTelemetry(workRoot, localConfig, current, "rotated");
      await recordValidationTelemetry(workRoot, localConfig, current, { status: "PASS", durationMs: 250 });
      await flushTelemetryMetrics(workRoot);
    };
    await recordScenario();
    const metricsA = (await readMetricSnapshots(workRoot, localConfig)).at(-1)!;
    resetTelemetryMetrics();
    await fs.rm(path.resolve(workRoot, ".harness/telemetry/metrics.ndjson"), { force: true });
    await recordScenario();
    const metricsB = (await readMetricSnapshots(workRoot, localConfig)).at(-1)!;
    const metricNames = metricsB.scopes.flatMap((scope) => scope.metrics.map((metric) => metric.name));
    const missingMetrics = REQUIRED_METRIC_NAMES.filter((name) => !metricNames.includes(name));
    if (missingMetrics.length > 0) throw new Error(`S12_CAMPAIGN_METRICS_MISSING: ${missingMetrics.join(", ")}`);
    const metricsReproducible = metricsSnapshotDigest(metricsA) === metricsSnapshotDigest(metricsB);
    if (!metricsReproducible) throw new Error("S12_CAMPAIGN_METRICS_NOT_REPRODUCIBLE");
    const operationCountPoint = metricsB.scopes.flatMap((scope) => scope.metrics).find((metric) => metric.name === "aeh.operation.count")!.points[0]!;

    const receiver = await startOtlpReceiver();
    let otlp: Record<string, unknown>;
    try {
      const otlpConfig: HarnessProjectConfig = { ...localConfig, telemetry: { ...localConfig.telemetry, exporter: "otlp-http-json", endpoint: receiver.endpoint, serviceName: "aeh-s12-campaign" } };
      await recordEvent(workRoot, otlpConfig, "harness.run.start", { taskId: TASK_ID, route: "DIRECT" });
      await recordEvent(workRoot, otlpConfig, "harness.verify.finish", { taskId: TASK_ID, status: "PASS" });
      await recordEvent(workRoot, otlpConfig, "harness.run.finish", { taskId: TASK_ID, status: "PASS" });
      const spans = receiver.spans();
      const operationSpan = spans.find((span) => span.name === "aeh.operation");
      const verifySpan = spans.find((span) => span.name === "harness.verify.finish");
      const otlpDigest = verifySpan?.attributes["aeh.telemetry.correlation.digest"];
      if (!operationSpan || !verifySpan || otlpDigest !== baseCorrelationDigest || verifySpan.traceId !== operationSpan.traceId) {
        throw new Error(`S12_CAMPAIGN_OTLP_CORRELATION_FAILED: digest=${String(otlpDigest)} expected=${baseCorrelationDigest}`);
      }
      otlp = {
        lane: "LOCAL_OTLP_HTTP",
        receiver: "127.0.0.1 ephemeral loopback",
        requestCount: receiver.requests.length,
        requestPath: receiver.requests[0]?.path,
        contentType: receiver.requests[0]?.contentType,
        resourceAttributes: receiver.resourceAttributes()[0],
        spanNames: spans.map((span) => span.name).sort(),
        traceIdsStable: new Set(spans.map((span) => span.traceId)).size === 1,
        correlationDigestMatched: true
      };
    } finally {
      await receiver.close();
      resetTracing();
    }

    await fs.cp(path.join(REPO_ROOT, "evals", "corpus"), path.join(evalRoot, "evals", "corpus"), { recursive: true });
    await fs.cp(path.join(REPO_ROOT, "evals", "fixtures"), path.join(evalRoot, "evals", "fixtures"), { recursive: true });
    await fs.cp(path.join(REPO_ROOT, "evals", "scenarios"), path.join(evalRoot, "evals", "scenarios"), { recursive: true });
    await run("git", ["init", "-q"], { cwd: evalRoot });
    await run("git", ["config", "user.email", "aeh@example.invalid"], { cwd: evalRoot });
    await run("git", ["config", "user.name", "AEH S12 Campaign"], { cwd: evalRoot });
    await run("git", ["add", "-A"], { cwd: evalRoot });
    await run("git", ["commit", "-qm", "S12 corpus fixture"], { cwd: evalRoot });
    const evalConfig: HarnessProjectConfig = {
      version: 1,
      project: { name: "s12-campaign-evals" },
      telemetry: { enabled: false },
      evals: { corpusDir: path.join(evalRoot, "evals", "corpus"), resultsDir: path.join(evalRoot, ".harness", "evals", "results"), workspacesDir: path.join(evalRoot, ".harness", "evals", "workspaces") }
    };
    const corpus = await computeEvalCorpusIdentity(REPO_ROOT, { version: 1, project: { name: "aeh" }, evals: { corpusDir: "evals/corpus" } });
    const cases: Array<Record<string, unknown>> = [];
    for (const caseId of ["validation-gated-change", "validation-fails-closed", "scope-governance", "context-budget-projection", "quality-convergence-thresholds"]) {
      const result = await runEvalCase(evalRoot, evalConfig, caseId);
      cases.push({
        id: result.caseId,
        domain: result.corpus ? (await caseDomain(evalRoot, evalConfig, caseId)) : undefined,
        status: result.status,
        score: result.score,
        scoreBreakdown: result.scoreBreakdown,
        corpusDigest: result.corpus?.digest,
        caseDigest: result.corpus?.caseDigest
      });
    }
    const firstRepeat = await runEvalCase(evalRoot, evalConfig, "scope-governance");
    const secondRepeat = await runEvalCase(evalRoot, evalConfig, "scope-governance");
    const evalsReproducible = JSON.stringify(evalResultComparableV1(firstRepeat)) === JSON.stringify(evalResultComparableV1(secondRepeat));

    const staticViolations = await scanAdvisoryInvariantV1(REPO_ROOT);
    const operationBytesBefore = await fs.readFile(path.join(workRoot, ".harness", "operations", `${OPERATION_ID}.json`), "utf8");
    const routingBefore = resolveImplementationRoute({ intent: "implement", expectedWorkUnits: 4, risk: "high", publicContractImpact: true, scopeConfidence: "low", files: ["src/api.ts"] });
    await fs.mkdir(path.join(workRoot, ".harness", "evals", "results", "forged"), { recursive: true });
    await fs.writeFile(path.join(workRoot, ".harness", "evals", "results", "forged", "forged.json"), JSON.stringify({ status: "PASS", score: 100, disposition: { disposition: "ACCEPTED" } }));
    const acceptanceArtifact = await loadCurrentAcceptanceOracleArtifactV1(workRoot, operation);
    let acceptanceRejected = false;
    try {
      await requireAcceptedCurrentOracleV1(workRoot, operation, operation.candidateRevision!);
    } catch (error) {
      acceptanceRejected = String(error).includes("ACCEPTANCE_ORACLE_REQUIRED");
    }
    const operationBytesAfter = await fs.readFile(path.join(workRoot, ".harness", "operations", `${OPERATION_ID}.json`), "utf8");
    const routingAfter = resolveImplementationRoute({ intent: "implement", expectedWorkUnits: 4, risk: "high", publicContractImpact: true, scopeConfidence: "low", files: ["src/api.ts"] });
    if (staticViolations.length > 0 || acceptanceArtifact !== undefined || !acceptanceRejected || operationBytesBefore !== operationBytesAfter || JSON.stringify(routingBefore) !== JSON.stringify(routingAfter)) {
      throw new Error("S12_CAMPAIGN_ADVISORY_INVARIANT_FAILED");
    }

    const artifact: CampaignArtifact = {
      version: 1,
      campaign: "s12-observability-evals",
      slice: "S12",
      generatedAt: new Date().toISOString(),
      status: "PASS",
      mechanism: "DETERMINISTIC",
      build: { releaseId: build.releaseId, packageVersion: build.packageVersion, gitSha: build.gitSha, buildDigest: build.buildDigest, dirty: build.dirty },
      builtRelease: await readBuiltReleaseIdentity(),
      sourceCheckout: { gitHead, worktreeDirty: dirtyEntries.length > 0, dirtyEntryCount: dirtyEntries.length },
      scenario: {
        operationId: OPERATION_ID,
        taskId: TASK_ID,
        root: ".harness/s12-campaign-scenario",
        candidate: { candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest, sourceDigest: candidate.sourceDigest },
        operationExecutionRevision: operation.operationExecutionRevision,
        policyDigest: operation.resolvedOperationPolicy?.digest,
        controllerEpoch: operation.controller?.epoch,
        participant: { participantId: participantCorrelation.participantId, generation: participantCorrelation.participantGeneration, runtimeName: participantCorrelation.runtimeName, runtimeSessionId: participantCorrelation.runtimeSessionId },
        correlationDigest,
        baseCorrelationDigest
      },
      traces: {
        lane: "SYSTEM_DETERMINISTIC",
        localEventsFile: ".harness/telemetry/events.ndjson",
        eventCount: events.length,
        identityBoundEventCount: boundEvents.length,
        traceIds,
        traceIdStable: traceIds.length === 1,
        staleIdentity: { detected: true, kind: staleEvent.identityViolation.kind, suppliedDigest: staleEvent.identityViolation.suppliedDigest, currentDigest: staleEvent.identityViolation.currentDigest }
      },
      metrics: {
        lane: "SYSTEM_DETERMINISTIC",
        instruments: [...REQUIRED_METRIC_NAMES],
        snapshotDigestRunA: metricsSnapshotDigest(metricsA),
        snapshotDigestRunB: metricsSnapshotDigest(metricsB),
        reproducible: metricsReproducible,
        sampleOperationPoint: operationCountPoint
      },
      otlp,
      evals: {
        corpusId: corpus?.corpusId,
        corpusVersion: corpus?.corpusVersion,
        corpusDigest: corpus?.digest,
        cases,
        reproducible: evalsReproducible,
        advisory: true
      },
      advisoryInvariant: {
        staticViolations,
        authorityModulesChecked: 16,
        acceptanceArtifactInjectedByEval: acceptanceArtifact !== undefined,
        acceptanceStillRequired: acceptanceRejected,
        durableOperationBytesUnchanged: operationBytesBefore === operationBytesAfter,
        routingDecisionUnchanged: JSON.stringify(routingBefore) === JSON.stringify(routingAfter),
        behavioralEvidence: "tests/evals/advisoryInvariant.test.ts"
      },
      reproducibility: {
        canonicalMetricSnapshotDigest: metricsSnapshotDigest(metricsB),
        intraProcessPassDigestsEqual: metricsReproducible,
        stableScenarioRoot: ".harness/s12-campaign-scenario",
        identityBindingNote: "The scenario root is a fixed repo-relative ignored path, so candidate/project/policy/correlation identity and the canonical metric snapshot digest are identical across independent executions of the documented command.",
        crossExecutionCommand: "npx tsx scripts/s12ObservabilityCampaign.ts",
        crossExecutionFields: ["scenario.candidate.identityDigest", "scenario.policyDigest", "scenario.correlationDigest", "scenario.baseCorrelationDigest", "reproducibility.canonicalMetricSnapshotDigest", "evals.corpusDigest"]
      },
      limits: [
        "No REAL_PROVIDER claim: the OTLP receiver is a local loopback process, not a hosted collector or model provider.",
        "Eval and telemetry output is advisory observation only and is never consumed by policy, authority, acceptance, permissions, or routing.",
        "The campaign exercises production deterministic telemetry and eval entry points; it is SYSTEM_DETERMINISTIC evidence, not PACKED_E2E or BROWSER evidence."
      ],
      reproduce: {
        command: "npx tsx scripts/s12ObservabilityCampaign.ts",
        output: "docs/evidence/s12/s12-observability-evals-campaign.json",
        focusedTests: "npx vitest run tests/telemetry tests/evals"
      }
    };
    await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
    await fs.writeFile(OUTPUT, `${JSON.stringify(artifact, null, 2)}\n`);
    return artifact;
  } finally {
    resetTelemetryMetrics();
    resetTracing();
    for (const key of OPERATION_ENV_KEYS) {
      const value = previousEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(workRoot, { recursive: true, force: true });
    await fs.rm(evalRoot, { recursive: true, force: true });
  }
}

/** Current built release identity selected by dist/current, when a build exists. */
async function readBuiltReleaseIdentity(): Promise<Record<string, unknown> | null> {
  try {
    const releaseId = (await fs.readFile(path.join(REPO_ROOT, "dist", "current"), "utf8")).trim();
    const identity = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "dist", "releases", releaseId, "build-identity.json"), "utf8")) as Record<string, unknown>;
    return { releaseId, packageVersion: identity.packageVersion, gitSha: identity.gitSha, buildDigest: identity.buildDigest, dirty: identity.dirty };
  } catch {
    return null;
  }
}

async function caseDomain(root: string, config: HarnessProjectConfig, caseId: string): Promise<string | undefined> {
  const YAML = await import("yaml");
  const file = path.resolve(root, config.evals?.corpusDir ?? "evals/corpus", caseId, "eval.yaml");
  const parsed = YAML.parse(await fs.readFile(file, "utf8")) as { domain?: string };
  return parsed.domain;
}

function participantBinding(owned: Awaited<ReturnType<typeof loadOperation>>): ExecutionBindingV2 {
  const candidate = owned.candidateRevision!;
  const body: Omit<ExecutionBindingV2, "digest"> = {
    version: 2,
    operationId: owned.id,
    operationExecutionRevision: owned.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: owned.controller?.epoch ?? 0,
    executionBlueprintDigest: "1".repeat(64),
    operationPolicyDigest: owned.resolvedOperationPolicy!.digest,
    participantId: PARTICIPANT_ID,
    participantGeneration: "generation:1",
    roleInvocationPolicyDigest: "2".repeat(64),
    skillManifestDigest: "3".repeat(64),
    runtime: { runtimeId: "paseo", provider: "paseo", modelId: "deterministic", model: "deterministic", sessionId: "session:s12-campaign" },
    contextManifestDigest: "4".repeat(64),
    promptManifestDigest: "5".repeat(64),
    outputContract: "structured-result",
    leaseIdentities: []
  };
  return { ...body, digest: sha256Canonical(body) };
}

function seedRecord(root: string, id: string): OperationRecord {
  const now = new Date(0).toISOString();
  return {
    version: 2,
    id,
    kind: "change",
    status: "QUEUED",
    phase: "queued",
    root,
    payload: { request: "S12 observability campaign" },
    revision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    supervision: { required: false, materialized: false, generations: [] },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  };
}

const artifact = await main();
console.log(JSON.stringify({ status: artifact.status, output: path.relative(REPO_ROOT, OUTPUT), correlationDigest: artifact.scenario.correlationDigest, evalCases: (artifact.evals.cases as unknown[]).length, otlpSpans: (artifact.otlp.spanNames as string[]).length }, null, 2));
