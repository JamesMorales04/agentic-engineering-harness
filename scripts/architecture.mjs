#!/usr/bin/env node
/**
 * Project-specific architecture validator for AEH/Home invariants.
 *
 * Ports the S13 governed-fixture pattern (tests/packed/s13GovernedOperationCampaign.mjs
 * scripts/architecture.mjs: a real export-surface check plus a directional
 * module-boundary check that fails closed instead of weakening) to the AEH
 * checkout itself. Every check below is deterministic, uses only Node
 * builtins, and encodes an invariant the Harness relies on:
 *
 * - the impact-review dimension vocabulary and its dimension->kind mapping
 *   (src/architecture/candidateAssurance.ts), which the validation resolver
 *   and the candidate-assurance compiler consume;
 * - the deterministic-core independence (src/architecture/** never imports
 *   agent runtimes), which keeps model reasoning from granting authority or
 *   selecting tools;
 * - the requirement schema carrying no command selector (the Planner names
 *   requirements, never executables);
 * - review assignments staying reviewer-owned and independent from validation
 *   actions (candidateAssurance.ts reviewer selection);
 * - the Home layering (projects/ registry independent of the control-center
 *   server; the Home/Control Center entry surface intact);
 * - the resolver fallback coverage (package.json scripts the resolution order
 *   falls back to) and the toolchain pin coherence the security validators
 *   depend on.
 *
 * Usage: `node scripts/architecture.mjs [root]` (root defaults to cwd).
 * Prints ARCHITECTURE_PASS on success, ARCHITECTURE_FAILED otherwise.
 */
import fs from "node:fs";
import path from "node:path";

const RULESET = "aeh-architecture-v1";

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

function runtimeExports(source) {
  const names = [];
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/gm)) {
    names.push(match[1]);
  }
  return names.sort();
}

function checkExportSurface(checks, root) {
  const assurance = read(root, "src/architecture/candidateAssurance.ts");
  const requirements = read(root, "src/architecture/validationRequirements.ts");
  if (assurance === undefined || requirements === undefined) {
    fail(checks, "ARCH-EXPORT-SURFACE", "src/architecture/candidateAssurance.ts and src/architecture/validationRequirements.ts must both exist.");
    return;
  }
  const expectedAssurance = [
    "CANDIDATE_ASSURANCE_VERSION",
    "candidateAssuranceProviderAdapterV1",
    "candidateImpactValidationRequirementsV1",
    "candidateReviewDimensionValues",
    "compileCandidateAssuranceV1"
  ].sort();
  const observedAssurance = runtimeExports(assurance);
  if (JSON.stringify(observedAssurance) !== JSON.stringify(expectedAssurance)) {
    fail(checks, "ARCH-EXPORT-SURFACE", `candidateAssurance.ts public export surface is [${observedAssurance.join(",")}] but must be [${expectedAssurance.join(",")}].`);
  } else {
    pass(checks, "ARCH-EXPORT-SURFACE");
  }
  const expectedRequirements = [
    "configuredValidationKindForCheckV1",
    "contractValidationRequirementsV1",
    "dropUnresolvablePlanValidationRequirementsV1",
    "mergeContractValidationRequirementsV1",
    "resolveValidationRequirements",
    "validationRequirementKindValues",
    "validationRequirementSchema"
  ].sort();
  const observedRequirements = runtimeExports(requirements);
  if (JSON.stringify(observedRequirements) !== JSON.stringify(expectedRequirements)) {
    fail(checks, "ARCH-EXPORT-SURFACE-REQUIREMENTS", `validationRequirements.ts public export surface is [${observedRequirements.join(",")}] but must be [${expectedRequirements.join(",")}].`);
  } else {
    pass(checks, "ARCH-EXPORT-SURFACE-REQUIREMENTS");
  }
}

