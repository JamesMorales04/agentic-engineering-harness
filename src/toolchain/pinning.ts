import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedToolchainTool, ToolchainConfig, ToolchainLock } from "./types.js";

export function isLatestVersion(version: string | undefined): boolean {
  if (!version) return true;
  return version.trim().toLowerCase() === "latest";
}

export function isUnpinnedImage(image: string | undefined): boolean {
  if (!image) return false;
  if (image.includes("@sha256:")) return false;
  const afterSlash = image.split("/").pop() ?? image;
  if (!afterSlash.includes(":")) return true;
  const tag = (afterSlash.split(":").pop() ?? "").trim();
  if (!tag) return true;
  const lower = tag.toLowerCase();
  return lower === "latest" || lower.startsWith("latest-") || lower.startsWith("latest_") || lower.startsWith("latest.") || lower.startsWith("latest:");
}

/**
 * Exact-equality version token extraction, mirroring
 * scripts/security/toolPin.mjs extractReportedVersion. The match includes any
 * attached pre-release suffix so `1.22.0-unpinned` parses as
 * `1.22.0-unpinned`, never as `1.22.0`.
 */
export function extractReportedVersion(observed: string | undefined | null): string | null {
  const match = String(observed ?? "").match(/(?<![0-9A-Za-z.])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![0-9A-Za-z.-])/);
  return match ? match[1] : null;
}

/**
 * Exact-equality comparison for doctor inspectTool. Missing expectations or
 * unreadable actuals preserve the historical lenient pass (reported by other
 * checks); any two parseable tokens must be exactly equal, including
 * pre-release suffixes. Unparseable pairs fall back to trimmed string
 * equality so novel formats fail closed instead of normalizing away.
 */
export function reportedVersionsEqual(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected || !actual) return true;
  const exp = extractReportedVersion(expected);
  const act = extractReportedVersion(actual);
  if (exp !== null && act !== null) return exp === act;
  return actual.trim() === expected.trim();
}

export function findLatestVersionPins(tools: ResolvedToolchainTool[]): string[] {
  return tools
    .filter((tool) => tool.kind === "mise" && isLatestVersion(tool.version))
    .map((tool) => tool.name)
    .sort();
}

export function findUnpinnedActiveContainerImages(tools: ResolvedToolchainTool[]): string[] {
  return tools
    .filter((tool) => tool.provisioning === "container" && tool.container?.image && isUnpinnedImage(tool.container.image))
    .map((tool) => tool.name)
    .sort();
}

export function findUnpinnedDefinedImages(tools: ResolvedToolchainTool[]): string[] {
  return tools
    .filter((tool) => tool.container?.image && isUnpinnedImage(tool.container.image))
    .map((tool) => tool.name)
    .sort();
}

export function assertNoLatestPins(tools: ResolvedToolchainTool[]): void {
  const unpinned = findLatestVersionPins(tools);
  if (unpinned.length) {
    throw new Error(
      `TOOLCHAIN_UNPINNED_VERSION: toolchain tools request unpinned version 'latest': ${unpinned.join(", ")}. Pin exact versions in .harness/toolchain.yaml.`
    );
  }
  const images = findUnpinnedActiveContainerImages(tools);
  if (images.length) {
    throw new Error(
      `TOOLCHAIN_UNPINNED_IMAGE: container tools use unpinned ':latest' images: ${images.join(", ")}. Pin image@sha256 digests in .harness/toolchain.yaml.`
    );
  }
}

export interface ParsedMiseLockEntry {
  version?: string;
  specifiers?: string[];
  backend?: string;
}

function normalizeMiseSource(source: string): string {
  return source.split("[")[0];
}

export function resolveMiseEntryForTool(
  parsed: Record<string, ParsedMiseLockEntry>,
  toolName: string,
  source: string | undefined
): ParsedMiseLockEntry | undefined {
  if (source) {
    if (parsed[source]) return parsed[source];
    const normalized = normalizeMiseSource(source);
    if (parsed[normalized]) return parsed[normalized];
  }
  if (parsed[toolName]) return parsed[toolName];
  if (source) {
    const normalized = normalizeMiseSource(source);
    for (const entry of Object.values(parsed)) {
      if (entry.backend === source || entry.backend === normalized) return entry;
    }
    for (const [key, entry] of Object.entries(parsed)) {
      if (normalizeMiseSource(key) === normalized) return entry;
    }
  }
  return undefined;
}

