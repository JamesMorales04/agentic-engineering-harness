import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");

// Regression for the v0.24.1 publish failures (runs 37989905139,
// 37993256834, 37994041260): `git ls-remote --tags origin | grep -q ...`
// under `set -euo pipefail` exits 141 (SIGPIPE: grep -q closes the pipe
// early, git dies with 141, pipefail propagates a false negative), so an
// EXISTING tag is misread as absent. Mechanism: DETERMINISTIC.

async function workflowRuns(): Promise<{
  gate: string;
  tagStep: string;
}> {
  const text = await fs.readFile(path.join(REPO, ".github/workflows/publish.yml"), "utf8");
  const workflow = parse(text) as Record<string, any>;
  const jobs = workflow.jobs as Record<string, any>;
  const gate = (
    jobs.publish.steps as Array<{ name?: string; run?: string }>
  ).find((s) => s.name === "Repair missing GitHub Release for current version")!.run!;
  const tagStep = (jobs["publish-npm"].steps as Array<{ name?: string; run?: string }>).find(
    (s) => s.name === "Create version tag after verification",
  )!.run!;
  expect(gate).toBeDefined();
  expect(tagStep).toBeDefined();
  return { gate, tagStep };
}

// Stub `git` (+ `node` for the gate's PACKAGE_NAME lookup): the full-tag
// namespace lists the target tag FIRST, then ~3000 filler lines (>64 KiB
// pipe buffer, like the real 220-ref remote). Early match is essential: it
// is what makes `grep -q` close the pipe while git is still writing, which
// is exactly the production SIGPIPE (exit 141 under pipefail).
async function stubGitWithLargeNamespace(targetTag: string): Promise<{ bin: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-tagdetect-"));
  const bin = path.join(dir, "stubbin");
  await fs.mkdir(bin);
  const lines: string[] = [
    `089cb41843c53a609d13d9cd3a32feb952b730aa\trefs/tags/${targetTag}`,
    `089cb41843c53a609d13d9cd3a32feb952b730aa\trefs/tags/${targetTag}^{}`,
  ];
  for (let i = 0; i < 3000; i++) {
    lines.push(`000000000000000000000000000000000000000${i % 10}\trefs/tags/v0.${i % 50}.${i}`);
  }
  await fs.writeFile(path.join(dir, "tags.txt"), `${lines.join("\n")}\n`);
  await fs.writeFile(
    path.join(bin, "git"),
    `#!/bin/sh\n` +
      `if [ "$1" = "ls-remote" ] && [ "$2" = "--tags" ]; then while IFS= read -r line; do printf '%s\\n' "$line"; done < "${path.join(dir, "tags.txt")}"; exit 0; fi\n` +
      `if [ "$1" = "ls-remote" ]; then\n` +
      `  if [ -n "$STUB_GIT_FAIL_EXACT" ]; then echo "stub: network unreachable" >&2; exit 1; fi\n` +
      `  REF=""; for a in "$@"; do case "$a" in refs/tags/*) REF="$a";; esac; done\n` +
      `  grep -F -- "$REF" "${path.join(dir, "tags.txt")}" || true\n` +
      `  exit 0\nfi\n` +
      `if [ "$1" = "rev-parse" ]; then echo "stubbed"; exit 0; fi\n` +
      `echo "stub: unsupported git $*" >&2; exit 1\n`,
  );
  await fs.chmod(path.join(bin, "git"), 0o755);
  await fs.writeFile(path.join(bin, "node"), `#!/bin/sh\nif [ "$1" = "-p" ]; then echo "aeh-test-pkg"; exit 0; fi\necho "stub: unsupported node $*" >&2; exit 1\n`);
  await fs.chmod(path.join(bin, "node"), 0o755);
  return { bin, dir };
}

// Execute the workflow's OWN detection `if` condition (tag step) with the
// stub git. Extracts the `if <cond>; then` line mentioning ls-remote,
// replays it as `if <cond>; then echo SEEN; else echo ABSENT; fi` (swapping
// labels when the workflow negates with `!`), prefixed by the workflow's
// TAG assignment lines.
function buildConditionProbe(run: string, version: string): string {
  const runLines = run.split("\n");
  const tagIdx = runLines.findIndex((l) => /^\s*TAG=/.test(l));
  expect(tagIdx).toBeGreaterThanOrEqual(0);
  // The detection `if` may test a precomputed variable (fail-closed
  // standalone assignment) rather than embedding the query, so locate the
  // first `if` AFTER the TAG assignment whose condition — or preceding
  // assignment preamble — mentions ls-remote.
  let ifIdx = -1;
  for (let i = tagIdx + 1; i < runLines.length; i++) {
    if (/^\s*if\b/.test(runLines[i])) {
      const block = runLines.slice(tagIdx, i + 1).join("\n");
      if (block.includes("ls-remote")) {
        ifIdx = i;
        break;
      }
    }
  }
  expect(ifIdx).toBeGreaterThan(tagIdx);
  const ifLine = runLines[ifIdx];
  const m = ifLine.match(/^\s*if\s+(!\s+)?(.*);\s*then\s*$/);
  expect(m, `detection if-line has unexpected shape: ${ifLine}`).not.toBeNull();
  const negated = Boolean(m![1]);
  const cond = m![2];
  const seen = negated ? "ABSENT" : "SEEN";
  const absent = negated ? "SEEN" : "ABSENT";
  return [
    "set -euo pipefail",
    `RELEASE_VERSION="${version}"`,
    ...runLines.slice(tagIdx, ifIdx),
    `if ${cond}; then echo "DETECT_${seen}"; else echo "DETECT_${absent}"; fi`,
  ].join("\n");
}

