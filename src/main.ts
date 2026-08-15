#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { loadProjectConfig } from "./core/config.js";
import { cancelOperation, executeOperation, startDetachedOperation, waitForOperation } from "./operations/controller.js";
import { assertHarnessWorkflowEntryAllowed, isSideEffectFreeMetaInvocation } from "./operations/executionContext.js";
import { promoteInteractiveOperation } from "./operations/interactive.js";
import { monitorOperationLiveness } from "./operations/liveness.js";
import { serveOperationMcp } from "./operations/mcp.js";
import { spawnOperationMonitor } from "./operations/monitorProcess.js";
import { loadOperationPortfolio } from "./operations/portfolio.js";
import { loadOperation, type AuditOperationPayload, type ChangeOperationPayload, type RunOperationPayload } from "./operations/state.js";
import { listManagedPaseoAgents } from "./paseo/runtime.js";
import { planSelfCheckoutRuntime, resolveStartProjectRoot } from "./runtime/invocation.js";
import { VERSION } from "./version.js";
import { createIntentDecision } from "./audit/intentDecision.js";

const args = process.argv.slice(2);
assertHarnessWorkflowEntryAllowed(args);

if (printControlPlaneMetaHelp(args)) process.exit(process.exitCode ?? 0);

if (args[0] === "start" && !isSideEffectFreeMetaInvocation(args)) {
  const root = resolveStartProjectRoot(args.slice(1));
  if (await relaunchSelfCheckoutIfNeeded(root)) process.exit(process.exitCode ?? 0);
  console.log(`aehRuntime=${VERSION}`);
  console.log(`aehEntry=${path.resolve(process.argv[1])}`);
}

const promotion = promoteInteractiveOperation(args);
if (promotion) {
  console.log(`interactivePromotion=detached-${promotion.kind}`);
  await runOperationStart(promotion.operationArgv);
  process.exit(process.exitCode ?? 0);
}

if (args[0] === "operation") {
  await runOperationCommand(args.slice(1));
  process.exit(process.exitCode ?? 0);
}

if (args[0] === "paseo" && args[1] === "agents" && hasOperationFilter(args.slice(2))) {
  await runOperationAwarePaseoAgents(args.slice(2));
  process.exit(process.exitCode ?? 0);
}

if (args.length === 1 && ["--help", "-h"].includes(args[0])) printControlPlaneHelp();
await import("./entry.js");

async function relaunchSelfCheckoutIfNeeded(root: string): Promise<boolean> {
  if (process.env.AEH_SELF_REEXEC === "1") return false;
  const plan = await planSelfCheckoutRuntime(root, process.argv[1]);
  if (!plan.shouldRelaunch) return false;
  if (!plan.localEntryReady) {
    throw new Error(
      `AEH source checkout detected at ${root}, but ${plan.localEntry} is not built. ` +
      "Run 'npm ci && npm run build', then start with 'npm run aeh -- start'. " +
      "Refusing to create a lead from an external/npm-exec runtime because it can be stale."
    );
  }
  console.log(`aehRuntimeRedirect=${plan.currentEntry} -> ${plan.localEntry}`);
  const exitCode = await spawnAndWait(process.execPath, [plan.localEntry, ...args], {
    cwd: root,
    env: { ...process.env, AEH_SELF_REEXEC: "1" }
  });
  process.exitCode = exitCode;
  return true;
}

function spawnAndWait(command: string, argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: options.cwd, env: options.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

async function runOperationCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub === "start") return runOperationStart(argv.slice(1));
  if (sub === "execute") return runOperationExecute(argv.slice(1));
  if (sub === "monitor") return runOperationMonitor(argv.slice(1));
  if (sub === "status") return runOperationStatus(argv.slice(1));
  if (sub === "portfolio") return runOperationPortfolio(argv.slice(1));
  if (sub === "wait") return runOperationWait(argv.slice(1));
  if (sub === "cancel") return runOperationCancel(argv.slice(1));
  if (sub === "mcp") return serveOperationMcp();
  throw new Error("aeh operation requires start, status, portfolio, wait, cancel, mcp, or internal execute/monitor.");
}

