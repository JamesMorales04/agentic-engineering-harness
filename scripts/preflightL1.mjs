#!/usr/bin/env node
/**
 * AEH L1 preflight gate (stabilization campaign, RED-state reporter).
 *
 * Mechanism classification: DETERMINISTIC. Every check below is a pure,
 * reproducible comparison of shipped configuration against deterministic
 * validation logic: JSONC parsing, source-text inspection, filesystem
 * existence probes, set-membership comparisons, loaded JSON Schema OBJECT
 * GRAPHS (dist/ imported as DATA, never token-scanned), and bounded
 * behavioral probes (calling built verify functions with crafted inputs and
 * asserting on the returned blockers). No network access, no model calls, no
 * randomness, no wall-clock dependence. Identical inputs (source tree + dist
 * snapshot) always produce identical reports.
 *
 * Established-pattern note: this is a `.mjs` gate following the
 * `scripts/architecture.mjs` / `scripts/publicApiContract.mjs` convention
 * (JSON report to stdout, drain-safe exit code). Unlike those gates it DOES
 * import the built `dist/` graph as DATA for the two behavior-bearing
 * checks: `dist/releases/<id>/agents/outputContracts.js` (provider-facing
 * JSON Schemas via outputJsonSchema, plus zod-gate liveness via
 * validateAgentOutput) and `dist/releases/<id>/validation/laneEvidence.js`
 * (verifyProviderLaneEvidenceV1 behavioral command-binding probe). The
 * release is resolved through `dist/current` relative to the INSPECTED root,
 * so auditing another checkout uses that checkout's snapshot — but only after
 * the snapshot's build-identity.json binds to the inspected source tree
 * (packageVersion + git HEAD; STALE_DIST refuses another tree's snapshot).
 * No `tsx` and no TypeScript source-text scanning is used for E/F behavior:
 * source text cannot prove a parameter is consumed. When `dist/` is
 * unavailable or stale the gate fails E closed AND fails F closed (the
 * structural text shape is advisory evidence only and never passes),
 * both explicitly marked in evidence. See `notes` in the emitted report for
 * every encoding decision/limit.
 *
 * Usage: `node scripts/preflightL1.mjs [root]` (root defaults to cwd).
 * Stdout is ALWAYS a single machine-readable JSON document:
 *   { version, tool, ruleset, root, node, checks:[{id,status,evidence}],
 *     notes:[...], summary:{total,passed,failed} }
 * `status` is PASS|FAIL per check. Exit code is 0 iff every check PASSES,
 * 1 when any check FAILs, 2 on load errors (assigned via `process.exitCode`,
 * never `process.exit`, so piped stdout is never truncated).
 *
 * The core check functions are exported pure functions so
 * `tests/preflightL1.test.ts` can evaluate crafted compliant/violating
 * fixtures without touching the filesystem. Dist-backed orchestration
 * (loadDistForRoot, probeWireLiveness, probeLaneCommandBindingBehavioral,
 * evaluateAll, loadRealTreeInputs, runPreflight) is async; the per-check
 * assertions themselves are pure and synchronous except the behavioral lane
 * probe, which takes an injectable verify function so tests can prove
 * consumption without a build.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RULESET = "aeh-preflight-l1-v1";
export const REPORT_VERSION = 1;

// ---------------------------------------------------------------------------
// Small deterministic parsing helpers (no dependencies).
// ---------------------------------------------------------------------------

/** Strip // and block comments exactly like src/agents/jsonc.ts (string-aware). */
export function stripJsoncComments(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      out.push(ch);
      i += 1;
      while (i < text.length) {
        const current = text[i];
        out.push(current);
        i += 1;
        if (current === "\\" && i < text.length) {
          out.push(text[i]);
          i += 1;
          continue;
        }
        if (current === '"') break;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("").replace(/,(\s*[}\]])/g, "$1");
}

export function parseJsonc(text) {
  return JSON.parse(stripJsoncComments(text));
}

/**
 * Brace-match `{...}` starting at openIndex (string/comment aware).
 * Returns the full `{...}` block or null. Template-literal bodies are
 * skipped wholesale; sources parsed here avoid unbalanced braces in them.
 */
export function matchBrace(text, openIndex) {
  if (text[openIndex] !== "{") return null;
  let depth = 0;
  let i = openIndex;
  let inStr = null;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
    i += 1;
  }
  return null;
}

/** Split the inner text of an array/object literal into top-level `{...}` blocks. */
export function splitTopLevelObjects(inner) {
  const blocks = [];
  let i = 0;
  while (i < inner.length) {
    const open = inner.indexOf("{", i);
    if (open === -1) break;
    const block = matchBrace(inner, open);
    if (!block) break;
    blocks.push(block);
    i = open + block.length;
  }
  return blocks;
}

function quotedList(text) {
  return [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Source parsers (deterministic; fail-closed with parse notes, no shims).
// ---------------------------------------------------------------------------

/**
 * Parse role profiles from src/participants/roles.ts.
 * Returns { roles: Record<role, profile>, parseNotes: [] }.
 * Alias consts (`coordinationTools`, …) are resolved from their
 * declarations; anything unresolvable is a parse note (fail-closed
 * downstream), never a silent default.
 */
export function parseRolesProfiles(source) {
  const parseNotes = [];
  const aliases = {};
  for (const m of source.matchAll(/const\s+(\w+)\s*=\s*\[([^\]]*)\]\s*as const/g)) {
    aliases[m[1]] = quotedList(m[2]);
  }
  const anchor = source.indexOf("DEFAULT_ROLE_PROFILES_V1");
  if (anchor === -1) {
    parseNotes.push("roles.ts: DEFAULT_ROLE_PROFILES_V1 declaration not found.");
    return { roles: {}, parseNotes };
  }
  const arrOpen = source.indexOf("[", anchor);
  if (arrOpen === -1) {
    parseNotes.push("roles.ts: DEFAULT_ROLE_PROFILES_V1 array literal not found.");
    return { roles: {}, parseNotes };
  }
  // Bracket-match the array (string/comment aware).
  let depth = 0;
  let arrEnd = -1;
  let inStr = null;
  for (let i = arrOpen; i < source.length; i += 1) {
    const ch = source[i];
    if (inStr) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "[") depth += 1;
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        arrEnd = i;
        break;
      }
    }
  }
  if (arrEnd === -1) {
    parseNotes.push("roles.ts: DEFAULT_ROLE_PROFILES_V1 array is unbalanced.");
    return { roles: {}, parseNotes };
  }
  const roles = {};
  for (const block of splitTopLevelObjects(source.slice(arrOpen + 1, arrEnd))) {
    const roleMatch = block.match(/role:\s*"([^"]+)"/);
    if (!roleMatch) {
      parseNotes.push("roles.ts: profile block without a role field.");
      continue;
    }
    const role = roleMatch[1];
    const authMatch = block.match(/authority:\s*\{([^}]*)\}/);
    const bool = (key) => {
      const m = authMatch ? authMatch[1].match(new RegExp(`${key}:\\s*(true|false)`)) : null;
      return m ? m[1] === "true" : undefined;
    };
    const toolOpen = block.indexOf("toolPack:");
    let toolPack = { required: [], optional: [], forbidden: [], unresolved: [] };
    if (toolOpen !== -1) {
      const brace = block.indexOf("{", toolOpen);
      const toolBlock = brace !== -1 ? matchBrace(block, brace) : null;
      if (!toolBlock) {
        parseNotes.push(`roles.ts: role '${role}' has an unparsable toolPack block.`);
      } else {
        for (const key of ["required", "optional", "forbidden"]) {
          const m = toolBlock.match(new RegExp(`${key}:\\s*(\\[[^\\]]*\\]|[A-Za-z_$][\\w$]*)`));
          if (!m) {
            parseNotes.push(`roles.ts: role '${role}' toolPack.${key} not found.`);
            toolPack.unresolved.push(key);
            continue;
          }
          if (m[1].startsWith("[")) toolPack[key] = quotedList(m[1]);
          else if (aliases[m[1]]) toolPack[key] = [...aliases[m[1]]];
          else {
            parseNotes.push(`roles.ts: role '${role}' toolPack.${key} references unknown alias '${m[1]}'.`);
            toolPack.unresolved.push(key);
          }
        }
      }
    } else {
      parseNotes.push(`roles.ts: role '${role}' has no toolPack block.`);
      toolPack.unresolved.push("required", "optional", "forbidden");
    }
    const maxMatch = block.match(/maxCapabilities:\s*\[([^\]]*)\]/);
    const specMatch = block.match(/specializations:\s*\[([^\]]*)\]/);
    const delMatch = block.match(/delegation:\s*\{[^}]*allowed:\s*(true|false)/);
    roles[role] = {
      role,
      authority: { canRead: bool("canRead"), canWrite: bool("canWrite"), canExecute: bool("canExecute") },
      toolPack,
      maxCapabilities: maxMatch ? quotedList(maxMatch[1]) : [],
      specializations: specMatch ? quotedList(specMatch[1]) : [],
      delegationAllowed: delMatch ? delMatch[1] === "true" : undefined,
    };
  }
  return { roles, parseNotes };
}

/**
 * Parse the canonical skill seed from src/participants/skills.ts.
 * Returns { seed: Record<id, {id, roles: string[]|null}>, parseNotes }.
 * `roles: null` means unrestricted (cross-cutting/technology without a
 * roles field). Competency `{id,…}` objects never match the
 * `{ version: 1, id: … proceduralSteps:` shape and are ignored by design.
 */
export function parseSkillSeed(source) {
  const parseNotes = [];
  const seed = {};
  for (const m of source.matchAll(/roleSkill\(\s*"([^"]+)"\s*,\s*"[^"]*"\s*,\s*"([^"]+)"/g)) {
    seed[m[1]] = { id: m[1], roles: [m[2]] };
  }
  const seedBlock = source.match(/CROSS_CUTTING_SKILL_SEEDS[\s\S]*?=\s*\[([\s\S]*?)\];/);
  if (seedBlock) {
    for (const m of seedBlock[1].matchAll(/\[\s*"([^"]+)"\s*,/g)) {
      seed[m[1]] = { id: m[1], roles: null };
    }
  } else {
    parseNotes.push("skills.ts: CROSS_CUTTING_SKILL_SEEDS block not found.");
  }
  for (const m of source.matchAll(/\{\s*version:\s*1,\s*id:\s*"([^"]+)"([\s\S]{0,2000}?)proceduralSteps:/g)) {
    const head = m[2];
    const kind = head.match(/kind:\s*"([^"]+)"/);
    if (!kind) continue;
    const rolesMatch = head.match(/roles:\s*\[([^\]]*)\]/);
    seed[m[1]] = { id: m[1], roles: rolesMatch ? quotedList(rolesMatch[1]) : null };
  }
  if (Object.keys(seed).length === 0) parseNotes.push("skills.ts: no skill definitions parsed.");
  return { seed, parseNotes };
}

/** Extract `validationCapabilityValues` from capabilityCatalog.ts. */
export function parseCatalogValues(source) {
  const m = source.match(/validationCapabilityValues\s*=\s*\[([\s\S]*?)\]\s*as const/);
  return m ? quotedList(m[1]) : [];
}

/**
 * Extract adapter coverage from validators/registry.ts:
 * keys of the `capabilityAdapter` mapping plus `return "…"` literals of
 * `capabilityForAdapter`. Union = capabilities with ≥1 adapter.
 */
export function parseRegistryCoverage(source) {
  const covered = new Set();
  const mapMatch = source.match(/const mapping:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\};/);
  if (mapMatch) {
    for (const m of mapMatch[1].matchAll(/"([^"]+)"\s*:/g)) covered.add(m[1]);
  }
  const fnAnchor = source.indexOf("function capabilityForAdapter");
  if (fnAnchor !== -1) {
    const brace = source.indexOf("{", fnAnchor);
    const body = brace !== -1 ? matchBrace(source, brace) : null;
    if (body) {
      for (const m of body.matchAll(/return\s+"([^"]+)"/g)) covered.add(m[1]);
    }
  }
  return [...covered].sort();
}

// ---------------------------------------------------------------------------
// Pure checks. Each returns { id, status: "PASS"|"FAIL", evidence }.
// ---------------------------------------------------------------------------

function mkCheck(id, violations, evidence) {
  return { id, status: violations ? "FAIL" : "PASS", evidence };
}

const GRANTED = new Set(["allow", "ask"]);

/** Roles that are CanonicalAgentRoles but intentionally not WorkGraph participants. */
export const NONPARTICIPANT_ROLES = ["Semantic Assessor"];

function isNonparticipantRole(role) {
  return NONPARTICIPANT_ROLES.includes(role);
}

