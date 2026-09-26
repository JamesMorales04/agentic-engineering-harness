import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import {
  resolveCandidateRelease,
  loadReleaseModule,
  CandidateUnavailableError,
  type CandidateBuildIdentityV1,
  type CandidateReleaseResolution
} from "./candidateRelease";

export type FailureClassification =
  | "PRODUCT_DEFECT"
  | "TEST_DEFECT"
  | "TEST_INFRASTRUCTURE_UNAVAILABLE"
  | "ENVIRONMENT_DEFECT"
  | "AUTHORIZATION_REQUIRED"
  | "ARCHITECTURE_DECISION_REQUIRED";

export interface JourneyCheckRecord {
  name: string;
  status: "PASS" | "FAIL";
  classification?: FailureClassification;
  error?: string;
  details?: unknown;
}

export class JourneyRecorder {
  readonly checks: JourneyCheckRecord[] = [];
  readonly notes: Record<string, unknown> = {};

  async check(name: string, classification: FailureClassification, run: () => Promise<void> | void, details?: unknown): Promise<boolean> {
    try {
      await run();
      this.checks.push({ name, status: "PASS", classification });
      return true;
    } catch (error) {
      const message = sanitizeText(error instanceof Error ? error.message : String(error));
      this.checks.push({ name, status: "FAIL", classification, error: message, details: safeDetails(details) });
      expect.soft(false, `${classification} :: ${name} :: ${message}`).toBe(true);
      return false;
    }
  }

  note(name: string, value: unknown): void {
    this.notes[name] = safeDetails(value);
  }

  failures(): JourneyCheckRecord[] {
    return this.checks.filter((check) => check.status === "FAIL");
  }
}

export class JourneySetupError extends Error {
  constructor(readonly classification: FailureClassification, message: string, readonly details?: unknown) {
    super(`${classification}: ${sanitizeText(message)}`);
    this.name = "JourneySetupError";
  }
}

export interface CommandResult {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const START_TIMEOUT_MS = 8 * 60_000;
const EXIT_GRACE_MS = 30_000;
const INIT_TIMEOUT_MS = 3 * 60_000;

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }
): Promise<CommandResult> {
  const startedAt = Date.now();
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
  }, options.timeoutMs);
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", () => resolve({ exitCode: null, signal: null }));
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  clearTimeout(timer);
  return { command: [command, ...args].join(" "), ...outcome, stdout, stderr, durationMs: Date.now() - startedAt, timedOut };
}

export function classifyDependencyFailure(text: string): FailureClassification {
  if (/credential|unauthor|api[ -_]?key|authentication|not logged in|login required|permission denied|401|403/i.test(text)) return "AUTHORIZATION_REQUIRED";
  if (/eaddrinuse|eacces|enospc|no space|filesystem|platform|daemon|port |pid namespace|uid/i.test(text)) return "ENVIRONMENT_DEFECT";
  if (/enoent|not found|command .*unavailable|cannot launch|could not be resolved|timed out|timeout/i.test(text)) return "TEST_INFRASTRUCTURE_UNAVAILABLE";
  return "PRODUCT_DEFECT";
}

