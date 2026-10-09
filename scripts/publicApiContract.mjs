#!/usr/bin/env node
/**
 * Project-specific public-API contract validator for AEH/Home.
 *
 * Deterministic gate for the `public API` impact-review dimension
 * (src/architecture/candidateAssurance.ts: `"public API" -> contract-test/ELEVATED`,
 * requirement id `impact-review-public-api`). The validation resolver maps that
 * dimension to kind `contract-test`; this script is wired as the approved
 * configured validator (`adapter: contract-test`, `node scripts/publicApiContract.mjs`)
 * so the dimension resolves instead of BLOCKED. Execution goes through the
 * contract-test provider path, which persists candidate-bound CONTRACT lane
 * evidence; a plain `npm run contract` project script that merely exits zero
 * cannot satisfy the lane (PROVIDER_LANE_EVIDENCE_REQUIRED).
 *
 * Every check below is deterministic, uses only Node builtins, and encodes a
 * public contract the Harness relies on:
 *
 * - the Control Center contract version pin (contracts.ts, server.ts, UI api.ts
 *   must agree on version 1; a silent bump breaks paired sessions);
 * - the Control Center resource-kind vocabulary (10 kinds; UI + server +
 *   projection must agree);
 * - the overview shape (server provides every field the UI requires; the UI
 *   never accepts a version it does not understand);
 * - the server route inventory (all GET/POST routes the UI calls must exist);
 * - the UI contract enforcement (required-field lists, buildIdentity digest
 *   shape, decisionRequest binding);
 * - the operation projection binding (version + controlCenterResourceId for
 *   every id; pause/resume/cancel gated on live status);
 * - the dimension->kind mapping stability (`public API` must stay
 *   contract-test/ELEVATED or the resolver would fabricate a new obligation);
 * - the resolver fallback coverage (package.json contract/test:contract scripts
 *   the resolution order falls back to).
 *
 * Usage: `node scripts/publicApiContract.mjs [--json] [root]` (root defaults to cwd).
 * Prints PUBLIC_API_CONTRACT_PASS on success, PUBLIC_API_CONTRACT_FAILED otherwise.
 *
 * Structured evidence: `--json` prints a versioned interaction array to stdout
 * (`{ version: 1, tool: "aeh-public-api-contract", interactions: [...], summary }`,
 * one interaction per check with `id`, `name`, `status` ("pass"|"fail") and
 * `evidence` detail) for the contract-test lane normalizer. The default text
 * format and exit codes are unchanged with or without the flag.
 */
import fs from "node:fs";
import path from "node:path";

const RULESET = "aeh-public-api-contract-v1";

// Versioned structured-evidence envelope consumed by the contract-test lane
// normalizer (src/validators/toolEvidence.ts). The normalizer accepts exactly
// this schema (tool + version 1 + interactions array); anything else still
// fail-closes, so these markers must stay stable.
const EVIDENCE_TOOL = "aeh-public-api-contract";
const EVIDENCE_SCHEMA_VERSION = 1;

const CHECK_NAMES = {
  "PUBLIC-API-EXPORT-SURFACE": "control-center export surface",
  "PUBLIC-API-PROJECTION-SURFACE": "operation projection surface",
  "PUBLIC-API-CONTRACT-VERSION": "contract version pin",
  "PUBLIC-API-RESOURCE-KINDS": "resource-kind vocabulary",
  "PUBLIC-API-OVERVIEW-SHAPE": "overview shape",
  "PUBLIC-API-SERVER-ROUTES": "server route inventory",
  "PUBLIC-API-UI-CONTRACT": "UI contract enforcement",
  "PUBLIC-API-PROJECTION-BINDING": "operation projection binding",
  "PUBLIC-API-DIMENSION-MAPPING": "dimension mapping stability",
  "PUBLIC-API-FALLBACK-COVERAGE": "resolver fallback coverage"
};

