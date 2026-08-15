import type { ContextCompressionProvider, ContextCompressionRequest, ContextCompressionResult, ProviderHealth } from "./types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "../estimator.js";
import { runProcess, commandExists } from "../../utils/process.js";
import { providerVersions } from "../../providers/versions.js";

export interface HeadroomOptions { command?: string; version?: string; python?: string; bridge?: string; executor?: typeof runProcess; }
export const HEADROOM_VERSION = providerVersions.headroom;

/** AEH-owned adapter. It talks to a local Headroom executable and never starts an agent process. */
export class HeadroomCompressionProvider implements ContextCompressionProvider {
  readonly name = "headroom";
  private readonly command: string;
  private readonly expectedVersion?: string;
  private readonly python?: string;
  private readonly bridge?: string;
  private readonly executor: typeof runProcess;

  constructor(options: HeadroomOptions = {}) {
    this.command = options.command ?? "headroom";
    this.expectedVersion = options.version ?? HEADROOM_VERSION;
    this.python = options.python;
    this.bridge = options.bridge;
    this.executor = options.executor ?? runProcess;
  }

  async doctor(root: string): Promise<ProviderHealth> {
    if (!(await commandExists(this.command, root))) return { ok: false, message: `Headroom executable '${this.command}' was not found in the reconciled toolchain PATH.` };
    const result = await this.executor(`${quote(this.command)} --version`, { cwd: root, timeoutMs: 15_000 });
    if (result.exitCode !== 0) return { ok: false, message: `Headroom health check failed: ${result.stderr || result.stdout}` };
    const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
    if (this.expectedVersion && !version.includes(this.expectedVersion)) return { ok: false, version, message: `Headroom version drift: expected ${this.expectedVersion}, got ${version}.` };
    try {
      const bridge = await this.bridgeCommand(root);
      const bridgeResult = await this.executor(`${bridge} --doctor`, { cwd: root, timeoutMs: 15_000, stdin: JSON.stringify({ version: 1, operation: "doctor" }) });
      const parsed = parseBridgeResponse(bridgeResult.stdout);
      if (bridgeResult.exitCode !== 0 || parsed?.providerVersion !== this.expectedVersion) return { ok: false, version, message: `Headroom SDK bridge is unavailable or drifted: expected ${this.expectedVersion}.` };
    } catch (error) {
      return { ok: false, version, message: `Headroom SDK bridge could not be resolved: ${String(error)}` };
    }
    return { ok: true, version, message: `Headroom local compressor ready${version ? ` (${version})` : ""}.` };
  }

  async compress(root: string, request: ContextCompressionRequest): Promise<ContextCompressionResult> {
    const bridge = await this.bridgeCommand(root);
    const result = await this.executor(bridge, {
      cwd: root,
      timeoutMs: 120_000,
      stdin: JSON.stringify({ version: 1, operation: "compress", content: request.fragment.content, maxTokens: request.maxTokens ?? estimateTokens(request.fragment.content), reversible: request.reversible === true, sourceSha256: request.sourceSha256 })
    });
    if (result.exitCode !== 0) throw new Error(`HEADROOM_RUNTIME_FAILURE: ${result.stderr || result.stdout}`);
    const parsed = parseBridgeResponse(result.stdout);
    if (!parsed) throw new Error("HEADROOM_MALFORMED_RESPONSE: Headroom SDK bridge returned no usable JSON response.");
    if (typeof parsed.content !== "string" || typeof parsed.reversible !== "boolean") throw new Error("HEADROOM_MALFORMED_RESPONSE: compression response omitted required fields.");
    if (parsed.sourceSha256 !== request.sourceSha256) throw new Error("HEADROOM_PROVENANCE_MISMATCH: bridge response source hash differs from request.");
    if (this.expectedVersion && parsed.providerVersion !== this.expectedVersion) throw new Error(`HEADROOM_VERSION_DRIFT: expected ${this.expectedVersion}, got ${parsed.providerVersion ?? "unknown"}.`);
    return { content: parsed.content, provider: this.name, providerVersion: parsed.providerVersion, reversible: parsed.reversible, handle: parsed.handle, originalTokens: parsed.originalTokens ?? estimateTokens(request.fragment.content), compressedTokens: parsed.compressedTokens ?? estimateTokens(parsed.content) };
  }

  private async bridgeCommand(root: string): Promise<string> {
    const bridge = this.bridge ?? fileURLToPath(new URL("../../../scripts/headroom-bridge.py", import.meta.url));
    await fs.access(bridge);
    const python = this.python ?? await resolveHeadroomPython(this.command, root, this.executor);
    return `${quote(python)} ${quote(bridge)}`;
  }
}

interface BridgeResponse { version: 1; content?: string; sourceSha256?: string; providerVersion?: string; reversible?: boolean; handle?: string; originalTokens?: number; compressedTokens?: number; error?: { code?: string; message?: string } }
function parseBridgeResponse(stdout: string): BridgeResponse | undefined {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) return undefined;
  try {
    const parsed = JSON.parse(lines[0]) as BridgeResponse;
    if (parsed.version !== 1 || parsed.error || typeof parsed.providerVersion !== "string") return undefined;
    return parsed;
  } catch { return undefined; }
}

async function resolveHeadroomPython(command: string, root: string, executor: typeof runProcess): Promise<string> {
  const located = await executor(`command -v ${quote(command)}`, { cwd: root, timeoutMs: 15_000 });
  if (located.exitCode !== 0) throw new Error(`Headroom executable '${command}' was not found.`);
  const executable = located.stdout.trim().split(/\r?\n/).at(-1)?.trim();
  if (!executable) throw new Error("Headroom executable path was empty.");
  const firstLine = await fs.readFile(executable, "utf8").then((value) => value.split(/\r?\n/, 1)[0]).catch(() => "");
  const shebang = firstLine.match(/^#!\s*(\S+)/)?.[1];
  if (!shebang) throw new Error("Headroom executable does not expose a Python shebang for the SDK bridge.");
  return shebang;
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