async function runOperationStart(argv: string[]): Promise<void> {
  const kind = argv[0];
  if (kind !== "audit" && kind !== "run" && kind !== "change") {
    throw new Error("aeh operation start requires audit, run or change.");
  }
  const valueFlags = new Set<string>(
    kind === "audit"
      ? ["file", "domain", "risk", "reviewer", "priority"]
      : kind === "run"
        ? ["profile", "priority"]
        : ["file", "domain", "risk", "accept", "profile", "priority", "title", "task"]
  );
  const parsed = parseFlags(argv.slice(1), valueFlags, new Set());
  const subject = parsed.positional[0];
  if (!subject) throw new Error(`aeh operation start ${kind} requires ${kind === "run" ? "<taskId>" : "<request>"}.`);
  if (parsed.positional.length > 2) throw new Error(`aeh operation start ${kind} accepts a subject and at most one project directory.`);
  const root = path.resolve(parsed.positional[1] ?? ".");
  await loadProjectConfig(root);

  const priority = parsePriority(parsed.value("priority"));
  let payload: AuditOperationPayload | RunOperationPayload | ChangeOperationPayload;
  if (kind === "audit") {
    payload = {
      request: subject,
      intentDecision: createIntentDecision("audit", subject, "explicit-cli"),
      files: parsed.values("file"),
      domains: parsed.values("domain"),
      risk: parseRisk(parsed.value("risk")),
      reviewers: parsed.values("reviewer")
    };
  } else if (kind === "run") {
    payload = { taskId: subject, intentDecision: createIntentDecision("run", `execute prepared task ${subject}`, "explicit-cli"), profile: parsed.value("profile"), priority };
  } else {
    payload = {
      request: subject,
      intentDecision: createIntentDecision("change", subject, "explicit-cli"),
      title: parsed.value("title"),
      taskId: parsed.value("task"),
      files: parsed.values("file"),
      domains: parsed.values("domain"),
      acceptance: parsed.values("accept"),
      risk: parseRisk(parsed.value("risk")),
      profile: parsed.value("profile"),
      priority
    };
  }

  const record = await startDetachedOperation(root, kind, payload, {
    nodeExecutable: process.execPath,
    entryFile: path.resolve(process.argv[1])
  });
  await spawnOperationMonitor(root, record, {
    nodeExecutable: process.execPath,
    entryFile: path.resolve(process.argv[1])
  });
  printOperation(record, false);
}

async function runOperationExecute(argv: string[]): Promise<void> {
  const operationId = argv[0];
  if (!operationId) throw new Error("aeh operation execute requires <operationId>.");
  if (argv.length > 2) throw new Error("aeh operation execute accepts <operationId> and at most one project directory.");
  const root = path.resolve(argv[1] ?? ".");
  const record = await executeOperation(root, operationId);
  if (record.status === "FAILED") process.exitCode = 1;
}

async function runOperationMonitor(argv: string[]): Promise<void> {
  const operationId = argv[0];
  if (!operationId) throw new Error("aeh operation monitor requires <operationId>.");
  if (argv.length > 2) throw new Error("aeh operation monitor accepts <operationId> and at most one project directory.");
  const root = path.resolve(argv[1] ?? ".");
  const config = await loadProjectConfig(root);
  // Let the controller's immediate terminal callback fast-path settle first.
  // The detached monitor is the recovery/liveness path that outlives it.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  await monitorOperationLiveness(root, config, operationId);
}

async function runOperationStatus(argv: string[]): Promise<void> {
  const parsed = parseFlags(argv, new Set(), new Set(["json"]));
  const operationId = parsed.positional[0];
  if (!operationId) throw new Error("aeh operation status requires <operationId>.");
  if (parsed.positional.length > 2) throw new Error("aeh operation status accepts <operationId> and at most one project directory.");
  printOperation(await loadOperation(path.resolve(parsed.positional[1] ?? "."), operationId), parsed.flag("json"));
}

async function runOperationPortfolio(argv: string[]): Promise<void> {
  const parsed = parseFlags(argv, new Set(), new Set(["json"]));
  if (parsed.positional.length > 1) throw new Error("aeh operation portfolio accepts at most one project directory.");
  const root = path.resolve(parsed.positional[0] ?? ".");
  const config = await loadProjectConfig(root);
  const portfolio = await loadOperationPortfolio(root, config.project.name);
  if (parsed.flag("json")) {
    console.log(JSON.stringify(portfolio, null, 2));
    return;
  }
  const entries = Object.values(portfolio.operations).sort((a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt));
  console.log(`lead=${portfolio.leadAgentId ?? "-"} generation=${portfolio.leadGeneration} activeOperations=${entries.filter((item) => item.status === "QUEUED" || item.status === "RUNNING").length}`);
  for (const item of entries) {
    console.log(`${item.status.padEnd(10)} priority=${String(item.priority).padStart(3)} phase=${item.phase.padEnd(20)} rev=${String(item.revision).padStart(4)} ack=${String(item.acknowledgedRevision).padStart(4)} kind=${item.kind.padEnd(7)} op=${item.operationId} supervisor=${item.supervisorAgentId ?? "-"}`);
  }
}

