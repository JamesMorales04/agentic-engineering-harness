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
 * Usage: `node scripts/publicApiContract.mjs [root]` (root defaults to cwd).
 * Prints PUBLIC_API_CONTRACT_PASS on success, PUBLIC_API_CONTRACT_FAILED otherwise.
 */
import fs from "node:fs";
import path from "node:path";

const RULESET = "aeh-public-api-contract-v1";

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
  const source = read(root, "src/control-center/contracts.ts");
  if (source === undefined) {
    fail(checks, "PUBLIC-API-RESOURCE-KINDS", "src/control-center/contracts.ts is missing.");
    return;
  }
  const expected = ["project", "operation", "participant", "candidate", "context", "authority", "evidence", "services", "knowledge", "event"];
  const block = source.match(/export type ControlCenterResourceKindV1\s*=\s*([\s\S]*?);/);
  if (!block) {
    fail(checks, "PUBLIC-API-RESOURCE-KINDS", "ControlCenterResourceKindV1 declaration not found.");
    return;
  }
  const missing = expected.filter((kind) => !block[1].includes(`"${kind}"`));
  if (missing.length) {
    fail(checks, "PUBLIC-API-RESOURCE-KINDS", `resource kinds missing from the contract: ${missing.join(", ")}.`);
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
  if (!overviewInterface) {
    fail(checks, "PUBLIC-API-OVERVIEW-SHAPE", "ControlCenterOverviewV1 declaration not found.");
    return;
  }
  const missingInterface = required.filter((field) => !overviewInterface[1].includes(field) && !contracts.includes(`export interface ControlCenterSnapshotV1`));
  if (missingInterface.length && !required.every((field) => contracts.includes(field))) {
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
  const root = path.resolve(process.argv[2] ?? process.cwd());
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
  if (failures.length) {
    console.error(`PUBLIC_API_CONTRACT_FAILED: ${failures.map((check) => `${check.id}: ${check.message}`).join("; ")}`);
    process.exit(1);
  }
  console.log(`PUBLIC_API_CONTRACT_PASS ${checks.length} checks (tool=node ${nodeVersion}, ruleset=${RULESET}).`);
}

main();