/**
 * L1-A1-PERMISSION-CEILING — preset permission grants must fit the role
 * ceiling (authority + delegation + toolPack + maxCapabilities). Mapping:
 * read→authority.canRead, write→authority.canWrite,
 * gitWrite→authority.canWrite, delegate→delegation.allowed,
 * shell→authority.canExecute AND `command-execute` ∈ toolPack.required∪optional,
 * review→`review` ∈ maxCapabilities (roles.ts maxCapabilities, compiled via
 * src/participants/skillCompiler.ts:30-32 roleCapabilities),
 * validate→`validate` ∈ maxCapabilities (same source).
 * network has no role-ceiling source in roles.ts and is intentionally
 * unchecked (validateExecutionCapabilities in permissions.ts:23-67 likewise
 * gates only a subset); documented as omitted in `notes`.
 * A grant is `allow`|`ask`; `deny`|absent is no grant. Unknown participant
 * roles and unresolvable toolPacks fail closed. Nonparticipant roles
 * (e.g. Semantic Assessor) are skipped here and covered by L1-A3 instead.
 */
export function checkPermissionCeiling(agents, roles) {
  const violations = [];
  for (const [name, agent] of Object.entries(agents)) {
    if (isNonparticipantRole(agent.role)) continue;
    const profile = roles[agent.role];
    if (!profile) {
      violations.push({ agent: name, role: agent.role, reason: "unknown role: no canonical profile" });
      continue;
    }
    const perms = agent.permissions ?? {};
    const grant = (key) => GRANTED.has(perms[key]);
    if (grant("read") && profile.authority.canRead !== true) {
      violations.push({ agent: name, role: agent.role, permission: "read", granted: perms.read, reason: "role authority.canRead is not true" });
    }
    if (grant("write") && profile.authority.canWrite !== true) {
      violations.push({ agent: name, role: agent.role, permission: "write", granted: perms.write, reason: "role authority.canWrite is not true" });
    }
    if (grant("gitWrite") && profile.authority.canWrite !== true) {
      violations.push({ agent: name, role: agent.role, permission: "gitWrite", granted: perms.gitWrite, reason: "git writes require role authority.canWrite" });
    }
    if (grant("delegate") && profile.delegationAllowed !== true) {
      violations.push({ agent: name, role: agent.role, permission: "delegate", granted: perms.delegate, reason: "role delegation.allowed is not true" });
    }
    if (grant("shell")) {
      const tools = [...(profile.toolPack.required ?? []), ...(profile.toolPack.optional ?? [])];
      if (profile.authority.canExecute !== true) {
        violations.push({ agent: name, role: agent.role, permission: "shell", granted: perms.shell, reason: "role authority.canExecute is not true" });
      } else if (!tools.includes("command-execute")) {
        violations.push({
          agent: name,
          role: agent.role,
          permission: "shell",
          granted: perms.shell,
          reason: `role toolPack (required∪optional) lacks command-execute: [${tools.join(", ")}]`,
        });
      }
    }
    if ((profile.toolPack.unresolved ?? []).length && (grant("shell"))) {
      violations.push({ agent: name, role: agent.role, permission: "shell", granted: perms.shell, reason: `role toolPack unresolvable: [${profile.toolPack.unresolved.join(", ")}]` });
    }
    if (grant("review") && !(profile.maxCapabilities ?? []).includes("review")) {
      violations.push({
        agent: name,
        role: agent.role,
        permission: "review",
        granted: perms.review,
        reason: `role maxCapabilities lacks review: [${(profile.maxCapabilities ?? []).join(", ")}]`,
      });
    }
    if (grant("validate") && !(profile.maxCapabilities ?? []).includes("validate")) {
      violations.push({
        agent: name,
        role: agent.role,
        permission: "validate",
        granted: perms.validate,
        reason: `role maxCapabilities lacks validate: [${(profile.maxCapabilities ?? []).join(", ")}]`,
      });
    }
  }
  return mkCheck("L1-A1-PERMISSION-CEILING", violations.length > 0, { violations });
}

/**
 * Resolve the runtime definition governing an agent: the resolved
 * `agent.runtime` (name) wins, else `execution.runtime`, else the model-alias
 * target in `models` (execution.model "@alias" → models[alias].runtime),
 * mirroring resolveAgentTopology (config.ts:162-163) and
 * executionSelectionForAgent (routing.ts:8).
 */
function runtimeForAgent(agent, runtimes, models) {
  const table = runtimes ?? {};
  const name =
    (typeof agent.runtime === "object" && typeof agent.runtime?.name === "string" ? agent.runtime.name : null) ??
    (typeof agent.execution?.runtime === "string" ? agent.execution.runtime : null) ??
    (typeof agent.execution?.model === "string" && agent.execution.model.startsWith("@")
      ? (models ?? {})[agent.execution.model.slice(1)]?.runtime ?? null
      : null);
  return name ? table[name] : undefined;
}

/**
 * L1-A3-NONPARTICIPANT — dedicated deterministic check for intentional
 * nonparticipants (CanonicalAgentRole without a RoleProfileV1, e.g. Semantic
 * Assessor per src/participants/types.ts canonicalAgentRoleValues vs
 * canonicalRoleValues). Enforces the permissions.ts:55-61 preset-decidable
 * constraints: all of read/write/shell/network/delegate/review/validate/
 * gitWrite explicitly `deny`, plus no skills, no MCPs, no top-level runtime
 * arguments, no execution runtime arguments, no runtime defaultArgs, and no
 * native-agent selection at either level. execution.nativeAgent IS statically
 * checkable: it is a configured string (src/agents/config.ts:17
 * executionSchema) compiled into selection.nativeAgent
 * (src/agents/routing.ts:8 executionSelectionForAgent), exactly like
 * execution.args merging into selection.args there — and runtime.defaultArgs
 * likewise merges (`args: [...(runtime.defaultArgs ?? []),
 * ...(agent.execution.args ?? [])]`, routing.ts:8), so a nonparticipant whose
 * runtime declares defaultArgs receives arguments even with empty
 * agent.args/execution.args. The old gate checked only
 * `agent.args ?? agent.execution?.args`, which let an empty top-level
 * `args: []` mask a nonempty `execution.args` (`[]` is not nullish, so `??`
 * keeps it); all three levels are now checked independently and either
 * nonempty is a violation. `runtimes` maps runtime name → definition
 * (with optional defaultArgs); `models` maps model alias → definition (with
 * runtime) for "@alias" execution.model resolution. Both default to {}.
 */
export function checkNonparticipantConstraints(agents, runtimes, models) {
  const violations = [];
  const denied = ["read", "write", "shell", "network", "delegate", "review", "validate", "gitWrite"];
  for (const [name, agent] of Object.entries(agents)) {
    if (!isNonparticipantRole(agent.role)) continue;
    const perms = agent.permissions ?? {};
    const opened = denied.filter((key) => perms[key] !== "deny");
    if (opened.length) {
      violations.push({
        agent: name,
        role: agent.role,
        reason: `nonparticipant must explicitly deny ${opened.join(", ")} (permissions.ts:55-58)`,
        opened,
      });
    }
    const skills = agent.skills ?? [];
    if (skills.length) {
      violations.push({ agent: name, role: agent.role, reason: "nonparticipant must declare no skills (permissions.ts:61)", skills });
    }
    const mcps = agent.mcps ?? [];
    if (mcps.length) {
      violations.push({ agent: name, role: agent.role, reason: "nonparticipant must declare no MCP servers (permissions.ts:61)", mcps });
    }
    const topArgs = Array.isArray(agent.args) ? agent.args : [];
    if (topArgs.length) {
      violations.push({ agent: name, role: agent.role, reason: "nonparticipant must declare no top-level runtime arguments (permissions.ts:61)", args: topArgs });
    }
    const execArgs = Array.isArray(agent.execution?.args) ? agent.execution.args : [];
    if (execArgs.length) {
      violations.push({
        agent: name,
        role: agent.role,
        reason: "nonparticipant must declare no execution runtime arguments (permissions.ts:61; execution.args merges into selection.args per routing.ts:8)",
        args: execArgs,
      });
    }
    const runtime = runtimeForAgent(agent, runtimes, models);
    const defaultArgs = Array.isArray(runtime?.defaultArgs) ? runtime.defaultArgs : [];
    if (defaultArgs.length) {
      violations.push({
        agent: name,
        role: agent.role,
        reason: "nonparticipant runtime must declare no defaultArgs (routing.ts:8 merges runtime.defaultArgs into selection.args, so the agent receives arguments even with empty agent.args/execution.args)",
        runtime: runtime?.name,
        args: defaultArgs,
      });
    }
    const nativeTop = typeof agent.nativeAgent === "string" ? agent.nativeAgent.trim() : agent.nativeAgent;
    if (nativeTop) {
      violations.push({ agent: name, role: agent.role, reason: "nonparticipant must not select a top-level native agent (permissions.ts:61)", nativeAgent: agent.nativeAgent });
    }
    const nativeExec = typeof agent.execution?.nativeAgent === "string" ? agent.execution.nativeAgent.trim() : agent.execution?.nativeAgent;
    if (nativeExec) {
      violations.push({
        agent: name,
        role: agent.role,
        reason: "nonparticipant must not select an execution native agent (permissions.ts:61; statically configured as execution.nativeAgent per config.ts:17, compiled into selection.nativeAgent per routing.ts:8)",
        nativeAgent: agent.execution.nativeAgent,
      });
    }
  }
  return mkCheck("L1-A3-NONPARTICIPANT", violations.length > 0, { violations });
}

/**
 * L1-A2-SKILL-ROLE-FIT — every preset skill must exist in the canonical
 * seed and, when the seed restricts it to roles, must include the agent's
 * role (mirrors src/participants/skillCompiler.ts role/required-tool
 * rejection). Mirrors the runtime compiler's registry split
 * (src/agents/compiler.ts:74-78 validateReferences): the canonical seed is
 * the registry of record for seed skill ids, while filesystem SKILL.md under
 * the configured roots covers non-seed OpenCode skills — a non-seed skill
 * that resolves on the filesystem is accepted here (its existence is L1-C2's
 * verdict), and only a skill in NEITHER registry fails closed. When no
 * filesystem probe is provided (pure evaluation), non-seed skills fail
 * closed as unknown. "*" always passes (compiler skips it).
 */
export function checkSkillRoleFit(agents, seed, skillRoots, fileExists) {
  const roots = skillRoots && skillRoots.length ? skillRoots : [".harness/skills"];
  const resolvesOnFilesystem = (skill) => {
    if (typeof fileExists !== "function") return false;
    return roots.some((root) => fileExists(`${root}/${skill}/SKILL.md`));
  };
  const violations = [];
  for (const [name, agent] of Object.entries(agents)) {
    for (const skill of agent.skills ?? []) {
      if (skill === "*") continue;
      const def = seed[skill];
      if (!def) {
        if (resolvesOnFilesystem(skill)) continue;
        violations.push({
          agent: name,
          role: agent.role,
          skill,
          reason: "unknown skill id: absent from canonical seed and unresolvable as <skillRoot>/<id>/SKILL.md",
        });
      } else if (def.roles && !def.roles.includes(agent.role)) {
        violations.push({ agent: name, role: agent.role, skill, reason: `seed restricts skill to roles [${def.roles.join(", ")}]` });
      }
    }
  }
  return mkCheck("L1-A2-SKILL-ROLE-FIT", violations.length > 0, { violations });
}

/**
 * L1-B-SPECIALIZATION-CLOSED — preset agent specializations and routing
 * selector specializations must be subsets of the role profile's
 * `specializations` (unknown specializations fail closed; the shipped
 * compiler validates role only — src/agents/compiler.ts:63-67).
 * Nonparticipant roles (e.g. Semantic Assessor) carry no profile by design
 * and are skipped here; they are covered by L1-A3 instead.
 */
export function checkSpecializationsClosed(agents, routing, roles) {
  const violations = [];
  for (const [name, agent] of Object.entries(agents)) {
    if (isNonparticipantRole(agent.role)) continue;
    const profile = roles[agent.role];
    if (!profile) {
      violations.push({ scope: "agent", agent: name, role: agent.role, reason: "unknown role: no canonical profile" });
      continue;
    }
    for (const spec of agent.specializations ?? []) {
      if (!profile.specializations.includes(spec)) {
        violations.push({ scope: "agent", agent: name, role: agent.role, specialization: spec, reason: `not in role specializations [${profile.specializations.join(", ")}]` });
      }
    }
  }
  for (const rule of routing ?? []) {
    for (const selector of [rule.select, ...(rule.review ?? [])].filter(Boolean)) {
      if (isNonparticipantRole(selector.role)) continue;
      const profile = roles[selector.role];
      if (!profile) {
        violations.push({ scope: "routing", rule: rule.id, role: selector.role, reason: "unknown role: no canonical profile" });
        continue;
      }
      for (const spec of selector.specializations ?? []) {
        if (!profile.specializations.includes(spec)) {
          violations.push({ scope: "routing", rule: rule.id, role: selector.role, specialization: spec, reason: `not in role specializations [${profile.specializations.join(", ")}]` });
        }
      }
    }
  }
  return mkCheck("L1-B-SPECIALIZATION-CLOSED", violations.length > 0, { violations });
}

