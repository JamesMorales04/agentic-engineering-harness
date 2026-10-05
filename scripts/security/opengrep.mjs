#!/usr/bin/env node
/**
 * Pinned OpenGrep SAST validator for AEH/Home.
 *
 * Fail-closed wrapper around the toolchain-provisioned `opengrep` binary:
 *  1. resolves the binary from PATH (toolchain bin paths first under Harness
 *     execution) and fails closed when it is absent;
 *  2. asserts the observed `--version` contains the pin from
 *     templates/provider-versions.json (single source of truth, cross-checked
 *     against policies/opengrep/pins.json);
 *  3. verifies every ruleset file digest plus the combined ruleset digest
 *     against policies/opengrep/pins.json before scanning;
 *  4. scans the candidate source scope (src/, scripts/, ui/control-center/src/)
 *     with the pinned ruleset and forwards the tool JSON to stdout untouched,
 *     so the Harness evidence parser sees exactly what the tool produced.
 *
 * Findings fail the validator through normalized evidence; warnings on stderr
 * (for example PartialParsing notes on valid TypeScript) are informational and
 * preserved in the raw artifact. Usage: `node scripts/security/opengrep.mjs`
 * with cwd set to the candidate tree root.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  assertToolVersion,
  providerVersions,
  readRulesetPins,
  resolveToolBinary,
  toolVersionOutput,
  verifyRulesetPins
} from "./toolPin.mjs";

const SCAN_TARGETS = ["src", "scripts", path.join("ui", "control-center", "src")];

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function main() {
  const root = process.cwd();
  let pins;
  let pinsDir;
  try {
    ({ pins, pinsDir } = readRulesetPins(REPO_ROOT));
  } catch (error) {
    fail(2, String(error instanceof Error ? error.message : error));
  }
  const versions = providerVersions(REPO_ROOT);
  if (pins.tool !== versions.opengrep) {
    fail(2, `TOOL_PIN_DIVERGED: policies/opengrep/pins.json pins opengrep '${pins.tool}' but templates/provider-versions.json pins '${versions.opengrep}'.`);
  }
  let ruleset;
  try {
    ruleset = verifyRulesetPins(pinsDir, pins);
  } catch (error) {
    fail(2, String(error instanceof Error ? error.message : error));
  }
  let binary;
  try {
    binary = resolveToolBinary("opengrep");
  } catch (error) {
    fail(2, String(error instanceof Error ? error.message : error));
  }
  let observedVersion;
  try {
    observedVersion = toolVersionOutput(binary);
    assertToolVersion("opengrep", pins.tool, observedVersion);
  } catch (error) {
    fail(2, String(error instanceof Error ? error.message : error));
  }
  const ruleFiles = Object.keys(pins.ruleset.files)
    .filter((relative) => relative.startsWith("rules/"))
    .sort()
    .map((relative) => path.resolve(pinsDir, relative));
  const targets = SCAN_TARGETS.map((target) => path.resolve(root, target)).filter((target) => {
    try {
      return fs.statSync(target).isDirectory();
    } catch {
      return false;
    }
  });
  if (!targets.length) {
    fail(2, "SCAN_SCOPE_EMPTY: none of src/, scripts/, ui/control-center/src/ exist under the candidate tree; refusing to report a vacuous pass.");
  }
  process.stderr.write(`opengrep ${observedVersion} ruleset ${pins.ruleset.name} v${ruleset.version} digest ${ruleset.digest}\n`);
  const scan = spawnSync(binary, ["scan", "--json", ...ruleFiles.flatMap((file) => ["-f", file]), ...targets], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024
  });
  if (scan.stdout) process.stdout.write(scan.stdout);
  if (scan.stderr) process.stderr.write(scan.stderr);
  if (scan.error) {
    fail(2, `TOOL_EXECUTION_FAILED: opengrep did not run: ${String(scan.error)}`);
  }
  process.exit(scan.status ?? 2);
}

main();
