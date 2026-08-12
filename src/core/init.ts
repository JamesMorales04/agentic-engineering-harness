import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
function packageRoot(): string { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."); }
async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }
async function copyFileIfMissing(source: string, destination: string): Promise<void> { if (await exists(destination)) return; await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination); }
async function copyTree(source: string, destination: string): Promise<void> { await fs.mkdir(destination, { recursive: true }); for (const entry of await fs.readdir(source, { withFileTypes: true })) { const src = path.join(source, entry.name); const dst = path.join(destination, entry.name); if (entry.isDirectory()) await copyTree(src, dst); else await copyFileIfMissing(src, dst); } }
export async function initializeProject(root: string): Promise<string[]> {
  const pkg = packageRoot(); const created: string[] = [];
  for (const [src, dst] of [["templates/project.yaml", ".harness/project.yaml"], ["templates/AGENTS.md", "AGENTS.md"]] as Array<[string,string]>) {
    const target = path.join(root, dst); if (!(await exists(target))) { await copyFileIfMissing(path.join(pkg, src), target); created.push(dst); }
  }
  await copyTree(path.join(pkg, "policies", "core"), path.join(root, ".harness", "policies", "core"));
  await copyTree(path.join(pkg, "skills"), path.join(root, ".harness", "skills"));
  for (const dir of [".harness/contracts", ".harness/seals", ".harness/reports", ".harness/repairs", ".harness/runs", ".harness/graph", ".harness/telemetry", "specs/changes", "docs/decisions"]) await fs.mkdir(path.join(root, dir), { recursive: true });
  return created;
}