function checkDimensionVocabulary(checks, root) {
  const source = read(root, "src/architecture/candidateAssurance.ts");
  if (source === undefined) {
    fail(checks, "ARCH-DIMENSION-VOCABULARY", "src/architecture/candidateAssurance.ts is missing.");
    return;
  }
  const expected = [
    "security",
    "authentication/authorization",
    "public API",
    "migration/schema",
    "dependency/supply chain",
    "UI/browser",
    "UI/visual",
    "architecture",
    "concurrency",
    "operations",
    "behavior.correctness"
  ];
  const block = source.match(/candidateReviewDimensionValues\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!block) {
    fail(checks, "ARCH-DIMENSION-VOCABULARY", "candidateReviewDimensionValues declaration not found.");
    return;
  }
  const observed = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    fail(checks, "ARCH-DIMENSION-VOCABULARY", `impact-review dimension vocabulary is [${observed.join(", ")}] but must be [${expected.join(", ")}].`);
  } else {
    pass(checks, "ARCH-DIMENSION-VOCABULARY");
  }
  const mappings = [
    ['security: { kind: "static-security", floor: "CRITICAL" }', "security->static-security/CRITICAL"],
    ['"dependency/supply chain": { kind: "dependency-security", floor: "CRITICAL" }', "dependency/supply chain->dependency-security/CRITICAL"],
    ['architecture: { kind: "architecture", floor: "ELEVATED" }', "architecture->architecture/ELEVATED"]
  ];
  const missing = mappings.filter(([snippet]) => !source.includes(snippet)).map(([, label]) => label);
  if (missing.length) {
    fail(checks, "ARCH-DIMENSION-KIND-MAPPING", `dimension->kind mappings changed or missing: ${missing.join(", ")}.`);
  } else {
    pass(checks, "ARCH-DIMENSION-KIND-MAPPING");
  }
}

function checkRequirementSchema(checks, root) {
  const source = read(root, "src/architecture/validationRequirements.ts");
  if (source === undefined) {
    fail(checks, "ARCH-REQUIREMENT-SCHEMA-NO-COMMAND", "src/architecture/validationRequirements.ts is missing.");
    return;
  }
  const block = source.match(/validationRequirementSchema\s*=\s*z\.object\(\{([\s\S]*?)\}\)\.strict\(\)/);
  if (!block) {
    fail(checks, "ARCH-REQUIREMENT-SCHEMA-NO-COMMAND", "validationRequirementSchema strict object declaration not found.");
    return;
  }
  if (/\bcommand\b/i.test(block[1])) {
    fail(checks, "ARCH-REQUIREMENT-SCHEMA-NO-COMMAND", "validationRequirementSchema must not carry a command selector: the model names requirements, never executables.");
  } else {
    pass(checks, "ARCH-REQUIREMENT-SCHEMA-NO-COMMAND");
  }
  if (!/[Mm]odel[\s\S]{0,400}cannot select an executable command/.test(source)) {
    fail(checks, "ARCH-RESOLVER-AUTHORITY-GUARD", "resolveValidationRequirements must retain the documented barrier that model output cannot select commands, providers, tools or credentials.");
  } else {
    pass(checks, "ARCH-RESOLVER-AUTHORITY-GUARD");
  }
}

function listSourceFiles(dir, relativeBase) {
  const output = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      output.push(...listSourceFiles(absolute, relativeBase));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      output.push(path.relative(relativeBase, absolute));
    }
  }
  return output;
}

function checkDeterministicCoreIndependence(checks, root) {
  const dir = path.join(root, "src", "architecture");
  if (!fs.existsSync(dir)) {
    fail(checks, "ARCH-DETERMINISTIC-CORE-INDEPENDENCE", "src/architecture/ is missing.");
    return;
  }
  const forbidden = ["src/agents/", "src/workers/", "src/paseo/"];
  const violations = [];
  for (const relative of listSourceFiles(dir, root)) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier.endsWith(".js") && !specifier.endsWith(".ts")) continue;
      const target = path.normalize(path.join(path.dirname(relative), specifier)).replace(/\.js$/, ".ts");
      const normalized = target.split(path.sep).join("/");
      if (forbidden.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
        violations.push(`${relative} -> ${normalized}`);
      }
    }
  }
  if (violations.length) {
    fail(checks, "ARCH-DETERMINISTIC-CORE-INDEPENDENCE", `deterministic architecture core must not import agent runtimes: ${violations.sort().join("; ")}.`);
  } else {
    pass(checks, "ARCH-DETERMINISTIC-CORE-INDEPENDENCE");
  }
}

