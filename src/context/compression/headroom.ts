import type { ContextCompressionProvider, ContextCompressionRequest, ContextCompressionResult, ProviderHealth } from "./types.js";
import { estimateTokens } from "../estimator.js";
import { runProcess, commandExists } from "../../utils/process.js";

export interface HeadroomOptions { command?: string; version?: string; executor?: typeof runProcess; }
export const HEADROOM_VERSION = "0.28.0";

/** AEH-owned adapter. It talks to a local Headroom executable and never starts an agent process. */
export class HeadroomCompressionProvider implements ContextCompressionProvider {
  readonly name = "headroom";
  private readonly command: string;
  private readonly expectedVersion?: string;
  private readonly executor: typeof runProcess;

  constructor(options: HeadroomOptions = {}) {
    this.command = options.command ?? "headroom";
    this.expectedVersion = options.version ?? HEADROOM_VERSION;
    this.executor = options.executor ?? runProcess;
  }

  async doctor(root: string): Promise<ProviderHealth> {
    if (!(await commandExists(this.command, root))) return { ok: false, message: `Headroom executable '${this.command}' was not found in the reconciled toolchain PATH.` };
    const result = await this.executor(`${quote(this.command)} --version`, { cwd: root, timeoutMs: 15_000 });
    if (result.exitCode !== 0) return { ok: false, message: `Headroom health check failed: ${result.stderr || result.stdout}` };
    const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
    if (this.expectedVersion && !version.includes(this.expectedVersion)) return { ok: false, version, message: `Headroom version drift: expected ${this.expectedVersion}, got ${version}.` };
    return { ok: true, version, message: `Headroom local compressor ready${version ? ` (${version})` : ""}.` };
  }

  async compress(root: string, request: ContextCompressionRequest): Promise<ContextCompressionResult> {
    const result = await this.executor(`${quote(this.command)} compress --format json`, { cwd: root, timeoutMs: 120_000, stdin: JSON.stringify({ content: request.fragment.content, maxTokens: request.maxTokens, reversible: true }) });
    if (result.exitCode !== 0) throw new Error(`Headroom compression failed: ${result.stderr || result.stdout}`);
    const parsed = parseResult(result.stdout);
    if (!parsed) throw new Error("Headroom returned no usable compressed content.");
    return { content: parsed.content, provider: this.name, providerVersion: parsed.version, reversible: parsed.reversible ?? true, handle: parsed.handle, originalTokens: estimateTokens(request.fragment.content), compressedTokens: estimateTokens(parsed.content) };
  }
}

function parseResult(stdout: string): { content: string; handle?: string; version?: string; reversible?: boolean } | undefined {
  const value = stdout.trim();
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content : typeof record.text === "string" ? record.text : undefined;
    return content === undefined ? undefined : { content, handle: typeof record.handle === "string" ? record.handle : undefined, version: typeof record.version === "string" ? record.version : undefined, reversible: typeof record.reversible === "boolean" ? record.reversible : undefined };
  } catch { return { content: value }; }
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
