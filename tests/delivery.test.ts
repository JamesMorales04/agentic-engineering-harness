import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSddChange } from "../src/core/sdd.js";
import { loadTaskContract } from "../src/core/config.js";
import { sealTask } from "../src/core/seal.js";
import { assertHandoffReady, handoffSdd, parseGithubRepository, renderIssueBody, renderPattern } from "../src/delivery/handoff.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "delivery-test" },
  sdd: { specsDir: "specs", contractsDir: ".harness/contracts" },
  validation: { baseRef: "main", requireSeal: true },
  delivery: { stateDir: ".harness/delivery", github: { enabled: false }, paseo: { enabled: false } }
};

async function makeRoot(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), "aeh-delivery-")); }
async function resolveTemplateTodos(root: string, taskId: string): Promise<void> {
  const dir = path.join(root, "specs", "changes", taskId);
  for (const file of ["proposal.md", "spec.md", "design.md", "tasks.yaml", "acceptance.feature"]) {
    const full = path.join(dir, file); const content = await fs.readFile(full, "utf8"); await fs.writeFile(full, content.replaceAll("TODO", "Defined"));
  }
  const contractFile = path.join(root, ".harness", "contracts", `${taskId}.yaml`); const contract = await fs.readFile(contractFile, "utf8"); await fs.writeFile(contractFile, contract.replaceAll("TODO", "Defined"));
}

describe("delivery handoff", () => {
  it("parses common GitHub origin formats", () => {
    expect(parseGithubRepository("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(parseGithubRepository("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(parseGithubRepository("not-a-github-remote")).toBeUndefined();
  });

  it("renders deterministic issue-linked branch names", () => {
    expect(renderPattern("feature/gh-{issue}-{slug}", { version: 1, task: { id: "CHANGE-42", title: "Add Better Auth Flow" } }, 123)).toBe("feature/gh-123-add-better-auth-flow");
  });

  it("rejects the untouched SDD template even though it is structurally traceable", async () => {
    const root = await makeRoot(); await createSddChange(root, "CHANGE-1", "Template", config); const contract = await loadTaskContract(root, "CHANGE-1", config);
    await expect(assertHandoffReady(root, contract)).rejects.toThrow(/template placeholders/i);
  });

  it("creates a resumable local delivery record only after the SDD is ready and sealed", async () => {
    const root = await makeRoot(); await createSddChange(root, "CHANGE-2", "Delivery Ready", config); await resolveTemplateTodos(root, "CHANGE-2");
    const contract = await loadTaskContract(root, "CHANGE-2", config); await sealTask(root, config, contract);
    const record = await handoffSdd(root, config, "CHANGE-2");
    expect(record.status).toBe("ready");
    expect(record.github).toBeUndefined();
    expect(record.paseo).toBeUndefined();
    expect(JSON.parse(await fs.readFile(path.join(root, ".harness", "delivery", "CHANGE-2.json"), "utf8"))).toMatchObject({ taskId: "CHANGE-2", status: "ready" });
    const body = await renderIssueBody(root, contract, "develop");
    expect(body).toContain("## Originating Branch\ndevelop");
    expect(body).toContain("delivery mirror");
  });
});
