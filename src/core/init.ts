import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
function packageRoot(): string { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."); }
async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }
async function copyFileIfMissing(source: string, destination: string): Promise<void> { if (await exists(destination)) return; await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination); }
async function copyTree(source: string, destination: string): Promise<void> { await fs.mkdir(destination, { recursive: true }); for (const entry of await fs.readdir(source, { withFileTypes: true })) { const src = path.join(source, entry.name); const dst = path.join(destination, entry.name); if (entry.isDirectory()) await copyTree(src, dst); else await copyFileIfMissing(src, dst); } }
export async function initializeProject(root: string): Promise<string[]> {
  const pkg = packageRoot(); const created: string[] = [];
  const mappings: Array<[string, string]> = [["templates/project.yaml", ".harness/project.yaml"], ["templates/toolchain.yaml", ".harness/toolchain.yaml"], ["templates/agents.source.jsonc", ".harness/agents.source.jsonc"], ["templates/AGENTS.md", "AGENTS.md"], ["templates/otel-collector.yaml", ".harness/otel-collector.yaml"], ["templates/openspec-config.yaml", "openspec/config.yaml"]];
  for (const [src, dst] of mappings) { const target = path.join(root, dst); if (!(await exists(target))) { await copyFileIfMissing(path.join(pkg, src), target); created.push(dst); } }
  await copyTree(path.join(pkg, "policies", "core"), path.join(root, ".harness", "policies", "core")); await copyTree(path.join(pkg, "skills"), path.join(root, ".harness", "skills"));
  for (const dir of [".harness/bin", ".harness/contracts", ".harness/seals", ".harness/reports", ".harness/repairs", ".harness/runs", ".harness/telemetry", ".harness/audits", ".harness/evals/results", ".harness/evals/workspaces", ".harness/provenance", ".harness/generated", ".harness/findings", ".harness/delivery", ".harness/controller", ".harness/evidence", ".harness/distributed/pending", ".harness/distributed/leased", ".harness/distributed/completed", ".harness/policy-bundles", ".harness/mcp-benchmarks", ".harness/paseo", ".harness/paseo/handoffs", ".config/mise/conf.d", "openspec/changes", "openspec/specs", "specs/changes", "docs/decisions", "evals/corpus", "memory-benchmarks"]) await fs.mkdir(path.join(root, dir), { recursive: true });
  if (await ensureGitignore(root)) created.push(".gitignore (AEH generated-state block)");
  return created;
}

async function ensureGitignore(root: string): Promise<boolean> {
  const file = path.join(root, ".gitignore"); const marker = "# BEGIN Agentic Engineering Harness generated state";
  const ignored = [".harness/bin/", ".harness/toolchain.state.json", ".harness/generated/", ".harness/contracts/", ".harness/seals/", ".harness/reports/", ".harness/repairs/", ".harness/runs/", ".harness/telemetry/", ".harness/audits/", ".harness/findings/", ".harness/evals/", ".harness/provenance/", ".harness/delivery/", ".harness/issues/", ".harness/controller/", ".harness/evidence/", ".harness/distributed/", ".harness/policy-bundles/", ".harness/mcp-benchmarks/", ".harness/paseo/", ".config/mise/conf.d/aeh.toml"];
  const end = "# END Agentic Engineering Harness generated state"; const block = `${marker}\n${ignored.join("\n")}\n${end}`; const current = await fs.readFile(file, "utf8").catch(() => "");
  if (current.includes(marker)) {
    const next = current.replace(new RegExp(`${escapeRegExp(marker)}[\\s\\S]*?${escapeRegExp(end)}`), block); if (next === current) return false; await fs.writeFile(file, next.endsWith("\n") ? next : `${next}\n`); return true;
  }
  const prefix = current && !current.endsWith("\n") ? `${current}\n` : current; await fs.writeFile(file, `${prefix}${prefix ? "\n" : ""}${block}\n`); return true;
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
