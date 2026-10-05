import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Authoritative toolchain pins; templates/provider-versions.json is the single source of truth. */
export function providerVersions(root = REPO_ROOT) {
  const override = process.env.AEH_PROVIDER_VERSIONS?.trim();
  const file = override ? path.resolve(override) : path.join(root, "templates", "provider-versions.json");
  let parsed;
  try {
    parsed = readJsonFile(file);
  } catch (error) {
    throw new Error(`TOOL_PIN_VERSIONS_UNREADABLE: provider versions file '${file}' cannot be read: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`TOOL_PIN_VERSIONS_UNREADABLE: provider versions file '${file}' is not a JSON object.`);
  }
  return parsed;
}

export function readRulesetPins(root = REPO_ROOT) {
  const override = process.env.AEH_OPENGREP_PINS?.trim();
  const pinsFile = override ? path.resolve(override) : path.join(root, "policies", "opengrep", "pins.json");
  let pins;
  try {
    pins = readJsonFile(pinsFile);
  } catch (error) {
    throw new Error(`RULESET_PIN_UNREADABLE: OpenGrep ruleset pins '${pinsFile}' cannot be read: ${String(error)}`);
  }
  if (!pins || pins.version !== 1 || !pins.ruleset || typeof pins.ruleset.digest !== "string" || !pins.ruleset.files || typeof pins.ruleset.files !== "object") {
    throw new Error(`RULESET_PIN_INVALID: OpenGrep ruleset pins '${pinsFile}' is not a version-1 pins document.`);
  }
  return { pins, pinsFile, pinsDir: path.dirname(pinsFile) };
}

export function sha256Utf8Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Canonical ruleset digest: sha256 over each pinned file in sorted path order
 * as `<relative-posix-path>\0<bytes>`. Verification recomputes both the
 * per-file digests and this combined digest and fails closed on any mismatch.
 */
export function rulesetDigest(pinsDir, files) {
  const hash = crypto.createHash("sha256");
  const observed = {};
  for (const relative of Object.keys(files).sort()) {
    const absolute = path.resolve(pinsDir, relative);
    let digest;
    try {
      digest = sha256File(absolute);
    } catch {
      throw new Error(`RULESET_FILE_MISSING: OpenGrep ruleset file '${relative}' is absent; the scan cannot run on an incomplete ruleset.`);
    }
    observed[relative] = digest;
    hash.update(relative, "utf8");
    hash.update("\0", "utf8");
    hash.update(fs.readFileSync(absolute));
  }
  return { digest: hash.digest("hex"), observed };
}

export function verifyRulesetPins(pinsDir, pins) {
  const { digest, observed } = rulesetDigest(pinsDir, pins.ruleset.files);
  const mismatched = Object.entries(pins.ruleset.files)
    .filter(([relative, expected]) => observed[relative] !== expected)
    .map(([relative]) => relative)
    .sort();
  if (mismatched.length) {
    throw new Error(`RULESET_DIGEST_MISMATCH: OpenGrep ruleset files changed without a pins update: ${mismatched.join(", ")}.`);
  }
  if (digest !== pins.ruleset.digest) {
    throw new Error(`RULESET_DIGEST_MISMATCH: OpenGrep ruleset combined digest ${digest} does not match pinned ${pins.ruleset.digest}.`);
  }
  return { version: pins.ruleset.version, digest };
}

export function resolveToolBinary(tool) {
  const override = process.env[`AEH_${tool.toUpperCase()}_BINARY`]?.trim();
  if (override) {
    if (isExecutable(override)) return override;
    throw new Error(`TOOL_UNAVAILABLE: ${tool} override '${override}' is not executable; the required validator cannot run.`);
  }
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, tool);
    if (isExecutable(candidate)) return candidate;
  }
  throw new Error(`TOOL_UNAVAILABLE: ${tool} is not installed; the required validator cannot run.`);
}

function isExecutable(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function toolVersionOutput(binary, args = ["--version"]) {
  try {
    return execFileSync(binary, [...args], { encoding: "utf8", timeout: 30_000 }).trim();
  } catch (error) {
    throw new Error(`TOOL_VERSION_UNREADABLE: '${binary} --version' failed: ${String(error)}`);
  }
}

/**
 * Parse the first tool version token out of `--version` output. The match
 * includes any attached pre-release suffix so `1.22.0-unpinned` parses as
 * `1.22.0-unpinned`, never as `1.22.0`. Returns null when no token is found.
 */
export function extractReportedVersion(observed) {
  const match = String(observed ?? "").match(/(?<![0-9A-Za-z.])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![0-9A-Za-z.-])/);
  return match ? match[1] : null;
}

/** Fail closed unless the parsed reported version equals the pinned version exactly. */
export function assertToolVersion(tool, pinned, observed) {
  if (!pinned || typeof pinned !== "string") {
    throw new Error(`TOOL_PIN_INVALID: no pinned version for '${tool}' in templates/provider-versions.json.`);
  }
  if (extractReportedVersion(observed) !== pinned) {
    throw new Error(`TOOL_VERSION_MISMATCH: ${tool} version pin is '${pinned}' but the resolved binary reported '${observed}'.`);
  }
  return pinned;
}