export function sanitizeText(value: string): string {
  return value
    .replace(/controlCenterPairing=\S+/g, "controlCenterPairing=<redacted>")
    .replace(/pair=[^\s"'#&]+/g, "pair=<redacted>")
    .replace(/aeh_control_session=[^;\s]+/g, "aeh_control_session=<redacted>")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .slice(0, 4_000);
}

function safeDetails(value: unknown, depth = 0): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 4) return "<depth-limit>";
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => safeDetails(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/token|cookie|nonce|secret|credential|csrf|pairing/i.test(key)) continue;
      result[key] = safeDetails(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

export interface StartResult {
  command: string;
  exitCode: number | null;
  controlCenterSession: string;
  controlCenterUrl: string;
  controlCenterOrigin: string;
  pairingUrl: string;
  pairingPath: string;
  agentId: string;
  paseoSession: string;
  leadAgent: string;
  provider: string;
  model: string;
  stdoutRedacted: string;
  stderrRedacted: string;
}

export interface DurableFixtureOperation {
  operationId: string;
  choiceId: string;
  choiceLabel: string;
  requestId: string;
  candidateId: string;
  candidateRevision: number;
  candidateDigest: string;
  policyDigest: string;
  controllerEpoch: number;
  operationExecutionRevision: number;
}

export interface FixtureEstablishment {
  provenance: "controller-accepted" | "fixture-synthetic";
  controllerOwnedConsumption: boolean;
  contextArtifact: string;
  contextDigest: string;
  remainingGap: string;
}

export interface HumanDecisionView {
  decisionId: string;
  actorId: string;
  kind: string;
  purpose: { kind: string; requestId?: string; choiceId?: string; command?: string };
  operationId: string;
  operationExecutionRevision: number;
  policyDigest: string;
  controllerEpoch: number;
}

export interface HumanDecisionLedgerView {
  list(): Promise<HumanDecisionView[]>;
  active(binding: unknown, now?: Date): Promise<HumanDecisionView[]>;
  find(decisionId: string): Promise<HumanDecisionView | undefined>;
  consumeExact(binding: unknown, purpose: unknown, decisionId: string, actorId: string, now?: Date): Promise<HumanDecisionView>;
  consumedExact(binding: unknown, purpose: unknown, decisionId: string, actorId: string, now?: Date): Promise<HumanDecisionView | undefined>;
}

export type ReleaseRecord = Record<string, any>;

export interface ReleaseApi {
  state: {
    saveOperation(root: string, record: unknown): Promise<void>;
    loadOperation(root: string, operationId: string): Promise<ReleaseRecord>;
    claimControllerEpoch(root: string, operationId: string, ownerId: string, options?: Record<string, unknown>): Promise<ReleaseRecord>;
    currentControllerEpoch(record: ReleaseRecord): number;
    bindResolvedOperationPolicy(root: string, operationId: string, policy: unknown): Promise<ReleaseRecord>;
    transitionOperationToTerminal(root: string, operationId: string, patch: Record<string, unknown>): Promise<{ record: ReleaseRecord; transitioned: boolean }>;
    suspendOperationForProductChoice(root: string, operationId: string, content: unknown, checkpoint: unknown, expiresInMs?: number): Promise<ReleaseRecord>;
    markOperationProductChoiceConsumed(root: string, operationId: string, input: { requestId: string; decisionId: string; choiceId: string }): Promise<ReleaseRecord>;
    bindProductChoiceExecutionSemantics(root: string, operationId: string, input: { requirementDigest: string; decisionId: string; choiceId: string; priorDecisionIds?: string[] }): Promise<ReleaseRecord>;
    resumeOperationProductChoice(root: string, operationId: string): Promise<ReleaseRecord>;
    reissueOperationProductChoice(root: string, operationId: string, checkpoint: unknown): Promise<ReleaseRecord>;
    loadOperationProductChoiceCheckpoint(root: string, operationId: string): Promise<unknown>;
  };
  portfolio: {
    syncOperationPortfolio(root: string, project: string, record: ReleaseRecord): Promise<unknown>;
  };
  controller: {
    cancelOperation(root: string, operationId: string, deps?: Record<string, unknown>): Promise<ReleaseRecord>;
  };
  config: {
    loadProjectConfig(root: string): Promise<{ project: { name: string } }>;
  };
  executionIdentity: {
    compileResolvedOperationPolicy(input: Record<string, unknown>): { digest: string } & Record<string, unknown>;
  };
  humanDecision: {
    HumanDecisionLedgerV2: new (file: string) => HumanDecisionLedgerView;
  };
  digest: {
    sha256Canonical(value: unknown): string;
  };
}

function lineValue(text: string, key: string): string | undefined {
  const matches = [...text.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((match) => match[1]?.trim()).filter(Boolean);
  return matches.at(-1);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try { process.kill(pid, 0); return false; } catch { return true; }
}

export class ControlCenterJourneyFixture {
  readonly recorder = new JourneyRecorder();
  readonly candidate: CandidateReleaseResolution;
  readonly consumerRoot: string;
  readonly evidenceRoot: string;
  private apiCache?: Promise<ReleaseApi>;
  private projectNameCache?: Promise<string>;
  private startResultCache?: StartResult;
  private durableCache?: DurableFixtureOperation;
  private establishmentCache?: FixtureEstablishment;
  private initResultCache?: CommandResult;
  private readonly screenshotFiles: Array<{ name: string; file: string; sha256: string }> = [];

  private constructor(candidate: CandidateReleaseResolution, consumerRoot: string) {
    this.candidate = candidate;
    this.consumerRoot = consumerRoot;
    this.evidenceRoot = path.join(candidate.repoRoot, ".harness", "evidence", "browser");
  }

  static async create(): Promise<ControlCenterJourneyFixture> {
    const candidate = await resolveCandidateRelease({ specFileUrl: import.meta.url, cwd: process.cwd() });
    const consumerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s9-browser-"));
    return new ControlCenterJourneyFixture(candidate, consumerRoot);
  }

  get repoRoot(): string { return this.candidate.repoRoot; }
  get releaseDir(): string { return this.candidate.releaseDir; }
  get buildIdentity(): CandidateBuildIdentityV1 { return this.candidate.identity; }
  get operation(): DurableFixtureOperation | undefined { return this.durableCache; }
  get establishment(): FixtureEstablishment | undefined { return this.establishmentCache; }
  get start(): StartResult | undefined { return this.startResultCache; }

  private childEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^AEH_(OPERATION_ID|OPERATION_KIND|OPERATION_WORKSPACE_ID|CONTROL_ROOT|OPERATION_STATE_REDIRECT|CONTROLLER_EPOCH|CONTROLLER_TOKEN|DETERMINISTIC_PASEO)$/.test(key)) delete env[key];
    }
    delete env.AEH_S9_REPO_ROOT;
    return env;
  }

  async api(): Promise<ReleaseApi> {
    if (!this.apiCache) {
      this.apiCache = (async () => {
        const [state, portfolio, controller, config, executionIdentity, humanDecision, digest] = await Promise.all([
          loadReleaseModule<ReleaseApi["state"]>(this.releaseDir, "operations/state.js"),
          loadReleaseModule<ReleaseApi["portfolio"]>(this.releaseDir, "operations/portfolio.js"),
          loadReleaseModule<ReleaseApi["controller"]>(this.releaseDir, "operations/controller.js"),
          loadReleaseModule<ReleaseApi["config"]>(this.releaseDir, "core/config.js"),
          loadReleaseModule<ReleaseApi["executionIdentity"]>(this.releaseDir, "architecture/executionIdentity.js"),
          loadReleaseModule<ReleaseApi["humanDecision"]>(this.releaseDir, "security/humanDecision.js"),
          loadReleaseModule<ReleaseApi["digest"]>(this.releaseDir, "core/digest.js")
        ]);
        return { state, portfolio, controller, config, executionIdentity, humanDecision, digest };
      })();
    }
    return this.apiCache;
  }

  async projectName(): Promise<string> {
    if (!this.projectNameCache) {
      this.projectNameCache = (async () => (await (await this.api()).config.loadProjectConfig(this.consumerRoot)).project.name)();
    }
    return this.projectNameCache;
  }

  async initializeConsumerRoot(): Promise<CommandResult> {
    if (this.initResultCache) return this.initResultCache;
    const result = await runCommand("npm", ["run", "aeh", "--", "init", this.consumerRoot], {
      cwd: this.repoRoot,
      timeoutMs: INIT_TIMEOUT_MS,
      env: this.childEnvironment()
    });
    this.initResultCache = result;
    if (result.exitCode !== 0) {
      throw new JourneySetupError(classifyDependencyFailure(`${result.stdout}\n${result.stderr}`),
        `the supported package path could not initialize the disposable consumer root (exit ${result.exitCode ?? result.signal}).`,
        { command: result.command, exitCode: result.exitCode, signal: result.signal, stdout: sanitizeText(result.stdout), stderr: sanitizeText(result.stderr) });
    }
    try {
      await fs.access(path.join(this.consumerRoot, ".harness", "project.yaml"));
    } catch {
      throw new JourneySetupError("PRODUCT_DEFECT", "candidate init reported success but did not create .harness/project.yaml.");
    }
    return result;
  }

  async startCandidate(): Promise<StartResult> {
    if (this.startResultCache) return this.startResultCache;
    const args = ["run", "aeh", "--", "start", "--no-open", this.consumerRoot];
    const command = ["npm", ...args].join(" ");
    const child = spawn("npm", args, { cwd: this.repoRoot, env: this.childEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const pairingUrl = await this.waitForPairingUrl(child, () => stdout);
    const exitCode = await this.waitForChildExit(child, EXIT_GRACE_MS);
    const stdoutRedacted = sanitizeText(stdout);
    const stderrRedacted = sanitizeText(stderr);
    const commandDetails = { command, exitCode, signal: child.signalCode, stdout: stdoutRedacted, stderr: stderrRedacted };
    if (!pairingUrl) {
      throw new JourneySetupError(classifyDependencyFailure(`${stdout}\n${stderr}`),
        `the current candidate start did not emit a controlCenterPairing URL (exit ${exitCode ?? child.signalCode}).`,
        commandDetails);
    }
    let parsed: URL;
    try {
      parsed = new URL(pairingUrl);
    } catch {
      throw new JourneySetupError("PRODUCT_DEFECT", "the candidate emitted a malformed controlCenterPairing URL.", { command, exitCode });
    }
    if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) || parsed.protocol !== "http:" || !parsed.port || parsed.pathname !== "/" || !parsed.hash.startsWith("#pair=")) {
      throw new JourneySetupError("PRODUCT_DEFECT", "the emitted pairing URL is not a loopback single-use pairing URL with the expected origin/path/fragment shape.", {
        origin: parsed.origin, path: parsed.pathname, fragmentPresent: parsed.hash.startsWith("#pair=")
      });
    }
    const controlCenterSession = lineValue(stdout, "controlCenterSession") ?? (lineValue(stdout, "controlCenter") ? "started" : "unknown");
    if (controlCenterSession === "reused") {
      throw new JourneySetupError("ENVIRONMENT_DEFECT", "the disposable consumer root unexpectedly reused an existing Control Center service instead of starting the fixture one.", commandDetails);
    }
    const result: StartResult = {
      command,
      exitCode,
      controlCenterSession,
      controlCenterUrl: `${parsed.origin}/`,
      controlCenterOrigin: parsed.origin,
      pairingUrl,
      pairingPath: `${parsed.pathname}${parsed.search}`,
      agentId: lineValue(stdout, "agentId") ?? "",
      paseoSession: lineValue(stdout, "session") ?? "",
      leadAgent: lineValue(stdout, "lead") ?? "",
      provider: lineValue(stdout, "provider") ?? "",
      model: lineValue(stdout, "model") ?? "",
      stdoutRedacted,
      stderrRedacted
    };
    if (exitCode !== 0) {
      throw new JourneySetupError(classifyDependencyFailure(`${stdout}\n${stderr}`),
        `the current candidate start emitted a pairing URL but exited ${exitCode ?? child.signalCode}.`, { ...commandDetails, agentIdPresent: Boolean(result.agentId) });
    }
    this.startResultCache = result;
    return result;
  }

  private async waitForPairingUrl(child: ChildProcess, readStdout: () => string): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      let settled = false;
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        resolve(value);
      };
      const deadline = Date.now() + START_TIMEOUT_MS;
      const timer = setInterval(() => {
        const value = lineValue(readStdout(), "controlCenterPairing");
        if (value) return finish(value);
        if (child.exitCode !== null || child.signalCode !== null) return finish(undefined);
        if (Date.now() > deadline) {
          child.kill("SIGTERM");
          return finish(undefined);
        }
      }, 200);
      child.once("error", () => finish(undefined));
      child.once("exit", () => finish(lineValue(readStdout(), "controlCenterPairing")));
    });
  }

  private async waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
    if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
        resolve();
      }, timeoutMs);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    return child.exitCode;
  }

  async establishChangeOperation(): Promise<DurableFixtureOperation> {
    if (this.durableCache) return this.durableCache;
    const taskId = "S9-BROWSER";
    const changeName = taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
    await this.seedOpenSpecChange(changeName);
    await this.writeDeterministicScript(changeName);
    const operationId = await this.startChangeOperation(taskId);
    const suspended = await this.waitForProductChoice(operationId, undefined, 180_000);
    const request = suspended.decisionRequest;
    const candidate = suspended.candidateRevision;
    if (!request || !candidate || !suspended.resolvedOperationPolicy) {
      throw new JourneySetupError("PRODUCT_DEFECT", "the controller-owned suspension did not persist a complete pending decision request with current candidate and policy.");
    }
    const choice = request.choices[0];
    this.durableCache = {
      operationId,
      choiceId: choice.choiceId,
      choiceLabel: choice.label,
      requestId: request.requestId,
      candidateId: candidate.candidateId,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      policyDigest: suspended.resolvedOperationPolicy.digest,
      controllerEpoch: suspended.controller?.epoch ?? 0,
      operationExecutionRevision: suspended.operationExecutionRevision
    };
    this.establishmentCache = {
      provenance: "controller-accepted",
      controllerOwnedConsumption: true,
      contextArtifact: `.harness/operations/${operationId}/events.ndjson`,
      contextDigest: "",
      remainingGap: ""
    };
    await this.syncPortfolio();
    return this.durableCache;
  }

  /** Pre-create the OpenSpec change so the frozen candidate already contains it. */
  private async seedOpenSpecChange(changeName: string): Promise<void> {
    const changeDir = path.join(this.consumerRoot, "openspec", "changes", changeName);
    await fs.mkdir(path.join(changeDir, "specs", "fixture"), { recursive: true });
    await fs.writeFile(path.join(changeDir, "proposal.md"), "# Proposal\n\nFixture proposal for the S9 browser journey.\n", "utf8");
    await fs.writeFile(path.join(changeDir, "tasks.md"), "## Tasks\n\n- [ ] 1.1 Apply the bounded fixture change.\n", "utf8");
    await fs.writeFile(path.join(changeDir, "specs", "fixture", "spec.md"), "## ADDED Requirements\n\n### Requirement: Fixture behavior\nThe fixture SHALL expose bounded behavior.\n", "utf8");
    for (const args of [["init", "-q"], ["config", "user.email", "aeh@example.test"], ["config", "user.name", "AEH Browser Fixture"], ["add", "-A"], ["commit", "-qm", "openspec fixture"]]) {
      const result = await runCommand("git", args, { cwd: this.consumerRoot, timeoutMs: 30_000, env: this.childEnvironment() });
      if (result.exitCode !== 0) throw new JourneySetupError("ENVIRONMENT_DEFECT", `git ${args[0]} failed while seeding the fixture: ${sanitizeText(result.stderr || result.stdout)}`);
    }
  }

  /** Fixture-owned external condition: the file-scripted deterministic provider responses. */
  private async writeDeterministicScript(changeName: string): Promise<void> {
    const routePayload = { judgment: { type: "ROUTE", recommendedRoute: "FORMAL_SDD", scopeClarity: "HIGH", decompositionNeed: false, coordinationNeed: false, architectureUncertainty: false, productUncertainty: false, formalizationNeed: "REQUIRED", semanticRiskSignals: [], evidenceRefs: ["request"], unknowns: [] }, claims: [], assumptions: [], unknowns: [], recommendations: [], knowledgeGaps: [] };
    const supervisorPayload = { summary: "Supervisor initialized.", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: [], roadmap: [], finalizationSafety: "SAFE" };
    const explorerPayload = { summary: "Bounded fixture discovery.", relevantFiles: [{ path: "src/fixture.ts", symbols: [], reason: "fixture scope" }], findings: [], moduleBoundaries: [], tests: [], dependencies: [], risks: [], openQuestions: [] };
    const plannerPayload = { workUnits: [{ id: "unit-1", objective: "Apply the bounded fixture change.", scope: ["src/fixture.ts"], dependencies: [], requirementRefs: [], acceptanceRefs: [], competencies: [], riskTags: [], changeKinds: ["source"], risk: "low", resourceClaims: [] }], affectedAreas: ["src/fixture.ts"], reviewDimensions: [], validationRequirements: [], outOfScopeImprovements: [] };
    const blockedSpec = (choiceId: string, label: string) => ({ change: changeName, status: "BLOCKED", artifacts: { specs: [] }, requirements: [], unresolvedDecisions: [`${choiceId} is unresolved`], decisionRequests: [{ issue: `Which bounded behavior should '${choiceId}' select?`, whatTried: ["Compared both bounded interpretations against the frozen request."], whyUnresolvable: "Both interpretations satisfy the request and only a human product authority may choose.", choices: [{ choiceId, label, description: `Select bounded behavior ${choiceId}.`, consequences: [`Records ${choiceId} in the requirement set.`] }], workThatCanContinue: ["Read-only discovery can continue."] }], validationReady: false });
    const file = path.join(this.consumerRoot, ".harness", "fixtures", "deterministic-paseo-runtime.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ version: 1, responses: { "semantic-assessment:ROUTE": [routePayload], supervisor: [supervisorPayload], explorer: [explorerPayload], planner: [plannerPayload], "spec-authoring": [blockedSpec("scope-narrow", "Narrow explicit behavior"), blockedSpec("scope-verify", "Verified explicit behavior")] } }, null, 2)}\n`, "utf8");
  }

  /** Start the governed operation through the supported public product CLI. */
  private async startChangeOperation(taskId: string): Promise<string> {
    const args = ["run", "aeh", "--", "operation", "start", "change", "Exercise the S9 Control Center browser journey against this disposable project.", this.consumerRoot, "--task", taskId, "--file", "src/fixture.ts"];
    const result = await runCommand("npm", args, { cwd: this.repoRoot, timeoutMs: 240_000, env: { ...this.childEnvironment(), AEH_DETERMINISTIC_PASEO_RUNTIME: "1" } });
    const operationId = lineValue(result.stdout, "operationId");
    if (result.exitCode !== 0 || !operationId) {
      throw new JourneySetupError(classifyDependencyFailure(`${result.stdout}\n${result.stderr}`), `the supported public change-operation start did not report an operation id (exit ${result.exitCode ?? result.signal}).`, { command: result.command, stdout: sanitizeText(result.stdout), stderr: sanitizeText(result.stderr) });
    }
    return operationId;
  }

  async waitForProductChoice(operationId: string, previousRequestId: string | undefined, timeoutMs: number): Promise<ReleaseRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const api = await this.api();
      const record = await api.state.loadOperation(this.consumerRoot, operationId);
      if (record.status !== "RUNNING") {
        throw new JourneySetupError("PRODUCT_DEFECT", `operation ${operationId} reached ${record.status} before the expected product-choice suspension: ${sanitizeText(String(record.error ?? ""))}`);
      }
      if (record.phase === "HUMAN_REQUIRED" && record.decisionRequest && record.decisionRequest.requestId !== previousRequestId) return record;
      if (Date.now() >= deadline) throw new JourneySetupError("PRODUCT_DEFECT", `timed out waiting for ${previousRequestId ? "the controller to consume the decision and reach the next" : "the first"} product-choice suspension (phase ${String(record.phase)}).`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async waitForPhase(predicate: (record: ReleaseRecord) => boolean, timeoutMs: number, label: string): Promise<ReleaseRecord> {
    const operation = await this.requireDurable();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const record = await this.readOperation();
      if (record.status !== "RUNNING" && record.status !== "CANCELLED") throw new JourneySetupError("PRODUCT_DEFECT", `operation ${operation.operationId} reached ${record.status} while waiting for ${label}: ${sanitizeText(String(record.error ?? ""))}`);
      if (predicate(record)) return record;
      if (Date.now() >= deadline) throw new JourneySetupError("PRODUCT_DEFECT", `timed out waiting for ${label} (status ${String(record.status)}, phase ${String(record.phase)}).`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private compilePolicy(api: ReleaseApi, record: ReleaseRecord): Record<string, unknown> {
    const candidate = record.candidateRevision;
    return api.executionIdentity.compileResolvedOperationPolicy({
      projectId: candidate.projectId,
      operationId: record.id,
      operationExecutionRevision: record.operationExecutionRevision,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      controllerEpoch: api.state.currentControllerEpoch(record),
      intent: "S9 browser journey controller fixture",
      route: "FORMAL_SDD",
      minimumAssurance: "STANDARD",
      policyVersions: { resolvedOperationPolicy: "1" },
      policyDigests: {},
      validationPolicy: {},
      reviewPolicy: {},
      deliveryPolicy: {},
      knowledgePolicy: {},
      contextPolicy: {},
      allowedExternalEffects: [],
      humanDecisionRequirements: []
    });
  }

  async compileResolvedPolicy(record: ReleaseRecord): Promise<Record<string, unknown>> {
    const api = await this.api();
    return this.compilePolicy(api, record);
  }

  async syncPortfolio(): Promise<void> {
    const operation = await this.requireDurable();
    const api = await this.api();
    const record = await api.state.loadOperation(this.consumerRoot, operation.operationId);
    await api.portfolio.syncOperationPortfolio(this.consumerRoot, await this.projectName(), record);
  }

  async readOperation(): Promise<ReleaseRecord> {
    const api = await this.api();
    const operation = await this.requireDurable();
    return api.state.loadOperation(this.consumerRoot, operation.operationId);
  }

  async ledger(): Promise<HumanDecisionLedgerView> {
    const api = await this.api();
    return new api.humanDecision.HumanDecisionLedgerV2(path.join(this.consumerRoot, ".harness", "security", "human-decisions.json"));
  }

  async activeProductChoice(decisionId?: string): Promise<HumanDecisionView | undefined> {
    const operation = await this.requireDurable();
    const record = await this.readOperation();
    const api = await this.api();
    const ledger = await this.ledger();
    if (decisionId) return ledger.find(decisionId);
    const binding = {
      operationId: record.id,
      candidate: record.candidateRevision,
      operationExecutionRevision: record.operationExecutionRevision,
      policyDigest: record.resolvedOperationPolicy?.digest,
      controllerEpoch: api.state.currentControllerEpoch(record)
    };
    const active = await ledger.active(binding, new Date());
    return active.find((decision) => decision.kind === "CHOOSE" && decision.purpose?.kind === "PRODUCT_CHOICE" && decision.purpose.requestId === operation.requestId);
  }

  /** Wait for the real controller to consume the submitted decision and suspend again. */
  async waitForSecondProductChoice(previousRequestId: string, timeoutMs = 180_000): Promise<ReleaseRecord> {
    const operation = await this.requireDurable();
    return this.waitForProductChoice(operation.operationId, previousRequestId, timeoutMs);
  }

  async loadContinuationCheckpoint(): Promise<unknown> {
    const api = await this.api();
    const operation = await this.requireDurable();
    return api.state.loadOperationProductChoiceCheckpoint(this.consumerRoot, operation.operationId);
  }

  async screenshot(page: Page, name: string): Promise<{ file: string; sha256: string }> {
    const currentUrl = page.url();
    if (currentUrl.includes("pair=") || currentUrl.includes("#pair")) {
      throw new Error("REFUSED_UNSANITIZED_SCREENSHOT: the pairing fragment is still present in the browser location.");
    }
    const directory = this.evidenceDirectory();
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const sha256 = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    this.screenshotFiles.push({ name, file, sha256 });
    return { file, sha256 };
  }

  evidenceDirectory(): string {
    return path.join(this.evidenceRoot, this.durableCache?.operationId ?? `setup-${process.pid}`);
  }

  private async requireDurable(): Promise<DurableFixtureOperation> {
    if (!this.durableCache) throw new JourneySetupError("TEST_DEFECT", "the durable fixture operation has not been established yet.");
    return this.durableCache;
  }

  async killExactControlCenterService(): Promise<string[]> {
    const notes: string[] = [];
    const snapshotPath = path.join(this.consumerRoot, ".harness", "runtime", "snapshot.json");
    let snapshot: { services?: Array<Record<string, any>> } | undefined;
    try {
      snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as { services?: Array<Record<string, any>> };
    } catch {
      return notes;
    }
    const services = (snapshot?.services ?? []).filter((service) => service.kind === "control-center" && path.resolve(String(service.canonicalRoot ?? "")) === this.consumerRoot);
    for (const service of services) {
      const pid = Number(service.pid);
      if (!Number.isSafeInteger(pid) || pid <= 1) {
        notes.push(`control-center service ${String(service.serviceId)} has no killable pid`);
        continue;
      }
      if (!(await this.processMatchesControlCenter(pid))) {
        notes.push(`pid ${pid} no longer identifies this fixture Control Center; not killed`);
        continue;
      }
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        notes.push(`control-center pid ${pid} could not be signalled: ${sanitizeText(String(error))}`);
        continue;
      }
      if (!(await waitForProcessExit(pid, 5_000))) {
        if (await this.processMatchesControlCenter(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch { /* exited between checks */ }
          await waitForProcessExit(pid, 3_000);
        }
      }
      notes.push(`stopped exact fixture Control Center pid ${pid}`);
    }
    if (!services.length) notes.push("no matching control-center service was recorded for this fixture root");
    return notes;
  }

  private async processMatchesControlCenter(pid: number): Promise<boolean> {
    try {
      const cmdline = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
      return cmdline.includes("control-center") && cmdline.includes(this.consumerRoot);
    } catch {
      return false;
    }
  }

  async stopExactFixtureLead(): Promise<string[]> {
    const notes: string[] = [];
    let agentId = this.startResultCache?.agentId ?? "";
    if (!agentId) {
      try {
        const state = JSON.parse(await fs.readFile(path.join(this.consumerRoot, ".harness", "paseo", "lead-session.json"), "utf8")) as { agentId?: unknown };
        if (typeof state.agentId === "string") agentId = state.agentId;
      } catch { /* no durable lead state */ }
    }
    if (!agentId) {
      notes.push("no fixture lead agent id was recorded");
      return notes;
    }
    const result = await runCommand("paseo", ["stop", agentId], { cwd: this.consumerRoot, timeoutMs: 30_000, env: this.childEnvironment() }).catch((error) => ({ command: `paseo stop ${agentId}`, exitCode: null, signal: null, stdout: "", stderr: String(error), durationMs: 0, timedOut: false } as CommandResult));
    if (result.exitCode !== 0) notes.push(`exact fixture lead ${agentId} stop exited ${result.exitCode ?? result.signal}: ${sanitizeText(result.stderr || result.stdout)}`);
    else notes.push(`stopped exact fixture lead ${agentId}`);
    return notes;
  }

  async cleanup(): Promise<string[]> {
    const notes: string[] = [];
    if (this.durableCache) {
      try {
        const api = await this.api();
        const record = await api.state.loadOperation(this.consumerRoot, this.durableCache.operationId);
        if (record.status === "RUNNING" || record.status === "QUEUED") {
          const cancelled = await api.controller.cancelOperation(this.consumerRoot, this.durableCache.operationId, { humanActorId: "human:control-center:s9-browser-cleanup" });
          notes.push(`cancelled the still-running fixture operation (${String(cancelled.status)})`);
        }
      } catch (error) {
        notes.push(`fixture operation cleanup failed: ${sanitizeText(String(error))}`);
      }
    }
    const contextNotes = await this.killExactControlCenterService().catch((error) => [`Control Center cleanup failed: ${sanitizeText(String(error))}`]);
    notes.push(...contextNotes);
    const leadNotes = await this.stopExactFixtureLead().catch((error) => [`fixture lead cleanup failed: ${sanitizeText(String(error))}`]);
    notes.push(...leadNotes);
    this.recorder.note("cleanup", notes);
    return notes;
  }

  async removeConsumerRoot(): Promise<string[]> {
    if (process.env.AEH_S9_KEEP_ROOT === "1") return [`consumer root retained at ${this.consumerRoot}`];
    try {
      await fs.rm(this.consumerRoot, { recursive: true, force: true });
      return ["removed disposable consumer root"];
    } catch (error) {
      return [`could not remove disposable consumer root: ${sanitizeText(String(error))}`];
    }
  }

  async writeEvidence(extra: Record<string, unknown> = {}): Promise<string> {
    const directory = this.evidenceDirectory();
    await fs.mkdir(directory, { recursive: true });
    let playwrightPackageVersion = "unknown";
    try {
      playwrightPackageVersion = String(createRequire(path.join(this.repoRoot, "package.json"))("@playwright/test/package.json").version);
    } catch { /* version stays unknown */ }
    const start = this.startResultCache;
    const payload = {
      slice: "S9",
      productBoundary: "npm run aeh -- start --no-open <disposable-root> -> actual detached Control Center -> packaged UI -> frontend/server/controller",
      generatedAt: new Date().toISOString(),
      package: this.candidate.identity,
      playwright: { packageVersion: playwrightPackageVersion, runner: "@playwright/test" },
      consumerRoot: this.consumerRoot,
      consumerRootRetained: process.env.AEH_S9_KEEP_ROOT === "1",
      startup: start ? {
        command: start.command,
        exitCode: start.exitCode,
        controlCenterSession: start.controlCenterSession,
        controlCenterOrigin: start.controlCenterOrigin,
        controlCenterPath: start.pairingPath,
        pairingUrlEmitted: true,
        pairingFragmentPersisted: false,
        agentId: start.agentId,
        paseoSession: start.paseoSession,
        leadAgent: start.leadAgent,
        provider: start.provider,
        model: start.model,
        stdout: start.stdoutRedacted,
        stderr: start.stderrRedacted
      } : undefined,
      operation: this.durableCache,
      establishment: this.establishmentCache,
      checks: this.recorder.checks,
      notes: this.recorder.notes,
      screenshots: this.screenshotFiles.map(({ name, file, sha256 }) => ({ name, file: path.relative(this.repoRoot, file), sha256, capturedAfterPairingFragmentRemoval: true })),
      credentialsCookiesCsrfHeadersAndNoncesPersisted: false,
      ...extra
    };
    await fs.writeFile(path.join(directory, "journey.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return directory;
  }
}

export async function writeSetupFailureEvidence(error: unknown): Promise<string | undefined> {
  try {
    const candidate = await resolveCandidateRelease({ specFileUrl: import.meta.url, cwd: process.cwd() });
    const directory = path.join(candidate.repoRoot, ".harness", "evidence", "browser", `setup-failure-${Date.now().toString(36)}`);
    await fs.mkdir(directory, { recursive: true });
    const classification = error instanceof CandidateUnavailableError ? error.classification : error instanceof JourneySetupError ? error.classification : "TEST_DEFECT";
    await fs.writeFile(path.join(directory, "journey.json"), `${JSON.stringify({
      slice: "S9",
      generatedAt: new Date().toISOString(),
      classification,
      message: sanitizeText(error instanceof Error ? error.message : String(error)),
      package: candidate.identity,
      credentialsCookiesCsrfHeadersAndNoncesPersisted: false
    }, null, 2)}\n`, "utf8");
    return directory;
  } catch {
    return undefined;
  }
}