/**
 * L1-C1-SKILLROOT-EXISTS — the configured skillRoot topology must be
 * materialized somewhere (absent `skillRoots` defaults to
 * [".harness/skills"], mirroring resolveAgentTopology). Aligned with the
 * runtime compiler (src/agents/compiler.ts:80-82 validateReferences): the
 * compiler probes `<root>/<skill>/SKILL.md` under EACH root and only fails
 * when NO root resolves — a single missing root dir is tolerated, never a
 * hard error. C1 therefore fails closed only when EVERY configured root is
 * missing (nowhere to resolve from); per-skill resolution is L1-C2. The
 * previous "any missing root fails" shape false-REDed consumer topologies
 * whose unioned skillRoots (preset roots plus consumer materialization)
 * legitimately leave some roots unmaterialized.
 */
export function checkSkillRootsExist(skillRoots, dirExists) {
  const roots = skillRoots && skillRoots.length ? skillRoots : [".harness/skills"];
  const missing = roots.filter((root) => !dirExists(root));
  const failed = missing.length >= roots.length;
  return mkCheck("L1-C1-SKILLROOT-EXISTS", failed, { skillRoots: roots, missing });
}

/**
 * L1-C2-SKILL-REF-RESOLVES — every preset skill (except "*") must resolve
 * to `<skillRoot>/<id>/SKILL.md` under at least one configured root,
 * EXCEPT canonical seed skills: the runtime compiler
 * (src/agents/compiler.ts:68-78) skips filesystem lookup for seed ids (the
 * seed is the registry of record; only the role ceiling applies). A seed
 * skill without materialized files must therefore PASS here (its validity
 * is L1-A2's verdict); anything in neither registry still fails.
 */
export function checkSkillRefsResolve(agents, skillRoots, fileExists, seed) {
  const roots = skillRoots && skillRoots.length ? skillRoots : [".harness/skills"];
  const violations = [];
  for (const [name, agent] of Object.entries(agents)) {
    for (const skill of agent.skills ?? []) {
      if (skill === "*") continue;
      if (seed && Object.prototype.hasOwnProperty.call(seed, skill)) continue;
      const tried = roots.map((root) => `${root}/${skill}/SKILL.md`);
      if (!tried.some((rel) => fileExists(rel))) {
        violations.push({ agent: name, role: agent.role, skill, tried });
      }
    }
  }
  return mkCheck("L1-C2-SKILL-REF-RESOLVES", violations.length > 0, { violations });
}

/**
 * L1-D1-MCP-FAIL-CLOSED — the runtime projection must NOT grant tool
 * access for selection.mcps entries absent from project config. FAILs iff
 * the fail-open shape is present in src/agents/permissions.ts: an
 * `if (!configured[name])` branch that assigns `tools[…] = true`.
 */
