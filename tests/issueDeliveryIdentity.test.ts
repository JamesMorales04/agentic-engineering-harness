import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { loadDeliveryRecord } from "../src/delivery/handoff.js";
import { prepareGithubIssueTask } from "../src/issues/intake.js";

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "identity-test" },
  workflow: { issueIntake: { enabled: true, requireOpen: true, verifyDriftOnRun: true }, quick: { maxFiles: 5 } },
  delivery: { stateDir: ".harness/delivery", github: { enabled: false, repository: "owner/repo" }, paseo: { enabled: false } },
  sdd: { specsDir: "specs", contractsDir: ".harness/contracts" },
  validation: { baseRef: "main", requireSeal: true }
};

afterEach(() => vi.unstubAllGlobals());

describe("issue delivery identity", () => {
  it("re-seeds the existing issue when ephemeral delivery state is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-identity-"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ number: 31, html_url: "https://github.com/owner/repo/issues/31", title: "Fix label", body: "## Acceptance Criteria\n- Label reads Save\n\n## Files\n- `src/Button.tsx`", state: "open", labels: [{ name: "frontend" }], created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-11T00:00:00Z" }), { status: 200 })));

    await prepareGithubIssueTask(root, config, 31, { usePlanner: false });
    await fs.rm(path.join(root, ".harness", "delivery", "GH-31.json"));
    await prepareGithubIssueTask(root, config, 31, { usePlanner: false });

    expect((await loadDeliveryRecord(root, config, "GH-31"))?.github).toMatchObject({ repository: "owner/repo", issueNumber: 31, issueUrl: "https://github.com/owner/repo/issues/31" });
  });
});
