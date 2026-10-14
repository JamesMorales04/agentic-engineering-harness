#!/usr/bin/env node
/**
 * AEH L1 preflight gate (stabilization campaign, RED-state reporter).
 *
 * Mechanism classification: DETERMINISTIC. Every check below is a pure,
 * static, reproducible comparison of shipped configuration against
 * deterministic validation logic and runtime behavior: JSONC parsing,
 * source-text inspection, filesystem existence probes, and set-membership
 * comparisons. No network access, no model calls, no randomness, no
 * wall-clock dependence. Identical inputs always produce identical reports.
 *
 * Established-pattern note: this is a `.mjs` deterministic gate, so it
 * follows the `scripts/architecture.mjs` / `scripts/publicApiContract.mjs`
 * convention (Node builtins only, static source inspection, JSON report to
 * stdout, drain-safe exit code). It deliberately does NOT import the built
 * `dist/` graph and does NOT require `tsx`: importing compiled modules
 * would execute provider/runtime code inside a read-only gate and would
 * couple the gate to the `dist/current` release pointer. The task brief
 * asked to verify the dist-consumption pattern first: `scripts/build.mjs`
 * emits `dist/main.js` (a launcher) plus `dist/releases/<id>/…`, which no
 * `.mjs` gate imports; `.mjs` gates read source-as-text. See `notes` in
 * the emitted report for this and every other encoding decision/limit.
 *
 * Usage: `node scripts/preflightL1.mjs [root]` (root defaults to cwd).
 * Stdout is ALWAYS a single machine-readable JSON document:
 *   { version, tool, ruleset, root, node, checks:[{id,status,evidence}],
 *     notes:[...], summary:{total,passed,failed} }
 * `status` is PASS|FAIL per check. Exit code is 0 iff every check PASSES,
 * nonzero otherwise (assigned via `process.exitCode`, never `process.exit`,
 * so piped stdout is never truncated).
 *
 * The core check functions are exported pure functions so
 * `tests/preflightL1.test.ts` can evaluate crafted compliant/violating
 * fixtures without touching the filesystem.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * L1-A1-PERMISSION-CEILING — preset permission grants must fit the role
 * ceiling (authority + delegation + toolPack). Mapping (and only this
 * mapping; network/review/validate have no role-ceiling source and are
 * documented as omitted in `notes`):
 * read→authority.canRead, write→authority.canWrite,
 * gitWrite→authority.canWrite, delegate→delegation.allowed,
 * shell→authority.canExecute AND `command-execute` ∈ toolPack.required∪optional.
 * A grant is `allow`|`ask`; `deny`|absent is no grant. Unknown roles and
 * unresolvable toolPacks fail closed.
 */
export function checkPermissionCeiling(agents, roles) {
  const violations = [];
  for (const [name, agent] of Object.entries(agents)) {
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
  }
  return mkCheck("L1-A1-PERMISSION-CEILING", violations.length > 0, { violations });
}

/**
 * L1-A2-SKILL-ROLE-FIT — every preset skill must exist in the canonical
 * seed and, when the seed restricts it to roles, must include the agent's
 * role (mirrors src/participants/skillCompiler.ts role/required-tool
 * rejection; unknown ids fail closed).
 */
