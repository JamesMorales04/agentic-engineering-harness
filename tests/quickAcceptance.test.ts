import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskContract, ValidationCheck } from "../src/core/types.js";
import { validateQuickAcceptance } from "../src/validators/quickAcceptance.js";

const scopePass: ValidationCheck = { id: "diff.allowed-scope", category: "diff", status: "PASS", message: "ok" };
const scopeFail: ValidationCheck = { id: "diff.allowed-scope", category: "diff", status: "FAIL", message: "bad" };

describe("deterministic QUICK acceptance", () => {
  it("checks exact file content and scope without trusting worker text", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-quick-acceptance-"));
    await fs.writeFile(path.join(root, "timeout.txt"), "worker timeout: 45 seconds\n");
    const contract: TaskContract = { version: 1, mode: "quick", task: { id: "Q-AC", title: "timeout" }, quick: { request: "timeout", acceptance: ["timeout.txt contains exactly 'worker timeout: 45 seconds'", "Do not modify any other file"], triage: { mode: "quick", reasons: [], evaluatedAt: new Date().toISOString() } } };
    const checks = await validateQuickAcceptance(root, contract, ["timeout.txt"], [scopePass]);
    expect(checks.map((check) => check.status)).toEqual(["PASS", "PASS"]);
  });

  it("fails closed for unsupported acceptance language and failed scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-quick-acceptance-"));
    const contract: TaskContract = { version: 1, mode: "quick", task: { id: "Q-AC-FAIL", title: "timeout" }, quick: { request: "timeout", acceptance: ["The change is good", "Do not modify any other file"], triage: { mode: "quick", reasons: [], evaluatedAt: new Date().toISOString() } } };
    const checks = await validateQuickAcceptance(root, contract, ["other.txt"], [scopeFail]);
    expect(checks.map((check) => check.status)).toEqual(["FAIL", "FAIL"]);
  });
});