export function checkMcpFailClosed(permissionsSource) {
  const hasUnconfiguredLoop = /for\s*\(\s*const\s+name\s+of\s+selection\.mcps\s*\)/.test(permissionsSource);
  const hasAbsentBranch = /if\s*\(\s*!configured\[name\]\s*\)/.test(permissionsSource);
  const hasTrueGrant = /tools\[\s*`?\$\{name\}[^\]]*\]\s*=\s*true/.test(permissionsSource);
  const failOpen = hasUnconfiguredLoop && hasAbsentBranch && hasTrueGrant;
  return mkCheck("L1-D1-MCP-FAIL-CLOSED", failOpen, {
    failOpen,
    detail: failOpen
      ? "selection.mcps entries absent from config are granted tools[name_*]=true instead of denied/ignored"
      : "no unconfigured-selection grant detected",
    markers: { hasUnconfiguredLoop, hasAbsentBranch, hasTrueGrant },
    ref: "src/agents/permissions.ts:124-126",
  });
}

/**
 * L1-D2-MCP-REF-CONFIGURED — every preset `mcps` entry must resolve to a
 * configured, enabled project MCP server (mirrors the `enabled !== false`
 * selection rule in buildOpenCodeRuntimeConfig).
 */
export function checkMcpRefsConfigured(agents, configured) {
  const violations = [];
  for (const [name, agent] of Object.entries(agents)) {
    for (const mcp of agent.mcps ?? []) {
      if (!configured[mcp]) {
        violations.push({ agent: name, mcp, reason: "absent from project mcp.servers" });
      } else if (configured[mcp].enabled === false) {
        violations.push({ agent: name, mcp, reason: "project mcp.servers entry is disabled (enabled: false)" });
      }
    }
  }
  return mkCheck("L1-D2-MCP-REF-CONFIGURED", violations.length > 0, { violations });
}

// ---------------------------------------------------------------------------
// L1-E object-graph wire parity (DATA-DRIVEN; no text scanning).
//
// The gate loads the provider-facing JSON Schemas as DATA (plain objects
// returned by outputJsonSchema from the dist/ snapshot) and asserts, per
// gate, that the EXACT property path in the EXACT branch object carries the
// EXACT typed constraint. A constraint counts only when path+type+cardinality
// coincide: `{ minItems: 1 }` without `type: "array"` FAILs, `{ minLength: 1 }`
// without `type: "string"` FAILs, and a constraint on an unrelated path or in
// an unrelated disjunction branch FAILs. There is no token search and no
// co-occurrence counting anywhere in this section.
//
// Known evidence array paths for the explorer gate (mirrors the zod
// superRefine disjunction in outputContracts.ts:98-113).
// ---------------------------------------------------------------------------

export const EXPLORER_KNOWN_EVIDENCE_ARRAYS = [
  "relevantFiles",
  "findings",
  "moduleBoundaries",
  "tests",
  "dependencies",
  "risks",
  "openQuestions",
];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** properties object carries field with type "array" and integer minItems >= 1. */
function arrayNonemptyAt(properties, field) {
  const node = isObject(properties) ? properties[field] : undefined;
  return (
    isObject(node) &&
    node.type === "array" &&
    Number.isInteger(node.minItems) &&
    node.minItems >= 1
  );
}

/** properties object carries field with type "array" and maxItems === 0 (empty enforcement). */
function arrayEmptyAt(properties, field) {
  const node = isObject(properties) ? properties[field] : undefined;
  return isObject(node) && node.type === "array" && node.maxItems === 0;
}

/** properties object carries field with type "string" and integer minLength >= 1. */
function stringNonemptyAt(properties, field) {
  const node = isObject(properties) ? properties[field] : undefined;
  return (
    isObject(node) &&
    node.type === "string" &&
    Number.isInteger(node.minLength) &&
    node.minLength >= 1
  );
}

/** Schema node constrains the value to a literal (const or enum-membership). */
function constrainsLiteral(node, literal) {
  if (!isObject(node)) return false;
  if (node.const === literal) return true;
  return Array.isArray(node.enum) && node.enum.includes(literal);
}

function disjunctionBranches(schema) {
  const out = [];
  if (isObject(schema)) {
    for (const key of ["anyOf", "oneOf"]) {
      if (Array.isArray(schema[key])) out.push(...schema[key]);
    }
  }
  return out;
}

/** True iff the schema object lists field in its `required` array. */
function schemaRequires(schema, field) {
  return isObject(schema) && Array.isArray(schema.required) && schema.required.includes(field);
}

/**
 * True iff a disjunction branch constrains nothing a violating payload could
 * not satisfy: a non-object, an empty object, or an object with no
 * properties/allOf/anyOf/oneOf/if constraint. Such a branch is an escape
 * hatch — payloads take it with the constrained properties omitted — so any
 * gate pairing a qualifying branch with one of these must FAIL.
 */
function isVacuousBranch(branch) {
  if (!isObject(branch)) return true;
  if (Object.keys(branch).length === 0) return true;
  if (
    !isObject(branch.properties) &&
    !Array.isArray(branch.allOf) &&
    !Array.isArray(branch.anyOf) &&
    !Array.isArray(branch.oneOf) &&
    !isObject(branch.if)
  ) {
    return true;
  }
  if (
    isObject(branch.properties) &&
    Object.keys(branch.properties).length === 0 &&
    !branch.allOf &&
    !branch.anyOf &&
    !branch.oneOf &&
    !branch.if
  ) {
    return true;
  }
  return false;
}

/** Planner zod gate (outputContracts.ts:63-71 PLANNER_EMPTY_RESULT). */
function plannerWireHolds(schema) {
  if (!isObject(schema)) return false;
  // The typed constraint is meaningless when the property can be omitted:
  // a payload without workUnits satisfies the schema while the zod gate
  // rejects []. Both required-membership and the typed cardinality must hold.
  if (!schemaRequires(schema, "workUnits")) return false;
  return arrayNonemptyAt(isObject(schema) ? schema.properties : undefined, "workUnits");
}

/**
 * Explorer zod gate (outputContracts.ts:98-113 EXPLORER_EMPTY_RESULT).
 * Accepts a direct binding (one known evidence array required AND bound to
 * type=array+minItems>=1 at top level — stricter than zod's any-of-seven,
 * documented residual) or a disjunction whose EVERY branch requires and binds
 * at least one known evidence array path to type=array+minItems>=1. A branch
 * that binds nothing (including a vacuous `{}`) is an escape hatch — a
 * payload with every evidence array empty takes it — and fails the whole
 * gate. A top-level constraint without required-membership likewise lets the
 * payload omit the array and fails.
 */
function explorerWireHolds(schema) {
  if (!isObject(schema)) return false;
  const top = schema.properties;
  if (EXPLORER_KNOWN_EVIDENCE_ARRAYS.some((field) => schemaRequires(schema, field) && arrayNonemptyAt(top, field))) return true;
  const branches = disjunctionBranches(schema);
  if (!branches.length) return false;
  if (branches.some((branch) => isVacuousBranch(branch))) return false;
  return branches.every((branch) =>
    EXPLORER_KNOWN_EVIDENCE_ARRAYS.some(
      (field) => schemaRequires(branch, field) && arrayNonemptyAt(isObject(branch) ? branch.properties : undefined, field),
    ),
  );
}

/**
 * True iff an artifacts node requires proposal+tasks AND types both as
 * nonempty strings at the exact paths (required alone allows empty strings;
 * minLength alone allows absence; untyped minLength is not a string
 * constraint — all three fail).
 */
function specArtifactsNodeHolds(node) {
  if (!isObject(node)) return false;
  if (node.type !== "object") return false;
  const required = Array.isArray(node.required) ? node.required : [];
  if (!required.includes("proposal") || !required.includes("tasks")) return false;
  const props = node.properties;
  return stringNonemptyAt(props, "proposal") && stringNonemptyAt(props, "tasks");
}

/**
 * Spec READY gate (outputContracts.ts:146-158 SPEC_MANAGER_INCOMPLETE_RESULT).
 * Every acceptance path additionally requires the schema to list `artifacts`
 * in its top-level `required`: an artifacts node carrying the pair is
 * meaningless when a READY payload may omit the parent `artifacts` object
 * entirely. Accepts: unconditional top-level enforcement (stricter than zod —
 * BLOCKED payloads would also need proposal/tasks at the wire; documented
 * residual), an allOf branch carrying the pair (allOf branches all apply), a
 * READY-tied anyOf/oneOf branch carrying the pair, or an if(status
 * READY)/then(pair) encoding. A bare anyOf branch carrying the pair without a
 * READY tie is a hole (READY payloads may satisfy another branch) and fails.
 */
/**
 * True iff a spec disjunction branch rejects every READY-with-empty-artifacts
 * payload: it either excludes the READY status (const/enum without READY) or
 * carries the proposal+tasks artifacts node. A vacuous `{}` (or any branch
 * constraining neither) admits the violator and is NOT safe.
 */
function specBranchSafe(branch) {
  if (!isObject(branch)) return false;
  const status = isObject(branch) ? branch.properties?.status : undefined;
  if (isObject(status)) {
    if (status.const !== undefined && status.const !== "READY") return true;
    if (Array.isArray(status.enum) && !status.enum.includes("READY")) return true;
  }
  return specArtifactsNodeHolds(isObject(branch) ? branch.properties?.artifacts : undefined);
}

/** True iff the branch ties status to READY and carries the artifacts pair (implies safe). */
function specBranchQualifies(branch) {
  if (!isObject(branch)) return false;
  return (
    constrainsLiteral(isObject(branch) ? branch.properties?.status : undefined, "READY") &&
    specArtifactsNodeHolds(isObject(branch) ? branch.properties?.artifacts : undefined)
  );
}

function specWireHolds(schema) {
  if (!isObject(schema)) return false;
  if (!schemaRequires(schema, "artifacts")) return false;
  if (specArtifactsNodeHolds(schema.properties?.artifacts)) return true;
  if (Array.isArray(schema.allOf) && schema.allOf.some((branch) => specArtifactsNodeHolds(isObject(branch) ? branch.properties?.artifacts : undefined))) {
    return true;
  }
  const branches = disjunctionBranches(schema);
  if (
    branches.length &&
    branches.some(specBranchQualifies) &&
    branches.every(specBranchSafe)
  ) {
    return true;
  }
  if (
    constrainsLiteral(schema.if?.properties?.status, "READY") &&
    specArtifactsNodeHolds(schema.then?.properties?.artifacts)
  ) {
    return true;
  }
  return false;
}

/**
 * True iff a reviewer branch object rejects every FAIL-with-empty-findings
 * payload: it either excludes the FAIL verdict (const/enum without FAIL) or
 * requires findings nonempty. A vacuous `{}` (or any branch constraining
 * neither) admits the violator and is NOT safe.
 */
function reviewerBranchSafe(branch) {
  if (!isObject(branch)) return false;
  const props = branch.properties;
  if (!isObject(props)) return false;
  const verdict = props.verdict;
  if (isObject(verdict)) {
    if (verdict.const !== undefined && verdict.const !== "FAIL") return true;
    if (Array.isArray(verdict.enum) && !verdict.enum.includes("FAIL")) return true;
  }
  return schemaRequires(branch, "findings") && arrayNonemptyAt(props, "findings");
}

/** True iff a branch object binds verdict to FAIL with findings required nonempty (implies safe). */
function reviewerBranchQualifies(branch) {
  if (!isObject(branch)) return false;
  const props = branch.properties;
  if (!isObject(props)) return false;
  return (
    constrainsLiteral(props.verdict, "FAIL") &&
    schemaRequires(branch, "findings") &&
    arrayNonemptyAt(props, "findings")
  );
}

/**
 * Reviewer FAIL gate (outputContracts.ts:208-215 REVIEWER_FAIL_WITHOUT_FINDING).
 * Requires top-level properties.verdict to carry type "string", to be listed
 * in top-level `required` (an omittable verdict lets FAIL payloads drop the
 * field), AND a single branch object binding verdict to FAIL with findings
 * type=array+minItems>=1 in that SAME branch (anyOf/oneOf branch or
 * if(verdict FAIL)/then). Mere co-occurrence of a FAIL literal, a findings
 * minItems and a coupling keyword spread across unrelated branches fails —
 * and a qualifying branch paired with a vacuous `{}` alternative fails: the
 * FAIL-with-empty-findings payload takes the vacuous branch. Every
 * anyOf/oneOf branch must therefore either qualify or independently reject
 * the violator. The critical/high-severity ⇒ not-SAFE gate
 * (outputContracts.ts:216-222 REVIEWER_UNSAFE_PASS) has no honest
 * object-graph encoding here and is an explicit residual, not a pass.
 */
function reviewerWireHolds(schema) {
  if (!isObject(schema)) return false;
  const top = schema.properties;
  if (!isObject(top) || top.verdict?.type !== "string") return false;
  if (!schemaRequires(schema, "verdict")) return false;
  const branches = disjunctionBranches(schema);
  if (
    branches.length &&
    branches.some((branch) => reviewerBranchQualifies(branch)) &&
    branches.every((branch) => reviewerBranchSafe(branch))
  ) {
    return true;
  }
  // A failing disjunction falls through: top-level if/then applies by
  // conjunction, so a sound if-FAIL-then still constrains payloads that take
  // a vacuous anyOf branch. Without one, the disjunction failure stands.
  // The FAIL-demanded findings must be required (in `then` or top-level):
  // a nonempty-typed but omittable findings lets {verdict:FAIL} pass.
  if (
    constrainsLiteral(schema.if?.properties?.verdict, "FAIL") &&
    arrayNonemptyAt(schema.then?.properties, "findings") &&
    (schemaRequires(schema.then, "findings") || schemaRequires(schema, "findings"))
  ) {
    return true;
  }
  return false;
}

/**
 * True iff a supervisor branch object rejects every SAFE-with-pending-items
 * payload: it either excludes the SAFE value (const/enum without SAFE) or
 * requires BOTH unresolved and missingEvidence empty. A vacuous `{}` admits
 * the violator and is NOT safe.
 */
function supervisorBranchSafe(props) {
  if (!isObject(props)) return false;
  const safety = props.finalizationSafety;
  if (isObject(safety)) {
    if (safety.const !== undefined && safety.const !== "SAFE") return true;
    if (Array.isArray(safety.enum) && !safety.enum.includes("SAFE")) return true;
  }
  return arrayEmptyAt(props, "unresolved") && arrayEmptyAt(props, "missingEvidence");
}

/**
 * Supervisor SAFE gate (outputContracts.ts:237-248 SUPERVISOR_UNSAFE_SAFE).
 * Requires a single branch object binding finalizationSafety to SAFE with
 * unresolved AND missingEvidence as type=array+maxItems===0 in that SAME
 * branch (anyOf/oneOf branch, allOf branch, or if(safety SAFE)/then).
 * Co-occurrence across unrelated branches fails — and a qualifying branch
 * paired with a vacuous `{}` anyOf/oneOf alternative fails: the
 * SAFE-with-pending-items payload takes the vacuous branch, so every
 * anyOf/oneOf branch must either qualify or independently reject the
 * violator. (allOf branches all apply, so a vacuous allOf sibling is not an
 * escape hatch and is ignored.) The top-level schema must list
 * `finalizationSafety` in `required`: an omittable safety field lets payloads
 * drop it while pending items remain.
 */
function supervisorWireHolds(schema) {
  if (!isObject(schema)) return false;
  if (!schemaRequires(schema, "finalizationSafety")) return false;
  const safeBranch = (props) => {
    if (!isObject(props)) return false;
    return (
      constrainsLiteral(props.finalizationSafety, "SAFE") &&
      arrayEmptyAt(props, "unresolved") &&
      arrayEmptyAt(props, "missingEvidence")
    );
  };
  const branches = disjunctionBranches(schema);
  if (
    branches.length &&
    branches.some((branch) => safeBranch(isObject(branch) ? branch.properties : undefined)) &&
    branches.every((branch) => supervisorBranchSafe(isObject(branch) ? branch.properties : undefined))
  ) {
    return true;
  }
  // A failing disjunction falls through: allOf branches and top-level
  // if/then apply by conjunction, so an allOf emptiness branch or a sound
  // if-SAFE-then still constrains payloads that take a vacuous anyOf branch.
  // Without one, the disjunction failure stands.
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const props = isObject(branch) ? branch.properties : undefined;
      if (
        isObject(props) &&
        arrayEmptyAt(props, "unresolved") &&
        arrayEmptyAt(props, "missingEvidence")
      ) {
        return true;
      }
    }
  }
  if (
    constrainsLiteral(schema.if?.properties?.finalizationSafety, "SAFE") &&
    arrayEmptyAt(schema.then?.properties, "unresolved") &&
    arrayEmptyAt(schema.then?.properties, "missingEvidence")
  ) {
    return true;
  }
  return false;
}

// Enumerated zod-gate → provider-JSON parity list. `test` inspects the loaded
// schema OBJECT GRAPH (exact path+constraint binding); `liveProbe` describes
// the behavioral zod-liveness check performed by probeWireLiveness (a removed
// zod gate is reported stale, never failed).
export const WIRE_GATES = [
  {
    gate: "planner-nonvacuous",
    zodRef: "src/agents/outputContracts.ts:63-71",
    zodMarkers: ["PLANNER_EMPTY_RESULT"],
    jsonContract: "planner",
    jsonPath: "planner required workUnits + planner.properties.workUnits (type=array AND minItems>=1)",
    expectation: "required lists workUnits and properties.workUnits carries type:array with integer minItems>=1",
    test: plannerWireHolds,
  },
  {
    gate: "explorer-nonvacuous",
    zodRef: "src/agents/outputContracts.ts:98-113",
    zodMarkers: ["EXPLORER_EMPTY_RESULT"],
    jsonContract: "explorer",
    jsonPath: "explorer.* (known evidence array paths, required AND type=array AND minItems>=1 per branch; no vacuous branch)",
    expectation:
      "a known evidence array is required and bound to type:array+minItems>=1 at top level, or every anyOf/oneOf branch requires and binds >=1 known evidence array path to type:array+minItems>=1 with no vacuous branch",
    test: explorerWireHolds,
  },
  {
    gate: "spec-ready-artifacts",
    zodRef: "src/agents/outputContracts.ts:146-158",
    zodMarkers: ["SPEC_MANAGER_INCOMPLETE_RESULT"],
    jsonContract: "spec-authoring",
    jsonPath: "spec-authoring required artifacts + artifacts node (required proposal+tasks AND both type=string+minLength>=1)",
    expectation:
      "top-level required lists artifacts and an artifacts node requires proposal+tasks with both typed type:string+minLength>=1 (unconditional, allOf branch, READY-tied anyOf/oneOf branch, or if-READY-then)",
    test: specWireHolds,
  },
  {
    gate: "reviewer-coherence",
    zodRef: "src/agents/outputContracts.ts:208-223",
    zodMarkers: ["REVIEWER_FAIL_WITHOUT_FINDING", "REVIEWER_UNSAFE_PASS"],
    jsonContract: "reviewer",
    jsonPath: "reviewer required verdict + branch binding verdict=FAIL with findings type=array+minItems>=1 (same branch, no vacuous alternative) + top-level verdict type=string",
    expectation:
      "required lists verdict, properties.verdict carries type:string, and one anyOf/oneOf branch (or if-FAIL-then) binds verdict to FAIL with findings type:array+minItems>=1 in the same branch object while every anyOf/oneOf branch rejects FAIL-with-empty-findings",
    test: reviewerWireHolds,
  },
  {
    gate: "supervisor-coherence",
    zodRef: "src/agents/outputContracts.ts:237-248",
    zodMarkers: ["SUPERVISOR_UNSAFE_SAFE"],
    jsonContract: "supervisor",
    jsonPath: "supervisor required finalizationSafety + branch binding finalizationSafety=SAFE with unresolved+missingEvidence type=array+maxItems===0 (same branch, no vacuous alternative)",
    expectation:
      "required lists finalizationSafety and one anyOf/oneOf/allOf branch (or if-SAFE-then) binds finalizationSafety to SAFE with unresolved and missingEvidence type:array+maxItems===0 in the same branch object while every anyOf/oneOf branch rejects SAFE-with-pending-items",
    test: supervisorWireHolds,
  },
];

/**
 * L1-E-WIRE-PARITY — every live zod coherence gate must have a corresponding
 * provider-facing JSON schema constraint, asserted on the loaded schema
 * OBJECT GRAPH (exact path+constraint binding, no text scanning). `schemas`
 * maps contract name → JSON Schema object (as returned by outputJsonSchema);
 * a missing/falsy `schemas` fails closed with distAvailable:false (no
 * source-text fallback is attempted — text cannot prove parity). `live` maps
 * gate id → boolean (behaviorally probed by probeWireLiveness on the real
 * tree; defaults to all-live for pure evaluation). Gates with live===false
 * are reported as stale, never failed: the enumeration follows the
 * deterministic validator, never a frozen assumption. `distStale` carries the
 * STALE_DIST binding refusal from loadDistForRoot (a dist/ snapshot bound to
 * a different source tree): it is reported explicitly and keeps the check
 * failed closed.
 */
export function checkWireParity(schemas, live, distStale) {
  const liveMap = live ?? {};
  const gates = [];
  const missing = [];
  const stale = [];
  const liveGates = WIRE_GATES.filter((def) => liveMap[def.gate] !== false);
  for (const def of WIRE_GATES) {
    if (liveMap[def.gate] === false) {
      stale.push(def.gate);
      continue;
    }
  }
  const staleDist = distStale ?? null;
  if (!isObject(schemas)) {
    for (const def of liveGates) missing.push(def.gate);
    return mkCheck("L1-E-WIRE-PARITY", true, {
      distAvailable: false,
      ...(staleDist ? { staleDist } : {}),
      reason: staleDist
        ? `STALE_DIST: refusing a dist/ snapshot bound to a different source tree (${staleDist.reason}); object-graph parity cannot be asserted without the schema objects for the inspected source.`
        : "provider JSON Schemas unavailable (dist/ snapshot missing): object-graph parity cannot be asserted without the schema objects; failing closed with no source-text fallback.",
      gates: liveGates.map((def) => ({ gate: def.gate, zod: def.zodRef, jsonPath: def.jsonPath, expectation: def.expectation, live: true, found: false })),
      missing,
      stale,
    });
  }
  for (const def of WIRE_GATES) {
    if (liveMap[def.gate] === false) continue;
    let found = false;
    try {
      found = def.test(schemas[def.jsonContract]) === true;
    } catch {
      found = false;
    }
    gates.push({ gate: def.gate, zod: def.zodRef, jsonPath: def.jsonPath, expectation: def.expectation, live: true, found });
    if (!found) missing.push(def.gate);
  }
  return mkCheck("L1-E-WIRE-PARITY", missing.length > 0, {
    distAvailable: true,
    ...(staleDist ? { staleDist } : {}),
    gates,
    missing,
    stale,
  });
}

/** Violating payloads proving each zod gate is live (behavioral, no text scan). */
export const WIRE_LIVENESS_PROBES = [
  { gate: "planner-nonvacuous", contract: "planner", marker: "PLANNER_EMPTY_RESULT", payload: { workUnits: [] } },
  { gate: "explorer-nonvacuous", contract: "explorer", marker: "EXPLORER_EMPTY_RESULT", payload: { summary: "liveness probe" } },
  {
    gate: "spec-ready-artifacts",
    contract: "spec-authoring",
    marker: "SPEC_MANAGER_INCOMPLETE_RESULT",
    payload: { change: "probe", status: "READY", artifacts: { specs: [] }, decisionRequests: [], validationReady: true },
  },
  {
    gate: "reviewer-coherence",
    contract: "reviewer",
    marker: "REVIEWER_FAIL_WITHOUT_FINDING",
    payload: { verdict: "FAIL", findings: [], finalizationSafety: "BLOCKED" },
  },
  {
    gate: "supervisor-coherence",
    contract: "supervisor",
    marker: "SUPERVISOR_UNSAFE_SAFE",
    payload: { summary: "liveness probe", finalizationSafety: "SAFE", unresolved: ["probe"] },
  },
];

/**
 * Probe zod-gate liveness behaviorally: a gate is live iff the deterministic
 * validator rejects the violating payload with the gate's marker code. Takes
 * the built validateAgentOutput (sync). Gates that accept their violating
 * payload are stale (removed upstream) and must not fail E. If the validator
 * is unavailable, every gate is assumed live (fail-closed direction).
 */
export function probeWireLiveness(validateAgentOutput) {
  const live = {};
  for (const probe of WIRE_LIVENESS_PROBES) {
    if (typeof validateAgentOutput !== "function") {
      live[probe.gate] = true;
      continue;
    }
    try {
      const result = validateAgentOutput(probe.contract, probe.payload);
      live[probe.gate] = !(result && result.ok === true);
      if (result && result.ok !== true) {
        const text = JSON.stringify(result.issues ?? []);
        if (!text.includes(probe.marker)) live[probe.gate] = true;
      }
    } catch {
      live[probe.gate] = true;
    }
  }
  return live;
}

/**
 * L1-F-LANE-COMMAND-BINDING — structural parameter-flow shape (ADVISORY ONLY;
 * never passes the gate since the M3 repair: see
 * checkLaneCommandBindingWithBehavioral, which fails closed without a bound
 * dist/ snapshot). Precisely:
 * (i) parse the `verifyProviderLaneEvidenceV1` signature for a command
 * parameter (name matching /command/i, e.g. expectedCommand/command); the
 * body must contain a SINGLE comparison expression (one `===`/`!==`
 * statement, delimited by `;`/`{`/`}`) that mentions BOTH the evidence's
 * `commandDigest` field AND that command parameter (digest-wrapped or bare).
 * An unrelated equality elsewhere (e.g. revision `!==`) plus a distant
 * commandDigest mention does NOT satisfy this. (ii) For every in-repo
 * consumer call site of verify/require* lane functions, paren-match the
 * call's OWN argument list from the call expression and require a command
 * value reference inside those parens (`command`/`expectedCommand` key or
 * `*.command`/`command` value bound to the verified parameter). A `command:`
 * token on a nearby line outside the call parens does NOT satisfy this.
 * Known false-pass classes of this fallback (it is NOT the enforcement;
 * the behavioral probe is): single-line compound comparisons that mention
 * both sides without relating them (e.g. `commandDigest !== sha256(seed) &&
 * expectedCommand !== ""`), aliasing, re-exports, wrapper indirection,
 * digest-function name variations, and runtime-passed values are not traced.
 * This proves static parameter-flow shape, not runtime binding correctness.
 */
export function parseVerifyCommandParam(laneSource) {
  const fnAnchor = laneSource.indexOf("verifyProviderLaneEvidenceV1");
  if (fnAnchor === -1) return { found: false, param: null };
  const parenOpen = laneSource.indexOf("(", fnAnchor);
  if (parenOpen === -1) return { found: true, param: null };
  let depth = 0;
  let close = -1;
  for (let i = parenOpen; i < laneSource.length; i += 1) {
    if (laneSource[i] === "(") depth += 1;
    if (laneSource[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return { found: true, param: null };
  const params = laneSource
    .slice(parenOpen + 1, close)
    .split(",")
    .map((part) => part.trim().split(":")[0].trim().split(" ").pop())
    .filter(Boolean);
  const commandParam = params.find((name) => /command/i.test(name)) ?? null;
  return { found: true, param: commandParam, params };
}

function splitComparisonStatements(body) {
  return body.split(/;|\n/).map((part) => part.trim()).filter(Boolean);
}

/** Paren-match `(...)` starting at openIndex (string-aware, minimal). */
function matchParen(text, openIndex) {
  if (text[openIndex] !== "(") return null;
  let depth = 0;
  let i = openIndex;
  let inStr = null;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      i += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
    i += 1;
  }
  return null;
}

/** Extract the call's own argument list for fnName from a collected snippet. */
function extractCallArgs(snippet, fnName) {
  const idx = snippet.indexOf(fnName);
  if (idx === -1) return null;
  const parenOpen = snippet.indexOf("(", idx + fnName.length);
  if (parenOpen === -1) return null;
  return matchParen(snippet, parenOpen);
}

export function checkLaneCommandBinding(laneSource, callSites) {
  const { found, param: commandParam } = parseVerifyCommandParam(laneSource);
  let verifyCompares = false;
  let verifyNote = "";
  if (!found) {
    verifyNote = "verifyProviderLaneEvidenceV1 not found in lane source.";
  } else if (!commandParam) {
    verifyNote = "verifyProviderLaneEvidenceV1 declares no command parameter (no /command/i param); no verified command value exists to compare.";
  } else {
    const brace = laneSource.indexOf("{", laneSource.indexOf(")", laneSource.indexOf("verifyProviderLaneEvidenceV1")));
    const body = brace !== -1 ? matchBrace(laneSource, brace) : null;
    if (!body) {
      verifyNote = "verifyProviderLaneEvidenceV1 body is unparsable.";
    } else {
      const statements = splitComparisonStatements(body);
      const hit = statements.find(
        (stmt) => /(===|!==)/.test(stmt) && stmt.includes("commandDigest") && stmt.includes(commandParam),
      );
      verifyCompares = Boolean(hit);
      verifyNote = hit
        ? `same-expression comparison binds evidence.commandDigest to verified parameter '${commandParam}': ${hit.slice(0, 160)}`
        : `no single ===/!== statement binds commandDigest to verified parameter '${commandParam}' (unrelated equalities do not satisfy this)`;
    }
  }
  const sitesMissing = (callSites ?? [])
    .filter((site) => {
      const fnName = ["verifyProviderLaneEvidenceV1", "requireProviderLaneEvidenceV1", "requireProviderLaneEvidenceForActionV1"].find((name) =>
        site.snippet.includes(name),
      );
      const args = fnName ? extractCallArgs(site.snippet, fnName) : null;
      if (!args) return true;
      // Argument-to-parameter tracing: the call's own parens must bind a
      // command value (object key command/expectedCommand with a command
      // value, or a positional *.command/command reference).
      if (/(command|expectedCommand)\s*:\s*[^\n,}]*command/i.test(args)) return false;
      if (/expectedCommand\s*:\s*[^\n,}]+/i.test(args) && /command/i.test(args)) return false;
      if (/\.\s*command\b/.test(args)) return false;
      if (/\(\s*[^,()]*\bcommand\b[^,()]*\)/.test(args)) return false;
      return true;
    })
    .map((site) => ({ file: site.file, line: site.line }));
  const failed = !verifyCompares || sitesMissing.length > 0;
  return mkCheck("L1-F-LANE-COMMAND-BINDING", failed, {
    mode: "structural-fallback",
    verifyComparesCommandDigest: verifyCompares,
    verifyDetail: verifyNote,
    verifiedCommandParam: commandParam,
    ref: "src/validation/laneEvidence.ts",
    consumerCallSitesMissingCommand: sitesMissing,
    consumerCallSitesChecked: (callSites ?? []).length,
  });
}

/** Blocker-code substring the command-binding probe requires (canonical fix contract). */
export const LANE_COMMAND_MISMATCH_MARKER = "COMMAND_MISMATCH";

/**
 * Build a synthetic but candidate-bound lane evidence document for the
 * behavioral probe. `helpers` provides the built digest/directory functions
 * ({ sha256Utf8, sha256Canonical, providerLaneEvidenceDirectory }) so tests
 * can inject fakes and the real tree uses dist code. The document carries
 * artifacts:[] (no fixture files needed) and a directory-correct artifact
 * path, so a correct verifier returns ok:true on the matching digest for
 * integrity reasons alone; only the command-digest cases discriminate.
 */
export function buildLaneProbeEvidence(helpers, root, config, commandText) {
  const { sha256Utf8, sha256Canonical, providerLaneEvidenceDirectory } = helpers;
  const candidate = { candidateId: "preflight-probe", revision: 1, identityDigest: "a".repeat(64) };
  const lane = "CONTRACT";
  const checkId = "preflight-command-binding-probe";
  const expected = { candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest };
  const directory = providerLaneEvidenceDirectory(root, config ?? {}, lane, expected);
  const correctDigest = sha256Utf8(commandText);
  const payload = {
    version: 1,
    lane,
    checkId,
    candidate: { candidateId: expected.candidateId, revision: expected.revision, identityDigest: expected.identityDigest },
    workspace: {
      version: 1,
      candidateId: expected.candidateId,
      candidateRevision: expected.revision,
      candidateIdentityDigest: expected.identityDigest,
      expectedSourceDigest: "b".repeat(64),
      observedSourceDigest: "b".repeat(64),
      status: "MATCH",
    },
    provider: { name: "preflight-probe", version: "1" },
    commandDigest: correctDigest,
    status: "PASS",
    summary: "preflight L1 command-binding probe",
    findingCount: 0,
    findings: [],
    artifacts: [],
    rawArtifact: "contract/preflight-probe.raw",
    rawArtifactDigest: "c".repeat(64),
    startedAt: "probe-started",
    finishedAt: "probe-finished",
    blockers: [],
    artifact: path.relative(root, path.join(directory, "preflight-command-binding-probe.json")),
  };
  const evidence = { ...payload, digest: sha256Canonical(payload) };
  return { evidence, expected, correctDigest, wrongDigest: sha256Utf8(`${commandText} :: different-action`) };
}

function blockerMentions(blockers, marker) {
  return Array.isArray(blockers) && blockers.some((blocker) => typeof blocker === "string" && blocker.includes(marker));
}

async function invokeLaneVerify(verifyFn, args) {
  try {
    const result = await verifyFn(...args);
    return { result, error: null };
  } catch (error) {
    return { result: null, error: String((error && error.message) || error) };
  }
}

/**
 * L1-F behavioral command-binding probe (BEHAVIORAL; the enforcement).
 * Calls the BUILT verifyProviderLaneEvidenceV1 with a synthetic evidence
 * document whose commandDigest is known: (a) the matching digest must verify
 * ok with no COMMAND_MISMATCH blocker; (b) a well-formed different digest
 * must return ok:false WITH a COMMAND_MISMATCH blocker; (c) undefined and a
 * malformed digest must each return ok:false WITH a COMMAND_MISMATCH
 * (fail-closed) blocker. A verifier that ignores its expected-command
 * parameter returns ok for (b)/(c) and therefore cannot pass: consumption is
 * proven, not scanned. `verifyFn` is injectable so self-tests prove the
 * discrimination without a build. A throw is never accepted as a blocker
 * (the canonical contract returns blockers; see notes).
 */
export async function probeLaneCommandBindingBehavioral(verifyFn, helpers, root, config) {
  const commandText = "preflight-l1 probe executed command --check unit-test";
  let built;
  try {
    built = buildLaneProbeEvidence(helpers, root, config, commandText);
  } catch (error) {
    return {
      mode: "behavioral",
      passed: false,
      detail: `probe evidence construction failed: ${String((error && error.message) || error)}`,
      cases: {},
    };
  }
  const { evidence, expected, correctDigest, wrongDigest } = built;
  const verifyArity = typeof verifyFn === "function" ? verifyFn.length : null;
  const caseA = await invokeLaneVerify(verifyFn, [root, config ?? {}, evidence, expected, correctDigest]);
  const caseB = await invokeLaneVerify(verifyFn, [root, config ?? {}, evidence, expected, wrongDigest]);
  const caseCUndefined = await invokeLaneVerify(verifyFn, [root, config ?? {}, evidence, expected, undefined]);
  const caseCMalformed = await invokeLaneVerify(verifyFn, [root, config ?? {}, evidence, expected, "not-a-digest"]);
  const aPass =
    caseA.error === null &&
    Boolean(caseA.result) &&
    caseA.result.ok === true &&
    !blockerMentions(caseA.result.blockers, LANE_COMMAND_MISMATCH_MARKER);
  const bPass =
    caseB.error === null &&
    Boolean(caseB.result) &&
    caseB.result.ok === false &&
    blockerMentions(caseB.result.blockers, LANE_COMMAND_MISMATCH_MARKER);
  const cPass =
    caseCUndefined.error === null &&
    Boolean(caseCUndefined.result) &&
    caseCUndefined.result.ok === false &&
    blockerMentions(caseCUndefined.result.blockers, LANE_COMMAND_MISMATCH_MARKER) &&
    caseCMalformed.error === null &&
    Boolean(caseCMalformed.result) &&
    caseCMalformed.result.ok === false &&
    blockerMentions(caseCMalformed.result.blockers, LANE_COMMAND_MISMATCH_MARKER);
  const passed = aPass && bPass && cPass;
  const summarize = (invocation) =>
    invocation.error !== null
      ? { threw: invocation.error }
      : { ok: invocation.result?.ok ?? null, blockers: invocation.result?.blockers ?? null };
  return {
    mode: "behavioral",
    passed,
    verifyArity,
    detail: passed
      ? "built verifier consumes its expected-command digest: matching digest verifies, differing digest is COMMAND_MISMATCH, undefined/malformed digests fail closed."
      : `built verifier does not enforce command binding (a:${aPass} b:${bPass} c:${cPass}); a verifier ignoring its expected-command parameter returns ok for the mismatched/missing cases.`,
    cases: {
      matchingDigestOk: aPass,
      differentDigestMismatch: bPass,
      missingMalformedFailClosed: cPass,
      caseA: summarize(caseA),
      caseB: summarize(caseB),
      caseCUndefined: summarize(caseCUndefined),
      caseCMalformed: summarize(caseCMalformed),
    },
  };
}

/**
 * Full L1-F check with behavioral enforcement. `input` is
 * { laneSource, callSites, behavioral?, distStale? } where `behavioral` is
 * { verifyFn, helpers, root, config } and `helpers` provides the built
 * { sha256Utf8, sha256Canonical, providerLaneEvidenceDirectory }. When
 * `behavioral` is present the verdict conjoins the consumption probe with the
 * consumer call-site threading shape (each in-repo call's own parens binding
 * a command digest value — threading shape, not runtime value correctness).
 * When absent (dist/ unavailable or STALE_DIST) the check FAILS CLOSED with
 * distAvailable:false: the structural text fallback proves static
 * parameter-flow shape only (same-expression comparison + in-parens
 * threading) and MUST NOT pass the gate — single-line compound comparisons,
 * aliasing, re-exports, wrapper indirection and digest-function variations
 * all fool it while the product gap (no consumption) remains. The structural
 * result is still computed and reported as advisory evidence
 * (structuralAdvisory) so operators see the static shape, but the verdict is
 * unconditionally FAIL.
 */
export async function checkLaneCommandBindingWithBehavioral(input) {
  const { laneSource, callSites, behavioral, distStale } = input ?? {};
  const sites = callSites ?? [];
  const sitesMissing = sites
    .filter((site) => {
      const fnName = ["verifyProviderLaneEvidenceV1", "requireProviderLaneEvidenceV1", "requireProviderLaneEvidenceForActionV1"].find((name) =>
        site.snippet.includes(name),
      );
      const args = fnName ? extractCallArgs(site.snippet, fnName) : null;
      if (!args) return true;
      if (/(command|expectedCommand)\s*:\s*[^\n,}]*command/i.test(args)) return false;
      if (/expectedCommand\s*:\s*[^\n,}]+/i.test(args) && /command/i.test(args)) return false;
      if (/\.\s*command\b/.test(args)) return false;
      if (/\(\s*[^,()]*\bcommand\b[^,()]*\)/.test(args)) return false;
      return true;
    })
    .map((site) => ({ file: site.file, line: site.line }));
  if (!behavioral || typeof behavioral.verifyFn !== "function") {
    const structural = checkLaneCommandBinding(laneSource, sites);
    const staleDist = distStale ?? null;
    return mkCheck("L1-F-LANE-COMMAND-BINDING", true, {
      mode: "structural-fallback",
      distAvailable: false,
      ...(staleDist ? { staleDist } : {}),
      reason: staleDist
        ? `STALE_DIST: refusing a dist/ snapshot bound to a different source tree (${staleDist.reason}); failing closed without a behavioral consumption proof.`
        : "dist/ snapshot unavailable: no behavioral consumption proof is possible; failing closed without trusting the structural text fallback.",
      structuralAdvisory: structural.evidence,
      note: "The structural text fallback (same-expression comparison + in-parens threading) is advisory only: known false-pass classes apply (compound comparisons, aliasing, re-exports, wrapper indirection); see notes. A PASS here would not prove command binding.",
      ref: "src/validation/laneEvidence.ts",
      consumerCallSitesMissingCommand: sitesMissing,
      consumerCallSitesChecked: sites.length,
    });
  }
  const probe = await probeLaneCommandBindingBehavioral(behavioral.verifyFn, behavioral.helpers, behavioral.root, behavioral.config);
  const failed = !probe.passed || sitesMissing.length > 0;
  return mkCheck("L1-F-LANE-COMMAND-BINDING", failed, {
    mode: "behavioral",
    distAvailable: true,
    probe,
    verifyConsumesCommandDigest: probe.passed,
    verifyDetail: probe.detail,
    ref: "src/validation/laneEvidence.ts",
    consumerCallSitesMissingCommand: sitesMissing,
    consumerCallSitesChecked: sites.length,
  });
}

/**
 * L1-G-ADAPTER-COVERAGE — every catalog capability
 * (src/validation/capabilityCatalog.ts) must have ≥1 adapter mapping in
 * src/validators/registry.ts (capabilityAdapter keys ∪ capabilityForAdapter
 * returns). FAILs listing each unmapped kind.
 */
export function checkAdapterCoverage(catalogSource, registrySource) {
  const catalog = parseCatalogValues(catalogSource);
  const covered = new Set(parseRegistryCoverage(registrySource));
  const unmapped = catalog.filter((kind) => !covered.has(kind));
  const failed = catalog.length === 0 || unmapped.length > 0;
  const evidence = { catalog, covered: [...covered].sort(), unmapped };
  if (catalog.length === 0) evidence.parseError = "validationCapabilityValues not parsed from catalog source.";
  return mkCheck("L1-G-ADAPTER-COVERAGE", failed, evidence);
}

/**
 * Run every check against one in-memory fixture bundle. Async because L1-F
 * awaits the behavioral consumption probe when `fx.laneBehavioral` provides
 * the built (or injected) verifier; every other assertion is synchronous and
 * pure. `fx` is
 * { agents, roles, skillSeed, skillRoots, routing, runtimes, models,
 *   permissionsSource, schemas, wireLive, distStale, laneSource, callSites,
 *   laneBehavioral, distStaleForLane, catalogSource, registrySource,
 *   dirExists, fileExists, mcpConfigured }.
 * `schemas` maps contract name → provider JSON Schema object (dist DATA);
 * `wireLive` maps wire gate id → boolean (behaviorally probed liveness);
 * `distStale` is the STALE_DIST refusal from loadDistForRoot (or null);
 * `laneBehavioral` is { verifyFn, helpers, root, config } or undefined
 * (undefined FAILS L1-F closed — the structural text fallback is advisory
 * only and never passes the gate).
 */
export async function evaluateAll(fx) {
  const laneCheck = fx.laneBehavioral
    ? await checkLaneCommandBindingWithBehavioral({ laneSource: fx.laneSource, callSites: fx.callSites, behavioral: fx.laneBehavioral })
    : await checkLaneCommandBindingWithBehavioral({ laneSource: fx.laneSource, callSites: fx.callSites, distStale: fx.distStaleForLane ?? fx.distStale });
  return [
    checkTopologyResolved(fx.topologyUnresolved),
    checkPermissionCeiling(fx.agents, fx.roles),
    checkSkillRoleFit(fx.agents, fx.skillSeed, fx.skillRoots, fx.fileExists),
    checkNonparticipantConstraints(fx.agents, fx.runtimes, fx.models),
    checkSpecializationsClosed(fx.agents, fx.routing, fx.roles),
    checkSkillRootsExist(fx.skillRoots, fx.dirExists),
    checkSkillRefsResolve(fx.agents, fx.skillRoots, fx.fileExists, fx.skillSeed),
    checkMcpFailClosed(fx.permissionsSource),
    checkMcpRefsConfigured(fx.agents, fx.mcpConfigured),
    checkWireParity(fx.schemas, fx.wireLive, fx.distStale),
    laneCheck,
    checkAdapterCoverage(fx.catalogSource, fx.registrySource),
  ];
}

// ---------------------------------------------------------------------------
// Real-tree loading (thin IO layer over the pure checks).
// ---------------------------------------------------------------------------

function readText(root, rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function listTsFiles(dir, base) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(abs, base));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return out.sort();
}

/** Minimal indentation-aware reader for `.harness/project.yaml` mcp.servers. */
export function parseProjectMcpServers(yamlText) {
  const servers = {};
  const lines = yamlText.split("\n");
  let inMcp = false;
  let mcpIndent = -1;
  let inServers = false;
  let serversIndent = -1;
  let current = null;
  let currentIndent = -1;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "");
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    const trimmed = line.trim();
    if (/^mcp\s*:\s*$/.test(trimmed)) {
      inMcp = true;
      mcpIndent = indent;
      inServers = false;
      current = null;
      continue;
    }
    if (inMcp && indent <= mcpIndent && !/^\s/.test(raw)) {
      inMcp = false;
      inServers = false;
      current = null;
      continue;
    }
    if (!inMcp) continue;
    if (/^servers\s*:\s*$/.test(trimmed)) {
      inServers = true;
      serversIndent = indent;
      current = null;
      continue;
    }
    if (inServers && indent <= serversIndent && trimmed.endsWith(":") === false && current === null) {
      // A dedented non-server key ends the servers block.
    }
    if (inServers) {
      if (current !== null && indent <= currentIndent && !/^[\w-]+\s*:\s*(\{.*\})?\s*$/.test(trimmed)) {
        current = null;
      }
      const serverMatch = trimmed.match(/^([\w-]+)\s*:\s*(\{.*\})?\s*$/);
      if (serverMatch && indent > serversIndent && indent <= serversIndent + 4) {
        current = serverMatch[1];
        currentIndent = indent;
        const inline = serverMatch[2];
        const disabled = inline ? /enabled\s*:\s*false/.test(inline) : false;
        servers[current] = { enabled: !disabled, _hasBlock: !inline };
        continue;
      }
      if (current !== null && indent > currentIndent) {
        const enabledMatch = trimmed.match(/^enabled\s*:\s*(true|false)\s*$/);
        if (enabledMatch) servers[current] = { enabled: enabledMatch[1] === "true" };
      } else if (indent <= serversIndent) {
        inServers = false;
        current = null;
      }
    }
  }
  const clean = {};
  for (const [name, value] of Object.entries(servers)) clean[name] = { enabled: value.enabled !== false };
  return clean;
}

/** Collect lane-evidence consumer call sites under <root>/src (static). */
export function collectLaneCallSites(root) {
  const srcDir = path.join(root, "src");
  const sites = [];
  const pattern = /verifyProviderLaneEvidenceV1|requireProviderLaneEvidenceV1|requireProviderLaneEvidenceForActionV1/g;
  for (const rel of listTsFiles(srcDir, root)) {
    if (rel === "src/validation/laneEvidence.ts") continue; // definitions live here
    const abs = path.join(root, rel);
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      pattern.lastIndex = 0;
      if (!pattern.test(lines[i])) continue;
      if (/^\s*import\s/.test(lines[i])) continue; // import, not a call
      if (/^\s*(export\s+)?(async\s+)?function\s/.test(lines[i])) continue; // definition, not a call
      const snippet = lines.slice(i, Math.min(lines.length, i + 14)).join("\n").slice(0, 1200);
      sites.push({ file: `${rel}:${i + 1}`, line: i + 1, snippet });
    }
  }
  return sites.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

const PREFLIGHT_NOTES = [
  "Mechanism=DETERMINISTIC for every check: static source/filesystem comparison plus loaded dist/ DATA (JSON Schema objects, built validator and verifier functions) with bounded crafted-input probes; no network, no model calls, no randomness.",
  "Dist-as-DATA choice: L1-E loads provider-facing JSON Schemas via outputJsonSchema from the dist/ release snapshot pinned by dist/current relative to the inspected root (auditing another checkout uses that checkout's snapshot), but only after the snapshot's build-identity.json binds to the inspected source tree (packageVersion + git HEAD must match; a dirty build or a dirty source tree refuses with explicit STALE_DIST). L1-F calls the built verifyProviderLaneEvidenceV1 with crafted digests and asserts on returned blockers. No tsx is required and no provider/runtime workflow executes: outputJsonSchema/validateAgentOutput are pure validators and the lane probe uses a synthetic artifacts:[] document. When dist/ is unavailable or STALE_DIST, L1-E fails closed with distAvailable:false (no source-text fallback is attempted — text cannot prove parity) and L1-F fails closed with distAvailable:false (the structural text shape is advisory only and never passes the gate).",
  "L1-A1 ceiling mapping covers read/write/gitWrite/delegate/shell plus review/validate against maxCapabilities (roles.ts maxCapabilities, compiled via src/participants/skillCompiler.ts:30-32 roleCapabilities). network has no role-ceiling source in roles.ts and is intentionally unchecked (validateExecutionCapabilities in permissions.ts:23-67 likewise gates only a subset).",
  "L1-A2 mirrors src/participants/skillCompiler.ts:77 role rejection plus the compiler registry split (src/agents/compiler.ts:74-78): seed ids are role-ceiling-checked, non-seed OpenCode skills resolving as <skillRoot>/<id>/SKILL.md are accepted (existence is L1-C2's verdict), and anything in neither registry fails; required/forbidden-tool coupling (src/participants/skillCompiler.ts:78-80) is out of scope because preset skills carry no tool declarations.",
  "L1-A3 covers intentional nonparticipants (Semantic Assessor: a CanonicalAgentRole without a RoleProfileV1 per src/participants/types.ts). It enforces the preset-decidable subset of permissions.ts:55-61 (all of read/write/shell/network/delegate/review/validate/gitWrite explicitly deny; no skills; no MCPs; no top-level args; no execution.args; no runtime.defaultArgs; no top-level or execution.nativeAgent). execution.nativeAgent IS statically checkable: a configured string (config.ts:17) compiled into selection.nativeAgent (routing.ts:8), exactly like execution.args merging into selection.args there; runtime.defaultArgs likewise merges (routing.ts:8 args spread) and is resolved per agent via agent.runtime.name, execution.runtime, or the execution.model @alias target. The previous gate's `agent.args ?? agent.execution?.args` shape let an empty top-level args mask a nonempty execution.args and is fixed by checking all three levels independently. L1-A1/L1-B skip nonparticipant roles instead of failing them as unknown-profile. Residual: transport/adapter/capability projection (paseo+codex, runtimeConfigInjection/structuredOutput/modelSelection) remains runtime-resolved, not preset-decidable, and is not checked here.",
  "L1-B checks profile-subset closure only; it does not require a matching enabled agent per selector.",
  "L1-C1 is aligned with the runtime compiler (src/agents/compiler.ts:80-82): missing root dirs are tolerated and only a fully unmaterialized topology (every configured root missing) fails; per-skill resolution is L1-C2, which is exact parity with compiler.ts:54-60 (filesystem SKILL.md under configured roots). The loader resolves the ACTIVE consumer topology (.harness/agents.source.jsonc extends-chain with skillRoots union, falling back to presets/agents/default.jsonc), so preset-only roots no longer false-RED consumer checkouts. Seed-ID validity is L1-A2; the seed-vs-filesystem split itself is the reported drift.",
  "L1-D1 asserts the absence of the fail-open shape; any future allowlist/explicit-deny rewrite passes as long as no `if (!configured[name]) … = true` grant remains.",
  "L1-D2 reads <root>/.harness/project.yaml mcp.servers with a minimal indentation-aware parser (full YAML fidelity is a documented limit; block and inline `{…}` server forms are handled).",
  "L1-E enumeration follows behaviorally-probed zod liveness (WIRE_LIVENESS_PROBES via validateAgentOutput); implementer/repair-result anyOf guards are already present in JSON and are therefore not listed as gates.",
  "L1-E asserts exact object-graph bindings, never token co-occurrence: planner required workUnits with properties.workUnits type=array AND minItems>=1; explorer either a known evidence array required and bound to type=array+minItems>=1 at top level or an anyOf/oneOf whose EVERY branch requires and binds >=1 known evidence array path to type=array+minItems>=1 with no vacuous branch (unrelated disjunctions fail); spec top-level required artifacts plus an artifacts node whose required includes proposal+tasks with both typed type:string+minLength>=1 (unconditional, allOf branch, READY-tied anyOf/oneOf branch, or if-READY-then); reviewer required verdict with top-level properties.verdict type:string AND one anyOf/oneOf branch (or if-FAIL-then) binding verdict to FAIL with findings type:array+minItems>=1 in the SAME branch object while every anyOf/oneOf branch rejects FAIL-with-empty-findings (a qualifying branch paired with a vacuous {} fails); supervisor required finalizationSafety with one anyOf/oneOf/allOf branch (or if-SAFE-then) binding finalizationSafety to SAFE with unresolved and missingEvidence type:array+maxItems===0 in the SAME branch object while every anyOf/oneOf branch rejects SAFE-with-pending-items. A bare `{minItems:1}` without type:array, a `{minLength:1}` without type:string, an omittable (unrequired) constrained property, a missing parent artifacts, or a constraint on an unrelated path all fail. Residuals (not faked): the reviewer critical/high-severity to not-SAFE implication has no honest object-graph encoding here and is NOT asserted; full conditional-implication semantics (READY/SAFE/FAIL constraining every conforming payload) are approximated by same-branch presence, not proven; unconditional (non-READY-tied) spec shapes and single-field explorer shapes are accepted as fail-closed enforcement though stricter than zod (they may reject payloads zod accepts — a completeness cost, not a soundness hole).",
  "L1-F command binding is proven behaviorally: the built verifier is called with (a) the matching command digest (must verify ok, no COMMAND_MISMATCH), (b) a well-formed different digest (must return ok:false with a COMMAND_MISMATCH blocker), (c) undefined and malformed digests (each must return ok:false with a COMMAND_MISMATCH fail-closed blocker). A verifier ignoring its expected-command parameter returns ok for (b)/(c) and cannot pass. The probe uses a synthetic candidate-bound document (artifacts:[], directory-correct artifact path); a full persist-to-load filesystem round-trip is a residual. Consumer call-site threading (each in-repo verify/require* call's own parens binding a command digest value) is conjoined statically: it proves threading shape, not runtime value correctness. Without a bound dist/ snapshot L1-F fails closed: the structural text shape (same-expression comparison + in-parens threading) is reported as advisory evidence only and never passes the gate. Structural-fallback residuals (advisory mode only): single-line compound comparisons mentioning both sides without relating them, aliasing, re-exports, wrapper indirection, and non-sha256 digest spellings are not traced.",
  "L1-G compares catalog values against the union of capabilityAdapter keys and capabilityForAdapter returns; provider-side registries (src/providers/validation/registry.ts) are out of scope.",
  "No backward-compatibility shims: unparsable inputs fail the affected check closed with a parse note instead of being silently accepted.",
];

/**
 * Pure STALE_DIST binder: decide whether a dist/ release identity belongs to
 * the inspected source tree. `identity` is the release's build-identity.json
 * ({ packageVersion, gitSha, releaseId, buildDigest, dirty }); `source` is
 * { packageVersion, gitSha, dirty } observed from the inspected root.
 * Returns null when bound, otherwise { reason } naming every mismatch. A
 * version or commit mismatch, a build recorded dirty, or an unresolvable
 * source identity all refuse the binding — the gate must fail closed rather
 * than assert parity/probe behavior against another tree's snapshot.
 */
export function checkDistBindsSource(identity, source) {
  if (!identity || typeof identity !== "object") return { reason: "dist build-identity.json is missing or unparsable" };
  if (!source || typeof source.packageVersion !== "string") return { reason: "source build identity is unresolvable (package.json unreadable)" };
  const mismatches = [];
  if (identity.packageVersion !== source.packageVersion) {
    mismatches.push(`packageVersion dist=${identity.packageVersion} source=${source.packageVersion}`);
  }
  if (typeof identity.gitSha === "string" && identity.gitSha !== "unknown" && typeof source.gitSha === "string" && source.gitSha) {
    if (identity.gitSha !== source.gitSha) mismatches.push(`gitSha dist=${identity.gitSha} source=${source.gitSha}`);
  } else {
    mismatches.push("gitSha binding unavailable (unknown dist sha or unresolvable source HEAD)");
  }
  // Fail closed on unknown dirty evidence: both sides must carry an explicit
  // boolean. A missing/non-boolean dist dirty, a missing/non-boolean source
  // dirty (including a failed dirty probe), or a dirty-true either side
  // refuses the binding — a failed probe (unknown) must never read as clean.
  if (identity.dirty !== false) {
    mismatches.push(identity.dirty === true ? "dist snapshot was built from a dirty tree" : "dist dirty evidence is missing or non-boolean (fail closed on unknown)");
  }
  if (source.dirty !== false) {
    mismatches.push(source.dirty === true ? "inspected source tree is dirty relative to HEAD" : "source dirty evidence is missing or non-boolean (fail closed on unknown)");
  }
  if (mismatches.length) return { reason: mismatches.join("; ") };
  return null;
}

/**
 * Best-effort HEAD SHA of the inspected root. Reads .git/HEAD directly
 * (plain checkouts); worktrees keep a `.git` FILE, so fall back to
 * `git rev-parse HEAD`. Returns "" when unresolvable — the binder then
 * refuses the binding explicitly instead of trusting the snapshot.
 */
async function readSourceHeadSha(root) {
  try {
    const dotGit = path.join(root, ".git");
    if (fs.statSync(dotGit).isDirectory()) {
      const head = fs.readFileSync(path.join(dotGit, "HEAD"), "utf8").trim();
      const refMatch = head.match(/^ref:\s*(.+)$/);
      if (refMatch) return fs.readFileSync(path.join(dotGit, refMatch[1]), "utf8").trim();
      if (/^[a-f0-9]{40}$/i.test(head)) return head;
    }
  } catch {
    // Fall through to git CLI.
  }
  try {
    const { execFileSync } = await import("node:child_process");
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Best-effort dirty probe of the inspected root (tracked files only: untracked
 *  worktree scaffolding such as symlinked node_modules must not force stale).
 *  Returns true/false, or undefined when the probe fails — callers fail
 *  closed on unknown (a failed probe must never read as a clean tree). */
async function readSourceDirty(root) {
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0;
  } catch {
    return undefined;
  }
}

/**
 * Load the dist/ DATA snapshot for the inspected root. Resolves
 * <root>/dist/current to a release id, binds the release's build-identity to
 * the inspected source tree (packageVersion + git HEAD; dirty on either side
 * refuses), and dynamically imports the three behavior-bearing modules
 * (outputContracts, laneEvidence, digest). Returns null when dist/ is
 * unavailable or unimportable — callers fail E closed and fail F closed, both
 * explicitly marked. Returns { releaseId, staleDist } (with no modules) when
 * the snapshot binds to a DIFFERENT source tree — callers fail E/F closed
 * with the explicit STALE_DIST reason instead of trusting another tree's
 * snapshot. Never throws.
 */
export async function loadDistForRoot(root) {
  try {
    const pointerPath = path.join(root, "dist", "current");
    const releaseId = fs.readFileSync(pointerPath, "utf8").trim();
    if (!/^[A-Za-z0-9._-]+$/.test(releaseId)) return null;
    const releaseDir = path.join(root, "dist", "releases", releaseId);
    let identity = null;
    try {
      identity = JSON.parse(fs.readFileSync(path.join(releaseDir, "build-identity.json"), "utf8"));
    } catch {
      return null;
    }
    let sourceVersion = null;
    try {
      sourceVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? null;
    } catch {
      sourceVersion = null;
    }
    const sourceSha = await readSourceHeadSha(root);
    const sourceDirty = await readSourceDirty(root);
    const stale = checkDistBindsSource(identity, { packageVersion: sourceVersion, gitSha: sourceSha, dirty: sourceDirty });
    if (stale) {
      return {
        releaseId,
        staleDist: { releaseId, reason: stale.reason, identity, source: { packageVersion: sourceVersion, gitSha: sourceSha || null, dirty: sourceDirty ?? null } },
      };
    }
    const [contracts, lane, digest] = await Promise.all([
      import(pathToFileURL(path.join(releaseDir, "agents", "outputContracts.js")).href),
      import(pathToFileURL(path.join(releaseDir, "validation", "laneEvidence.js")).href),
      import(pathToFileURL(path.join(releaseDir, "core", "digest.js")).href),
    ]);
    if (
      typeof contracts?.outputJsonSchema !== "function" ||
      typeof contracts?.validateAgentOutput !== "function" ||
      typeof lane?.verifyProviderLaneEvidenceV1 !== "function" ||
      typeof lane?.providerLaneEvidenceDirectory !== "function" ||
      typeof digest?.sha256Utf8 !== "function" ||
      typeof digest?.sha256Canonical !== "function"
    ) {
      return null;
    }
    return { releaseId, contracts, lane, digest, buildIdentity: identity };
  } catch {
    return null;
  }
}

/**
 * Resolve the ACTIVE agent topology for the inspected root (consumer-aware).
 * The old loader read presets/agents/default.jsonc alone, which false-REDed
 * real checkouts two ways: it missed the unioned `skillRoots skills/` from
 * the consumer overlay (.harness/agents.source.jsonc extends
 * aeh:orchestration → aeh:default, unioning ["skills"] over the preset
 * [".harness/skills", ".agents/skills", ".opencode/skills"]), and it checked
 * preset agents/runtimes/models instead of the composed consumer layer. This
 * mirrors loadComposedLayer/composeAgentTopologyLayers (config.ts:39-77) for
 * the preflight-relevant subset: extends-chain resolution (aeh:default,
 * aeh:orchestration, relative paths), skillRoots UNION, and per-key
 * agent/runtime/model merges with execution-map merging. Profile overrides
 * are out of scope (base agents govern the checked ceilings). Falls back to
 * presets/agents/default.jsonc when no consumer source exists. FAILS CLOSED
 * when the ACTIVE consumer topology exists but cannot be composed: returns
 * configUnresolved (CONFIG_UNRESOLVED) with an empty topology instead of a
 * silent fallback-to-default PASS — the gate must never assert against a
 * preset topology while the consumer believes its own overlay is active.
 * Never throws: returns { topology, notes, configUnresolved } with parse
 * failures as notes (fail-closed downstream via empty topology + note).
 */
export function resolveConsumerTopology(root) {
  const notes = [];
  const readLayer = (abs) => parseJsonc(fs.readFileSync(abs, "utf8"));
  const resolveExtension = (extension, fromDirectory) => {
    if (extension === "aeh:default") return path.join(root, "presets", "agents", "default.jsonc");
    if (extension === "aeh:orchestration") return path.join(root, "presets", "agents", "orchestration.jsonc");
    if (extension.startsWith("aeh:")) throw new Error(`Unknown built-in agent topology preset ${extension}.`);
    return path.isAbsolute(extension) ? extension : path.resolve(fromDirectory, extension);
  };
  const union = (base, overlay) => [...new Set([...(base ?? []), ...(overlay ?? [])])];
  const mergeRecord = (base, overlay, merger) => {
    if (!base && !overlay) return undefined;
    const result = { ...(base ?? {}) };
    for (const [name, value] of Object.entries(overlay ?? {})) result[name] = merger(result[name], value);
    return result;
  };
  const mergeAgent = (base, overlay) => ({
    ...(base ?? {}),
    ...overlay,
    execution: { ...((base ?? {}).execution ?? {}), ...((overlay ?? {}).execution ?? {}) },
    permissions: { ...((base ?? {}).permissions ?? {}), ...((overlay ?? {}).permissions ?? {}) },
  });
  const shallowMerge = (base, overlay) => ({ ...(base ?? {}), ...overlay });
  const compose = (base, overlay) => ({
    version: 1,
    skillRoots: union(base.skillRoots, overlay.skillRoots),
    runtimes: mergeRecord(base.runtimes, overlay.runtimes, shallowMerge),
    models: mergeRecord(base.models, overlay.models, shallowMerge),
    agents: mergeRecord(base.agents, overlay.agents, mergeAgent),
    routing: [...(base.routing ?? []), ...(overlay.routing ?? [])],
  });
  const loadComposed = (file, stack) => {
    const absolute = path.resolve(file);
    if (stack.has(absolute)) throw new Error(`Circular agent topology extension detected at ${absolute}.`);
    const next = new Set(stack);
    next.add(absolute);
    const layer = readLayer(absolute);
    // Mirror the runtime layerSchema (src/agents/config.ts:30, layerSchema
    // at :43: version: z.literal(1)). The composer below hardcodes
    // version: 1, so without this check a syntactically valid overlay such
    // as { version: 2, extends: ["aeh:default"] } would normalize silently
    // while the runtime loader rejects it. Fail closed (Mechanism=DETERMINISTIC).
    if (layer === null || typeof layer !== "object" || Array.isArray(layer)) {
      throw new Error(`Invalid agent topology layer ${absolute}: expected an object layer with version: 1.`);
    }
    if (layer.version !== 1) {
      throw new Error(
        `Unsupported agent topology layer version ${JSON.stringify(layer.version)} at ${absolute}: expected version: 1.`,
      );
    }
    if (layer.extends !== undefined) {
      const validExtends =
        Array.isArray(layer.extends) && layer.extends.every((e) => typeof e === "string" && e.length > 0);
      if (!validExtends) {
        throw new Error(`Invalid agent topology layer ${absolute}: "extends" must be an array of non-empty strings.`);
      }
    }
    let composed = { version: 1 };
    for (const extension of layer.extends ?? []) {
      composed = compose(composed, loadComposed(resolveExtension(extension, path.dirname(absolute)), next));
    }
    const { extends: _extends, ...rest } = layer;
    return compose(composed, rest);
  };
  const consumerFile = path.join(root, ".harness", "agents.source.jsonc");
  let consumerPresent = false;
  try {
    consumerPresent = fs.statSync(consumerFile).isFile();
  } catch {
    consumerPresent = false;
  }
  if (consumerPresent) {
    try {
      const topology = loadComposed(consumerFile, new Set());
      return { topology, notes, configUnresolved: null };
    } catch (error) {
      const reason = `CONFIG_UNRESOLVED: active agent topology ${consumerFile} cannot be composed (${String((error && error.message) || error)}); refusing silent fallback-to-default PASS.`;
      notes.push(`${reason} Falling back to an EMPTY topology (fail closed).`);
      return { topology: { version: 1 }, notes, configUnresolved: { code: "CONFIG_UNRESOLVED", reason } };
    }
  }
  try {
    const preset = parseJsonc(fs.readFileSync(path.join(root, "presets", "agents", "default.jsonc"), "utf8"));
    if (preset === null || typeof preset !== "object" || Array.isArray(preset) || preset.version !== 1) {
      throw new Error("presets/agents/default.jsonc layer version unsupported: expected version: 1.");
    }
    return {
      topology: {
        version: 1,
        skillRoots: preset.skillRoots,
        runtimes: preset.runtimes,
        models: preset.models,
        agents: preset.agents,
        routing: preset.routing,
      },
      notes,
      configUnresolved: null,
    };
  } catch (error) {
    notes.push(`presets/agents/default.jsonc unreadable (${String((error && error.message) || error)}).`);
    return { topology: { version: 1 }, notes, configUnresolved: { code: "CONFIG_UNRESOLVED", reason: "no composable agent topology available" } };
  }
}

/**
 * L1-CONFIG-RESOLVED — the ACTIVE agent topology must compose. A broken
 * consumer overlay (.harness/agents.source.jsonc) fails closed with the
 * explicit CONFIG_UNRESOLVED reason instead of silently falling back to
 * the default preset and PASSing against a topology the consumer is not
 * running. Mechanism=DETERMINISTIC.
 */
export function checkTopologyResolved(configUnresolved) {
  const failed = Boolean(configUnresolved);
  return mkCheck("L1-CONFIG-RESOLVED", failed, {
    ...(failed ? { code: "CONFIG_UNRESOLVED", reason: configUnresolved?.reason ?? "active topology unresolvable" } : {}),
  });
}

/** Load real-tree inputs and evaluate. Throws with a clear message on missing files. */
export async function loadRealTreeInputs(root) {
  const { topology, notes: topologyNotes, configUnresolved } = resolveConsumerTopology(root);
  const rolesSource = readText(root, "src/participants/roles.ts");
  const skillsSource = readText(root, "src/participants/skills.ts");
  const { roles, parseNotes: roleNotes } = parseRolesProfiles(rolesSource);
  const { seed, parseNotes: seedNotes } = parseSkillSeed(skillsSource);
  let mcpConfigured = {};
  try {
    mcpConfigured = parseProjectMcpServers(readText(root, ".harness/project.yaml"));
  } catch {
    mcpConfigured = {};
  }
  const dirExists = (rel) => {
    try {
      return fs.statSync(path.join(root, rel)).isDirectory();
    } catch {
      return false;
    }
  };
  const fileExists = (rel) => {
    try {
      return fs.statSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  };
  const laneSource = readText(root, "src/validation/laneEvidence.ts");
  const callSites = collectLaneCallSites(root);
  const dist = await loadDistForRoot(root);
  let schemas;
  let wireLive;
  let laneBehavioral;
  let distStale = null;
  let distNote;
  if (dist && !dist.staleDist) {
    const names = ["planner", "explorer", "spec-authoring", "reviewer", "supervisor"];
    schemas = {};
    for (const name of names) {
      try {
        schemas[name] = dist.contracts.outputJsonSchema(name);
      } catch {
        schemas[name] = undefined;
      }
    }
    wireLive = probeWireLiveness(dist.contracts.validateAgentOutput);
    laneBehavioral = {
      verifyFn: (...args) => dist.lane.verifyProviderLaneEvidenceV1(...args),
      helpers: {
        sha256Utf8: dist.digest.sha256Utf8,
        sha256Canonical: dist.digest.sha256Canonical,
        providerLaneEvidenceDirectory: (...args) => dist.lane.providerLaneEvidenceDirectory(...args),
      },
      root,
      config: {},
    };
    distNote = `dist: release snapshot ${dist.releaseId} bound to the inspected source tree (build-identity match) for object-graph (L1-E) and behavioral (L1-F) probes.`;
  } else {
    schemas = undefined;
    wireLive = undefined;
    laneBehavioral = undefined;
    if (dist?.staleDist) {
      distStale = dist.staleDist;
      distNote = `dist: STALE_DIST — release snapshot ${dist.releaseId} is bound to a different source tree (${dist.staleDist.reason}); refusing it. L1-E fails closed with distAvailable:false and L1-F fails closed (no source-text parity fallback is attempted).`;
    } else {
      distNote = "dist: snapshot unavailable — L1-E fails closed with distAvailable:false and L1-F fails closed (no source-text parity fallback is attempted).";
    }
  }
  return {
    fx: {
      agents: topology.agents ?? {},
      skillRoots: topology.skillRoots ?? [".harness/skills"],
      topologyUnresolved: configUnresolved ?? null,
      routing: topology.routing ?? [],
      runtimes: topology.runtimes ?? {},
      models: topology.models ?? {},
      roles,
      skillSeed: seed,
      permissionsSource: readText(root, "src/agents/permissions.ts"),
      schemas,
      wireLive,
      distStale,
      laneSource,
      callSites,
      laneBehavioral,
      distStaleForLane: distStale,
      catalogSource: readText(root, "src/validation/capabilityCatalog.ts"),
      registrySource: readText(root, "src/validators/registry.ts"),
      dirExists,
      fileExists,
      mcpConfigured,
    },
    parseNotes: [...roleNotes, ...seedNotes, ...topologyNotes],
    distNote,
  };
}

export async function runPreflight(root) {
  const { fx, parseNotes, distNote } = await loadRealTreeInputs(root);
  const checks = await evaluateAll(fx);
  const failed = checks.filter((c) => c.status !== "PASS").length;
  return {
    version: REPORT_VERSION,
    tool: "aeh-preflight-l1",
    ruleset: RULESET,
    root: path.resolve(root),
    node: process.version,
    checks,
    notes: [...PREFLIGHT_NOTES, distNote, ...parseNotes.map((note) => `parse: ${note}`)],
    summary: { total: checks.length, passed: checks.length - failed, failed },
  };
}

// ---------------------------------------------------------------------------
// Entry point (side-effect free for --help/-h).
// ---------------------------------------------------------------------------

function printUsage() {
  process.stdout.write(
    "Usage: node scripts/preflightL1.mjs [root]\n" +
      "Deterministic L1 preflight gate. Stdout is a machine-readable JSON report;\n" +
      "exit 0 iff every check passes, nonzero otherwise.\n",
  );
}

const invokedAsScript =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
  } else {
    const positional = args.filter((arg) => !arg.startsWith("--"));
    const root = path.resolve(positional[0] ?? process.cwd());
    let report;
    try {
      report = await runPreflight(root);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify(
          {
            version: REPORT_VERSION,
            tool: "aeh-preflight-l1",
            ruleset: RULESET,
            root,
            node: process.version,
            checks: [],
            notes: PREFLIGHT_NOTES,
            summary: { total: 0, passed: 0, failed: 1 },
            error: String((error && error.message) || error),
          },
        )}\n`,
      );
      process.exitCode = 2;
      report = null;
    }
    if (report) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.summary.failed ? 1 : 0;
    }
  }
}
