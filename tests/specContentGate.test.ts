import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSpecManagerPrompt,
  validateSpecAuthoringResult,
  SPEC_MANAGER_CONTENT_MAX_RETRIES,
  isSpecManagerContentNotCanonical,
  shouldRetrySpecManagerContent,
  buildSpecManagerContentRetryNote,
} from "../src/operations/change.js";
import {
  validateOpenSpecTasksCanonicalityV1,
} from "../src/spec/openspec.js";
import type { ChangeOperationPayload } from "../src/operations/state.js";

/**
 * RED/GREEN for CHANGE-20261005T060646Z-be9f5ac1 rev61:
 * content-poor READY (dash bullets, 0 checkboxes, valid deltas/scenarios)
 * passed the handoff (presence/non-emptiness only) and died at
 * `compileOpenSpecChange` (`openspec validate --strict`: tasks.md 0 tasks).
 * GREEN: rejected at handoff with typed CONTENT_NOT_CANONICAL + bounded retry.
 */

const payload: ChangeOperationPayload = {
  request: "Redesign Home.",
  files: [],
  domains: [],
  risk: "low",
  acceptance: [],
  title: "Home redesign",
};

const canonicalSpecContent = [
  "## ADDED Requirements",
  "",
  "### Requirement: Home binds to versioned Overview",
  "The Home view SHALL render only from versioned overviews.",
  "",
  "#### Scenario: Overview renders",
  "Given a session When Home loads Then projections render.",
  "",
].join("\n");

function readyWithTasks(change: string, tasks: string) {
  return {
    change,
    status: "READY" as const,
    artifacts: {
      proposal: "# Proposal: Home redesign.",
      tasks,
      specs: [{ capability: "home-overview", content: canonicalSpecContent }],
    },
    requirements: [],
    unresolvedDecisions: [],
    decisionRequests: [],
    validationReady: true,
  };
}

// Exact failed-op shape: dash bullets, no checkboxes, valid specs.
const CONTENT_POOR_TASKS = "# Tasks\n- Redesign Home and ProjectCenter.\n- Wire decisions.\n- Add S9/S11 evidence.\n- Pass gates and open PR.\n";
const CANONICAL_TASKS = "# Tasks\n- [ ] 1.1 Redesign Home.\n- [ ] 1.2 Wire decisions.\n";

describe("spec content gate (CHANGE-20261005T060646Z rev61)", () => {
  it("rejects dash-bullet tasks with 0 checkboxes at the handoff gate", () => {
    expect(() => validateOpenSpecTasksCanonicalityV1("change-1", CONTENT_POOR_TASKS)).toThrow(
      /SPEC_MANAGER_CONTENT_NOT_CANONICAL.*tasks\.md.*artifacts\.tasks/
    );
    expect(() => validateOpenSpecTasksCanonicalityV1("change-1", CANONICAL_TASKS)).not.toThrow();
  });

  it("validateSpecAuthoringResult rejects content-poor READY with typed tasks error", () => {
    expect(() =>
      validateSpecAuthoringResult("change-1", readyWithTasks("change-1", CONTENT_POOR_TASKS) as never)
    ).toThrow(/SPEC_MANAGER_CONTENT_NOT_CANONICAL.*tasks\.md/);
    expect(() =>
      validateSpecAuthoringResult("change-1", readyWithTasks("change-1", CANONICAL_TASKS) as never)
    ).not.toThrow();
  });

  it("content retry budget is independent max-1", () => {
    expect(SPEC_MANAGER_CONTENT_MAX_RETRIES).toBe(1);
    const contentError = (() => {
      try {
        validateSpecAuthoringResult("change-1", readyWithTasks("change-1", CONTENT_POOR_TASKS) as never);
      } catch (error) {
        return error;
      }
      throw new Error("expected CONTENT_NOT_CANONICAL");
    })();
    expect(isSpecManagerContentNotCanonical(contentError)).toBe(true);
    expect(isSpecManagerContentNotCanonical(new Error("SPEC_MANAGER_READY_INVALID: nope"))).toBe(false);
    expect(shouldRetrySpecManagerContent(contentError, 0)).toBe(true);
    expect(shouldRetrySpecManagerContent(contentError, 1)).toBe(false);
    const note = buildSpecManagerContentRetryNote("change-1");
    expect(note).toContain("SPEC_MANAGER_CONTENT_NOT_CANONICAL");
    expect(note).toContain("- [ ]");
    expect(note).toContain("## ADDED Requirements");
    expect(note).toContain("#### Scenario:");
  });

  it("prompt requires checkbox tasks explicitly", () => {
    const prompt = buildSpecManagerPrompt(payload, "change-1", undefined, undefined, []);
    expect(prompt).toContain("- [ ]");
    expect(prompt).toContain("## ADDED Requirements");
    expect(prompt).toContain("#### Scenario:");
  });
});