export function checkSkillRoleFit(agents, seed) {
  const violations = [];
  for (const [name, agent] of Object.entries(agents)) {
    for (const skill of agent.skills ?? []) {
      const def = seed[skill];
      if (!def) {
        violations.push({ agent: name, role: agent.role, skill, reason: "unknown skill id: absent from canonical seed" });
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
 */
export function checkSpecializationsClosed(agents, routing, roles) {
  const violations = [];
  for (const [name, agent] of Object.entries(agents)) {
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
 * L1-C1-SKILLROOT-EXISTS — every configured skillRoot must be an existing
 * directory (absent `skillRoots` defaults to [".harness/skills"], mirroring
 * resolveAgentTopology).
 */
export function checkSkillRootsExist(skillRoots, dirExists) {
  const roots = skillRoots && skillRoots.length ? skillRoots : [".harness/skills"];
  const missing = roots.filter((root) => !dirExists(root));
  return mkCheck("L1-C1-SKILLROOT-EXISTS", missing.length > 0, { skillRoots: roots, missing });
}

/**
 * L1-C2-SKILL-REF-RESOLVES — every preset skill (except "*") must resolve
 * to `<skillRoot>/<id>/SKILL.md` under at least one configured root
 * (exact parity with src/agents/compiler.ts:54-60).
 */
export function checkSkillRefsResolve(agents, skillRoots, fileExists) {
  const roots = skillRoots && skillRoots.length ? skillRoots : [".harness/skills"];
  const violations = [];
  for (const [name, agent] of Object.entries(agents)) {
    for (const skill of agent.skills ?? []) {
      if (skill === "*") continue;
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

// Enumerated zod-gate → provider-JSON parity list, derived from
// src/agents/outputContracts.ts superRefine blocks. `zodMarkers` must all be
// present for the gate to be live; `test` inspects the contract's JSON
// schema block for the corresponding constraint.
const WIRE_GATES = [
  {
    gate: "planner-nonvacuous",
    zodRef: "src/agents/outputContracts.ts:63-71",
    zodMarkers: ["PLANNER_EMPTY_RESULT"],
    jsonContract: "planner",
    jsonPath: "planner.workUnits",
    expectation: "JSON schema requires workUnits minItems>=1",
    test: (block) => /workUnits:\s*\{[^}]*minItems/.test(block),
  },
  {
    gate: "explorer-nonvacuous",
    zodRef: "src/agents/outputContracts.ts:98-113",
    zodMarkers: ["EXPLORER_EMPTY_RESULT"],
    jsonContract: "explorer",
    jsonPath: "explorer.* (evidence arrays)",
    expectation: "JSON schema carries a non-vacuous constraint (minItems/anyOf/allOf/oneOf)",
    test: (block) => /(anyOf|allOf|oneOf|minItems)/.test(block),
  },
  {
    gate: "spec-ready-artifacts",
    zodRef: "src/agents/outputContracts.ts:146-158",
    zodMarkers: ["SPEC_MANAGER_INCOMPLETE_RESULT"],
    jsonContract: "spec-authoring",
    jsonPath: "spec-authoring.artifacts.required",
    expectation: "JSON schema artifacts.required includes proposal and tasks",
    test: (block) => {
      const m = block.match(/artifacts:\s*\{[^]*?required:\s*\[([^\]]*)\]/);
      return Boolean(m) && m[1].includes("proposal") && m[1].includes("tasks");
    },
  },
  {
    gate: "reviewer-coherence",
    zodRef: "src/agents/outputContracts.ts:208-223",
    zodMarkers: ["REVIEWER_FAIL_WITHOUT_FINDING", "REVIEWER_UNSAFE_PASS"],
    jsonContract: "reviewer",
    jsonPath: "reviewer (verdict/findings/finalizationSafety)",
    expectation: "JSON schema couples verdict↔findings↔finalizationSafety (anyOf/allOf/oneOf)",
    test: (block) => /(anyOf|allOf|oneOf)/.test(block),
  },
  {
    gate: "supervisor-coherence",
    zodRef: "src/agents/outputContracts.ts:237-248",
    zodMarkers: ["SUPERVISOR_UNSAFE_SAFE"],
    jsonContract: "supervisor",
    jsonPath: "supervisor (finalizationSafety/unresolved/missingEvidence)",
    expectation: "JSON schema couples finalizationSafety with unresolved/missingEvidence (anyOf/allOf/oneOf)",
    test: (block) => /(anyOf|allOf|oneOf)/.test(block),
  },
];

function findContractBlock(schemasText, name) {
  for (const key of [`${name}:`, `"${name}":`]) {
    const idx = schemasText.indexOf(key);
    if (idx === -1) continue;
    const brace = schemasText.indexOf("{", idx);
    if (brace === -1) continue;
    const block = matchBrace(schemasText, brace);
    if (block) return block;
  }
  return null;
}

/**
 * L1-E-WIRE-PARITY — every live zod superRefine coherence gate must have a
 * corresponding provider-facing JSON schema constraint. FAILs listing each
 * missing gate. Gates whose zod markers vanished are reported as stale in
 * `evidence.stale` (and notes) rather than failed: the enumeration follows
 * the source, never a frozen list.
 */
export function checkWireParity(contractsSource) {
  const anchor = contractsSource.indexOf("const jsonSchemas");
  let schemasText = null;
  if (anchor !== -1) {
    const brace = contractsSource.indexOf("{", anchor);
    schemasText = brace !== -1 ? matchBrace(contractsSource, brace) : null;
  }
  const gates = [];
  const missing = [];
  const stale = [];
  for (const def of WIRE_GATES) {
    const live = def.zodMarkers.every((marker) => contractsSource.includes(marker));
    if (!live) {
      stale.push(def.gate);
      continue;
    }
    const block = schemasText ? findContractBlock(schemasText, def.jsonContract) : null;
    const found = block ? def.test(block) : false;
    gates.push({ gate: def.gate, zod: def.zodRef, jsonPath: def.jsonPath, expectation: def.expectation, found });
    if (!found) missing.push(def.gate);
  }
  const failed = missing.length > 0 || !schemasText;
  const evidence = { gates, missing, stale };
  if (!schemasText) evidence.parseError = "jsonSchemas record not found in outputContracts source.";
  return mkCheck("L1-E-WIRE-PARITY", failed, evidence);
}

/**
 * L1-F-LANE-COMMAND-BINDING — structural command-binding check for
 * provider lane evidence (src/validation/laneEvidence.ts:256-279 never
 * compares commandDigest). Precisely: (i) the `verifyProviderLaneEvidenceV1`
 * body must reference `commandDigest` together with an expected/command
 * value and an equality comparison; (ii) every in-repo consumer call site
 * of verify/require* lane functions must pass a `command:` argument.
 * Static-text limits (aliasing, re-exports, runtime-passed values) are
 * documented in `notes`; this check proves the presence/absence of the
 * binding shape, not runtime correctness.
 */
export function checkLaneCommandBinding(laneSource, callSites) {
  const fnAnchor = laneSource.indexOf("verifyProviderLaneEvidenceV1");
  let verifyCompares = false;
  let verifyNote = "";
  if (fnAnchor === -1) {
    verifyNote = "verifyProviderLaneEvidenceV1 not found in lane source.";
  } else {
    const brace = laneSource.indexOf("{", laneSource.indexOf(")", fnAnchor));
    const body = brace !== -1 ? matchBrace(laneSource, brace) : null;
    if (!body) {
      verifyNote = "verifyProviderLaneEvidenceV1 body is unparsable.";
    } else {
      const refsDigest = body.includes("commandDigest");
      const refsExpected = /expected/i.test(body);
      const compares = /(===|!==)/.test(body);
      verifyCompares = refsDigest && refsExpected && compares;
      verifyNote = `body refs commandDigest=${refsDigest}, expected/command=${refsExpected}, equality=${compares}`;
    }
  }
  const sitesMissing = (callSites ?? [])
    .filter((site) => !/\bcommand\s*:/.test(site.snippet))
    .map((site) => ({ file: site.file, line: site.line }));
  const failed = !verifyCompares || sitesMissing.length > 0;
  return mkCheck("L1-F-LANE-COMMAND-BINDING", failed, {
    verifyComparesCommandDigest: verifyCompares,
    verifyDetail: verifyNote,
    ref: "src/validation/laneEvidence.ts:256-279",
    consumerCallSitesMissingCommand: sitesMissing,
    consumerCallSitesChecked: (callSites ?? []).length,
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

/** Run every check against one in-memory fixture bundle (pure). */
export function evaluateAll(fx) {
  return [
    checkPermissionCeiling(fx.agents, fx.roles),
    checkSkillRoleFit(fx.agents, fx.skillSeed),
    checkSpecializationsClosed(fx.agents, fx.routing, fx.roles),
    checkSkillRootsExist(fx.skillRoots, fx.dirExists),
    checkSkillRefsResolve(fx.agents, fx.skillRoots, fx.fileExists),
    checkMcpFailClosed(fx.permissionsSource),
    checkMcpRefsConfigured(fx.agents, fx.mcpConfigured),
    checkWireParity(fx.contractsSource),
    checkLaneCommandBinding(fx.laneSource, fx.callSites),
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
  "Mechanism=DETERMINISTIC for every check: static source/filesystem comparison only; no network, no model calls.",
  "Script-convention choice: pure-Node .mjs static inspection (scripts/architecture.mjs pattern). The gate reads source-as-text and never imports dist/ (a launcher + release snapshot per scripts/build.mjs, imported by no .mjs gate) nor tsx-loaded TypeScript (would execute provider/runtime code inside a read-only gate). It runs identically before and after build.",
  "L1-A1 ceiling mapping covers read/write/gitWrite/delegate/shell only. network/review/validate have no role-ceiling source in roles.ts and are intentionally unchecked (validateExecutionCapabilities in permissions.ts:23-67 likewise gates only a subset).",
  "L1-A2 mirrors skillCompiler.ts:77 role rejection; required/forbidden-tool coupling (skillCompiler.ts:78-80) is out of scope because preset skills carry no tool declarations.",
  "L1-B checks profile-subset closure only; it does not require a matching enabled agent per selector.",
  "L1-C2 is exact parity with compiler.ts:54-60 (filesystem SKILL.md under configured roots). Seed-ID validity is L1-A2; the seed-vs-filesystem split itself is the reported drift.",
  "L1-D1 asserts the absence of the fail-open shape; any future allowlist/explicit-deny rewrite passes as long as no `if (!configured[name]) … = true` grant remains.",
  "L1-D2 reads <root>/.harness/project.yaml mcp.servers with a minimal indentation-aware parser (full YAML fidelity is a documented limit; block and inline `{…}` server forms are handled).",
  "L1-E enumeration follows the live zod markers; implementer/repair-result anyOf guards are already present in JSON and are therefore not listed as gates.",
  "L1-F is structural: it proves whether a commandDigest comparison and command-argument threading exist in static text, not runtime binding correctness. verify() currently takes no command parameter, so (i) cannot pass without a signature change; consumer call-site coverage cannot see through aliases or re-exports.",
  "L1-G compares catalog values against the union of capabilityAdapter keys and capabilityForAdapter returns; provider-side registries (src/providers/validation/registry.ts) are out of scope.",
  "L1-A1/L1-B fail closed on roles with no canonical participant profile (e.g. Semantic Assessor, a CanonicalAgentRole without a RoleProfileV1): with no ceiling there is nothing to check against, so the agent is reported, not silently passed.",
  "No backward-compatibility shims: unparsable inputs fail the affected check closed with a parse note instead of being silently accepted.",
];

/** Load real-tree inputs and evaluate. Throws with a clear message on missing files. */
export function loadRealTreeInputs(root) {
  const preset = parseJsonc(readText(root, "presets/agents/default.jsonc"));
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
  return {
    fx: {
      agents: preset.agents ?? {},
      skillRoots: preset.skillRoots ?? [".harness/skills"],
      routing: preset.routing ?? [],
      roles,
      skillSeed: seed,
      permissionsSource: readText(root, "src/agents/permissions.ts"),
      contractsSource: readText(root, "src/agents/outputContracts.ts"),
      laneSource: readText(root, "src/validation/laneEvidence.ts"),
      callSites: collectLaneCallSites(root),
      catalogSource: readText(root, "src/validation/capabilityCatalog.ts"),
      registrySource: readText(root, "src/validators/registry.ts"),
      dirExists,
      fileExists,
      mcpConfigured,
    },
    parseNotes: [...roleNotes, ...seedNotes],
  };
}

export function runPreflight(root) {
  const { fx, parseNotes } = loadRealTreeInputs(root);
  const checks = evaluateAll(fx);
  const failed = checks.filter((c) => c.status !== "PASS").length;
  return {
    version: REPORT_VERSION,
    tool: "aeh-preflight-l1",
    ruleset: RULESET,
    root: path.resolve(root),
    node: process.version,
    checks,
    notes: [...PREFLIGHT_NOTES, ...parseNotes.map((note) => `parse: ${note}`)],
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
      report = runPreflight(root);
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
