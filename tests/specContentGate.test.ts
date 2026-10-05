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
  parseTasks,
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

// Drift-guard compiler cross-check shells out to `openspec` via PATH. CI `test`
// job (setup-node + npm ci, no mise) has no openspec binary: execFileSync
// throws ENOENT. Detect once; skip the compiler block with an explicit reason
// when absent. Mirror (gate==parser) assertions stay unconditional (no binary).
export function isOpenspecCompilerAvailable(binary = "openspec"): boolean {
  try {
    execFileSync(binary, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasOpenspecCompiler = isOpenspecCompilerAvailable();
const OPENSPEC_ABSENT_REASON = "openspec binary absent from PATH — compiler cross-check skipped";

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

describe("gate==parser agreement (single canonical matcher)", () => {
  const IDS = ["T-R1", "T-R2"];
  const TITLES = ["First requirement", "Second requirement"];
  const FALLBACK = TITLES.map((title) => `Implement ${title}`);

  function gateAccepts(tasks: string): boolean {
    try {
      validateOpenSpecTasksCanonicalityV1("change-1", tasks);
      return true;
    } catch {
      return false;
    }
  }

  // Canonical = gate and parseTasks consume OPENSPEC_TASK_CHECKBOX_PATTERN, so the
  // gate accepts exactly when parseTasks finds checkbox lines (no fallback titles).
  const cases: Array<{ name: string; tasks: string; canonical: boolean; parsed?: Array<{ title: string; status: string }> }> = [
    { name: "unchecked checkbox", tasks: "- [ ] 1.1 Do the work\n", canonical: true, parsed: [{ title: "1.1 Do the work", status: "pending" }] },
    { name: "checked checkbox", tasks: "- [x] 1.1 Done work\n", canonical: true, parsed: [{ title: "1.1 Done work", status: "done" }] },
    { name: "uppercase [X]", tasks: "- [X] 1.1 Done work\n", canonical: true, parsed: [{ title: "1.1 Done work", status: "done" }] },
    { name: "nested/indented checkboxes", tasks: "  - [ ] nested task\n    - [x] deep done\n", canonical: true, parsed: [{ title: "nested task", status: "pending" }, { title: "deep done", status: "done" }] },
    { name: "trailing spaces", tasks: "- [ ] 1.1 Do the work   \n", canonical: true, parsed: [{ title: "1.1 Do the work", status: "pending" }] },
    { name: "mixed bullet + checkbox", tasks: "- Just a bullet\n- [ ] 1.1 Real task\n", canonical: true, parsed: [{ title: "1.1 Real task", status: "pending" }] },
    { name: "dash bullets without checkboxes", tasks: "- Do the work\n- Do more\n", canonical: false },
    { name: "numbered list", tasks: "1. Do the work\n2. Do more\n", canonical: false },
    { name: "plain-text prose", tasks: "Do the work soon.\nMore prose here.\n", canonical: false },
  ];

  for (const shape of cases) {
    it(`${shape.name}: gate and parseTasks agree`, () => {
      const parsed = parseTasks(shape.tasks, IDS, TITLES);
      expect(gateAccepts(shape.tasks)).toBe(shape.canonical);
      if (shape.canonical) {
        expect(parsed.map((item) => ({ title: item.title, status: item.status }))).toEqual(shape.parsed);
      } else {
        // Parser falls back to one placeholder per requirement: compiler counts 0 tasks.
        expect(parsed.map((item) => item.title)).toEqual(FALLBACK);
      }
    });
  }
});

describe.skipIf(!hasOpenspecCompiler)(`mirror==compiler cross-check (drift guard)${hasOpenspecCompiler ? "" : ` [SKIPPED: ${OPENSPEC_ABSENT_REASON}]`}`, () => {
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
    // NOTE: removed `compiler.output` prose assertion — CLI prose is not a
    // stability contract (CI observed bare newline vs local "counts as 0 tasks").
    // `openspec` here already resolves to the repo-pinned 1.13.2
    // (templates/provider-versions.json + .harness/toolchain.yaml, CI installs
    // the same via mise), so no further version pin is available in this helper.
    // Drift-guard lives on verdict agreement: mirror and compiler must agree.
    expect(mirror).toBe(compiler.exitCode === 0);
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
