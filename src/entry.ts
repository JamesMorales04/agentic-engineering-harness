#!/usr/bin/env node
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";
import { initializeProject } from "./core/init.js";
import { loadProjectConfig } from "./core/config.js";
import { compileAgentTopology } from "./agents/compiler.js";
import { compileToolchain, setupToolchain } from "./toolchain/setup.js";
import { loadToolchainConfig } from "./toolchain/config.js";
import { resolveToolchain } from "./toolchain/resolve.js";
import { runDistributedWorkerLoop } from "./distributed/worker.js";
import { serveDistributedQueue } from "./distributed/queue.js";
import { resolveOrganizationPolicyBundles } from "./policy/bundles.js";
import { benchmarkMcpCatalog } from "./mcp/benchmark.js";
import { buildEvalDashboard, runRepeatedEval } from "./evals/statistics.js";
import { startPaseoHarness } from "./paseo/start.js";
import { runDeterministicPaseoTurn, startDeterministicPaseoHarness } from "./paseo/deterministicSession.js";
import { guardLeadContext } from "./paseo/context.js";
import { listManagedPaseoAgents } from "./paseo/runtime.js";
import { PaseoGatewayV1 } from "./paseo/gateway.js";
import { prepareOpenSpecChange, compileOpenSpecChange } from "./spec/openspec.js";
import { classifyEngineeringIntentWithSemanticAssessment, formatEngineeringIntent } from "./audit/intent.js";
import { createSemanticAssessmentRuntimeV1, createSemanticRepositoryBindingV1 } from "./semantic/runtime.js";
import { runAudit } from "./audit/run.js";
import type { TaskRisk } from "./core/types.js";
import { VERSION } from "./version.js";
import { retrieveAuthorizedContext } from "./context/authorizationV2.js";
import { serveContextRetrievalMcp } from "./context/retrieval/server.js";
import { createIntentDecision, type IntentDecisionV1 } from "./audit/intentDecision.js";
import { LocalControlCenterV1, createProjectHome } from "./control-center/index.js";
import { createProjectRegistry } from "./projects/index.js";
import { cancelOperation } from "./operations/controller.js";
import { loadOperationPortfolio } from "./operations/portfolio.js";
import { loadOperation, requestOperationPause, requestOperationResume } from "./operations/state.js";
import { HumanDecisionLedgerV2 } from "./security/humanDecision.js";
import { createManagedRuntime, readManagedRuntimeSnapshot, runtimeProjectId } from "./runtime/index.js";
import { serveSerenaMcpProxy, serveSerenaPoolServer } from "./providers/serenaProxy.js";
import { recordControlCenterDecision } from "./control-center/decision.js";
import { controlCenterResourceId, type ControlCenterActionResultV1 } from "./control-center/contracts.js";
import { projectOperationRecordV1 } from "./control-center/operationProjection.js";
import { resolveControlCenterLeadBinding } from "./control-center/leadBinding.js";
import { controlCenterHealthCheck, reusableControlCenterFromSnapshot } from "./control-center/reuse.js";

const args = process.argv.slice(2);
if (args.length === 1 && ["--version", "-V"].includes(args[0])) { console.log(VERSION); process.exit(0); }

