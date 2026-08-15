import fs from "node:fs/promises";
import path from "node:path";
import { evaluateFinalQualityGate } from "../agents/qualityConvergence.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import { executeOperation, startDetachedOperation } from "../operations/controller.js";
import { loadOperation } from "../operations/state.js";
import { notifyOperationCompletion } from "../operations/completion.js";
import { runExternalToolValidator } from "../validators/external.js";
import type { AuditReport, AuditRequest } from "../audit/run.js";
import { startPaseoHarness, type PaseoStartOptions, type PaseoStartResult } from "./start.js";
import { loadResolvedAgentTopology } from "../agents/config.js";

export interface DeterministicPaseoTurnResult {
  version: 1;
  session: { agentId: string; state: "idle" | "received-completion"; turnCount: number };
  userTurn: { prompt: string; accepted: boolean };
  operation: { id: string; kind: "audit"; status: string; phase: string; revision: number; result?: Record<string, unknown> };
  validation: { status: string; checks: Array<{ id: string; status: string; message: string }> };
  completion: { status: string; agentId: string; attempts: number };
  lead: { wakeReceived: boolean; message: string };
  human: string;
}

interface DeterministicSessionState {
  version: 1;
  agentId: string;
  turns: Array<{ prompt: string; role: "user" | "system"; content: string; at: string }>;
}

const SESSION_FILE = ".harness/paseo/deterministic-session.json";

/**
 * A deterministic Paseo SDK boundary for black-box and packaged journeys.
 * The normal start path remains unchanged; this boundary replaces only the
 * external daemon/model conversation with a file-backed fake SDK session.
 */
export async function startDeterministicPaseoHarness(root: string, config: HarnessProjectConfig, options: PaseoStartOptions = {}): Promise<PaseoStartResult> {
  const result = await startPaseoHarness(root, config, options, {
    run: async (command: string) => command.includes("daemon status") ? { exitCode: 0, stdout: "{}", stderr: "", durationMs: 1 } : { exitCode: 1, stdout: "", stderr: "deterministic fake Paseo command boundary", durationMs: 1 },
    commandExists: async () => true,
    setupToolchain: async () => ({ profile: "deterministic" } as never),
    loadTopology: loadResolvedAgentTopology,
    detectCapabilities: async () => ({ version: "deterministic", background: true, quiet: true, json: true, outputSchema: true, daemonJson: true, nativeToolsRecommended: true }),
    launchAgent: async (_projectRoot: string, launchOptions: { labels?: Record<string, string> }) => ({ id: `deterministic-lead-${launchOptions.labels?.["aeh.generation"] ?? "1"}`, exitCode: 0, stdout: "", stderr: "", status: "idle", transport: "sdk" as const }),
    probeAgent: async () => true
  } as never);
  const sessionFile = path.resolve(root, SESSION_FILE);
  const previous = await readSession(sessionFile);
  const session: DeterministicSessionState = result.session === "reused" && previous ? { ...previous, agentId: result.agentId } : { version: 1, agentId: result.agentId, turns: [] };
  await writeSession(sessionFile, session);
  return { ...result, transport: "sdk" };
}

