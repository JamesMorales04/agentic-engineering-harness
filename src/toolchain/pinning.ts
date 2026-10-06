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
 */
export function parseMiseLock(content: string): Record<string, ParsedMiseLockEntry> {
  const result: Record<string, ParsedMiseLockEntry> = {};
  const lines = content.split(/\r?\n/);
  let current: string | undefined;
  let inSpecifiers = false;
  let specBuffer = "";
  const header = /^\s*\[\[tools\.(.+)\]\]\s*$/;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const headerMatch = line.match(header);
    if (headerMatch) {
      let key = headerMatch[1].trim();
      if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
        try {
          key = JSON.parse(key);
        } catch {
          key = key.slice(1, -1);
        }
      }
      if (key.includes(".")) continue;
      current = key;
      result[current] ??= {};
      inSpecifiers = false;
      specBuffer = "";
      continue;
    }
    if (!current) continue;
    if (current.includes(".")) continue;
    if (inSpecifiers) {
      specBuffer += ` ${line}`;
      if (line.includes("]")) {
        result[current].specifiers = parseStringArray(specBuffer);
        inSpecifiers = false;
        specBuffer = "";
      }
      continue;
    }
    const versionMatch = line.match(/^version\s*=\s*(.+)\s*$/);
    if (versionMatch) {
      result[current].version = parseTomlString(versionMatch[1]);
      continue;
    }
    const backendMatch = line.match(/^backend\s*=\s*(.+)\s*$/);
    if (backendMatch) {
      result[current].backend = parseTomlString(backendMatch[1]);
      continue;
    }
    const specifiersMatch = line.match(/^specifiers\s*=\s*(.+)\s*$/);
    if (specifiersMatch) {
      const rest = specifiersMatch[1].trim();
      if (rest.includes("]")) {
        result[current].specifiers = parseStringArray(rest);
      } else {
        inSpecifiers = true;
        specBuffer = rest;
      }
    }
  }
  return result;
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

export async function loadMiseLockForDoctor(root: string): Promise<{ parsed: Record<string, ParsedMiseLockEntry>; file: string } | undefined> {
  const candidates = [".config/mise/mise.lock", "mise.lock", ".mise.lock"];
  for (const candidate of candidates) {
    try {
      const file = path.resolve(root, candidate);
      const content = await fs.readFile(file, "utf8");
      return { parsed: parseMiseLock(content), file: candidate };
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
  miseLock: Record<string, ParsedMiseLockEntry> | undefined
): LockConsistencyResult {
  const divergences: string[] = [];
  if (!lock) return { ok: true, divergences };
  if (!miseLock) return { ok: divergences.length === 0, divergences };
  for (const [name, entry] of Object.entries(lock.tools)) {
    const definition = toolchain.tools[name];
    if (definition?.version && entry.requestedVersion !== undefined && entry.requestedVersion !== definition.version) {
      divergences.push(
        `tool '${name}' requestedVersion divergence: toolchain.yaml='${definition.version}' vs toolchain.lock requested='${entry.requestedVersion}'`
      );
    }
    const miseEntry = resolveMiseEntryForTool(miseLock, name, definition?.source ?? entry.source);
    if (miseEntry && entry.resolvedVersion && miseEntry.version && entry.resolvedVersion !== miseEntry.version) {
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