const CHECK_PASS_EVIDENCE = {
  "PUBLIC-API-EXPORT-SURFACE": "contracts.ts exports CONTROL_CENTER_CONTRACT_VERSION = 1, controlCenterResourceId and the Overview/Operation/Participant/Candidate projection interfaces",
  "PUBLIC-API-PROJECTION-SURFACE": "operationProjection.ts exports projectOperationRecordV1",
  "PUBLIC-API-CONTRACT-VERSION": "contracts.ts, server.ts and ui/control-center/src/api.ts agree on contract version 1",
  "PUBLIC-API-RESOURCE-KINDS": "contracts/server/ui/projection agree on the 10 resource kinds in stable order with the exact UI route inventory",
  "PUBLIC-API-OVERVIEW-SHAPE": "ui overview() requires every overview field, the Overview/Snapshot interfaces declare them, and server stamps version/generatedAt/buildIdentity",
  "PUBLIC-API-SERVER-ROUTES": "server exposes every resource route plus the cancel/pause/resume/select actions",
  "PUBLIC-API-UI-CONTRACT": "ui api.ts keeps every required-field list, buildIdentity digest check and decisionRequest binding guard",
  "PUBLIC-API-PROJECTION-BINDING": "operation projection binds CONTROL_CENTER_CONTRACT_VERSION and controlCenterResourceId with pause/resume/cancel gated on live status",
  "PUBLIC-API-DIMENSION-MAPPING": "candidateAssurance.ts keeps the public API -> contract-test/ELEVATED mapping",
  "PUBLIC-API-FALLBACK-COVERAGE": "package.json declares the contract and test:contract fallback scripts"
};

function fail(checks, id, message) {
  checks.push({ id, ok: false, message });
}

function pass(checks, id) {
  checks.push({ id, ok: true });
}

