import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PaseoSdkPermissionStop } from "./sdk.js";

const safePermissionNames = new Set(["external_directory", "permission", "tool", "shell", "network", "read", "write", "command"]);

/** Revalidate provider supplied structured diagnostics before they cross a persistence boundary. */
export function redactPermissionStopDiagnostic(value: unknown, fallbackSessionId?: string): PaseoSdkPermissionStop {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const candidate = typeof record.name === "string" ? record.name : "";
  const name = safePermissionNames.has(candidate) ? candidate : "UNKNOWN";
  const relation = record.scopeRelation === "INSIDE" || record.scopeRelation === "OUTSIDE" ? record.scopeRelation : "UNKNOWN";
  const requestedScopeDigest = typeof record.requestedScopeDigest === "string" && /^[a-f0-9]{64}$/i.test(record.requestedScopeDigest) ? record.requestedScopeDigest.toLowerCase() : undefined;
  const safeId = (item: unknown): string | undefined => typeof item === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(item) ? item : undefined;
  const sessionId = safeId(record.sessionId) ?? safeId(fallbackSessionId);
  const turnId = safeId(record.turnId);
  // Harness-side projection snapshot (bounded absolute paths only): makes the
  // next OUTSIDE attributable to its active lease without persisting
  // provider-supplied paths. Raw request patterns stay redacted by design.
  const authorizedRoots = Array.isArray(record.authorizedRoots)
    ? record.authorizedRoots
      .filter((item): item is string => typeof item === "string" && item.startsWith("/") && item.length <= 300)
      .slice(0, 16)
    : undefined;
  return { name, scopeRelation: relation, ...(requestedScopeDigest ? { requestedScopeDigest } : {}), ...(authorizedRoots?.length ? { authorizedRoots } : {}), ...(sessionId ? { sessionId } : {}), ...(turnId ? { turnId } : {}) };
}

/** Redact provider scope data while classifying it against the frozen launch projection. */
export async function createPermissionStopDiagnostic(
  name: string | undefined,
  patterns: string[] | undefined,
  authorizedRoots: string[] | undefined,
  sessionId?: string,
  turnId?: string
): Promise<PaseoSdkPermissionStop | undefined> {
  if (!name && !patterns?.length) return undefined;
  const requestedScopeDigest = patterns?.length ? createHash("sha256").update(JSON.stringify(patterns)).digest("hex") : undefined;
  const scopeRelation = await classifyPermissionScope(patterns, authorizedRoots);
  return redactPermissionStopDiagnostic({
    ...(name ? { name } : {}),
    scopeRelation,
    ...(requestedScopeDigest ? { requestedScopeDigest } : {}),
    ...(authorizedRoots?.length ? { authorizedRoots } : {}),
    sessionId,
    turnId
  }, sessionId);
}

async function classifyPermissionScope(patterns: string[] | undefined, roots: string[] | undefined): Promise<PaseoSdkPermissionStop["scopeRelation"]> {
  if (!patterns?.length || !roots?.length) return "UNKNOWN";
  const canonicalRoots = await Promise.all(roots.map((root) => canonicalize(root).catch(() => undefined)));
  const resolvedRoots = canonicalRoots.filter((root): root is string => Boolean(root));
  if (!resolvedRoots.length || resolvedRoots.length !== roots.length) return "UNKNOWN";
  let sawInside = false;
  for (const raw of patterns) {
    const requested = expandPath(raw);
    if (!requested || !path.isAbsolute(requested)) return "UNKNOWN";
    const wildcardAt = requested.search(/[?*[{]/);
    const hasGlob = wildcardAt >= 0;
    const staticPrefix = hasGlob ? requested.slice(0, wildcardAt).replace(/[/\\]+$/, "") || path.parse(requested).root : requested;
    const canonicalRequest = await canonicalize(staticPrefix).catch(() => undefined);
    if (!canonicalRequest) return "UNKNOWN";
    const within = resolvedRoots.some((root) => contains(root, canonicalRequest));
    const containsAuthorizedRoot = resolvedRoots.some((root) => contains(canonicalRequest, root));
    if (within && (!hasGlob || resolvedRoots.some((root) => contains(root, canonicalRequest)))) sawInside = true;
    else if (containsAuthorizedRoot) return hasGlob ? "OUTSIDE" : "UNKNOWN";
    else return "OUTSIDE";
  }
  return sawInside ? "INSIDE" : "UNKNOWN";
}

function expandPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

async function canonicalize(value: string): Promise<string> {
  const absolute = path.resolve(value);
  try { return await fs.realpath(absolute); }
  catch {
    // Resolve the deepest existing ancestor so nonexistent leaf scopes retain the
    // actual symlink boundary of their parent. The unresolved suffix is normalized.
    const parent = path.dirname(absolute);
    if (parent === absolute) throw new Error("unresolvable permission scope");
    return path.join(await canonicalize(parent), path.basename(absolute));
  }
}

function contains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
