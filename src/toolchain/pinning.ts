import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedToolchainTool, ToolchainConfig, ToolchainLock, ToolchainLockTool, ToolchainToolDefinition } from "./types.js";

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
 * KNOWN-OPAQUE TOOL-ENTRY FIELDS: mise documents `uv` (Python sidecar
 * `{ path, digest }`, same inline-table shape as the `aube` npm sidecar) and
 * `options` (backend-specific artifact identity, e.g.
 * `options = { swift_platform = "ubuntu24.04" }`) as valid fields under a
 * `[[tools.*]]` entry. Their values are integrity/identity evidence
 * orthogonal to this gate's version-consistency claim, so `aube = ...`,
 * `uv = ...`, and `options = ...` lines (including dotted-key forms such as
 * `options.foo = ...`, and multi-line inline tables consumed until brackets
 * balance) are skipped as known-opaque rather than counted. Single-bracket
 * nested tables under a known field (e.g. `[tools.<entry>.uv]`) end the
 * current entry section like every other single-bracket section and are never
 * counted (documented out-of-scope subset, same as platform blocks).
 *
 * FAIL-CLOSED ACCOUNTING (parseMiseLockDetailed): constructs in
 * `[[tools.*]]` scope that this subset parser cannot parse are counted in
 * `unparsedInScope` instead of being silently skipped:
 * - `[[tools.*]]` header attempts the header pattern cannot match (trailing
 *   inline comments) or cannot attribute (dotted keys);
 * - non-empty, non-comment field lines under a valid `[[tools.*]]` entry that
 *   are not `version`/`backend`/`specifiers` or a known-opaque field
 *   (`aube`/`uv`/`options`, including dotted-key forms and multi-line inline
 *   tables consumed until brackets balance, which are skipped, never counted;
 *   this includes dotted keys and field values with trailing inline comments,
 *   which are never stripped-and-reparsed as clean values);
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
 * (never false-comply). Two opaque-run truncation rules close the
 * swallow-through-EOF gap: a section-header line (`[`-leading) while inside a
 * known-opaque run ends the run — the opener never balanced, so it is counted
 * and the header is processed normally (headers are structural and cannot
 * occur inside a valid inline table, so later tool sections are never
 * swallowed); EOF with a still-open opaque run (unbalanced table, truncated
 * lock) counts the opener the same way.
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
  let inOpaqueKnown = false;
  let opaqueDepth = 0;
  let opaqueOpener: string | undefined;
  // TOML 1.1 multiline STRING state (DETERMINISTIC): a bracket-led
  // continuation line inside `"""..."""` / `'''...'''` is string content,
  // never a section header. Only multiline delimiters carry across lines;
  // single-line `"` / `'` strings cannot span lines.
  let inMultilineString: '"""' | "'''" | null = null;
  for (const raw of lines) {
    if (inMultilineString !== null) {
      // Continuation/closing line inside a multiline string: never
      // structural and never separately counted — the opener line already
      // carries the fail-closed accounting.
      inMultilineString = scanMultilineStringState(raw, inMultilineString);
      continue;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const startsBracket = line.startsWith("[");
    // Headers are structural and never open a string; only non-header lines
    // can carry multiline state into the next line.
    inMultilineString = startsBracket ? null : scanMultilineStringState(raw, null);
    if (inOpaqueKnown && startsBracket) {
      // Section headers are structural: they cannot occur inside a valid
      // inline table, so a header line ends the opaque run and is processed
      // as a header normally. The table that opened the run never balanced
      // (truncated lock): record the opener fail-closed (INCONCLUSIVE) so a
      // truncated `uv = { ...` can never swallow following tool sections
      // into false compliance.
      if (opaqueOpener !== undefined) unparsedInScope.push(opaqueOpener);
      inOpaqueKnown = false;
      opaqueDepth = 0;
      opaqueOpener = undefined;
    } else if (inOpaqueKnown) {
      // Multi-line inline table under a known-opaque field (aube/uv/options):
      // consumed until brackets balance, never counted.
      opaqueDepth += bracketDepthDelta(line);
      if (opaqueDepth <= 0) {
        inOpaqueKnown = false;
        opaqueDepth = 0;
        opaqueOpener = undefined;
      }
      continue;
    }
    if (startsBracket) {
      const headerMatch = line.match(MISE_TOOLS_HEADER);
      if (headerMatch) {
        const key = unquoteTomlKey(headerMatch[1].trim());
        if (!key.includes(".")) {
          current = key;
          entries[current] ??= {};
          inEntrySection = true;
          inSpecifiers = false;
          specBuffer = "";
          inOpaqueKnown = false;
          opaqueDepth = 0;
          opaqueOpener = undefined;
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
      inOpaqueKnown = false;
      opaqueDepth = 0;
      opaqueOpener = undefined;
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
    // Known-opaque tool-entry fields (see contract above): integrity/identity
    // evidence orthogonal to version consistency (`aube`/`uv` sidecar
    // `{ path, digest }` references, `options` backend artifact identity).
    // Skipped, never counted — including dotted-key forms (`options.foo`,
    // `uv.path`, ...) and multi-line inline tables (consumed until brackets
    // balance so continuation lines are never misread as unparsed fields).
    if (/^(aube|uv|options)\s*=/.test(line)) {
      const value = line.slice(line.indexOf("=") + 1);
      const depth = bracketDepthDelta(value);
      if (depth > 0) {
        inOpaqueKnown = true;
        opaqueDepth = depth;
        opaqueOpener = raw;
      }
      continue;
    }
    if (/^(aube|uv|options)\./.test(line)) continue;
    unparsedInScope.push(raw);
  }
  if (inMultilineString !== null) {
    // Unclosed multiline string through EOF: truncated lock — the swallowed
    // tail cannot be verified, so INCONCLUSIVE-fail (never false-comply).
    unparsedInScope.push("<truncated multiline string at EOF>");
  }
  if (inOpaqueKnown) {
    // Unbalanced opaque table through EOF: truncated lock — the swallowed
    // tail cannot be verified, so INCONCLUSIVE-fail (never false-comply).
    unparsedInScope.push(opaqueOpener ?? "<truncated known-opaque table at EOF>");
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

/** Net `{`/`[` minus `}`/`]` outside quoted strings (`#` starts a comment). */
function bracketDepthDelta(line: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") break;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }
  return depth;
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

/** Outgoing multiline-STRING state after scanning one raw line (DETERMINISTIC).
 * Tracks TOML 1.1 `"""` (basic, `\`-escapes) and `'''` (literal, no escapes)
 * delimiters; single-line `"` / `'` strings are skipped inline and never
 * carry; `#` outside strings starts a comment. Headers never open strings —
 * callers only carry state for non-header lines, and continuation lines are
 * skipped before any structural test so `[`-leading string content is never
 * misread as a section header. */
function scanMultilineStringState(raw: string, incoming: '"""' | "'''" | null): '"""' | "'''" | null {
  let state = incoming;
  let i = 0;
  while (i < raw.length) {
    if (state === '"""') {
      if (raw[i] === "\\") { i += 2; continue; }
      if (raw.startsWith('"""', i)) { state = null; i += 3; continue; }
      i++;
      continue;
    }
    if (state === "'''") {
      if (raw.startsWith("'''", i)) { state = null; i += 3; continue; }
      i++;
      continue;
    }
    const char = raw[i];
    if (char === "#") break;
    if (raw.startsWith('"""', i)) { state = '"""'; i += 3; continue; }
    if (raw.startsWith("'''", i)) { state = "'''"; i += 3; continue; }
    if (char === '"') {
      i++;
      while (i < raw.length) {
        if (raw[i] === "\\") { i += 2; continue; }
        if (raw[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (char === "'") {
      i++;
      while (i < raw.length && raw[i] !== "'") i++;
      if (i < raw.length) i++;
      continue;
    }
    i++;
  }
  return state;
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeJsonShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value === "object") return "object";
  return typeof value;
}

/**
 * DRIFT-safe expects-mise predicate (default-true, DETERMINISTIC).
 *
 * Returns false ONLY on positive proof of non-mise provisioning: the lock
 * entry explicitly names another provisioner (`system`/`container`), or the
 * matched toolchain.yaml definition has a non-mise kind. Every ambiguous
 * case — orphan entries with no `provisioning` and no matching tool
 * definition, malformed entries, unknown provisioner names — returns true:
 * when the provisioner cannot be proven non-mise, assume mise-provisioned so
 * unverifiable tools drift instead of passing silently.
 */
function expectsMiseEntry(
  entry: Pick<ToolchainLockTool, "provisioning"> | null | undefined,
  definition: Pick<ToolchainToolDefinition, "kind"> | undefined
): boolean {
  if (entry?.provisioning === "system" || entry?.provisioning === "container") return false;
  if (definition?.kind !== undefined && definition.kind !== "mise") return false;
  return true;
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
  if (!isPlainRecord(lock.tools)) {
    // Fail-closed: the config loader passes raw lock JSON through without
    // validation, so a syntactically valid but wrong-shaped lock reaches this
    // gate. Name the malformation explicitly (collapsing to
    // "uninitialized" would mask a corrupt-but-present lock). Never silent ok.
    const shape = describeJsonShape(lock.tools);
    return { ok: false, divergences: [`toolchain-lock-malformed: 'tools' in toolchain.lock.json is not an object (got ${shape}); delete the lock and run \`aeh setup\` to regenerate it.`] };
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
  if (!miseLock) {
    // Fail-closed: with no mise.lock on disk, every mise-provisioned locked
    // tool is unverifiable → DRIFT (cannot verify, never skipped). Tools with
    // no mise backend (all non-mise-provisioned) need no mise entry, so a
    // lock with zero mise-provisioned tools stays ok — distinguished by
    // reading each tool's backend, not by blanket rule. Same
    // expects-mise-entry predicate as the per-tool missing-entry check below.
    for (const [name, entry] of Object.entries(lock.tools)) {
      if (!isPlainRecord(entry)) {
        divergences.push(
          `tool '${name}' lock entry is malformed (expected an object with provisioning/source/version fields, got ${describeJsonShape(entry)}); delete the lock and run \`aeh setup\` to regenerate it.`
        );
        continue;
      }
      const definition = toolchain.tools[name];
      if (expectsMiseEntry(entry, definition)) {
        divergences.push(
          `tool '${name}' has no mise.lock to verify against (missing mise.lock; cannot verify, not skipped; run \`aeh setup\` to regenerate locks).`
        );
      }
    }
    return { ok: divergences.length === 0, divergences };
  }
  for (const [name, entry] of Object.entries(lock.tools)) {
    if (!isPlainRecord(entry)) {
      divergences.push(
        `tool '${name}' lock entry is malformed (expected an object with provisioning/source/version fields, got ${describeJsonShape(entry)}); delete the lock and run \`aeh setup\` to regenerate it.`
      );
      continue;
    }
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
      // Default-true: only positive proof of non-mise provisioning opts out.
      if (expectsMiseEntry(entry, definition)) {
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
