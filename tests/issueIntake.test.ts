import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTaskContract } from "../src/core/config.js";
import { verifyTaskSeal } from "../src/core/seal.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { loadDeliveryRecord } from "../src/delivery/handoff.js";
import { inspectGithubIssue, issueContentSha256, prepareGithubIssueTask, verifyGithubIssueDrift } from "../src/issues/intake.js";

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "issue-test" },
  workflow: { quick: { maxFiles: 5 }, issueIntake: { enabled: true, snapshotDir: ".harness/issues", verifyDriftOnRun: true, requireOpen: true, autoHandoff: false } },
  delivery: { stateDir: ".harness/delivery", github: { enabled: false, repository: "owner/repo", tokenEnv: "GH_TOKEN", branchPattern: "feature/gh-{issue}-{slug}" }, paseo: { enabled: false } },
  sdd: { specsDir: "specs", contractsDir: ".harness/contracts", reportsDir: ".harness/reports" },
  validation: { baseRef: "main", requireSeal: true },
  orchestration: { provider: "none", worker: { maxRepairAttempts: 2 } }
};

afterEach(() => { vi.unstubAllGlobals(); });
async function root(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), "aeh-issue-")); }
function mockIssue(input: { number: number; title: string; body: string; labels?: string[]; state?: string; updated?: string }): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ number: input.number, html_url: `https://github.com/owner/repo/issues/${input.number}`, title: input.title, body: input.body, state: input.state ?? "open", labels: (input.labels ?? []).map((name) => ({ name })), created_at: "2026-08-01T00:00:00Z", updated_at: input.updated ?? "2026-08-11T00:00:00Z" }), { status: 200, headers: { "content-type": "application/json" } })));
}

describe("GitHub issue intake", () => {
  it("classifies a bounded low-risk issue as QUICK and freezes the existing issue", async () => {
    const repo = await root();
    mockIssue({ number: 12, title: "Adjust save label", labels: ["frontend"], body: "## Acceptance Criteria\n- The save button displays Save changes\n\n## Files\n- `src/Button.tsx`" });
    const inspected = await inspectGithubIssue(repo, config, 12);
    expect(inspected.preliminaryMode).toBe("quick");
    const prepared = await prepareGithubIssueTask(repo, config, 12, { usePlanner: false });
    expect(prepared.mode).toBe("quick");
    expect(prepared.contract.source?.issue).toBe(".harness/issues/GH-12.json");
    expect(prepared.contract.issue).toMatchObject({ provider: "github", repository: "owner/repo", number: 12 });
    expect((await loadDeliveryRecord(repo, config, "GH-12"))?.github?.issueNumber).toBe(12);
    expect((await verifyTaskSeal(repo, prepared.contract, true)).status).toBe("PASS");
  });

  it("turns a security-sensitive issue into a traceable sealed SDD without creating a new issue", async () => {
    const repo = await root();
    mockIssue({ number: 42, title: "Add organization permission check", labels: ["backend", "security"], body: "## Requirements\n- Requests from another organization are denied\n- Authorized organization members retain access\n\n## Acceptance Criteria\n- Cross-organization access returns 403\n- Same-organization access remains successful" });
    const prepared = await prepareGithubIssueTask(repo, config, 42, { usePlanner: false });
    expect(prepared.mode).toBe("spec");
    expect(prepared.traceability).toContain("GH-42-R1");
    expect(prepared.contract.requirements?.length).toBeGreaterThanOrEqual(2);
    expect(prepared.contract.routing?.risk).not.toBe("low");
    expect(await fs.readFile(path.join(repo, prepared.contract.source!.spec!), "utf8")).toContain("GitHub issue #42");
    expect((await loadDeliveryRecord(repo, config, "GH-42"))?.github).toMatchObject({ repository: "owner/repo", issueNumber: 42 });
    expect((await verifyTaskSeal(repo, prepared.contract, true)).status).toBe("PASS");
  });

  it("detects normative issue drift after the TaskContract has been frozen", async () => {
    const repo = await root();
    mockIssue({ number: 77, title: "Update docs wording", labels: ["docs"], body: "## Acceptance Criteria\n- README uses the new wording\n\n## Files\n- `README.md`" });
    await prepareGithubIssueTask(repo, config, 77, { usePlanner: false });
    const contract = await loadTaskContract(repo, "GH-77", config);
    mockIssue({ number: 77, title: "Update docs wording", labels: ["docs"], body: "## Acceptance Criteria\n- README uses a DIFFERENT required wording\n\n## Files\n- `README.md`", updated: "2026-08-12T00:00:00Z" });
    const drift = await verifyGithubIssueDrift(repo, config, contract);
    expect(drift.ok).toBe(false);
    expect(drift.message).toContain("ISSUE_DRIFT");
    await expect(prepareGithubIssueTask(repo, config, 77, { usePlanner: false })).rejects.toThrow(/ISSUE_DRIFT/);
  });

  it("refreshes a changed issue before workspace creation without changing its delivery identity", async () => {
    const repo = await root();
    mockIssue({ number: 88, title: "Update copy", labels: ["docs"], body: "## Acceptance Criteria\n- README says Alpha\n\n## Files\n- `README.md`" });
    const first = await prepareGithubIssueTask(repo, config, 88, { usePlanner: false });
    const originalHash = first.contract.issue!.contentSha256;
    const originalRecord = await loadDeliveryRecord(repo, config, "GH-88");

    mockIssue({ number: 88, title: "Update copy", labels: ["docs"], body: "## Acceptance Criteria\n- README says Beta\n\n## Files\n- `README.md`", updated: "2026-08-12T01:00:00Z" });
    const refreshed = await prepareGithubIssueTask(repo, config, 88, { refresh: true, usePlanner: false });
    const refreshedRecord = await loadDeliveryRecord(repo, config, "GH-88");

    expect(refreshed.contract.issue!.contentSha256).not.toBe(originalHash);
    expect(refreshedRecord?.github?.issueNumber).toBe(88);
    expect(refreshedRecord?.createdAt).toBe(originalRecord?.createdAt);
    expect((await verifyTaskSeal(repo, refreshed.contract, true)).status).toBe("PASS");
  });

  it("hashes only normative title/body content, not mutable labels", () => {
    expect(issueContentSha256("Title", "Body")).toBe(issueContentSha256("Title", "Body"));
    expect(issueContentSha256("Title", "Body")).not.toBe(issueContentSha256("Title", "Body changed"));
  });
});
