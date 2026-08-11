import fs from "node:fs/promises";
import path from "node:path";

const requiredArtifacts = ["proposal.md", "spec.md", "design.md", "tasks.yaml", "acceptance.feature"];

export async function createSddChange(root: string, taskId: string, title: string): Promise<string> {
  const dir = path.join(root, "specs", "changes", taskId);
  await fs.mkdir(dir, { recursive: true });
  const files: Record<string, string> = {
    "proposal.md": `# ${taskId}: ${title}\n\n## Problem\n\n## Desired outcome\n\n## Scope\n\n## Non-goals\n`,
    "spec.md": `# Specification: ${title}\n\n## Requirements\n\n### ${taskId}-R1\n\nTODO\n\n## Invariants\n`,
    "design.md": `# Design: ${title}\n\n## Current state\n\n## Proposed design\n\n## Data/API impact\n\n## Risks and trade-offs\n`,
    "tasks.yaml": `version: 1\ntask: ${taskId}\nitems:\n  - id: 1\n    title: TODO\n    status: pending\n`,
    "acceptance.feature": `@${taskId}\nFeature: ${title}\n\n  Rule: TODO business rule\n\n    Scenario: TODO observable behavior\n      Given TODO\n      When TODO\n      Then TODO\n`
  };

  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    try { await fs.access(file); } catch { await fs.writeFile(file, content); }
  }
  return dir;
}

export async function validateSddChange(root: string, taskId: string): Promise<{ ok: boolean; missing: string[] }> {
  const dir = path.join(root, "specs", "changes", taskId);
  const missing: string[] = [];
  for (const name of requiredArtifacts) {
    try {
      const stat = await fs.stat(path.join(dir, name));
      if (stat.size === 0) missing.push(name);
    } catch {
      missing.push(name);
    }
  }
  return { ok: missing.length === 0, missing };
}