if (args[0] === "start") { await runStart(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "paseo" && args[1] === "turn") { await runPaseoTurn(args.slice(2)); process.exit(process.exitCode ?? 0); }
if (args[0] === "context" && args[1] === "guard") { await runContextGuard(args.slice(2)); process.exit(process.exitCode ?? 0); }
if (args[0] === "context" && args[1] === "retrieve") { await runContextRetrieve(args.slice(2)); process.exit(process.exitCode ?? 0); }
if (args[0] === "context" && args[1] === "mcp") { await serveContextRetrievalMcp(); process.exit(process.exitCode ?? 0); }
if (args[0] === "provider" && args[1] === "serena-proxy") { await serveSerenaMcpProxy(); process.exit(process.exitCode ?? 0); }
if (args[0] === "provider" && args[1] === "serena-pool") { await serveSerenaPoolServer(); process.exit(process.exitCode ?? 0); }
if (args[0] === "home") { await runHome(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "control-center") { await runControlCenter(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "project") { await runProject(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "paseo" && args[1] === "agents") { await runPaseoAgents(args.slice(2)); process.exit(process.exitCode ?? 0); }
if (args[0] === "spec" && ["prepare", "compile"].includes(args[1] ?? "")) { await runSpec(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "intent") { await runIntent(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "audit") { await runAuditCommand(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "setup") { await runSetup(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "toolchain") { await runToolchain(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "init" && args.includes("--setup")) { await runInitSetup(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "worker") { await runWorker(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "policy" && args[1] === "sync") { await runPolicySync(args.slice(2)); process.exit(process.exitCode ?? 0); }
if (args[0] === "mcp" && args[1] === "benchmark") { await runMcpBenchmark(args.slice(2)); process.exit(process.exitCode ?? 0); }
if (args[0] === "eval" && ["repeat", "dashboard"].includes(args[1] ?? "")) { await runStatisticalEval(args.slice(1)); process.exit(process.exitCode ?? 0); }

await import("./cli.js");

async function runStart(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["lead", "title"]), new Set(["new", "resume", "no-web-ui", "no-open", "no-setup", "deterministic"]));
  if (parsed.positional.length > 1) throw new Error(`aeh start accepts at most one project directory, received: ${parsed.positional.join(", ")}`);
  if (parsed.flag("new") && parsed.flag("resume")) throw new Error("aeh start cannot combine --new and --resume.");
  const root = path.resolve(parsed.positional[0] ?? ".");
  const config = await loadProjectConfig(root);
  const entry = path.resolve(process.argv[1]);
  const aehCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)}`;
  const start = parsed.flag("deterministic") || process.env.AEH_DETERMINISTIC_PASEO === "1" ? startDeterministicPaseoHarness : startPaseoHarness;
  const result = await start(root, config, {
    autoSetup: parsed.flag("no-setup") ? false : undefined,
    webUi: parsed.flag("no-web-ui") ? false : undefined,
    forceNew: parsed.flag("new"),
    resume: parsed.flag("resume"),
    leadAgent: parsed.value("lead"),
    title: parsed.value("title"),
    aehCommand
  });
  const deterministic = parsed.flag("deterministic") || process.env.AEH_DETERMINISTIC_PASEO === "1";
  const controlCenter = !deterministic && !parsed.flag("no-web-ui") ? await launchDetachedControlCenter(root, process.argv[1], parsed.flag("no-open"), result.agentId) : undefined;
  console.log(`AEH Paseo ready for ${config.project.name}.`);
  console.log(`daemon=${result.daemonStarted ? "started" : "reused"}`);
  console.log(`session=${result.session}`);
  console.log(`lead=${result.leadAgent}`);
  console.log(`provider=${result.provider}`);
  console.log(`model=${result.model}`);
  if (result.paseoVersion) console.log(`paseo=${result.paseoVersion}`);
  console.log(`agentId=${result.agentId}`);
  console.log(`title=${result.title}`);
  if (controlCenter) {
    console.log(`controlCenter=${controlCenter.url}`);
    console.log(`controlCenterSession=${controlCenter.reused ? "reused" : "started"}`);
    if (controlCenter.pairingUrl) console.log(`controlCenterPairing=${controlCenter.pairingUrl}`);
  }
  if (deterministic) console.log("sessionBoundary=deterministic-fake-paseo-sdk");
  console.log(`Open Paseo and continue in '${result.title}'. Engineering operations route through the Harness; normal aeh start creates a fresh lead, while --resume explicitly reuses a compatible one.`);
}

async function runHome(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["port", "registry"]), new Set(["once", "no-open"]));
  if (parsed.positional.length > 1) throw new Error("aeh home accepts at most one registry directory.");
  const registry = createProjectRegistry({ statePath: parsed.value("registry") ?? parsed.positional[0] });
  const center = await createProjectHome({ registry, port: parsed.value("port") ? Number(parsed.value("port")) : 0 });
  const started = await center.start();
  console.log(`AEH Home ready at ${started.url}`);
  console.log(`controlCenterPairing=${started.pairingUrl}`);
  if (parsed.flag("once")) { await center.close(); return; }
  await new Promise<void>((resolve) => {
    const shutdown = () => { void center.close().finally(resolve); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function runControlCenter(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["port", "ready-file"]), new Set(["once", "no-open"]));
  if (parsed.positional.length > 1) throw new Error("aeh control-center accepts at most one project directory.");
  const root = parsed.positional[0] ? path.resolve(parsed.positional[0]) : undefined;
  const config = root ? await loadProjectConfig(root) : undefined;
  const expectedStartLeadId = process.env.AEH_CONTROL_CENTER_PARENT?.trim()
    ? process.env.AEH_CONTROL_CENTER_EXPECTED_LEAD_ID?.trim()
    : undefined;
  const leadBinding = root ? await resolveControlCenterLeadBinding(root, expectedStartLeadId || undefined) : undefined;
  const runtime = root ? await createManagedRuntime({ root, projectId: runtimeProjectId(root), ownerId: `control-center:${process.pid}` }) : undefined;
  const decisionLedger = root ? new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json")) : undefined;
  const center = new LocalControlCenterV1({
    port: parsed.value("port") ? Number(parsed.value("port")) : 0,
    operationRoots: () => root ? [root] : [],
    snapshot: async () => {
      if (!root || !config) return {};
      const portfolio = await loadOperationPortfolio(root, config.project.name);
      const operationRecords = await Promise.all(Object.values(portfolio.operations).map(async (item) => ({ detail: await loadOperation(root, item.operationId) })));
      const operations = operationRecords.map(({ detail }) => projectOperationRecordV1(detail));
      const participants = operations.flatMap((operation) => operation.participants);
      const candidates = operationRecords.flatMap(({ detail }) => detail.candidateRevision
        ? [{ ...detail.candidateRevision, controlCenterId: controlCenterResourceId("candidate", detail.candidateRevision.candidateId) }]
        : []);
      return {
        operations,
        participants,
        candidates,
        services: runtime ? await runtime.snapshot() : { version: 1 as const, capturedAt: new Date().toISOString(), services: [], providerLeases: [] },
        quality: { activeOperations: Object.values(portfolio.operations).filter((item) => item.status === "RUNNING" || item.status === "QUEUED").length }
      };
    },
    ...(root ? { paseoGateway: new PaseoGatewayV1(), paseo: {
      root,
      leadId: leadBinding?.status === "BOUND" ? leadBinding.leadId : undefined,
      resolveLeadId: async () => {
        const current = await resolveControlCenterLeadBinding(root);
        return current.status === "BOUND" ? current.leadId : undefined;
      }
    } } : {}),
    onDecision: root && decisionLedger ? async (value, actorId): Promise<ControlCenterActionResultV1> => {
      const result = await recordControlCenterDecision(root, decisionLedger, value, actorId);
      return {
        accepted: result.accepted === true,
        ...(typeof result.decisionId === "string" ? { decisionId: result.decisionId } : {}),
        ...(typeof result.operationId === "string" ? { operationId: result.operationId } : {}),
        ...(typeof result.candidateRevision === "number" ? { candidateRevision: result.candidateRevision } : {}),
        ...(typeof result.requestId === "string" ? { requestId: result.requestId } : {}),
        ...(typeof result.choiceId === "string" ? { choiceId: result.choiceId } : {})
      };
    } : undefined,
    onCancelOperation: root ? async (operationId, actorId): Promise<ControlCenterActionResultV1> => {
      const result = await cancelOperation(root, operationId, { humanActorId: actorId });
      return { accepted: true, operationId: result.id, status: result.status, phase: result.phase, revision: result.revision };
    } : undefined,
    onPauseOperation: root ? async (operationId, actorId): Promise<ControlCenterActionResultV1> => {
      const decision = await requestOperationPause(root, operationId, actorId);
      const current = await loadOperation(root, operationId);
      return { accepted: true, operationId: current.id, decisionId: decision.decisionId, status: current.status, phase: current.phase, revision: current.revision };
    } : undefined,
    onResumeOperation: root ? async (operationId, actorId): Promise<ControlCenterActionResultV1> => {
      const decision = await requestOperationResume(root, operationId, actorId);
      const current = await loadOperation(root, operationId);
      return { accepted: true, operationId: current.id, decisionId: decision.decisionId, status: current.status, phase: current.phase, revision: current.revision };
    } : undefined
  });
  const started = await center.start();
  const serviceId = runtime ? `control-center:${runtime.projectId}` : undefined;
  let serviceHeartbeat: NodeJS.Timeout | undefined;
  try {
    if (runtime && serviceId) {
      await runtime.registerService({ serviceId, kind: "control-center", status: "READY", pid: process.pid, healthUrl: started.url, metadata: { aehVersion: VERSION, leadBindingMode: "validated-current-session-v1" } });
      serviceHeartbeat = setInterval(() => {
        void runtime.heartbeat(serviceId).catch((error: unknown) => console.error(`Control Center runtime heartbeat failed: ${String(error)}`));
      }, 15_000);
      serviceHeartbeat.unref();
    }
    const readyFile = parsed.value("ready-file");
    if (readyFile) await fs.writeFile(path.resolve(readyFile), `${JSON.stringify({ version: 1, url: started.url, pairingUrl: started.pairingUrl, pid: process.pid })}\n`, { encoding: "utf8", mode: 0o600 });
    console.log(`AEH Project Control Center ready at ${started.url}`);
    console.log(`controlCenterPairing=${started.pairingUrl}`);
    if (parsed.flag("once")) return;
    await new Promise<void>((resolve) => {
      const shutdown = () => { process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown); resolve(); };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } finally {
    if (serviceHeartbeat) clearInterval(serviceHeartbeat);
    await center.close();
    if (runtime) await runtime.drainAndRelease();
  }
}

interface DetachedControlCenterV1 { url: string; pairingUrl?: string; reused: boolean; }

async function launchDetachedControlCenter(root: string, entry: string | undefined, noOpen: boolean, expectedLeadId: string): Promise<DetachedControlCenterV1> {
  if (!entry) throw new Error("Control Center startup failed: the running AEH entry point could not be resolved.");
  const existing = await findReusableControlCenter(root);
  if (existing) {
    if (!noOpen) openControlCenter(existing.url);
    return { ...existing, reused: true };
  }

  const snapshot = await readManagedRuntimeSnapshot(root);
  const serviceId = `control-center:${runtimeProjectId(root)}`;
  const currentService = snapshot.services.find((service) => service.serviceId === serviceId);
  if (currentService && currentService.canonicalRoot === path.resolve(root)
    && currentService.status !== "STOPPED" && currentService.status !== "FAILED" && processIsAlive(currentService.pid)) {
    throw new Error(`Control Center startup failed: active service owner ${currentService.ownerId} is not reusable by this build or failed its loopback health check. Stop the existing service and rerun aeh start.`);
  }

  const readyFile = path.join(root, ".harness", "runtime", `control-center-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`);
  await fs.mkdir(path.dirname(readyFile), { recursive: true, mode: 0o700 });
  await fs.rm(readyFile, { force: true });
  const child = spawn(process.execPath, [entry, "control-center", root, "--ready-file", readyFile], { cwd: root, detached: true, stdio: "ignore", env: { ...process.env, AEH_CONTROL_CENTER_PARENT: String(process.pid), AEH_CONTROL_CENTER_EXPECTED_LEAD_ID: expectedLeadId } });
  child.unref();
  const deadline = Date.now() + 15_000;
  try {
    while (Date.now() < deadline) {
      try {
        const value = JSON.parse(await fs.readFile(readyFile, "utf8")) as { url?: unknown; pairingUrl?: unknown };
        const url = typeof value.url === "string" ? safeControlCenterUrl(value.url) : undefined;
        const pairingUrl = typeof value.pairingUrl === "string" ? safePairingUrl(value.pairingUrl, url) : undefined;
        if (url && pairingUrl) {
          await fs.rm(readyFile, { force: true });
          if (!noOpen) openControlCenter(pairingUrl);
          return { url, pairingUrl, reused: false };
        }
      } catch { /* wait for actual listener readiness */ }

      const reused = await findReusableControlCenter(root);
      if (reused) {
        await fs.rm(readyFile, { force: true });
        if (!noOpen) openControlCenter(reused.url);
        return { ...reused, reused: true };
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await fs.rm(readyFile, { force: true });
  }
  throw new Error("Control Center startup failed: the detached server did not publish a valid ready record, and no compatible healthy project service became available.");
}

async function findReusableControlCenter(root: string): Promise<{ url: string } | undefined> {
  const selected = reusableControlCenterFromSnapshot(root, await readManagedRuntimeSnapshot(root));
  if (!selected || !await controlCenterHealthCheck(selected.url)) return undefined;
  return selected;
}

function processIsAlive(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) return false;
  try { process.kill(pid!, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function safeControlCenterUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname.toLowerCase()) || !url.port
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
    return url.origin + "/";
  } catch { return undefined; }
}

function safePairingUrl(value: string, baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(value);
    const base = new URL(baseUrl);
    if (url.origin !== base.origin || url.pathname !== "/" || url.username || url.password || url.search
      || !/^#pair=[A-Za-z0-9_-]+$/.test(url.hash)) return undefined;
    return url.toString();
  } catch { return undefined; }
}

function openControlCenter(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function runProject(argv: string[]): Promise<void> {
  const subcommand = argv[0] ?? "list";
  const parsed = parseGeneric(argv.slice(1), new Set(["repository", "display-name", "registry"]), new Set());
  const registry = createProjectRegistry({ statePath: parsed.value("registry") });
  if (subcommand === "list") {
    if (parsed.positional.length > 1) throw new Error("aeh project list accepts at most one registry directory.");
    console.log(JSON.stringify(await registry.list(), null, 2));
    return;
  }
  if (subcommand === "register") {
    if (parsed.positional.length > 1) throw new Error("aeh project register accepts one project directory.");
    const root = path.resolve(parsed.positional[0] ?? ".");
    const repository = parsed.value("repository");
    if (!repository) throw new Error("aeh project register requires --repository <canonical-repository-identity>.");
    const config = await loadProjectConfig(root);
    const project = await registry.register({ rootPath: root, repositoryIdentity: repository, displayName: parsed.value("display-name"), config });
    console.log(JSON.stringify(project, null, 2));
    return;
  }
  throw new Error(`Unknown project command '${subcommand}'. Use list or register.`);
}

async function runPaseoTurn(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["decision"]), new Set(["json"]));
  if (parsed.positional.length < 1 || parsed.positional.length > 2) throw new Error("aeh paseo turn accepts <simulated-user-prompt> and at most one project directory.");
  let decision: unknown;
  if (parsed.value("decision")) {
    try { decision = JSON.parse(parsed.value("decision")!); }
    catch (error) { throw new Error(`--decision must contain valid JSON: ${String(error)}`); }
  }
  const result = await runDeterministicPaseoTurn(path.resolve(parsed.positional[1] ?? "."), await loadProjectConfig(path.resolve(parsed.positional[1] ?? ".")), parsed.positional[0], decision as IntentDecisionV1 | undefined);
  if (parsed.flag("json")) console.log(JSON.stringify(result, null, 2));
  else console.log(result.human);
}

async function runContextGuard(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["agent", "brief"]), new Set());
  if (parsed.positional.length > 1) throw new Error("aeh context guard accepts at most one project directory.");
  const root = path.resolve(parsed.positional[0] ?? ".");
  const config = await loadProjectConfig(root);
  const agentId = parsed.value("agent") ?? process.env.PASEO_AGENT_ID;
  if (!agentId) throw new Error("aeh context guard requires --agent <id> or PASEO_AGENT_ID.");
  const result = await guardLeadContext(root, config, agentId, { brief: parsed.value("brief") });
  console.log(result.state);
  console.log(result.message);
  console.log(JSON.stringify(result, null, 2));
}

async function runContextRetrieve(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["ref", "participant", "agent", "max-tokens"]), new Set());
  if (parsed.positional.length > 2) throw new Error("aeh context retrieve accepts <operationId> and at most one project directory.");
  const operationId = parsed.positional[0]; if (!operationId) throw new Error("aeh context retrieve requires <operationId>.");
  const root = path.resolve(parsed.positional[1] ?? "."); const refId = parsed.value("ref"); if (!refId) throw new Error("aeh context retrieve requires --ref <controller-authorized-ref-id>.");
  const participantId = parsed.value("participant") ?? process.env.AEH_CONTEXT_PARTICIPANT_ID ?? process.env.AEH_PARTICIPANT_ID; if (!participantId) throw new Error("aeh context retrieve requires --participant <current-participant-id> or AEH_CONTEXT_PARTICIPANT_ID.");
  const logicalAgent = parsed.value("agent") ?? process.env.AEH_LOGICAL_AGENT; if (!logicalAgent) throw new Error("aeh context retrieve requires --agent <logical-agent> or AEH_LOGICAL_AGENT.");
  const sessionId = process.env.PASEO_AGENT_ID?.trim() || process.env.AEH_CONTEXT_SESSION_ID?.trim();
  const maxTokens = parsed.value("max-tokens") ? Number(parsed.value("max-tokens")) : undefined; if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) throw new Error("--max-tokens must be a positive integer.");
  const config = await loadProjectConfig(root);
  const controlRoot = process.env.AEH_CONTEXT_CONTROL_ROOT?.trim() || process.env.AEH_CONTROL_ROOT?.trim() || root;
  const phase = process.env.AEH_CONTEXT_PHASE?.trim() || "work";
  const result = await retrieveAuthorizedContext(root, controlRoot, operationId, participantId, sessionId, logicalAgent, phase, { refId, requestId: crypto.randomUUID(), maxTokens });
  console.log(JSON.stringify(result, null, 2));
}

async function runPaseoAgents(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["task", "role", "kind", "status"]), new Set(["json"]));
  if (parsed.positional.length > 1) throw new Error("aeh paseo agents accepts at most one project directory.");
  const root = path.resolve(parsed.positional[0] ?? ".");
  const config = await loadProjectConfig(root);
  const labels: Record<string, string> = { "aeh.project": config.project.name };
  if (parsed.value("task")) labels["aeh.task"] = parsed.value("task")!;
  if (parsed.value("role")) labels["aeh.role"] = parsed.value("role")!;
  if (parsed.value("kind")) labels["aeh.kind"] = parsed.value("kind")!;
  const requestedStatus = parsed.value("status");
  const agents = (await listManagedPaseoAgents(root, labels)).filter((agent) => !requestedStatus || agent.status === requestedStatus);
  const view = agents.map((agent) => ({ id: agent.id, status: agent.status ?? "unknown", title: agent.title, workspaceId: agent.workspaceId, role: agent.labels?.["aeh.role"], task: agent.labels?.["aeh.task"], kind: agent.labels?.["aeh.kind"], labels: agent.labels }));
  if (parsed.flag("json")) { console.log(JSON.stringify(view, null, 2)); return; }
  if (!view.length) { console.log("No matching active AEH Paseo agents."); return; }
  for (const agent of view) console.log(`${agent.status.padEnd(12)} role=${(agent.role ?? "-").padEnd(24)} task=${(agent.task ?? "-").padEnd(24)} kind=${(agent.kind ?? "-").padEnd(8)} id=${agent.id}${agent.title ? ` title=${agent.title}` : ""}`);
}

async function runSpec(argv: string[]): Promise<void> {
  const sub = argv[0];
  const parsed = parseGeneric(argv.slice(1), new Set(["title", "change"]), new Set());
  const taskId = parsed.positional[0];
  if (!taskId) throw new Error(`aeh spec ${sub} requires <taskId>.`);
  if (parsed.positional.length > 2) throw new Error(`aeh spec ${sub} accepts <taskId> and at most one project directory.`);
  const root = path.resolve(parsed.positional[1] ?? ".");
  const title = parsed.value("title");
  if (!title) throw new Error(`aeh spec ${sub} requires --title <title>.`);
  const config = await loadProjectConfig(root);
  if (sub === "prepare") {
    const result = await prepareOpenSpecChange(root, config, taskId, title);
    console.log(`OPENSPEC ${result.created ? "CREATED" : "READY"} ${result.changeName}`);
    console.log(`manager=${result.managerAgent}`);
    console.log(`schema=${result.schema}`);
    console.log(`directory=${path.relative(root, result.directory).replaceAll("\\", "/")}`);
    return;
  }
  if (sub === "compile") {
    const result = await compileOpenSpecChange(root, config, taskId, title, parsed.value("change"));
    console.log(`COMPILED ${result.changeName} -> ${taskId}`);
    console.log(`requirements=${result.requirements.join(",")}`);
    console.log(`sourceSha256=${result.sourceSha256}`);
    console.log(`contract=${path.relative(root, result.contractPath).replaceAll("\\", "/")}`);
    return;
  }
  throw new Error(`Unknown spec command '${sub}'. Use prepare or compile.`);
}

async function runIntent(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["file", "domain", "risk"]), new Set());
  const request = parsed.positional[0];
  if (!request) throw new Error("aeh intent requires a natural-language request.");
  if (parsed.positional.length > 2) throw new Error("aeh intent accepts <request> and at most one project directory.");
  const root = path.resolve(parsed.positional[1] ?? ".");
  const config = await loadProjectConfig(root);
  const runtime = await createSemanticAssessmentRuntimeV1(root, config);
  const binding = await createSemanticRepositoryBindingV1(root, config);
  const decision = await classifyEngineeringIntentWithSemanticAssessment(config, { request, files: parsed.values("file"), domains: parsed.values("domain"), risk: parseRisk(parsed.value("risk")) }, { service: runtime.service, binding, policyRevision: runtime.policyRevision });
  console.log(formatEngineeringIntent(decision));
  console.log(JSON.stringify(decision, null, 2));
}

async function runAuditCommand(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["file", "domain", "risk", "reviewer"]), new Set());
  const request = parsed.positional[0];
  if (!request) throw new Error("aeh audit requires a natural-language audit request.");
  if (parsed.positional.length > 2) throw new Error("aeh audit accepts <request> and at most one project directory.");
  const root = path.resolve(parsed.positional[1] ?? ".");
  const config = await loadProjectConfig(root);
  const report = await runAudit(root, config, { request, intentDecision: createIntentDecision("audit", request, "explicit-cli"), files: parsed.values("file"), domains: parsed.values("domain"), risk: parseRisk(parsed.value("risk")), reviewers: parsed.values("reviewer") });
  console.log(`AUDIT ${report.status} — ${report.auditId}`);
  console.log(`productionSafe=${report.productionSafe}`);
  console.log(`findings critical=${report.counts.critical} high=${report.counts.high} medium=${report.counts.medium} low=${report.counts.low} note=${report.counts.note}`);
  console.log(`debtScore=${report.debtScore}`);
  for (const check of report.validationChecks.filter((item) => item.status !== "PASS" && item.status !== "SKIP")) console.log(`validator ${check.status} ${check.id} class=${check.failureClass}: ${check.message}`);
  for (const finding of report.findings) console.log(`${finding.severity.toUpperCase()} ${finding.id} ${finding.location.file}: ${finding.evidence}`);
  console.log(`report=.harness/audits/${report.auditId}.json`);
}

async function runSetup(argv: string[]): Promise<void> {
  const parsed = parse(argv); const root = path.resolve(parsed.directory); const config = await loadProjectConfig(root);
  const result = await setupToolchain(root, config, { profile: parsed.value("profile"), dryRun: parsed.flag("dry-run"), updateLock: parsed.flag("update-lock"), skipProjectDependencies: parsed.flag("skip-project-deps"), preferContainers: parsed.flag("prefer-containers") });
  console.log(`${result.dryRun ? "DRY-RUN" : "READY"} toolchain profile=${result.profile}`); console.log(`miseConfig=${result.generatedConfig}`); console.log(`lock=${result.lockFile}`); console.log(`state=${result.stateFile}`); if (result.installed.length) console.log(`tools=${result.installed.join(", ")}`); if (result.containers.length) console.log(`containers=${result.containers.join(", ")}`); if (result.projectDependencyCommands.length) console.log(`projectDeps=${result.projectDependencyCommands.join(" && ")}`); if (result.systemMissing.length) { console.error(`missingSystem=${result.systemMissing.join(", ")}`); process.exitCode = 1; }
}
async function runToolchain(argv: string[]): Promise<void> { const sub = argv[0] ?? "show"; const parsed = parse(argv.slice(1)); const root = path.resolve(parsed.directory); const config = await loadProjectConfig(root); if (sub === "compile") { console.log(`Compiled toolchain: ${await compileToolchain(root, config, { profile: parsed.value("profile"), updateLock: parsed.flag("update-lock") })}`); return; } if (sub === "show") { const tc = await loadToolchainConfig(root, config); console.log(JSON.stringify(await resolveToolchain(root, config, tc, { profile: parsed.value("profile") }), null, 2)); return; } if (sub === "setup") { await runSetup(argv.slice(1)); return; } throw new Error(`Unknown toolchain command '${sub}'. Use compile, show or setup.`); }
async function runInitSetup(argv: string[]): Promise<void> { const without = argv.filter((value) => value !== "--setup"); const parsed = parse(without); const root = path.resolve(parsed.directory); const created = await initializeProject(root); const config = await loadProjectConfig(root); if (config.agents) { const compiled = await compileAgentTopology(root, config); if (!compiled.ok) throw new Error(compiled.issues.join("; ")); } await compileToolchain(root, config); const setup = await setupToolchain(root, config, { profile: parsed.value("profile"), preferContainers: parsed.flag("prefer-containers") }); console.log(created.length ? `Created: ${created.join(", ")}` : "Harness already initialized."); console.log(`Toolchain ready: profile=${setup.profile}`); }

async function runWorker(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "run"; const parsed = parseGeneric(argv.slice(1), new Set(["worker-id", "port", "host"]), new Set(["once"])); const root = path.resolve(parsed.positional[0] ?? "."); const config = await loadProjectConfig(root);
  if (sub === "run") { await runDistributedWorkerLoop(root, config, { workerId: parsed.value("worker-id"), once: parsed.flag("once") }); return; }
  if (sub === "serve") { const port = Number(parsed.value("port") ?? "8787"); if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("--port must be a valid TCP port."); const localConfig = { ...config, distributed: { ...config.distributed, provider: "filesystem" as const } }; await serveDistributedQueue(root, localConfig, { port, host: parsed.value("host") }); console.log(`AEH distributed queue listening on ${parsed.value("host") ?? "127.0.0.1"}:${port}`); await new Promise<void>(() => undefined); return; }
  throw new Error(`Unknown worker command '${sub}'. Use run or serve.`);
}

async function runPolicySync(argv: string[]): Promise<void> { const parsed = parseGeneric(argv, new Set(), new Set()); const root = path.resolve(parsed.positional[0] ?? "."); const config = await loadProjectConfig(root); const resolution = await resolveOrganizationPolicyBundles(root, config); console.log(JSON.stringify(resolution, null, 2)); if (resolution.issues.length && config.organization?.policyBundles?.required) process.exitCode = 1; }
async function runMcpBenchmark(argv: string[]): Promise<void> { const parsed = parseGeneric(argv, new Set(["server"]), new Set()); const root = path.resolve(parsed.positional[0] ?? "."); const config = await loadProjectConfig(root); const servers = parsed.values("server"); console.log(JSON.stringify(await benchmarkMcpCatalog(root, config, servers.length ? servers : undefined), null, 2)); }
async function runStatisticalEval(argv: string[]): Promise<void> { const sub = argv[0]; const parsed = parseGeneric(argv.slice(1), new Set(["variant", "runs"]), new Set()); const caseId = parsed.positional[0]; if (!caseId) throw new Error(`aeh eval ${sub} requires <caseId>.`); const root = path.resolve(parsed.positional[1] ?? "."); const config = await loadProjectConfig(root); if (sub === "repeat") { const runs = parsed.value("runs") ? Number(parsed.value("runs")) : undefined; console.log(JSON.stringify(await runRepeatedEval(root, config, caseId, parsed.value("variant"), runs), null, 2)); return; } console.log(JSON.stringify(await buildEvalDashboard(root, config, caseId), null, 2)); }

function parseRisk(value?: string): TaskRisk { if (!value) return "low"; if (value === "low" || value === "medium" || value === "high") return value; throw new Error(`Invalid risk '${value}'. Use low, medium or high.`); }
function parse(argv: string[]): { directory: string; flag(name: string): boolean; value(name: string): string | undefined } { const parsed = parseGeneric(argv, new Set(["profile"]), new Set(["dry-run", "update-lock", "skip-project-deps", "prefer-containers"])); if (parsed.positional.length > 1) throw new Error(`Expected at most one project directory, received: ${parsed.positional.join(", ")}`); return { directory: parsed.positional[0] ?? ".", flag: parsed.flag, value: parsed.value }; }
function parseGeneric(argv: string[], valueFlags: Set<string>, booleanFlags: Set<string>): { positional: string[]; flag(name: string): boolean; value(name: string): string | undefined; values(name: string): string[] } {
  const flags = new Map<string, Array<string | true>>(); const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) { const token = argv[i]; if (!token.startsWith("--")) { positional.push(token); continue; } const name = token.slice(2); if (valueFlags.has(name)) { const next = argv[++i]; if (!next || next.startsWith("--")) throw new Error(`--${name} requires a value.`); const list = flags.get(name) ?? []; list.push(next); flags.set(name, list); continue; } if (!booleanFlags.has(name)) throw new Error(`Unknown option --${name}.`); const list = flags.get(name) ?? []; list.push(true); flags.set(name, list); }
  return { positional, flag: (name) => flags.get(name)?.includes(true) ?? false, value: (name) => { const found = flags.get(name)?.find((item): item is string => typeof item === "string"); return found; }, values: (name) => (flags.get(name) ?? []).filter((item): item is string => typeof item === "string") };
}