function read(root, relative) {
  const file = path.join(root, relative);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function checkExportSurface(checks, root) {
  const contracts = read(root, "src/control-center/contracts.ts");
  if (contracts === undefined) {
    fail(checks, "PUBLIC-API-EXPORT-SURFACE", "src/control-center/contracts.ts is missing.");
    return;
  }
  if (!contracts.includes("export const CONTROL_CENTER_CONTRACT_VERSION = 1")) {
    fail(checks, "PUBLIC-API-EXPORT-SURFACE", "contracts.ts must export CONTROL_CENTER_CONTRACT_VERSION = 1.");
  } else if (!contracts.includes("export function controlCenterResourceId")) {
    fail(checks, "PUBLIC-API-EXPORT-SURFACE", "contracts.ts must export controlCenterResourceId.");
  } else if (
    !contracts.includes("export interface ControlCenterOverviewV1") ||
    !contracts.includes("export interface ControlCenterOperationProjectionV1") ||
    !contracts.includes("export interface ControlCenterParticipantProjectionV1") ||
    !contracts.includes("export interface ControlCenterCandidateProjectionV1")
  ) {
    fail(checks, "PUBLIC-API-EXPORT-SURFACE", "contracts.ts must export the Overview/Operation/Participant/Candidate projection interfaces.");
  } else {
    pass(checks, "PUBLIC-API-EXPORT-SURFACE");
  }
  const projection = read(root, "src/control-center/operationProjection.ts");
  if (projection === undefined) {
    fail(checks, "PUBLIC-API-PROJECTION-SURFACE", "src/control-center/operationProjection.ts is missing.");
    return;
  }
  if (!projection.includes("export function projectOperationRecordV1")) {
    fail(checks, "PUBLIC-API-PROJECTION-SURFACE", "operationProjection.ts must export projectOperationRecordV1.");
  } else {
    pass(checks, "PUBLIC-API-PROJECTION-SURFACE");
  }
}

function checkContractVersion(checks, root) {
  const contracts = read(root, "src/control-center/contracts.ts");
  const server = read(root, "src/control-center/server.ts");
  const api = read(root, "ui/control-center/src/api.ts");
  if (contracts === undefined || server === undefined || api === undefined) {
    fail(checks, "PUBLIC-API-CONTRACT-VERSION", "contracts.ts, server.ts and ui/control-center/src/api.ts must all exist.");
    return;
  }
  const problems = [];
  if (!contracts.includes("export const CONTROL_CENTER_CONTRACT_VERSION = 1 as const")) {
    problems.push("contracts.ts version pin drifted");
  }
  if (!server.includes("CONTROL_CENTER_CONTRACT_VERSION")) {
    problems.push("server.ts no longer binds CONTROL_CENTER_CONTRACT_VERSION");
  }
  if (!api.includes("body.version !== 1") && !api.includes("version !== 1")) {
    problems.push("ui api.ts no longer enforces contract version 1");
  }
  if (problems.length) {
    fail(checks, "PUBLIC-API-CONTRACT-VERSION", problems.join("; "));
  } else {
    pass(checks, "PUBLIC-API-CONTRACT-VERSION");
  }
}

function checkResourceKinds(checks, root) {
  const contracts = read(root, "src/control-center/contracts.ts");
  const server = read(root, "src/control-center/server.ts");
  const api = read(root, "ui/control-center/src/api.ts");
  const projection = read(root, "src/control-center/operationProjection.ts");
  if (contracts === undefined || server === undefined || api === undefined || projection === undefined) {
    fail(checks, "PUBLIC-API-RESOURCE-KINDS", "contracts.ts, server.ts, ui api.ts and operationProjection.ts must all exist.");
    return;
  }
  const expected = ["project", "operation", "participant", "candidate", "context", "authority", "evidence", "services", "knowledge", "event"];
  const block = contracts.match(/export type ControlCenterResourceKindV1\s*=\s*([\s\S]*?);/);
  if (!block) {
    fail(checks, "PUBLIC-API-RESOURCE-KINDS", "ControlCenterResourceKindV1 declaration not found.");
    return;
  }
  const observed = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    fail(checks, "PUBLIC-API-RESOURCE-KINDS", `resource-kind union is [${observed.join(", ")}] but must be exactly [${expected.join(", ")}] (no extras, no omissions, stable order).`);
    return;
  }
  const serverKinds = [...new Set([...server.matchAll(/(?:collection|detail)\(\s*"([^"]+)"/g)].map((match) => match[1]))];
  const serverMissing = expected.filter((kind) => !serverKinds.includes(kind));
  const serverExtra = serverKinds.filter((kind) => !expected.includes(kind));
  const projectionKinds = [...projection.matchAll(/controlCenterResourceId\(\s*"([^"]+)"/g)].map((match) => match[1]);
  const projectionExtra = [...new Set(projectionKinds)].filter((kind) => !expected.includes(kind));
  const projectionCore = ["operation", "project", "candidate", "participant"];
  const projectionMissingCore = projectionCore.filter((kind) => !projectionKinds.includes(kind));
  const routeFor = { project: "/api/v1/projects", operation: "/api/v1/operations", participant: "/api/v1/participants", candidate: "/api/v1/candidates", context: "/api/v1/context", authority: "/api/v1/authority", evidence: "/api/v1/evidence", services: "/api/v1/services", knowledge: "/api/v1/knowledge", event: "/api/v1/events" };
  const uiMissing = expected.filter((kind) => !api.includes(routeFor[kind]));
  // Exact UI route inventory: the 10 resource routes above plus the contract
  // auxiliaries the UI legitimately calls (pair/session/overview, paseo +
  // timeline + lead messages, project select, decisions, operation
  // detail/cancel/pause/resume). Any addition or removal changes the public
  // surface, so extras fail alongside omissions.
  const expectedUiRoutes = [
    "/api/v1/pair",
    "/api/v1/session",
    "/api/v1/overview",
    "/api/v1/projects",
    "/api/v1/operations",
    "/api/v1/operations/{id}",
    "/api/v1/operations/{id}/cancel",
    "/api/v1/operations/{id}/pause",
    "/api/v1/operations/{id}/resume",
    "/api/v1/participants",
    "/api/v1/candidates",
    "/api/v1/context",
    "/api/v1/authority",
    "/api/v1/evidence",
    "/api/v1/services",
    "/api/v1/knowledge",
    "/api/v1/events/history",
    "/api/v1/paseo",
    "/api/v1/paseo/participants/{id}/timeline",
    "/api/v1/paseo/lead/messages",
    "/api/v1/projects/{id}/select",
    "/api/v1/decisions"
  ];
  const observedUiRoutes = [...new Set(
    [...api.matchAll(/["`]\/api\/v1\/[^"`]*["`]/g)]
      .map((match) => match[0].slice(1, -1).replace(/\$\{[^}]*\}/g, "{id}"))
  )];
  const uiRouteMissing = expectedUiRoutes.filter((route) => !observedUiRoutes.includes(route));
  const uiRouteExtra = observedUiRoutes.filter((route) => !expectedUiRoutes.includes(route));
  const problems = [];
  if (uiRouteMissing.length || uiRouteExtra.length) {
    problems.push(`ui route set [${observedUiRoutes.sort().join(", ")}] must be exactly [${expectedUiRoutes.slice().sort().join(", ")}] (missing: ${uiRouteMissing.join(", ") || "none"}; extra: ${uiRouteExtra.join(", ") || "none"})`);
  }
  if (serverMissing.length || serverExtra.length) {
    problems.push(`server vocabulary [${serverKinds.join(", ")}] diverges (missing: ${serverMissing.join(", ") || "none"}; extra: ${serverExtra.join(", ") || "none"})`);
  }
  if (projectionExtra.length || projectionMissingCore.length) {
    problems.push(`projection vocabulary diverges (extra: ${projectionExtra.join(", ") || "none"}; missing core: ${projectionMissingCore.join(", ") || "none"})`);
  }
  if (uiMissing.length) {
    problems.push(`ui vocabulary missing routes for: ${uiMissing.map((kind) => `${kind} (${routeFor[kind]})`).join(", ")}`);
  }
  if (problems.length) {
    fail(checks, "PUBLIC-API-RESOURCE-KINDS", problems.join("; "));
  } else {
    pass(checks, "PUBLIC-API-RESOURCE-KINDS");
  }
}

function checkOverviewShape(checks, root) {
  const contracts = read(root, "src/control-center/contracts.ts");
  const api = read(root, "ui/control-center/src/api.ts");
  const server = read(root, "src/control-center/server.ts");
  if (contracts === undefined || api === undefined || server === undefined) {
    fail(checks, "PUBLIC-API-OVERVIEW-SHAPE", "contracts.ts, ui api.ts and server.ts must all exist.");
    return;
  }
  const required = ["version", "generatedAt", "buildIdentity", "projects", "operations", "participants", "candidates", "context", "authority", "evidence", "services", "knowledge", "quality", "certification", "security", "pairing"];
  const overviewCall = api.match(/overview\(\): Promise<Overview> \{([\s\S]*?)\n  \}/);
  const missingRequired = required.filter((field) => !api.includes(`"${field}"`));
  if (!overviewCall || missingRequired.length) {
    fail(checks, "PUBLIC-API-OVERVIEW-SHAPE", `ui overview() must require the overview fields (missing: ${missingRequired.join(", ") || "overview method"}).`);
    return;
  }
  const overviewInterface = contracts.match(/export interface ControlCenterOverviewV1 extends ControlCenterSnapshotV1 \{([\s\S]*?)\n\}/);
  const snapshotInterface = contracts.match(/export interface ControlCenterSnapshotV1 \{([\s\S]*?)\n\}/);
  if (!overviewInterface || !snapshotInterface) {
    fail(checks, "PUBLIC-API-OVERVIEW-SHAPE", "ControlCenterOverviewV1/ControlCenterSnapshotV1 declarations not found.");
    return;
  }
  const snapshotFields = ["projects", "operations", "participants", "candidates", "context", "authority", "evidence", "services", "knowledge", "quality", "certification"];
  const overviewOwnFields = ["version", "generatedAt", "buildIdentity", "security", "pairing"];
  const hasField = (body, field) => new RegExp(`\\b${field}\\s*[?:]`).test(body);
  const missingSnapshot = snapshotFields.filter((field) => !hasField(snapshotInterface[1], field));
  const missingOverview = overviewOwnFields.filter((field) => !hasField(overviewInterface[1], field));
  const missingInterface = [...missingSnapshot, ...missingOverview];
  if (missingInterface.length) {
    fail(checks, "PUBLIC-API-OVERVIEW-SHAPE", `ControlCenterOverviewV1/snapshot missing fields: ${missingInterface.join(", ")}.`);
  } else if (!server.includes("version: CONTROL_CENTER_CONTRACT_VERSION") || !server.includes("generatedAt") || !server.includes("buildIdentity")) {
    fail(checks, "PUBLIC-API-OVERVIEW-SHAPE", "server overview() must stamp version, generatedAt and buildIdentity.");
  } else {
    pass(checks, "PUBLIC-API-OVERVIEW-SHAPE");
  }
}

function checkServerRoutes(checks, root) {
  const source = read(root, "src/control-center/server.ts");
  if (source === undefined) {
    fail(checks, "PUBLIC-API-SERVER-ROUTES", "src/control-center/server.ts is missing.");
    return;
  }
  const expected = [
    "/api/v1/pair",
    "/api/v1/session",
    "/api/v1/overview",
    "/api/v1/projects",
    "/api/v1/operations",
    "/api/v1/participants",
    "/api/v1/candidates",
    "/api/v1/context",
    "/api/v1/authority",
    "/api/v1/evidence",
    "/api/v1/services",
    "/api/v1/knowledge",
    "/api/v1/paseo",
    "/api/v1/decisions"
  ];
  const missing = expected.filter((route) => !source.includes(route));
  const actionRoutes = ["/cancel", "/pause", "/resume", "/select"];
  const missingActions = actionRoutes.filter((route) => !source.includes(route));
  if (missing.length || missingActions.length) {
    fail(checks, "PUBLIC-API-SERVER-ROUTES", `server routes missing: ${[...missing, ...missingActions].join(", ")}.`);
  } else {
    pass(checks, "PUBLIC-API-SERVER-ROUTES");
  }
}

function checkUiContract(checks, root) {
  const source = read(root, "ui/control-center/src/api.ts");
  if (source === undefined) {
    fail(checks, "PUBLIC-API-UI-CONTRACT", "ui/control-center/src/api.ts is missing.");
    return;
  }
  const guards = [
    '["version", "csrfToken"]',
    "unsupported contract version",
    "buildIdentity is malformed",
    "decisionRequest candidate does not match",
    "policyDigest must be a lowercase SHA-256 digest",
    'resumeTarget !== "SPEC_AUTHORING"'
  ];
  const missing = guards.filter((snippet) => !source.includes(snippet));
  if (missing.length) {
    fail(checks, "PUBLIC-API-UI-CONTRACT", `ui contract enforcement regressed (missing: ${missing.join("; ")}).`);
  } else {
    pass(checks, "PUBLIC-API-UI-CONTRACT");
  }
}

function checkProjectionBinding(checks, root) {
  const source = read(root, "src/control-center/operationProjection.ts");
  if (source === undefined) {
    fail(checks, "PUBLIC-API-PROJECTION-BINDING", "src/control-center/operationProjection.ts is missing.");
    return;
  }
  const guards = [
    "CONTROL_CENTER_CONTRACT_VERSION",
    'controlCenterResourceId("operation"',
    'controlCenterResourceId("participant"',
    'controlCenterResourceId("candidate"',
    "pause: active",
    "resume: active",
    "cancel: active"
  ];
  const missing = guards.filter((snippet) => !source.includes(snippet));
  if (missing.length) {
    fail(checks, "PUBLIC-API-PROJECTION-BINDING", `operation projection lost required binding/controls: ${missing.join("; ")}.`);
  } else {
    pass(checks, "PUBLIC-API-PROJECTION-BINDING");
  }
}

function checkDimensionMapping(checks, root) {
  const source = read(root, "src/architecture/candidateAssurance.ts");
  if (source === undefined) {
    fail(checks, "PUBLIC-API-DIMENSION-MAPPING", "src/architecture/candidateAssurance.ts is missing.");
    return;
  }
  if (!source.includes('"public API": { kind: "contract-test", floor: "ELEVATED" }')) {
    fail(checks, "PUBLIC-API-DIMENSION-MAPPING", "public API->contract-test/ELEVATED mapping changed or missing; the resolver would fabricate a new obligation.");
  } else {
    pass(checks, "PUBLIC-API-DIMENSION-MAPPING");
  }
}

function checkFallbackCoverage(checks, root) {
  const raw = read(root, "package.json");
  if (raw === undefined) {
    fail(checks, "PUBLIC-API-FALLBACK-COVERAGE", "package.json is missing.");
    return;
  }
  let scripts;
  try {
    scripts = JSON.parse(raw).scripts ?? {};
  } catch {
    fail(checks, "PUBLIC-API-FALLBACK-COVERAGE", "package.json does not parse.");
    return;
  }
  const missing = [];
  for (const name of ["contract", "test:contract"]) {
    if (typeof scripts[name] !== "string" || !scripts[name].trim()) missing.push(name);
  }
  if (missing.length) {
    fail(checks, "PUBLIC-API-FALLBACK-COVERAGE", `package.json fallback scripts missing for the contract-test resolution order: ${missing.join(", ")}.`);
  } else {
    pass(checks, "PUBLIC-API-FALLBACK-COVERAGE");
  }
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const root = path.resolve(positional[0] ?? process.cwd());
  const startedAt = Date.now();
  const checks = [];
  checkExportSurface(checks, root);
  checkContractVersion(checks, root);
  checkResourceKinds(checks, root);
  checkOverviewShape(checks, root);
  checkServerRoutes(checks, root);
  checkUiContract(checks, root);
  checkProjectionBinding(checks, root);
  checkDimensionMapping(checks, root);
  checkFallbackCoverage(checks, root);
  const failures = checks.filter((check) => !check.ok);
  const nodeVersion = process.version;
  if (json) {
    const interactions = checks.map((check) => ({
      id: check.id,
      name: CHECK_NAMES[check.id] ?? check.id,
      status: check.ok ? "pass" : "fail",
      evidence: check.ok ? (CHECK_PASS_EVIDENCE[check.id] ?? "ok") : (check.message ?? "check failed")
    }));
    const payload = {
      version: EVIDENCE_SCHEMA_VERSION,
      tool: EVIDENCE_TOOL,
      ruleset: RULESET,
      root,
      node: nodeVersion,
      interactions,
      summary: {
        total: checks.length,
        passed: checks.length - failures.length,
        failed: failures.length,
        durationMs: Date.now() - startedAt
      }
    };
    // Drain-safe output: assign exitCode instead of calling process.exit()
    // immediately, so piped stdout is never truncated (console.log +
    // immediate exit can drop the write under pipe backpressure).
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = failures.length ? 1 : 0;
    return;
  }
  if (failures.length) {
    console.error(`PUBLIC_API_CONTRACT_FAILED: ${failures.map((check) => `${check.id}: ${check.message}`).join("; ")}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`PUBLIC_API_CONTRACT_PASS ${checks.length} checks (tool=node ${nodeVersion}, ruleset=${RULESET}).\n`);
}

main();