/**
 * Minimal purpose-built parser for the subset of mise.lock TOML needed by the
 * doctor lock-consistency gate (no TOML dependency in package.json).
 * Parses only `[[tools.*]]` headers plus `version`, `backend`, and
 * `specifiers` fields; all other TOML (platform checksums, aube digests) is
 * ignored. Multi-line `specifiers = [...]` arrays are supported.
 *
 * FAIL-CLOSED ACCOUNTING (parseMiseLockDetailed): constructs in
 * `[[tools.*]]` scope that this subset parser cannot parse are counted in
 * `unparsedInScope` instead of being silently skipped:
 * - `[[tools.*]]` header attempts the header pattern cannot match (trailing
 *   inline comments) or cannot attribute (dotted keys);
 * - non-empty, non-comment field lines under a valid `[[tools.*]]` entry that
 *   are not `version`/`backend`/`specifiers` (including dotted keys and field
 *   values with trailing inline comments, which are never stripped-and-
 *   reparsed as clean values);
 * - any section header ends the current entry section, so fields under an
 *   unparseable header are never misattributed to the previous tool.
 * Single-bracket sections (`[tools."<source>"."platforms.<p>"]` checksum /
 * digest blocks) and the file preamble are the documented out-of-scope
 * subset: they end the current entry section but are never counted, so real
 * mise.lock files with platform blocks stay conclusive. The same holds for
 * `aube = {...}` digest-evidence lines under an entry: integrity evidence
 * orthogonal to this gate's version-consistency claim (named in the original
 * subset contract), explicitly ignored rather than counted. A non-empty
 * `unparsedInScope` makes checkToolchainLockConsistency INCONCLUSIVE-fail
 * (never false-comply).
 */
export interface DetailedMiseLockParse {
  entries: Record<string, ParsedMiseLockEntry>;
  unparsedInScope: string[];
}

const MISE_TOOLS_HEADER = /^\s*\[\[tools\.(.+)\]\]\s*$/;

export function parseMiseLockDetailed(content: string): DetailedMiseLockParse {
  const entries: Record<string, ParsedMiseLockEntry> = {};
  const unparsedInScope: string[] = [];
  const lines = content.split(/\r?\n/);
  let current: string | undefined;
  let inEntrySection = false;
  let inSpecifiers = false;
  let specBuffer = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const headerMatch = line.match(MISE_TOOLS_HEADER);
      if (headerMatch) {
        const key = unquoteTomlKey(headerMatch[1].trim());
        if (!key.includes(".")) {
          current = key;
          entries[current] ??= {};
          inEntrySection = true;
          inSpecifiers = false;
          specBuffer = "";
          continue;
        }
      }
      // In-scope-but-unparseable header attempt: double-bracket tools headers
      // with dotted keys or trailing inline comments. Counted fail-closed.
      if (/^\[\[\s*tools\./.test(line)) unparsedInScope.push(raw);
      current = undefined;
      inEntrySection = false;
      inSpecifiers = false;
      specBuffer = "";
      continue;
    }
    if (!inEntrySection || !current) continue;
    if (inSpecifiers) {
      specBuffer += ` ${line}`;
      if (line.includes("]")) {
        entries[current].specifiers = parseStringArray(specBuffer);
        inSpecifiers = false;
        specBuffer = "";
      }
      continue;
    }
    const versionMatch = line.match(/^version\s*=\s*(.+)\s*$/);
    if (versionMatch) {
      if (hasTrailingComment(versionMatch[1])) { unparsedInScope.push(raw); continue; }
      entries[current].version = parseTomlString(versionMatch[1]);
      continue;
    }
    const backendMatch = line.match(/^backend\s*=\s*(.+)\s*$/);
    if (backendMatch) {
      if (hasTrailingComment(backendMatch[1])) { unparsedInScope.push(raw); continue; }
      entries[current].backend = parseTomlString(backendMatch[1]);
      continue;
    }
    const specifiersMatch = line.match(/^specifiers\s*=\s*(.+)\s*$/);
    if (specifiersMatch) {
      const rest = specifiersMatch[1].trim();
      if (rest.includes("]")) {
        entries[current].specifiers = parseStringArray(rest);
      } else {
        inSpecifiers = true;
        specBuffer = rest;
      }
      continue;
    }
    // `aube = {...}` digest evidence is named ignored-subset (see contract
    // above): integrity evidence orthogonal to version consistency.
    if (/^aube\s*=/.test(line)) continue;
    unparsedInScope.push(raw);
  }
  return { entries, unparsedInScope };
}

export function parseMiseLock(content: string): Record<string, ParsedMiseLockEntry> {
  return parseMiseLockDetailed(content).entries;
}

function unquoteTomlKey(key: string): string {
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    try {
      return JSON.parse(key);
    } catch {
      return key.slice(1, -1);
    }
  }
  return key;
}

/** True when a TOML scalar carries a `#` comment outside quoted strings. */
function hasTrailingComment(value: string): boolean {
  let quote: string | undefined;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return true;
  }
  return false;
}