describe("mirror==compiler cross-check (drift guard)", () => {
  async function validateWithCompiler(tasks: string, specContent: string): Promise<{ exitCode: number; output: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-spec-content-mirror-"));
    try {
      const change = `mirror-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const dir = path.join(root, "openspec", "changes", change);
      await fs.mkdir(path.join(dir, "specs", "test-cap"), { recursive: true });
      await fs.writeFile(path.join(dir, "proposal.md"), "# Proposal\n\n## Why\nTest.\n\n## What Changes\nTest.\n");
      await fs.writeFile(path.join(dir, "tasks.md"), tasks);
      await fs.writeFile(path.join(dir, "specs", "test-cap", "spec.md"), specContent);
      try {
        const out = execFileSync("openspec", ["validate", change, "--strict"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { exitCode: 0, output: String(out) };
      } catch (error) {
        const err = error as { status?: number; stdout?: unknown; stderr?: unknown };
        return { exitCode: err.status ?? 1, output: `${String(err.stdout ?? "")}\n${String(err.stderr ?? "")}` };
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  function mirrorAccepts(tasks: string, specContent: string): boolean {
    try {
      validateOpenSpecTasksCanonicalityV1("change-1", tasks);
      // Reuse the canonical specs gate (same function the handoff uses).
      validateSpecAuthoringResult(
        "change-1",
        {
          change: "change-1",
          status: "READY",
          artifacts: { proposal: "# Proposal", tasks, specs: [{ capability: "test-cap", content: specContent }] },
          requirements: [],
          unresolvedDecisions: [],
          decisionRequests: [],
          validationReady: true,
        } as never
      );
      return true;
    } catch {
      return false;
    }
  }

  it("checkbox tasks + canonical delta pass both mirror and compiler", async () => {
    const tasks = "- [ ] 1.1 Do the work\n";
    const mirror = mirrorAccepts(tasks, canonicalSpecContent);
    const compiler = await validateWithCompiler(tasks, canonicalSpecContent);
    expect(mirror).toBe(true);
    expect(compiler.exitCode).toBe(0);
  });

  it("dash list without checkboxes fails both mirror and compiler", async () => {
    const tasks = "# Tasks\n- Do the work\n- Do more\n";
    const mirror = mirrorAccepts(tasks, canonicalSpecContent);
    const compiler = await validateWithCompiler(tasks, canonicalSpecContent);
    expect(mirror).toBe(false);
    expect(compiler.exitCode).not.toBe(0);
    expect(compiler.output).toContain("counts as 0 tasks");
  });

  it("numbered list without checkboxes fails both mirror and compiler", async () => {
    const tasks = "# Tasks\n1. Do the work\n2. Do more\n";
    const mirror = mirrorAccepts(tasks, canonicalSpecContent);
    const compiler = await validateWithCompiler(tasks, canonicalSpecContent);
    expect(mirror).toBe(false);
    expect(compiler.exitCode).not.toBe(0);
  });

  it("flat requirement without delta fails both mirror and compiler", async () => {
    const tasks = "- [ ] 1.1 Do the work\n";
    const flat = "### Requirement: Flat\n\nThe system SHALL work.\n\n#### Scenario: Works\n\n- **WHEN** run\n- **THEN** works\n";
    const mirror = mirrorAccepts(tasks, flat);
    const compiler = await validateWithCompiler(tasks, flat);
    expect(mirror).toBe(false);
    // Compiler rejects flat deltas (non-zero exit or delta guidance).
    expect(compiler.exitCode !== 0 || compiler.output.includes("ADDED")).toBe(true);
  });
});