async function runOperationWait(argv: string[]): Promise<void> {
  const parsed = parseFlags(argv, new Set(["timeout"]), new Set(["json"]));
  const operationId = parsed.positional[0];
  if (!operationId) throw new Error("aeh operation wait requires <operationId>.");
  if (parsed.positional.length > 2) throw new Error("aeh operation wait accepts <operationId> and at most one project directory.");
  const timeoutSeconds = Number(parsed.value("timeout") ?? "1800");
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("--timeout must be a positive number of seconds.");
  const record = await waitForOperation(path.resolve(parsed.positional[1] ?? "."), operationId, timeoutSeconds * 1000);
  printOperation(record, parsed.flag("json"));
  if (record.status === "FAILED") process.exitCode = 1;
  if (record.status === "CANCELLED") process.exitCode = 130;
}

async function runOperationCancel(argv: string[]): Promise<void> {
  if (!argv[0]) throw new Error("aeh operation cancel requires <operationId>.");
  if (argv.length > 2) throw new Error("aeh operation cancel accepts <operationId> and at most one project directory.");
  printOperation(await cancelOperation(path.resolve(argv[1] ?? "."), argv[0]), false);
}

async function runOperationAwarePaseoAgents(argv: string[]): Promise<void> {
  const parsed = parseFlags(argv, new Set(["task", "role", "kind", "status", "operation", "operation-kind", "phase"]), new Set(["json"]));
  if (parsed.positional.length > 1) throw new Error("aeh paseo agents accepts at most one project directory.");
  const root = path.resolve(parsed.positional[0] ?? ".");
  const config = await loadProjectConfig(root);
  const labels: Record<string, string> = { "aeh.project": config.project.name };
  for (const [flag, label] of [
    ["task", "aeh.task"], ["role", "aeh.role"], ["kind", "aeh.kind"], ["operation", "aeh.operation"],
    ["operation-kind", "aeh.operation.kind"], ["phase", "aeh.operation.phase"]
  ] as const) if (parsed.value(flag)) labels[label] = parsed.value(flag)!;
  const requestedStatus = parsed.value("status");
  const agents = (await listManagedPaseoAgents(root, labels)).filter((agent) => !requestedStatus || agent.status === requestedStatus);
  const view = agents.map((agent) => ({
    id: agent.id,
    status: agent.status ?? "unknown",
    title: agent.title,
    workspaceId: agent.workspaceId,
    role: agent.labels?.["aeh.role"],
    task: agent.labels?.["aeh.task"],
    kind: agent.labels?.["aeh.kind"],
    operation: agent.labels?.["aeh.operation"],
    operationKind: agent.labels?.["aeh.operation.kind"],
    phase: agent.labels?.["aeh.operation.phase"],
    parentAgent: agent.labels?.["aeh.parent-agent"],
    supervisorGeneration: agent.labels?.["aeh.supervisor.generation"],
    workspaceKind: agent.labels?.["aeh.workspace.kind"],
    labels: agent.labels
  }));
  if (parsed.flag("json")) { console.log(JSON.stringify(view, null, 2)); return; }
  if (!view.length) { console.log("No matching active AEH Paseo agents."); return; }
  for (const agent of view) console.log(`${agent.status.padEnd(12)} role=${(agent.role ?? "-").padEnd(24)} op=${(agent.operation ?? "-").padEnd(30)} phase=${(agent.phase ?? "-").padEnd(14)} task=${(agent.task ?? "-").padEnd(24)} parent=${agent.parentAgent ?? "-"} id=${agent.id}${agent.title ? ` title=${agent.title}` : ""}`);
}

