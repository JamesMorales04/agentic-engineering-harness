#!/usr/bin/env node
/**
 * Pinned Trivy dependency-vulnerability validator for AEH/Home.
 *
 * Fail-closed wrapper around the toolchain-provisioned `trivy` binary:
 *  1. resolves the binary from PATH (toolchain bin paths first under Harness
 *     execution) and fails closed when it is absent;
 *  2. asserts the observed `trivy --version` contains the pin from
 *     templates/provider-versions.json (single source of truth);
 *  3. runs `trivy fs` over the candidate tree with the pinned scanner and
 *     severity scope (vulnerabilities only, HIGH and CRITICAL) and forwards
 *     the tool JSON to stdout untouched, so the Harness evidence parser sees
 *     exactly what the tool produced.
 *
 * Secret and misconfiguration scanning live in trivy-secret-misconfig.mjs as
 * a separate assurance dimension with its own candidate-bound evidence.
 * Usage: `node scripts/security/trivy-vuln.mjs` with cwd set to the candidate
 * tree root.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { REPO_ROOT, assertToolVersion, providerVersions, resolveToolBinary, toolVersionOutput } from "./toolPin.mjs";

const SCANNERS = "vuln";
const SEVERITY = "HIGH,CRITICAL";

// Drain-safe output: synchronous writes block until the bytes are
// delivered, so a process.exit() immediately afterward can never truncate
// piped stdout/stderr (async write + immediate exit drops buffered output,
// which once produced truncated trivy JSON that failed evidence parsing).
function fail(code, message) {
  fs.writeSync(process.stderr.fd, `${message}\n`);
  process.exit(code);
}

function main() {
  const root = process.cwd();
  const versions = providerVersions(REPO_ROOT);
  const pinned = versions.trivy;
  if (!pinned) fail(2, "TOOL_PIN_INVALID: no pinned version for 'trivy' in templates/provider-versions.json.");
  let binary;
  try {
    binary = resolveToolBinary("trivy");
  } catch (error) {
    fail(2, String(error instanceof Error ? error.message : error));
  }
  let observedVersion;
  try {
    observedVersion = toolVersionOutput(binary);
    assertToolVersion("trivy", pinned, observedVersion);
  } catch (error) {
    fail(2, String(error instanceof Error ? error.message : error));
  }
  fs.writeSync(process.stderr.fd, `trivy dependency scan (scanners=${SCANNERS} severity=${SEVERITY}) with pinned trivy ${pinned}\n`);
  const scan = spawnSync(
    binary,
    ["fs", "--format", "json", "--exit-code", "1", "--severity", SEVERITY, "--scanners", SCANNERS, "."],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
  );
  // Drain-safe: synchronous writes (see fail() above).
  if (scan.stdout) fs.writeSync(process.stdout.fd, scan.stdout);
  if (scan.stderr) fs.writeSync(process.stderr.fd, scan.stderr);
  if (scan.error) {
    fail(2, `TOOL_EXECUTION_FAILED: trivy did not run: ${String(scan.error)}`);
  }
  process.exit(scan.status ?? 2);
}

main();
