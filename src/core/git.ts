import { runProcess } from "../utils/process.js";

async function namesFrom(command: string, cwd: string): Promise<string[]> {
  const result = await runProcess(command, { cwd });
  if (result.exitCode !== 0) return [];
  return result.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

export async function getCurrentBranch(cwd: string): Promise<string | undefined> {
  const result = await runProcess("git branch --show-current", { cwd });
  const branch = result.exitCode === 0 ? result.stdout.trim() : "";
  return branch || undefined;
}

export async function getOriginRemote(cwd: string): Promise<string | undefined> {
  const result = await runProcess("git remote get-url origin", { cwd });
  const remote = result.exitCode === 0 ? result.stdout.trim() : "";
  return remote || undefined;
}

export async function getChangedFiles(cwd: string, baseRef: string): Promise<string[]> {
  const sets = await Promise.all([
    namesFrom(`git diff --name-only ${shellQuote(baseRef)}...HEAD`, cwd),
    namesFrom("git diff --name-only", cwd),
    namesFrom("git diff --cached --name-only", cwd),
    namesFrom("git ls-files --others --exclude-standard", cwd)
  ]);
  return [...new Set(sets.flat())].sort();
}

export async function getDiffStats(cwd: string, baseRef: string): Promise<{ files: number; added: number; deleted: number }> {
  const result = await runProcess(`git diff --numstat ${shellQuote(baseRef)}...HEAD`, { cwd });
  const worktree = await runProcess("git diff --numstat", { cwd });
  const staged = await runProcess("git diff --cached --numstat", { cwd });
  const rows = [result.stdout, worktree.stdout, staged.stdout].join("\n").split(/\r?\n/).filter(Boolean);
  let added = 0;
  let deleted = 0;
  for (const row of rows) {
    const [a, d] = row.split(/\s+/);
    if (a && a !== "-") added += Number(a) || 0;
    if (d && d !== "-") deleted += Number(d) || 0;
  }
  const changed = await getChangedFiles(cwd, baseRef);
  return { files: changed.length, added, deleted };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