export async function runDeterministicPaseoTurn(root: string, config: HarnessProjectConfig, prompt: string): Promise<DeterministicPaseoTurnResult> {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) throw new Error("aeh paseo turn requires a non-empty simulated user prompt.");
  const sessionFile = path.resolve(root, SESSION_FILE);
  const session = await readSession(sessionFile);
  if (!session) throw new Error(`No deterministic Paseo lead session exists at ${sessionFile}. Run aeh start --deterministic first.`);
  session.turns.push({ prompt: normalizedPrompt, role: "user", content: normalizedPrompt, at: new Date().toISOString() });
  await writeSession(sessionFile, session);

  const operation = await startDetachedOperation(root, "audit", { request: normalizedPrompt, risk: "low" }, {
    nodeExecutable: process.execPath,
    entryFile: process.argv[1] ?? "aeh",
    completionAgentId: session.agentId,
    completionSource: "deterministic-paseo-sdk",
    spawnProcess: (() => ({ pid: process.pid, unref: () => undefined }) as never) as never
  });
  let wakeMessage = "";
  const terminal = await executeOperation(root, operation.id, {
    run: async () => ({ exitCode: 1, stdout: "", stderr: "deterministic fake Paseo workspace boundary", durationMs: 1 }),
    runAudit: deterministicAudit,
    startWatchdog: () => () => undefined,
    notifyCompletion: async (operationRoot, completed) => {
      const delivered = await notifyOperationCompletion(operationRoot, completed, {
        retryDelaysMs: [0],
        sleep: async () => undefined,
        trace: async () => undefined,
        dispatch: async (_dispatchRoot, agentId, message) => { wakeMessage = message; return { id: agentId, exitCode: 0, stdout: "accepted", stderr: "", status: "working", transport: "sdk" as const }; }
      });
      if (!delivered || delivered.status !== "SENT") throw new Error("deterministic lead completion callback was not delivered");
    }
  });
  const current = await loadOperation(root, terminal.id);
  const completion = JSON.parse(await fs.readFile(path.resolve(root, ".harness/operations", `${terminal.id}.completion.json`), "utf8")) as { status: string; agentId: string; attempts: number };
  session.turns.push({ prompt: normalizedPrompt, role: "system", content: wakeMessage, at: new Date().toISOString() });
  await writeSession(sessionFile, session);
  const checks = Array.isArray(current.result?.validationChecks) ? current.result.validationChecks as Array<{ id: string; status: string; message: string }> : [{ id: "deterministic-validation", status: current.status === "SUCCEEDED" ? "PASS" : "FAIL", message: current.status === "SUCCEEDED" ? "deterministic validation passed" : current.error ?? "operation failed" }];
  const validationStatus = checks.some((check) => check.status === "FAIL") ? "FAIL" : "PASS";
  const result: DeterministicPaseoTurnResult = {
    version: 1,
    session: { agentId: session.agentId, state: wakeMessage ? "received-completion" : "idle", turnCount: session.turns.filter((turn) => turn.role === "user").length },
    userTurn: { prompt: normalizedPrompt, accepted: true },
    operation: { id: current.id, kind: "audit", status: current.status, phase: current.phase, revision: current.revision, result: current.result },
    validation: { status: validationStatus, checks },
    completion,
    lead: { wakeReceived: Boolean(wakeMessage), message: wakeMessage },
    human: `DETERMINISTIC PASEO: user turn accepted; operation ${current.id} ${current.status}; validation ${validationStatus}; completion ${completion.status}; lead ${wakeMessage ? "received terminal wake" : "not woken"}.`
  };
  return result;
}

async function deterministicAudit(root: string, config: HarnessProjectConfig, input: AuditRequest): Promise<AuditReport> {
  const contract: TaskContract = { version: 1, task: { id: input.auditId ?? "DETERMINISTIC-AUDIT", title: input.request } };
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('{}')")}`;
  const check = await runExternalToolValidator({ root, config, contract, spec: { id: "deterministic-validation", adapter: "command", command, required: true }, baseRef: config.validation?.baseRef ?? "HEAD", changedFiles: [] });
  const validationChecks = [{ ...check, failureClass: check.status === "PASS" ? "NONE" as const : "TOOL_FAILURE" as const }];
  const qualityGate = evaluateFinalQualityGate([], config);
  const now = new Date().toISOString();
  const report: AuditReport = {
    version: 1, auditId: input.auditId ?? "DETERMINISTIC-AUDIT", intent: "audit", request: input.request, status: check.status === "PASS" ? "CLEAN" : "DEGRADED", startedAt: now, finishedAt: now,
    repository: { root, baseRef: config.validation?.baseRef ?? "HEAD", dirtyPaths: [] }, reviewers: ["deterministic-reviewer"], validationChecks, findings: [], counts: qualityGate.counts, debtPoints: qualityGate.debtPoints, debtScore: qualityGate.debtScore, qualityGate, productionSafe: check.status === "PASS", sessions: [{ id: "deterministic-reviewer", provider: "fake-paseo-sdk", model: "deterministic", logicalAgent: "reviewer", runtime: "fake", transport: "sdk", status: "completed", exitCode: 0, stdout: "{}", stderr: "" } satisfies WorkerSession], restoredPaths: []
  };
  const file = path.resolve(root, ".harness", "audits", `${report.auditId}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function readSession(file: string): Promise<DeterministicSessionState | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as DeterministicSessionState; }
  catch { return undefined; }
}
async function writeSession(file: string, session: DeterministicSessionState): Promise<void> { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(session, null, 2)}\n`); }