function checkReviewIndependence(checks, root) {
  const source = read(root, "src/architecture/candidateAssurance.ts");
  if (source === undefined) {
    fail(checks, "ARCH-REVIEW-INDEPENDENCE", "src/architecture/candidateAssurance.ts is missing.");
    return;
  }
  const guards = [
    'candidate.role !== "Reviewer" || candidate.readOnly !== true',
    "identity === implementer",
    "INDEPENDENT_REVIEW_DIVERSITY_UNSATISFIED",
    "INDEPENDENT_REVIEW_UNSATISFIED"
  ];
  const missing = guards.filter((snippet) => !source.includes(snippet));
  if (missing.length) {
    fail(checks, "ARCH-REVIEW-INDEPENDENCE", `reviewer selection lost required independence guards: ${missing.join("; ")}.`);
  } else {
    pass(checks, "ARCH-REVIEW-INDEPENDENCE");
  }
}

function checkHomeLayering(checks, root) {
  const projectsDir = path.join(root, "src", "projects");
  const entry = read(root, "src/entry.ts");
  const registry = read(root, "src/projects/registry.ts");
  const server = read(root, "src/control-center/server.ts");
  if (!fs.existsSync(projectsDir) || entry === undefined || registry === undefined || server === undefined) {
    fail(checks, "ARCH-HOME-LAYERING", "Home surface files (src/entry.ts, src/projects/registry.ts, src/control-center/server.ts) must all exist.");
    return;
  }
  const violations = [];
  for (const relative of listSourceFiles(projectsDir, root)) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const target = path.normalize(path.join(path.dirname(relative), match[1])).split(path.sep).join("/");
      if (target === "src/control-center" || target.startsWith("src/control-center/")) {
        violations.push(`${relative} -> ${target}`);
      }
    }
  }
  if (violations.length) {
    fail(checks, "ARCH-HOME-LAYERING", `projects/ registry must not depend on the control-center server: ${violations.sort().join("; ")}.`);
  } else {
    pass(checks, "ARCH-HOME-LAYERING");
  }
  const surface = [
    ['if (args[0] === "home")', "entry.ts home command"],
    ["AEH Home ready at", "Home ready announcement"],
    ["project_", "project_ identity prefix"],
    [/csrf/i.test(server), "control-center CSRF/pairing reference"]
  ];
  const missing = surface.filter(([snippet]) => typeof snippet === "string" ? !(entry.includes(snippet) || registry.includes(snippet)) : !snippet).map(([, label]) => label);
  if (missing.length) {
    fail(checks, "ARCH-HOME-SURFACE", `Home entry surface regressed: ${missing.join(", ")}.`);
  } else {
    pass(checks, "ARCH-HOME-SURFACE");
  }
}

function checkResolverFallbackCoverage(checks, root) {
  const raw = read(root, "package.json");
  if (raw === undefined) {
    fail(checks, "ARCH-RESOLVER-FALLBACK-COVERAGE", "package.json is missing.");
    return;
  }
  const scripts = JSON.parse(raw).scripts ?? {};
  const missing = [];
  for (const name of ["architecture", "check:architecture"]) {
    if (typeof scripts[name] !== "string" || !scripts[name].trim()) missing.push(name);
  }
  if (!["audit", "security:dependencies"].some((name) => typeof scripts[name] === "string" && scripts[name].trim())) {
    missing.push("audit|security:dependencies");
  }
  if (!["security", "lint", "check"].some((name) => typeof scripts[name] === "string" && scripts[name].trim())) {
    missing.push("security|lint|check");
  }
  if (missing.length) {
    fail(checks, "ARCH-RESOLVER-FALLBACK-COVERAGE", `package.json fallback scripts missing for the resolution order: ${missing.join(", ")}.`);
  } else {
    pass(checks, "ARCH-RESOLVER-FALLBACK-COVERAGE");
  }
}

