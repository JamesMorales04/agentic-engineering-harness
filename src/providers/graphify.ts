import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import type { CodeIntelligenceProvider, CodeImpactReport } from "./types.js";
import { commandExists, runProcess } from "../utils/process.js";
import { loadCanonicalGraph } from "./graphifyModel.js";

export interface GraphifyGenerationMetadata {
  version: 1;
  provider: "graphify";
  providerVersion: string;
  gitCommit?: string;
  sourceFingerprint: string;
  graphSha256: string;
  generatedAt: string;
}

const GRAPHIFY_COMMAND = "graphify";

/** Graphify owns generation/freshness; all consumers use graphifyModel.ts. */
export class GraphifyCodeIntelligenceProvider implements CodeIntelligenceProvider {
  readonly name = "graphify";
  constructor(private readonly config?: HarnessProjectConfig, private readonly executor: typeof runProcess = runProcess) {}

  async doctor(root: string): Promise<{ ok: boolean; message: string }> {
    const cli = await commandExists(GRAPHIFY_COMMAND, root);
    const graph = await this.load(root);
    if (!cli && !graph) return { ok: false, message: "Graphify CLI and canonical graph are unavailable." };
    const version = cli ? await this.providerVersion(root).catch(() => undefined) : undefined;
    return { ok: true, message: graph ? `Graphify canonical graph is readable${version ? ` (${version})` : ""}; freshness is repository-state bound.` : `Graphify CLI detected${version ? ` (${version})` : ""}; provider generation is available.` };
  }

  async build(root: string): Promise<void> { await this.generate(root, false); }
  async refresh(root: string): Promise<void> { await this.generate(root, false); }
  async update(root: string): Promise<void> { await this.generate(root, true); }

  async load(root: string): Promise<unknown | undefined> { return loadCanonicalGraph(root, this.graphPath()); }

  async isFresh(root: string): Promise<boolean> {
    const graph = await this.load(root);
    const metadata = await this.readMetadata(root);
    if (!graph || !metadata || metadata.provider !== "graphify") return false;
    const current = await sourceFingerprint(root);
    return metadata.sourceFingerprint === current.sourceFingerprint && metadata.gitCommit === current.gitCommit && metadata.graphSha256 === (graph as { sourceHash?: string }).sourceHash && metadata.providerVersion.length > 0;
  }

  async impact(root: string): Promise<CodeImpactReport> {
    const graph = await this.load(root) as { nodes?: string[]; communities?: Record<string, string>; sourceHash?: string } | undefined;
    return { provider: this.name, affectedNodes: graph?.nodes ?? [], affectedCommunities: [...new Set(Object.values(graph?.communities ?? {}))] };
  }

  private async generate(root: string, incremental: boolean): Promise<void> {
    const override = this.config?.codeIntelligence?.refreshCommand?.trim();
    if (override) {
      const result = await this.executor(override, { cwd: root, timeoutMs: 300_000 });
      if (result.exitCode !== 0) throw new Error(`GRAPHIFY_REFRESH_FAILED: ${result.stderr || result.stdout}`);
    } else {
      if (!(await commandExists(GRAPHIFY_COMMAND, root))) throw new Error("GRAPHIFY_UNAVAILABLE: Graphify CLI is not installed.");
      const args = [GRAPHIFY_COMMAND, ".", ...(incremental ? ["--update"] : []), ...(this.config?.codeIntelligence?.codeOnly ? ["--code-only"] : []), "--no-viz"];
      const result = await this.executor(args.map(quote).join(" "), { cwd: root, timeoutMs: 300_000 });
      if (result.exitCode !== 0) throw new Error(`GRAPHIFY_REFRESH_FAILED: ${result.stderr || result.stdout}`);
    }
    await this.targetConfiguredGraph(root);
    const graphFile = path.resolve(root, this.graphPath());
    const raw = await fs.readFile(graphFile, "utf8").catch(() => undefined);
    if (!raw) throw new Error("GRAPHIFY_OUTPUT_MISSING: Graphify completed without a readable configured graph output.");
    if (!(await this.load(root))) throw new Error("GRAPHIFY_OUTPUT_INVALID: configured graph output is not valid through the canonical AEH model.");
    const fingerprint = await sourceFingerprint(root);
    const metadata: GraphifyGenerationMetadata = { version: 1, provider: "graphify", providerVersion: override ? "override" : await this.providerVersion(root), gitCommit: fingerprint.gitCommit, sourceFingerprint: fingerprint.sourceFingerprint, graphSha256: crypto.createHash("sha256").update(raw).digest("hex"), generatedAt: new Date().toISOString() };
    const file = this.metadataPath(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

  private async targetConfiguredGraph(root: string): Promise<void> {
    const target = path.resolve(root, this.graphPath());
    if (target === path.resolve(root, "graphify-out/graph.json")) return;
    const generated = await fs.readFile(path.resolve(root, "graphify-out/graph.json"), "utf8").catch(() => undefined);
    if (!generated) return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, generated, "utf8");
  }

  private graphPath(): string { return this.config?.codeIntelligence?.graphPath ?? "graphify-out/graph.json"; }
  private metadataPath(root: string): string { return path.resolve(root, this.config?.codeIntelligence?.snapshotDir ?? ".harness/graphify", "generation.json"); }
  private async readMetadata(root: string): Promise<GraphifyGenerationMetadata | undefined> { try { return JSON.parse(await fs.readFile(this.metadataPath(root), "utf8")) as GraphifyGenerationMetadata; } catch { return undefined; } }
  private async providerVersion(root: string): Promise<string> {
    const result = await this.executor(`${quote(GRAPHIFY_COMMAND)} --version`, { cwd: root, timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error(`Graphify version check failed: ${result.stderr || result.stdout}`);
    const version = (result.stdout || result.stderr).trim().split(/\r?\n/).at(0)?.trim();
    if (!version) throw new Error("Graphify version check returned no version.");
    return version;
  }
}

async function sourceFingerprint(root: string): Promise<{ sourceFingerprint: string; gitCommit?: string }> {
  const filesResult = await runProcess("git ls-files -co --exclude-standard", { cwd: root, timeoutMs: 30_000 });
  const names = filesResult.exitCode === 0 ? filesResult.stdout.split(/\r?\n/).map((item) => item.trim()).filter((item) => item && !excluded(item)) : await fallbackSourceFiles(root);
  const hash = crypto.createHash("sha256");
  for (const name of [...new Set(names)].sort()) hash.update(name).update("\0").update(await fs.readFile(path.resolve(root, name)).catch(() => Buffer.from(""))).update("\0");
  const commitResult = await runProcess("git rev-parse HEAD", { cwd: root, timeoutMs: 30_000 });
  return { sourceFingerprint: hash.digest("hex"), gitCommit: commitResult.exitCode === 0 ? commitResult.stdout.trim() : undefined };
}

async function fallbackSourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[])) {
      const absolute = path.join(directory, entry.name); const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory() && !excluded(relative)) await visit(absolute); else if (entry.isFile() && !excluded(relative)) result.push(relative);
    }
  };
  await visit(root); return result;
}

function excluded(relative: string): boolean { return relative === ".git" || relative.startsWith(".git/") || relative === "node_modules" || relative.startsWith("node_modules/") || relative === ".harness" || relative.startsWith(".harness/") || relative === "graphify-out" || relative.startsWith("graphify-out/"); }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
