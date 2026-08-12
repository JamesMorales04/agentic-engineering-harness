#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { loadProjectConfig } from "./core/config.js";
import { cancelOperation, executeOperation, startDetachedOperation, waitForOperation } from "./operations/controller.js";
import { loadOperation, type AuditOperationPayload, type RunOperationPayload } from "./operations/state.js";
import { listManagedPaseoAgents } from "./paseo/runtime.js";

const args = process.argv.slice(2);

if (args[0] === "operation") {
  await runOperationCommand(args.slice(1));
  process.exit(process.exitCode ?? 0);
}

if (args[0] === "paseo" && args[1] === "agents" && hasOperationFilter(args.slice(2))) {
  await runOperationAwarePaseoAgents(args.slice(2));
  process.exit(process.exitCode ?? 0);
}

await import("./entry.js");

async function runOperationCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub === "start") return runOperationStart(argv.slice(1));
  if (sub === "execute") return runOperationExecute(argv.slice(1));
  if (sub === "status") return runOperationStatus(argv.slice(1));
  if (sub === "wait") return runOperationWait(argv.slice(1));
  if (sub === "cancel") return runOperationCancel(argv.slice(1));
  throw new Error("aeh operation requires start, status, wait, cancel, or internal execute.");
}

async function runOperationStart(argv: string[]): Promise<void> {
  const kind = argv[0];
  if (kind !== "audit" && kind !== "run") throw new Error("aeh operation start requires audit or run.");
  const parsed = parseFlags(argv.slice(1), new Set(kind === "audit" ? ["file", "domain", "risk", "reviewer"] : ["profile"]), new Set());
  const subject = parsed.positional[0];
  if (!subject) throw new Error(`aeh operation start ${kind} requires ${kind === "audit" ? "<request>" : "<taskId>"}.`);
  if (parsed.positional.length > 2) throw new Error(`aeh operation start ${kind} accepts a subject and at most one project directory.`);
  const root = path.resolve(parsed.positional[1] ?? ".");
  await loadProjectConfig(root);
  const payload: AuditOperationPayload | RunOperationPayload = kind === "audit"
    ? {
        request: subject,
        files: parsed.values("file"),
        domains: parsed.values("domain"),
        risk: parseRisk(parsed.value("risk")),
        reviewers: parsed.values("reviewer")
      }
    : { taskId: subject, profile: parsed.value("profile") };
  const record = await startDetachedOperation(root, kind, payload, {
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

async function runOperationStatus(argv: string[]): Promise<void> {
  const parsed = parseFlags(argv, new Set(), new Set(["json"]));
  const operationId = parsed.positional[0];
  if (!operationId) throw new Error("aeh operation status requires <operationId>.");
  if (parsed.positional.length > 2) throw new Error("aeh operation status accepts <operationId> and at most one project directory.");
  printOperation(await loadOperation(path.resolve(parsed.positional[1] ?? "."), operationId), parsed.flag("json"));
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
    ["task", "aeh.task"],
    ["role", "aeh.role"],
    ["kind", "aeh.kind"],
    ["operation", "aeh.operation"],
    ["operation-kind", "aeh.operation.kind"],
    ["phase", "aeh.operation.phase"]
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
    workspaceKind: agent.labels?.["aeh.workspace.kind"],
    labels: agent.labels
  }));
  if (parsed.flag("json")) { console.log(JSON.stringify(view, null, 2)); return; }
  if (!view.length) { console.log("No matching active AEH Paseo agents."); return; }
  for (const agent of view) console.log(`${agent.status.padEnd(12)} role=${(agent.role ?? "-").padEnd(24)} op=${(agent.operation ?? "-").padEnd(30)} phase=${(agent.phase ?? "-").padEnd(14)} task=${(agent.task ?? "-").padEnd(24)} id=${agent.id}${agent.title ? ` title=${agent.title}` : ""}`);
}

function printOperation(record: Awaited<ReturnType<typeof loadOperation>>, json: boolean): void {
  if (json) { console.log(JSON.stringify(record, null, 2)); return; }
  console.log(`operationId=${record.id}`);
  console.log(`kind=${record.kind}`);
  console.log(`status=${record.status}`);
  console.log(`phase=${record.phase}`);
  if (record.workspaceId) console.log(`workspaceId=${record.workspaceId}`);
  if (record.workspaceWarning) console.log(`workspaceWarning=${record.workspaceWarning}`);
  if (record.error) console.log(`error=${record.error.split("\n", 1)[0]}`);
  if (record.result) console.log(`result=${JSON.stringify(record.result)}`);
}

function hasOperationFilter(argv: string[]): boolean { return argv.some((value) => value === "--operation" || value === "--operation-kind" || value === "--phase"); }
function parseRisk(value?: string): "low" | "medium" | "high" | undefined { if (!value) return undefined; if (value === "low" || value === "medium" || value === "high") return value; throw new Error(`Invalid risk '${value}'. Use low, medium or high.`); }

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