function readJson(root, relative) {
  const text = read(root, relative);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readYamlVersion(root, relative, tool) {
  const text = read(root, relative);
  if (text === undefined) return undefined;
  const match = text.match(new RegExp(`^\\s*${tool}:\\s*\\{[^}]*?version:\\s*"([^"]+)"`, "m"));
  if (match) return match[1];
  const block = text.match(new RegExp(`^\\s*${tool}:\\s*\\n((?:^\\s+.*\\n)+)`, "m"));
  if (block) {
    const version = block[1].match(/version:\s*"([^"]+)"/);
    if (version) return version[1];
  }
  return undefined;
}

function checkToolchainPinCoherence(checks, root) {
  const versions = readJson(root, "templates/provider-versions.json");
  const templateTrivy = readYamlVersion(root, "templates/toolchain.yaml", "trivy");
  const templateOpengrep = readYamlVersion(root, "templates/toolchain.yaml", "opengrep");
  const overlayTrivy = readYamlVersion(root, ".harness/toolchain.yaml", "trivy");
  const overlayOpengrep = readYamlVersion(root, ".harness/toolchain.yaml", "opengrep");
  const pins = readJson(root, "policies/opengrep/pins.json");
  if (!versions || templateTrivy === undefined || templateOpengrep === undefined || overlayTrivy === undefined || overlayOpengrep === undefined || !pins) {
    fail(checks, "ARCH-TOOLCHAIN-PIN-COHERENCE", "toolchain pin sources (templates/provider-versions.json, templates/toolchain.yaml, .harness/toolchain.yaml, policies/opengrep/pins.json) must all exist and parse.");
    return;
  }
  const problems = [];
  if (versions.trivy !== templateTrivy || versions.trivy !== overlayTrivy) {
    problems.push(`trivy pin diverged (provider-versions=${versions.trivy}, template=${templateTrivy}, overlay=${overlayTrivy})`);
  }
  if (versions.opengrep !== templateOpengrep || versions.opengrep !== overlayOpengrep) {
    problems.push(`opengrep pin diverged (provider-versions=${versions.opengrep}, template=${templateOpengrep}, overlay=${overlayOpengrep})`);
  }
  if (pins.tool !== versions.opengrep) {
    problems.push(`opengrep ruleset pins tool '${pins.tool}' but provider-versions pins '${versions.opengrep}'`);
  }
  if (problems.length) {
    fail(checks, "ARCH-TOOLCHAIN-PIN-COHERENCE", problems.join("; "));
  } else {
    pass(checks, "ARCH-TOOLCHAIN-PIN-COHERENCE");
  }
}

function main() {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const checks = [];
  checkExportSurface(checks, root);
  checkDimensionVocabulary(checks, root);
  checkRequirementSchema(checks, root);
  checkDeterministicCoreIndependence(checks, root);
  checkReviewIndependence(checks, root);
  checkHomeLayering(checks, root);
  checkResolverFallbackCoverage(checks, root);
  checkToolchainPinCoherence(checks, root);
  const failures = checks.filter((check) => !check.ok);
  const nodeVersion = process.version;
  if (failures.length) {
    console.error(`ARCHITECTURE_FAILED: ${failures.map((check) => `${check.id}: ${check.message}`).join("; ")}`);
    process.exit(1);
  }
  console.log(`ARCHITECTURE_PASS ${checks.length} checks (tool=node ${nodeVersion}, ruleset=${RULESET}).`);
}

main();
