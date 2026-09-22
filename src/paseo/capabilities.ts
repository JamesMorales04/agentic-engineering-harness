import type { ProcessResult } from "../utils/process.js";
import { runShell } from "../utils/process.js";

export interface PaseoDaemonCapabilities {
  version?: string;
  daemonJson: boolean;
}

export interface PaseoCapabilities extends PaseoDaemonCapabilities {
  background: boolean;
  quiet: boolean;
  json: boolean;
  outputSchema: boolean;
  nativeToolsRecommended: boolean;
}

export interface PaseoBackgroundRunOptions {
  title: string;
  provider: string;
  model?: string;
  workspaceId?: string;
  prompt: string;
}

type Runner = typeof runShell;

/**
 * Minimal CLI discovery needed by daemon bootstrap. This deliberately does not
 * inspect `paseo run --help`; run flags belong to the compatibility CLI runtime
 * and are probed only if that fallback is actually needed.
 */
export async function detectPaseoDaemonCapabilities(
  root: string,
  run: Runner = runShell
): Promise<PaseoDaemonCapabilities> {
  const [versionResult, daemonHelp] = await Promise.all([
    run("paseo --version", { cwd: root, timeoutMs: 15_000 }),
    run("paseo daemon status --help", { cwd: root, timeoutMs: 15_000 })
  ]);
  const version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  const daemonText = `${daemonHelp.stdout}\n${daemonHelp.stderr}`;
  return {
    version,
    daemonJson: hasOption(daemonText, "--json")
  };
}

/**
 * Full CLI runtime negotiation. Call this only when AEH is about to use the
 * Paseo CLI compatibility execution path.
 */
export async function detectPaseoCapabilities(
  root: string,
  run: Runner = runShell
): Promise<PaseoCapabilities> {
  const [daemon, runHelp] = await Promise.all([
    detectPaseoDaemonCapabilities(root, run),
    run("paseo run --help", { cwd: root, timeoutMs: 15_000 })
  ]);
  const runText = `${runHelp.stdout}\n${runHelp.stderr}`;
  return {
    ...daemon,
    background: hasOption(runText, "--background"),
    quiet:
      hasOption(runText, "--quiet") ||
      hasOption(runText, "-q") ||
      semverAtLeast(daemon.version, [0, 4, 0]),
    json: hasOption(runText, "--json"),
    outputSchema: hasOption(runText, "--output-schema"),
    nativeToolsRecommended: semverAtLeast(daemon.version, [0, 4, 0])
  };
}

export function buildPaseoBackgroundRunCommand(
  options: PaseoBackgroundRunOptions,
  capabilities: PaseoCapabilities
): string {
  if (!capabilities.background) {
    throw new Error(
      `Installed Paseo${capabilities.version ? ` ${capabilities.version}` : ""} does not advertise background runs.`
    );
  }
  const parts = ["paseo run", "--background"];
  if (capabilities.json) parts.push("--json");
  else if (capabilities.quiet) parts.push("--quiet");
  parts.push(`--title ${quote(options.title)}`, `--provider ${quote(options.provider)}`);
  if (options.workspaceId) parts.push(`--workspace ${quote(options.workspaceId)}`);
  if (options.model) parts.push(`--model ${quote(options.model)}`);
  parts.push(quote(options.prompt));
  return parts.join(" ");
}

export function extractPaseoAgentId(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const id = findId(parsed);
    if (id) return id;
  } catch {
    // Older Paseo emits plain text.
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.reverse()) {
    const direct = line.match(
      /^(?:agent(?:Id)?[=: ]+)?([A-Za-z0-9][A-Za-z0-9._:-]{2,})$/i
    )?.[1];
    if (direct) return direct;
    const embedded = line.match(
      /(?:agent(?:Id)?|id)["'=:\s]+([A-Za-z0-9][A-Za-z0-9._:-]{2,})/i
    )?.[1];
    if (embedded) return embedded;
  }
  return undefined;
}

export function isRecoverableDaemonStatus(result: ProcessResult): boolean {
  const raw = `${result.stderr}\n${result.stdout}`;
  const parsed = parseDaemonStatusJson(result.stdout) ?? parseDaemonStatusJson(result.stderr);
  if (parsed) {
    const localDaemon = statusValue(parsed.localDaemon);
    const connectedDaemon = statusValue(parsed.connectedDaemon);
    if (connectedDaemon && isHealthyDaemonStatus(connectedDaemon)) return false;
    if ([localDaemon, connectedDaemon].some((status) => status && isStoppedDaemonStatus(status))) return true;
  }
  return /stale[_ -]?pid|unreachable|connection refused|daemon.*not.*running|not running/i.test(raw);
}

function parseDaemonStatusJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function statusValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim().toLowerCase().replace(/[ -]+/g, "_");
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["status", "state", "lifecycle"]) {
    if (typeof record[key] === "string") return statusValue(record[key]);
  }
  return undefined;
}

function isStoppedDaemonStatus(status: string): boolean {
  return ["stopped", "not_running", "unreachable", "stale_pid", "error", "failed"].includes(status);
}

function isHealthyDaemonStatus(status: string): boolean {
  return ["connected", "reachable", "ready", "running", "healthy"].includes(status);
}

function findId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findId(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["agentId", "agent_id", "id"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  for (const child of Object.values(record)) {
    const found = findId(child);
    if (found) return found;
  }
  return undefined;
}

function parseVersion(text: string): string | undefined {
  return text.match(/\b(?:v)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)?.[1];
}
function hasOption(text: string, option: string): boolean {
  return text.includes(option);
}
function semverAtLeast(
  version: string | undefined,
  minimum: [number, number, number]
): boolean {
  if (!version) return false;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