// Execute the repair gate's whole detection block (TAG assignment through
// the first refusal `fi`), then print GATE_OPEN. Pre-fix the block refuses
// (exit 1) on the SIGPIPE false negative; post-fix it falls through.
function buildGateProbe(run: string, version: string): string {
  const runLines = run.split("\n");
  const tagIdx = runLines.findIndex((l) => /^\s*TAG=/.test(l));
  expect(tagIdx).toBeGreaterThanOrEqual(0);
  const fiIdx = runLines.findIndex((l, i) => i > tagIdx && /^\s*fi\s*$/.test(l));
  expect(fiIdx).toBeGreaterThan(tagIdx);
  return [
    "set -euo pipefail",
    `RELEASE_VERSION="${version}"`,
    ...runLines.slice(tagIdx, fiIdx + 1),
    'echo "GATE_OPEN"',
  ].join("\n");
}

async function runProbe(
  script: string,
  tag: string,
  extraEnv: Record<string, string> = {},
): Promise<{ out: string; code: number }> {
  const { bin, dir } = await stubGitWithLargeNamespace(tag);
  const scriptPath = path.join(dir, "probe.sh");
  await fs.writeFile(scriptPath, `${script}\n`);
  const r = spawnSync("bash", [scriptPath], {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...extraEnv },
    encoding: "utf8",
  });
  return { out: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, code: r.status ?? -1 };
}

describe("publish tag detection (SIGPIPE-safe under pipefail)", () => {
  it("repair gate detects the existing tag (no false refusal)", async () => {
    const { gate } = await workflowRuns();
    const { out } = await runProbe(buildGateProbe(gate, "9.9.9"), "v9.9.9");
    // Pre-fix: pipeline exits 141 -> `! 141` takes the refusal branch
    // (exit 1, GATE_OPEN never printed).
    expect(out).toMatch(/GATE_OPEN/);
    expect(out).not.toMatch(/without in-workflow verification/);
  });

  it("tag-after-verify detects the existing tag (no spurious recreation)", async () => {
    const { tagStep } = await workflowRuns();
    const { out } = await runProbe(buildConditionProbe(tagStep, "9.9.9"), "v9.9.9");
    expect(out).toMatch(/DETECT_SEEN/);
    expect(out).not.toMatch(/DETECT_ABSENT/);
  });

  it("tag lookup failure is fail-closed UNKNOWN (never silent absent)", async () => {
    // If `git ls-remote` fails, the standalone assignment must propagate
    // the failure under `set -e` instead of selecting the "tag absent"
    // branch (which would create and push a tag on UNKNOWN state).
    const { tagStep } = await workflowRuns();
    const { out, code } = await runProbe(buildConditionProbe(tagStep, "9.9.9"), "v9.9.9", {
      STUB_GIT_FAIL_EXACT: "1",
    });
    expect(code).not.toBe(0);
    expect(out).not.toMatch(/DETECT_SEEN/);
    expect(out).not.toMatch(/DETECT_ABSENT/);
  });

  it("tag detection does not use the SIGPIPE-fragile full-namespace pipe", async () => {
    const text = await fs.readFile(path.join(REPO, ".github/workflows/publish.yml"), "utf8");
    // No `ls-remote --tags origin | grep -q` pipeline may remain: with a
    // large tag namespace grep -q closes the pipe early and pipefail turns
    // git's SIGPIPE (141) into a false negative.
    expect(text).not.toMatch(/ls-remote --tags origin\s*\|/);
  });

  it("tag detection requires an exact ref match (no suffix confusion)", async () => {
    // The stub's exact-ref query answers substring-style (as a
    // pattern-matching server could): querying refs/tags/v9.9 returns the
    // refs/tags/v9.9.9 lines. The workflow must still report ABSENT via its
    // exact ref-column filter.
    const { tagStep } = await workflowRuns();
    const { out } = await runProbe(buildConditionProbe(tagStep, "9.9"), "v9.9.9");
    expect(out).toMatch(/DETECT_ABSENT/);
    expect(out).not.toMatch(/DETECT_SEEN/);
  });

  it("tag creation is idempotent when the tag already exists locally", async () => {
    const { tagStep } = await workflowRuns();
    // A retry whose checkout already fetched the tag must resume, never fail
    // with `fatal: tag 'vX' already exists` (run 37989905139).
    expect(tagStep).toMatch(/rev-parse.*--verify.*TAG_REF|rev-parse.*--verify.*refs\/tags/);
    expect(tagStep).not.toMatch(/git tag -f|tag --force/);
  });

  it("a divergent pre-existing local tag fails without pushing", async () => {
    const { tagStep } = await workflowRuns();
    // A local tag pointing elsewhere must be refused BEFORE any push (never
    // publish a divergent tag; the TAG_SHA bind below stays normative).
    expect(tagStep).toMatch(/LOCAL_SHA|local.*tag.*does not match|divergent/i);
    expect(tagStep).toMatch(/refusing to push a divergent tag/i);
  });
});