function printOperation(record: Awaited<ReturnType<typeof loadOperation>>, json: boolean): void {
  if (json) { console.log(JSON.stringify(record, null, 2)); return; }
  console.log(`operationId=${record.id}`);
  console.log(`kind=${record.kind}`);
  console.log(`status=${record.status}`);
  console.log(`phase=${record.phase}`);
  console.log(`revision=${record.revision}`);
  console.log(`progress=${record.progress.completed}/${record.progress.expected} completed, ${record.progress.running} running, ${record.progress.failed} failed, ${record.progress.blocked} blocked`);
  const supervisor = record.supervision.generations.find((item) => item.generation === record.supervision.activeGeneration);
  if (supervisor) console.log(`supervisor=g${supervisor.generation}:${supervisor.status}:${supervisor.agentId ?? "unmaterialized"}`);
  if (record.workspaceId) console.log(`workspaceId=${record.workspaceId}`);
  if (record.workspaceRoot) console.log(`workspaceRoot=${record.workspaceRoot}`);
  if (record.workspaceWarning) console.log(`workspaceWarning=${record.workspaceWarning}`);
  if (record.error) console.log(`error=${record.error.split("\n", 1)[0]}`);
  if (record.result) console.log(`result=${JSON.stringify(record.result)}`);
}

function printControlPlaneMetaHelp(argv: string[]): boolean {
  if (!isSideEffectFreeMetaInvocation(argv)) return false;
  const command = argv[0];
  if (command === "audit") {
    console.log("Usage: aeh audit <request> [directory] [--file <path>] [--domain <name>] [--risk low|medium|high] [--reviewer <agent>]");
    console.log("Run a read-only engineering audit. Managed interactive leads normally use detached operation start; bounded agents may inspect this help without entering another workflow.");
    return true;
  }
  if (command === "start") {
    console.log("Usage: aeh start [directory] [--lead <agent>] [--title <title>] [--new|--resume] [--no-web-ui] [--no-setup]");
    console.log("Start a managed Paseo lead. A normal start creates a fresh lead; --resume explicitly reuses a compatible one.");
    return true;
  }
  if (command === "operation") {
    console.log("Usage: aeh operation start audit|run|change ... | status|portfolio|wait|cancel ...");
    console.log("Detached operation control. Internal execute/monitor processes own workflow execution and durable liveness.");
    return true;
  }
  return false;
}

function printControlPlaneHelp(): void {
  console.log("AEH control-plane commands (in addition to the core command tree below):");
  console.log("  start [directory]                              Start a fresh managed Paseo lead");
  console.log("  context guard [directory]                     Inspect managed-lead context pressure");
  console.log("  context retrieve <operationId> --fragment <id> Retrieve an authorized raw context artifact");
  console.log("  intent <request> [directory]                  Classify INFORMATIONAL/AUDIT/CHANGE intent");
  console.log("  audit <request> [directory]                   Synchronous audit compatibility entrypoint");
  console.log("  operation start audit|run|change ...          Start a detached supervised operation");
  console.log("  operation portfolio [directory]               Inspect the lead's operation portfolio");
  console.log("  operation status|wait|cancel <operationId>    Observe/control a detached operation");
  console.log("  paseo agents [directory]                      Inspect AEH-managed Paseo agents");
  console.log("  setup [directory]                             Reconcile the managed engineering toolchain");
  console.log("  spec prepare|compile ...                      OpenSpec-backed SPEC authoring bridge");
  console.log("");
}

function hasOperationFilter(argv: string[]): boolean { return argv.some((value) => value === "--operation" || value === "--operation-kind" || value === "--phase"); }
function parseRisk(value?: string): "low" | "medium" | "high" | undefined { if (!value) return undefined; if (value === "low" || value === "medium" || value === "high") return value; throw new Error(`Invalid risk '${value}'. Use low, medium or high.`); }
function parsePriority(value?: string): number | undefined { if (value === undefined) return undefined; const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new Error("--priority must be a number from 0 to 100."); return Math.round(parsed); }

function parseFlags(argv: string[], valueFlags: Set<string>, booleanFlags: Set<string>): { positional: string[]; flag(name: string): boolean; value(name: string): string | undefined; values(name: string): string[] } {
  const flags = new Map<string, Array<string | true>>(); const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const name = token.slice(2);
    if (valueFlags.has(name)) {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`--${name} requires a value.`);
      const list = flags.get(name) ?? []; list.push(next); flags.set(name, list); continue;
    }
    if (!booleanFlags.has(name)) throw new Error(`Unknown option --${name}.`);
    const list = flags.get(name) ?? []; list.push(true); flags.set(name, list);
  }
  return {
    positional,
    flag: (name) => flags.get(name)?.includes(true) ?? false,
    value: (name) => flags.get(name)?.find((item): item is string => typeof item === "string"),
    values: (name) => (flags.get(name) ?? []).filter((item): item is string => typeof item === "string")
  };
}