function parseTomlString(value: string): string | undefined {
  const trimmed = value.trim().replace(/,+\s*$/, "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return undefined;
}

function parseStringArray(value: string): string[] {
  const matches = value.match(/"([^"]*)"|'([^']*)'/g) ?? [];
  return matches.map((token) => {
    const t = token.trim();
    if (t.startsWith('"') && t.endsWith('"')) {
      try {
        return JSON.parse(t) as string;
      } catch {
        return t.slice(1, -1);
      }
    }
    return t.slice(1, -1);
  });
}

export async function loadMiseLockForDoctor(root: string): Promise<{ parsed: Record<string, ParsedMiseLockEntry>; file: string; unparsedInScope: string[] } | undefined> {
  const candidates = [".config/mise/mise.lock", "mise.lock", ".mise.lock"];
  for (const candidate of candidates) {
    try {
      const file = path.resolve(root, candidate);
      const content = await fs.readFile(file, "utf8");
      const detailed = parseMiseLockDetailed(content);
      return { parsed: detailed.entries, file: candidate, unparsedInScope: detailed.unparsedInScope };
    } catch {
      continue;
    }
  }
  return undefined;
}

export interface LockConsistencyResult {
  ok: boolean;
  divergences: string[];
}

export function checkToolchainLockConsistency(
  toolchain: ToolchainConfig,
  lock: ToolchainLock | undefined,
  miseLock: Record<string, ParsedMiseLockEntry> | undefined,
  options: { miseLockUnparsedInScope?: readonly string[] } = {}
): LockConsistencyResult {
  const divergences: string[] = [];
  if (!lock) {
    // Fail-closed: toolchain.lock.json is gitignored machine-local state that
    // `aeh setup` always writes. Absence means uninitialized — never "ok".
    return { ok: false, divergences: ["toolchain-lock-uninitialized: no toolchain.lock.json found; run `aeh setup` to generate it (post-setup it always exists)."] };
  }
  const unparsed = options.miseLockUnparsedInScope ?? [];
  if (unparsed.length) {
    // INCONCLUSIVE-fail: the subset parser could not parse in-scope mise.lock
    // constructs, so consistency cannot be verified. Never false-comply.
    const preview = unparsed.slice(0, 3).map((line) => line.trim().slice(0, 80)).join(" | ");
    divergences.push(
      `INCONCLUSIVE: mise.lock has ${unparsed.length} unparsed in-scope line(s) (e.g. ${preview}); lock consistency cannot be verified. Regenerate locks with 'aeh setup' using supported constructs.`
    );
  }
  if (!miseLock) return { ok: divergences.length === 0, divergences };
  for (const [name, entry] of Object.entries(lock.tools)) {
    const definition = toolchain.tools[name];
    if (definition?.version && entry.requestedVersion !== undefined && entry.requestedVersion !== definition.version) {
      divergences.push(
        `tool '${name}' requestedVersion divergence: toolchain.yaml='${definition.version}' vs toolchain.lock requested='${entry.requestedVersion}'`
      );
    }
    const miseEntry = resolveMiseEntryForTool(miseLock, name, definition?.source ?? entry.source);
    if (!miseEntry) {
      // Fail-closed: a mise-provisioned pinned tool with no mise.lock entry
      // cannot be verified. Missing entries are DRIFT, never skipped.
      const expectsMiseEntry = entry.provisioning === "mise" || (entry.provisioning === undefined && definition?.kind === "mise");
      if (expectsMiseEntry) {
        divergences.push(
          `tool '${name}' has no entry in mise.lock (cannot verify, not skipped; run \`aeh setup\` to regenerate locks).`
        );
      }
      continue;
    }
    if (entry.resolvedVersion && miseEntry.version && entry.resolvedVersion !== miseEntry.version) {
      divergences.push(
        `tool '${name}' version divergence: toolchain.lock resolved='${entry.resolvedVersion}' vs mise.lock version='${miseEntry.version}'`
      );
    }
    if (miseEntry?.specifiers?.includes("latest")) {
      divergences.push(`tool '${name}' mise.lock specifiers contain unpinned 'latest' (specifiers=[${miseEntry.specifiers.map((s) => `'${s}'`).join(", ")}])`);
    }
    if (miseEntry && entry.resolvedVersion && miseEntry.specifiers && !miseEntry.specifiers.includes(entry.resolvedVersion)) {
      divergences.push(
        `tool '${name}' mise.lock specifiers missing locked version '${entry.resolvedVersion}' (specifiers=[${miseEntry.specifiers.map((s) => `'${s}'`).join(", ")}])`
      );
    }
  }
  return { ok: divergences.length === 0, divergences };
}
