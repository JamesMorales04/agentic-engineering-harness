import fs from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig } from "../core/config.js";
import { PASEO_BOOTSTRAP_VERSION } from "../paseo/leadState.js";
import { VERSION } from "../version.js";

/**
 * Durable managed-lead identity (MECHANISM: DETERMINISTIC).
 *
 * The durable lead-session.json written by `aeh start` is the sole authority
 * for which Paseo session is the managed Lead for a control root. Ambient
 * identities (PASEO_AGENT_ID propagated into an arbitrary shell, explicit
 * caller-supplied agent ids) are notification hints, never authority: they
 * bind as operation lead only when they verify against this durable record.
 */

export interface DurableLeadIdentity {
  agentId: string;
  source: "lead-state";
}

export interface StartLeadCandidate {
  agentId: string;
  source: string;
}

export type StartLeadBindingResolution =
  | { status: "VERIFIED"; agentId: string; source: string }
  | { status: "DURABLE"; agentId: string; source: "lead-state" }
  | { status: "UNBOUND"; reason: string };

/**
 * Resolve the durable managed lead for a control root. Throws when no
 * project configuration exists, the lead-session file is unreadable, or the
 * persisted state is incompatible with this root/runtime (same compatibility
 * rules the MCP identity path has always enforced). Callers that must never
 * fail (operation start, S6 dispatch) use tryResolveDurableLeadIdentity.
 */
export async function resolveDurableLeadIdentity(root: string): Promise<DurableLeadIdentity> {
  const absoluteRoot = path.resolve(root);
  const config = await loadProjectConfig(absoluteRoot);
  const stateDir = path.resolve(absoluteRoot, config.orchestration?.interactive?.stateDir ?? ".harness/paseo");
  const stateFile = path.join(stateDir, "lead-session.json");
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(stateFile, "utf8")); }
  catch (error) {
    throw new Error(`AEH could not resolve the current managed lead agent: neither an explicit agentId nor PASEO_AGENT_ID is available, and ${stateFile} could not be read as durable lead state. Start a fresh managed lead with aeh start or pass agentId explicitly for diagnostics. (${error instanceof Error ? error.message : String(error)})`);
  }

  const state = object(value);
  const agentId = safeOptionalString(state.agentId);
  const projectRoot = safeOptionalString(state.projectRoot);
  const projectName = safeOptionalString(state.projectName);
  const aehVersion = safeOptionalString(state.aehVersion);
  const version = typeof state.version === "number" ? state.version : undefined;
  const bootstrapVersion = typeof state.bootstrapVersion === "number" ? state.bootstrapVersion : undefined;
  const mismatches: string[] = [];
  if (version !== 2) mismatches.push(`state version ${String(version ?? "missing")} != 2`);
  if (bootstrapVersion !== PASEO_BOOTSTRAP_VERSION) mismatches.push(`bootstrap ${String(bootstrapVersion ?? "missing")} != ${PASEO_BOOTSTRAP_VERSION}`);
  if (aehVersion !== VERSION) mismatches.push(`AEH ${aehVersion ?? "missing"} != ${VERSION}`);
  if (!projectRoot || path.resolve(projectRoot) !== absoluteRoot) mismatches.push("project root does not match AEH_CONTROL_ROOT");
  if (projectName !== config.project.name) mismatches.push(`project ${projectName ?? "missing"} != ${config.project.name}`);
  if (!agentId) mismatches.push("agentId is missing");
  if (mismatches.length) throw new Error(`AEH refused incompatible durable lead state at ${stateFile}: ${mismatches.join("; ")}. Start a fresh managed lead with aeh start or pass agentId explicitly for diagnostics.`);
  return { agentId: agentId!, source: "lead-state" };
}

/** Never-throwing durable-lead probe for fail-closed-but-never-throw paths. */
export async function tryResolveDurableLeadIdentity(root: string): Promise<DurableLeadIdentity | undefined> {
  try { return await resolveDurableLeadIdentity(root); }
  catch { return undefined; }
}

/**
 * Decide the operation-lead binding for an operation start (pure,
 * deterministic, unit-testable without filesystem or daemon access).
 *
 * - VERIFIED: the starter identity IS the durable managed lead. Bind it with
 *   its original source so legitimate managed starts keep byte-identical
 *   operation.lead records.
 * - DURABLE: the starter is absent or does not match the durable lead. Bind
 *   the durable lead instead (fail closed to durable authority); the starter
 *   remains only a completion-notification target registered separately.
 * - UNBOUND: no durable lead exists to confer authority. Bind nothing; the
 *   caller records the reason and S6 fails closed with
 *   ACCEPTANCE_LEAD_REQUIRED when a lead is truly required.
 */
export function resolveStartLeadBinding(
  candidate: StartLeadCandidate | undefined,
  durable: DurableLeadIdentity | undefined
): StartLeadBindingResolution {
  if (candidate && durable && candidate.agentId === durable.agentId) {
    return { status: "VERIFIED", agentId: candidate.agentId, source: candidate.source };
  }
  if (durable) {
    return { status: "DURABLE", agentId: durable.agentId, source: "lead-state" };
  }
  if (candidate) {
    return { status: "UNBOUND", reason: `starter identity '${candidate.agentId}' (source '${candidate.source}') is not backed by a resolvable durable managed lead; leaving the operation lead unbound` };
  }
  return { status: "UNBOUND", reason: "no starter identity and no resolvable durable managed lead; leaving the operation lead unbound" };
}

/**
 * S6 defense in depth (MECHANISM: DETERMINISTIC): the bound operation lead
 * must BE the durable managed lead for the control root before any semantic
 * acceptance turn is dispatched. Fail-closed with an ACCEPTANCE_LEAD_* code
 * instead of prompting a non-lead session.
 *
 * Note on generations: operation.lead.generation counts bindings of one
 * operation while lead-session.json generation counts lead sessions for the
 * root; they are independent counters, so equality is verified on agentId
 * (plus durable compatibility, which the resolution itself enforces).
 * Within-operation staleness is still enforced separately by the caller.
 */
export async function assertDurableLeadBinding(
  controlRoot: string,
  binding: { agentId?: unknown } | undefined
): Promise<DurableLeadIdentity> {
  const agentId = typeof binding?.agentId === "string" && binding.agentId.trim() ? binding.agentId : undefined;
  const durable = await tryResolveDurableLeadIdentity(controlRoot);
  if (!durable) {
    throw new Error(`ACCEPTANCE_LEAD_UNVERIFIED: bound operation lead '${agentId ?? "<missing>"}' cannot be verified because no compatible durable managed-lead session exists for this control root; refusing to solicit semantic acceptance from an unverified session.`);
  }
  if (agentId !== durable.agentId) {
    throw new Error(`ACCEPTANCE_LEAD_MISMATCH: bound operation lead '${agentId ?? "<missing>"}' is not the durable managed lead '${durable.agentId}' for this control root; refusing to solicit semantic acceptance from a non-lead session.`);
  }
  return durable;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
