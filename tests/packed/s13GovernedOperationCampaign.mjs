import crypto from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { harnessRevisionV1 } from "./s13CampaignHarnessRevision.mjs";
import { accountWorkspaceCleanupV1, workspaceArchiveDecision } from "./s13GovernedCampaignPolicy.mjs";
import { assertIsolatedPaseoEnv, setupIsolatedPaseoHome, teardownIsolatedPaseoHome } from "./paseoIsolatedHome.mjs";

/**
 * S13 packed governed-operation campaign.
 *
 * Runs a real packed candidate's canonical `operation start` control path inside a disposable
 * fixture with REAL Paseo participants and a REAL local model (no AEH_DETERMINISTIC_PASEO_RUNTIME,
 * no scripted provider boundary). A deterministic oracle then verifies the durable operation record,
 * candidate revision, participant receipts, validation evidence and acceptance artifacts.
 *
 * P-NEW-4 hermetic isolation: every Paseo resource in this campaign (lead agents,
 * participant sessions, operation workspaces) lives in a temporary isolated
 * daemon home (fresh `PASEO_HOME` + free loopback port + `PASEO_DAEMON_URL`),
 * never in the live daemon. Teardown deletes residual agents, archives residual
 * workspaces, stops the isolated daemon and removes the temp home on
 * success/failure/abort. Setup failure throws `PASEO_ISOLATION_UNAVAILABLE`
 * and the run fails closed (never live).
 *
 * Usage: node tests/packed/s13GovernedOperationCampaign.mjs [checkout]
 * Optional: S13_GOV_LANES=audit,change-direct  S13_GOV_TIMEOUT_SECONDS=900  S13_GOV_KEEP=1
 */

const checkout = path.resolve(process.argv[2] ?? process.cwd());
const round = Number(process.env.S13_ROUND ?? "0");
if (!Number.isSafeInteger(round) || round < 1) throw new Error("S13_ROUND must be a positive integer.");
const runId = (process.env.S13_RUN_ID ?? `run-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${crypto.randomBytes(3).toString("hex")}`).trim();
if (!/^[A-Za-z0-9-]{1,80}$/.test(runId)) throw new Error("S13_RUN_ID must contain only letters, digits, and hyphens.");
const laneFilter = (process.env.S13_GOV_LANES ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const laneTimeoutSeconds = Number(process.env.S13_GOV_TIMEOUT_SECONDS ?? "900");
// Round 16: the canonical FORMAL_SDD path (Explorer + Spec Manager + OpenSpec compilation +
// Planner + implementation + independent review + supervisor consolidation) and the cold
// candidate-drift supervisor rotation barrier can legitimately exceed 900 s. The bound stays
// explicit and per-lane; a run that exceeds its declared bound is classified FAIL (`timeout: true`)
// and a late terminal is recorded separately, never presented as a clean bounded result.
// Round 23: the repair forcing geometry adds a full remediation cycle on top of the canonical
// change stages, so preceding stages consume ~22 min before review; the observed review provider
// turn is 10-15 min (r22-gov-3 and r23-gov-6). The cap is raised to 3600 s so a repair rerun can
// declare a bound that accounts for the observed review latency without weakening the
// FAIL-on-exceeded-bound rule.
if (!Number.isSafeInteger(laneTimeoutSeconds) || laneTimeoutSeconds < 1 || laneTimeoutSeconds > 3600) throw new Error("S13_GOV_TIMEOUT_SECONDS must be an integer from 1 through 3600.");
const keepStaging = process.env.S13_GOV_KEEP === "1";
const archiveEvidence = process.env.S13_GOV_ARCHIVE_EVIDENCE === "1";
const debug = process.env.S13_GOV_DEBUG === "1";
const prepareOnly = process.env.S13_GOV_PREPARE_ONLY === "1";

// P-NEW-4: hermetic isolation before any fixture/paseo work. Lane children
// inherit the isolated daemon via laneEnvironment().
const paseoIsolation = await setupIsolatedPaseoHome({ prefix: "aeh-s13-gov-" });
assertIsolatedPaseoEnv(paseoIsolation);

const dist = path.join(checkout, "dist");
const releaseId = (await fs.readFile(path.join(dist, "current"), "utf8")).trim();
const release = path.join(dist, "releases", releaseId);
const certify = await import(pathToFileURL(path.join(release, "certification", "index.js")));
const gitModule = await import(pathToFileURL(path.join(release, "core", "git.js")));
const buildIdentity = (await import(pathToFileURL(path.join(release, "build", "identity.js")))).getBuildIdentity();

const staging = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s13-gov-"));
const evidenceRoot = path.join(checkout, "docs", "evidence", "s13");
const laneRoot = path.join(staging, "lanes");
const workRoot = path.join(staging, "work");
await fs.mkdir(laneRoot, { recursive: true });
await fs.mkdir(workRoot, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeoutMs ?? 60_000, cwd: options.cwd ?? checkout, env: options.env ?? process.env, maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim(), error: result.error ? String(result.error) : undefined };
}

function runShell(command, options = {}) {
  return run("/bin/bash", ["-lc", command], options);
}

async function trackedDigest() {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: checkout, maxBuffer: 64 * 1024 * 1024 }).toString().split("\0").filter(Boolean).sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(`path\0${file}\0`);
    hash.update(await fs.readFile(path.join(checkout, file)));
  }
  return { digest: hash.digest("hex"), files: files.length };
}

function sanitizeString(value) {
  return value
    .replace(/#pair=[^\s"'\\]+/g, "#pair=REDACTED")
    .replace(/controlCenterPairing=[^\s"'\\]+/g, "controlCenterPairing=REDACTED")
    .replace(/([?&](?:token|code|nonce|csrf)=)[^\s"'\\&]+/gi, "$1REDACTED")
    .replace(/gho_[A-Za-z0-9]+/g, "gho_REDACTED")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_REDACTED");
}

function sanitizeEvidence(value) {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeEvidence(item)]));
  return value;
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return undefined; }
}

function operationFile(fixtureRoot, operationId) {
  return path.join(fixtureRoot, ".harness", "operations", `${operationId}.json`);
}

async function paseoAgents() {
  const listed = run("paseo", ["agent", "ls", "--json"], { timeoutMs: 60_000 });
  try { return JSON.parse(listed.stdout); } catch { return []; }
}

async function paseoWorkspaces() {
  const listed = run("paseo", ["workspace", "ls", "--json"], { timeoutMs: 60_000 });
  try { return JSON.parse(listed.stdout); } catch { return []; }
}

function agentIdOf(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-/.test(value) ? value : undefined;
}

function inspectAgent(agentId) {
  const inspected = run("paseo", ["agent", "inspect", agentId, "--json"], { timeoutMs: 30_000 });
  let snapshot;
  try { const parsed = JSON.parse(inspected.stdout); snapshot = parsed.agent ?? parsed.snapshot ?? parsed; } catch { snapshot = undefined; }
  const pick = (...keys) => { for (const key of keys) if (snapshot && snapshot[key] !== undefined) return snapshot[key]; return null; };
  return {
    agentId,
    inspectExitCode: inspected.status,
    provider: pick("provider", "Provider"),
    model: pick("model", "Model"),
    thinkingOptionId: pick("thinkingOptionId", "Thinking"),
    status: pick("status", "Status"),
    sessionId: pick("sessionId", "SessionId"),
    modeId: pick("currentModeId", "Mode"),
    lastUsage: pick("lastUsage", "LastUsage", "usage"),
    labels: pick("labels", "Labels"),
    createdAt: pick("createdAt", "CreatedAt"),
    updatedAt: pick("updatedAt", "UpdatedAt")
  };
}

// -------------------------------------------------------------------------------------------------
// Fixture construction
// -------------------------------------------------------------------------------------------------

const FIXTURE_SETUP = [
  { command: "git", args: ["init", "-q", "-b", "master"] },
  { command: "git", args: ["config", "core.fsmonitor", "false"] },
  { command: "git", args: ["config", "user.email", "s13-gov@aeh.invalid"] },
  { command: "git", args: ["config", "user.name", "S13 Governed Campaign"] }
];

async function writeFixtureSource(kind) {
  const source = path.join(workRoot, `fixture-source-${kind}`);
  await fs.rm(source, { recursive: true, force: true });
  await fs.mkdir(path.join(source, "src"), { recursive: true });
  await fs.mkdir(path.join(source, "scripts"), { recursive: true });

  // Round-18 multi-worker/distributed fixtures: two separable deliverables (a `farewell` module
  // and a `FAREWELL` export) that the frozen Planner can decompose into a multi-unit task DAG.
  const multiUnit = kind === "multi-worker" || kind === "distributed";
  const repairForced = kind === "repair";
  const requiresFarewell = kind === "change" || kind === "change-formal" || kind === "change-multifile" || multiUnit;
  await fs.writeFile(path.join(source, "package.json"), `${JSON.stringify({ name: `s13-gov-${kind}`, version: "1.0.0", private: true, scripts: { test: "node scripts/validate.mjs", "check:architecture": "node scripts/architecture.mjs" } }, null, 2)}\n`);
  await fs.writeFile(path.join(source, ".gitignore"), "node_modules/\ndist/\n\n# BEGIN Agentic Engineering Harness generated state\n.harness/*\n!.harness/project.yaml\n!.harness/toolchain.yaml\n!.harness/provider-versions.json\n!.harness/agents.source.jsonc\n!.harness/otel-collector.yaml\n# END Agentic Engineering Harness generated state\n");
  await fs.writeFile(path.join(source, "src", "greeting.mjs"), [
    "export function greet(name) {",
    "  return `Hello, ${name}!`;",
    "}",
    ""
  ].join("\n"));
  await fs.writeFile(path.join(source, "scripts", "validate.mjs"), [
    "import { greet } from \"../src/greeting.mjs\";",
    "",
    "const failures = [];",
    "if (typeof greet !== \"function\" || greet(\"AEH\") !== \"Hello, AEH!\") failures.push(\"greet contract\");",
    ...(requiresFarewell ? [
      "let module;",
      "try { module = await import(\"../src/greeting.mjs\"); } catch (error) { failures.push(`module load: ${error.message}`); }",
      "if (!failures.length && module.FAREWELL !== \"bye\") failures.push(\"FAREWELL export\");"
    ] : []),
    "if (failures.length) {",
    "  console.error(`VALIDATION_FAILED: ${failures.join(\"; \")}`);",
    "  process.exit(1);",
    "}",
    "console.log(\"VALIDATION_PASS\");",
    ""
  ].join("\n"));
  await fs.writeFile(path.join(source, "scripts", "contract.mjs"), [
    "import { greet } from \"../src/greeting.mjs\";",
    "",
    "const failures = [];",
    "if (typeof greet !== \"function\") failures.push(\"greet export contract\");",
    "if (typeof greet === \"function\" && greet(\"AEH\") !== \"Hello, AEH!\") failures.push(\"greet behavior contract\");",
    ...(requiresFarewell ? [
      "let module;",
      "try { module = await import(\"../src/greeting.mjs\"); } catch (error) { failures.push(`module load: ${error.message}`); }",
      "if (!failures.length && typeof module.FAREWELL !== \"string\") failures.push(\"FAREWELL export contract\");",
      "if (!failures.length && module.FAREWELL !== \"bye\") failures.push(\"FAREWELL value contract\");"
    ] : []),
    "import(\"../src/greeting.mjs\").then((moduleValue) => {",
    "  if (Object.keys(moduleValue).some((key) => ![\"greet\", \"FAREWELL\"].includes(key))) failures.push(\"unexpected public export\");",
    "  if (failures.length) {",
    "    console.error(`CONTRACT_FAILED: ${failures.join(\"; \")}`);",
    "    process.exit(1);",
    "  }",
    "  console.log(\"CONTRACT_PASS\");",
    "});",
    ""
  ].join("\n"));
  await fs.writeFile(path.join(source, "scripts", "architecture.mjs"), [
    "import fs from \"node:fs\";",
    "",
    "const failures = [];",
    "const read = (file) => { try { return fs.readFileSync(file, \"utf8\"); } catch { return undefined; } };",
    "const greeting = read(\"src/greeting.mjs\");",
    `const expectedExports = ${JSON.stringify(["greet", ...(requiresFarewell ? ["FAREWELL"] : [])].sort())};`,
    "if (greeting === undefined) failures.push(\"src/greeting.mjs missing\");",
    "if (greeting !== undefined) {",
    "  const exported = [...greeting.matchAll(/export\\s+(?:const|function|class)\\s+([A-Za-z0-9_$]+)/g)].map((match) => match[1]).sort();",
    "  if (JSON.stringify(exported) !== JSON.stringify(expectedExports)) failures.push(`greeting public export surface ${exported.join(\",\")}`);",
    "  const format = read(\"src/format.mjs\");",
    "  if (format !== undefined) {",
    "    if (!/from\\s+[\"']\\.\\/format\\.mjs[\"']/.test(greeting)) failures.push(\"greeting must import the extracted format module\");",
    "    if (/from\\s+[\"']\\.\\/greeting\\.mjs[\"']/.test(format)) failures.push(\"format must not import greeting (module cycle)\");",
    "  }",
    "}",
    "if (failures.length) {",
    "  console.error(`ARCHITECTURE_FAILED: ${failures.join(\"; \")}`);",
    "  process.exit(1);",
    "}",
    "console.log(\"ARCHITECTURE_PASS\");",
    ""
  ].join("\n"));
  await fs.writeFile(path.join(source, "README.md"), [
    `# S13 governed fixture (${kind})`,
    "",
    "Disposable certification fixture. `scripts/validate.mjs`, `scripts/contract.mjs` and `scripts/architecture.mjs` are real validation commands.",
    ""
  ].join("\n"));
  if (repairForced) {
    // Round-19 forcing fixture: the deterministic first-pass failure lives in src/config.mjs, which
    // is inside the frozen contract scope (the canonical Repairer is authorized to repair it) but
    // outside every planner work-unit scope (the request documents only src/greeting.mjs and
    // src/farewell.mjs), so the implementer turns cannot remove the failure within their scope.
    // Round 23: the fixture no longer seeds src/format.mjs. That file existed only to populate the
    // wildcard scope, but scripts/architecture.mjs then requires src/greeting.mjs to import it,
    // creating a latent out-of-contract failure the Reviewer can (and did) deliberate over
    // indefinitely (r23-gov-6). The FAREWELL config defect alone forces the repair geometry.
    await fs.writeFile(path.join(source, "src", "farewell.mjs"), [
      "export function farewell(name) {",
      "  return `Goodbye, ${name}!`;",
      "}",
      ""
    ].join("\n"));
    await fs.writeFile(path.join(source, "src", "config.mjs"), [
      "export const FAREWELL = \"goodbye\";",
      ""
    ].join("\n"));
    await fs.writeFile(path.join(source, "src", "index.mjs"), [
      "export const MODULE_NAME = \"greeting\";",
      ""
    ].join("\n"));
    await fs.writeFile(path.join(source, "src", "constants.mjs"), [
      "export const GREETING_PREFIX = \"Hello\";",
      ""
    ].join("\n"));
    await fs.writeFile(path.join(source, "scripts", "validate.mjs"), [
      "import { greet } from \"../src/greeting.mjs\";",
      "import { FAREWELL } from \"../src/config.mjs\";",
      "",
      "const failures = [];",
      "if (typeof greet !== \"function\" || greet(\"AEH\") !== \"Hello, AEH!\") failures.push(\"greet contract\");",
      "if (FAREWELL !== \"bye\") failures.push(\"FAREWELL constant contract\");",
      "let farewell;",
      "try { farewell = await import(\"../src/farewell.mjs\"); } catch (error) { failures.push(`farewell module: ${error.message}`); }",
      "if (farewell && (typeof farewell.farewell !== \"function\" || farewell.farewell(\"AEH\") !== \"Goodbye, AEH!\")) failures.push(\"farewell contract\");",
      "if (failures.length) {",
      "  console.error(`VALIDATION_FAILED: ${failures.join(\"; \")}`);",
      "  process.exit(1);",
      "}",
      "console.log(\"VALIDATION_PASS\");",
      ""
    ].join("\n"));
    await fs.writeFile(path.join(source, "scripts", "contract.mjs"), [
      "import { greet } from \"../src/greeting.mjs\";",
      "import { FAREWELL } from \"../src/config.mjs\";",
      "",
      "const failures = [];",
      "if (typeof greet !== \"function\" || greet(\"AEH\") !== \"Hello, AEH!\") failures.push(\"greet contract\");",
      "if (FAREWELL !== \"bye\") failures.push(\"FAREWELL constant contract\");",
      "const greeting = await import(\"../src/greeting.mjs\");",
      "if (Object.keys(greeting).sort().join(\",\") !== \"greet\") failures.push(\"greeting public export surface contract\");",
      "const farewell = await import(\"../src/farewell.mjs\");",
      "if (typeof farewell.farewell !== \"function\" || farewell.farewell(\"AEH\") !== \"Goodbye, AEH!\") failures.push(\"farewell behavior contract\");",
      "if (failures.length) {",
      "  console.error(`CONTRACT_FAILED: ${failures.join(\"; \")}`);",
      "  process.exit(1);",
      "}",
      "console.log(\"CONTRACT_PASS\");",
      ""
    ].join("\n"));
  }
  if (multiUnit) {
    // Two validators spanning two files give the frozen Planner a genuine two-deliverable task.
    await fs.writeFile(path.join(source, "scripts", "validate.mjs"), [
      "import { greet } from \"../src/greeting.mjs\";",
      "",
      "const failures = [];",
      "if (typeof greet !== \"function\" || greet(\"AEH\") !== \"Hello, AEH!\") failures.push(\"greet contract\");",
      "let greeting;",
      "try { greeting = await import(\"../src/greeting.mjs\"); } catch (error) { failures.push(`greeting module: ${error.message}`); }",
      "if (greeting && greeting.FAREWELL !== \"bye\") failures.push(\"FAREWELL export\");",
      "let farewell;",
      "try { farewell = await import(\"../src/farewell.mjs\"); } catch (error) { failures.push(`farewell module: ${error.message}`); }",
      "if (farewell && (typeof farewell.farewell !== \"function\" || farewell.farewell(\"AEH\") !== \"Goodbye, AEH!\")) failures.push(\"farewell contract\");",
      "if (failures.length) {",
      "  console.error(`VALIDATION_FAILED: ${failures.join(\"; \")}`);",
      "  process.exit(1);",
      "}",
      "console.log(\"VALIDATION_PASS\");",
      ""
    ].join("\n"));
    await fs.writeFile(path.join(source, "scripts", "contract.mjs"), [
      "import { greet } from \"../src/greeting.mjs\";",
      "",
      "const failures = [];",
      "if (typeof greet !== \"function\" || greet(\"AEH\") !== \"Hello, AEH!\") failures.push(\"greet contract\");",
      "const greeting = await import(\"../src/greeting.mjs\");",
      "const greetingExports = Object.keys(greeting).sort().join(\",\");",
      "if (greetingExports !== \"FAREWELL,greet\") failures.push(`greeting public export surface ${greetingExports}`);",
      "const farewell = await import(\"../src/farewell.mjs\");",
      "const farewellExports = Object.keys(farewell).sort().join(\",\");",
      "if (farewellExports !== \"farewell\") failures.push(`farewell public export surface ${farewellExports}`);",
      "if (typeof farewell.farewell !== \"function\" || farewell.farewell(\"AEH\") !== \"Goodbye, AEH!\") failures.push(\"farewell behavior contract\");",
      "if (failures.length) {",
      "  console.error(`CONTRACT_FAILED: ${failures.join(\"; \")}`);",
      "  process.exit(1);",
      "}",
      "console.log(\"CONTRACT_PASS\");",
      ""
    ].join("\n"));
  }
  return source;
}

function parsePackFilename(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== "[") continue;
    try {
      const parsed = JSON.parse(lines.slice(index).join("\n"));
      const record = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
      if (record && typeof record.filename === "string" && record.filename.endsWith(".tgz") && path.basename(record.filename) === record.filename) return record.filename;
    } catch { /* keep scanning */ }
  }
  throw new Error("npm pack did not return a JSON artifact record.");
}

async function packCandidate() {
  const packDir = path.join(staging, "pack");
  await fs.mkdir(packDir, { recursive: true });
  const packed = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { timeoutMs: 600_000, cwd: checkout });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr || packed.stdout}`);
  const filename = parsePackFilename(packed.stdout);
  const artifactPath = path.join(packDir, filename);
  const artifactDigest = crypto.createHash("sha256").update(await fs.readFile(artifactPath)).digest("hex");
  return { artifactPath, artifactDigest, filename };
}

async function packedBuildIdentity(fixtureRoot) {
  const packageRoot = path.join(fixtureRoot, "node_modules", "agentic-engineering-harness");
  const distDir = path.join(packageRoot, "dist");
  const current = (await fs.readFile(path.join(distDir, "current"), "utf8").catch(() => "")).trim();
  if (!/^release-[A-Za-z0-9._-]+$/.test(current)) return {};
  const raw = await readJson(path.join(distDir, "releases", current, "build-identity.json"));
  return raw ? { releaseId: current, buildDigest: raw.buildDigest, gitSha: raw.gitSha, packageVersion: raw.packageVersion } : {};
}

async function fixtureProjectConfig(kind) {
  const config = YAML.parse(await fs.readFile(path.join(checkout, "templates", "project.yaml"), "utf8"));
  config.project = { ...(config.project ?? {}), name: `s13-gov-${kind}` };
  config.validation = {
    baseRef: "master",
    commands: [{ id: "fixture-greeting", command: "node scripts/validate.mjs", required: true, timeoutSeconds: 60 }],
    validators: [{ id: "contract-test", adapter: "contract-test", command: "node scripts/contract.mjs", required: true, timeoutSeconds: 60 }]
  };
  if (kind === "distributed") {
    // Round-18 distributed-execution lane: the wave executor dispatches work units to the
    // filesystem queue only when planning.distributed and the distributed provider are enabled.
    config.workflow = { ...(config.workflow ?? {}), planning: { ...(config.workflow?.planning ?? {}), distributed: true } };
    config.distributed = { enabled: true, provider: "filesystem", pollIntervalMs: 500, leaseSeconds: 1800 };
  }
  if (kind === "repair") {
    // The forcing defect is src/config.mjs; the validators are frozen so neither the implementer nor
    // the Repairer can satisfy the failure by weakening the checks.
    // Round 23: the repair fixture configures both checks as commands (no `contract-test` validator
    // adapter). The frozen contract binds each acceptance requirement to `command.<id>` check ids;
    // a Planner that names a configured validator id with kind `command` then collides with the
    // contract-derived adapter kind and the operation fails closed
    // (`VALIDATION_REQUIREMENT_ID_CONFLICT`, r23-gov-7). With command-kind checks only, a plan
    // requirement that names a configured check id agrees with the contract-derived kind and
    // merges; the failure set (both scripts fail on the seeded FAREWELL defect) and the repair
    // geometry are unchanged.
    config.validation = {
      baseRef: "master",
      commands: [
        { id: "fixture-greeting", command: "node scripts/validate.mjs", required: true, timeoutSeconds: 60 },
        { id: "fixture-contract", command: "node scripts/contract.mjs", required: true, timeoutSeconds: 60 }
      ],
      frozenPaths: ["scripts/validate.mjs", "scripts/contract.mjs"]
    };
  }
  return YAML.stringify(config);
}

async function prepareFixture(kind, candidate) {
  const fixtureRoot = path.join(workRoot, `lane-${kind}-fixture`);
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.cp(await writeFixtureSource(kind), fixtureRoot, { recursive: true, force: true });
  for (const setup of FIXTURE_SETUP) {
    const result = run(setup.command, setup.args, { cwd: fixtureRoot });
    if (result.status !== 0) throw new Error(`fixture setup failed: ${result.stderr || result.stdout}`);
  }
  const installed = run("npm", ["install", "--ignore-scripts", "--no-save", "--prefix", fixtureRoot, candidate.artifactPath], { timeoutMs: 600_000, cwd: fixtureRoot });
  if (installed.status !== 0) throw new Error(`fixture install failed: ${installed.stderr || installed.stdout}`);
  const initialized = run(process.execPath, [candidateBinary(fixtureRoot), "init", "."], { cwd: fixtureRoot, env: laneEnvironment(), timeoutMs: 300_000 });
  if (initialized.status !== 0) throw new Error(`fixture init failed: ${initialized.stderr || initialized.stdout}`);
  await fs.writeFile(path.join(fixtureRoot, ".harness", "project.yaml"), await fixtureProjectConfig(kind));
  const topologyOverride = brainTopologyOverride();
  if (topologyOverride) {
    const source = {
      version: 1,
      extends: ["aeh:orchestration"],
      activeProfile: "balanced",
      models: { brain: { runtime: topologyOverride.runtime, provider: topologyOverride.provider, model: topologyOverride.model } },
      agents: {},
      routing: [],
      remove: { agents: [], models: [], runtimes: [], profiles: [], routing: [], councils: [] }
    };
    await fs.writeFile(path.join(fixtureRoot, ".harness", "agents.source.jsonc"), `${JSON.stringify(source, null, 2)}\n`);
    // The generated topology must be recompiled after a source override or the deterministic
    // topology audit fails closed with `topology.generated-drift` before any participant runs.
    const compiled = run(process.execPath, [candidateBinary(fixtureRoot), "agents", "compile", "."], { cwd: fixtureRoot, env: laneEnvironment(), timeoutMs: 300_000 });
    if (compiled.status !== 0) throw new Error(`fixture agents compile failed: ${compiled.stderr || compiled.stdout}`);
  }
  const committed = runShell("git add -A && git commit -q -m 'fixture baseline'", { cwd: fixtureRoot });
  if (committed.status !== 0) throw new Error(`fixture commit failed: ${committed.stderr || committed.stdout}`);
  const commit = run("git", ["rev-parse", "HEAD"], { cwd: fixtureRoot }).stdout;
  if (kind === "distributed") {
    // The distributed worker clones `origin` at the frozen base ref; a local bare mirror keeps the
    // journey real without any external effect.
    const origin = path.join(workRoot, `origin-distributed-${runId}.git`);
    const bare = run("git", ["init", "-q", "--bare", origin], { cwd: workRoot });
    if (bare.status !== 0) throw new Error(`distributed origin init failed: ${bare.stderr || bare.stdout}`);
    const remote = run("git", ["remote", "add", "origin", origin], { cwd: fixtureRoot });
    if (remote.status !== 0) throw new Error(`distributed origin remote failed: ${remote.stderr || remote.stdout}`);
    const pushed = run("git", ["push", "-q", "origin", "HEAD:master"], { cwd: fixtureRoot });
    if (pushed.status !== 0) throw new Error(`distributed origin push failed: ${pushed.stderr || pushed.stdout}`);
  }
  const treeDigest = await gitModule.computeWorktreeDigest(fixtureRoot);
  const build = await packedBuildIdentity(fixtureRoot);
  return {
    root: fixtureRoot,
    commit,
    treeDigest,
    topologyOverride,
    candidateBinding: {
      packedArtifact: candidate.filename,
      packedArtifactDigest: candidate.artifactDigest,
      packedBuild: build,
      fixtureTreeDigest: treeDigest,
      fixtureCommit: commit
    }
  };
}

// -------------------------------------------------------------------------------------------------
// Operation execution
// -------------------------------------------------------------------------------------------------

function candidateBinary(fixtureRoot) {
  return path.join(fixtureRoot, "node_modules", "agentic-engineering-harness", "dist", "main.js");
}

/**
 * Round 23 fixture topology override. When `S13_GOV_BRAIN_*` is set, the disposable fixture's
 * `.harness/agents.source.jsonc` maps the `brain` model alias (lead, supervisor, planner, spec
 * manager, repairer) to the configured real runtime/provider/model. This exists because the
 * default `brain` alias requires the codex ChatGPT account, which can be hard-blocked by an
 * account usage limit while the opencode runtime remains available. The override is a documented
 * product surface (`templates/agents.source.jsonc` model-alias override) and is always recorded in
 * the lane evidence; it is never a silent substitution.
 */
function brainTopologyOverride() {
  const runtime = process.env.S13_GOV_BRAIN_RUNTIME?.trim();
  const provider = process.env.S13_GOV_BRAIN_PROVIDER?.trim();
  const model = process.env.S13_GOV_BRAIN_MODEL?.trim();
  if (!runtime && !provider && !model) return null;
  return { runtime: runtime || "opencode", provider: provider || "opencode-go", model: model || "gpt-6-luna" };
}

function laneEnvironment() {
  const env = { ...process.env };
  delete env.AEH_DETERMINISTIC_PASEO_RUNTIME;
  delete env.AEH_DETERMINISTIC_PASEO;
  delete env.AEH_MANAGED_AGENT;
  delete env.AEH_INTERACTIVE_LEAD;
  delete env.AEH_ORCHESTRATION_ALLOWED;
  delete env.AEH_OPERATION_ID;
  delete env.AEH_OPERATION_KIND;
  delete env.AEH_CONTROL_ROOT;
  delete env.AEH_OPERATION_STATE_REDIRECT;
  delete env.AEH_CONTROLLER_EPOCH;
  delete env.AEH_CONTROLLER_TOKEN;
  delete env.AEH_ALLOW_NESTED_OPERATION;
  delete env.PASEO_AGENT_ID;
  delete env.PASEO_SESSION_ID;
  // P-NEW-4: PASEO_HOME/PASEO_DAEMON_URL are intentionally preserved so lane
  // children inherit the isolated daemon; the guard above proves they point
  // at the isolated home, never the live daemon.
  return env;
}

/**
 * A non-interactive `operation start` has no bound Lead, so a DELEGATED route cannot produce the
 * Lead semantic-acceptance evidence its frozen policy requires (`ACCEPTANCE_LEAD_REQUIRED`). The
 * certification lane emulates the interactive entry by creating a real Paseo Lead agent and
 * starting the operation with `PASEO_AGENT_ID` bound to it; the agent is the lane's Lead.
 */
function createLaneLeadAgent(laneName) {
  const prompt = "You are the bound Lead for a managed AEH operation in a real-provider certification lane. Do not modify repository files. When the controller sends a message beginning [AEH_MANAGED_LEAD_ACCEPTANCE], assess the supplied assertions exactly as instructed and return the required AEH_RESULT_JSON line. Acknowledge now with LEAD_READY.";
  const brain = brainTopologyOverride();
  const paseoProvider = brain?.runtime === "codex" || !brain ? "codex" : "opencode";
  const modelId = brain ? (brain.runtime === "codex" ? brain.model : `${brain.provider}/${brain.model}`) : "gpt-6-luna";
  const created = run("paseo", ["agent", "--json", "run", "--background", "--provider", paseoProvider, "--model", modelId, "--title", `s13-r${round}-${runId}-${laneName}-lead`, "--label", `aeh.provider=${paseoProvider}`, "--label", "aeh.role=lead", "--label", `aeh.operation=s13-round${round}`, prompt], { timeoutMs: 180_000 });
  try {
    const parsed = JSON.parse(created.stdout);
    if (typeof parsed?.agentId === "string") return parsed.agentId;
  } catch { /* fall through to table parsing */ }
  return /^([0-9a-f]{8}-[0-9a-f-]{27,})\s/m.exec(created.stdout)?.[1];
}

async function startOperation(lane, fixtureRoot, extra = []) {
  const argv = ["operation", "start", lane.kind, lane.request(...extra), "."];
  for (const [flag, value] of Object.entries(lane.flags ?? {})) {
    if (Array.isArray(value)) for (const item of value) argv.push(`--${flag}`, item);
    else argv.push(`--${flag}`, value);
  }
  const leadAgentId = createLaneLeadAgent(lane.fixture ?? lane.kind);
  if (!leadAgentId) throw new Error("unable to materialize a real Paseo lead agent for the lane");
  const started = run(process.execPath, [candidateBinary(fixtureRoot), ...argv], {
    cwd: fixtureRoot,
    env: { ...laneEnvironment(), PASEO_AGENT_ID: leadAgentId },
    timeoutMs: 600_000
  });
  const operationId = /^operationId=(.+)$/m.exec(started.stdout)?.[1]?.trim();
  return { argv, started, operationId, leadAgentId };
}

async function waitForTerminal(fixtureRoot, operationId, timeoutMs, stageTrace = []) {
  const deadline = Date.now() + timeoutMs;
  let record;
  let lastStages = "";
  while (Date.now() < deadline) {
    record = await readJson(operationFile(fixtureRoot, operationId));
    if (record) {
      const stages = JSON.stringify(Object.fromEntries(Object.entries(record.stages ?? {}).map(([key, value]) => [key, value.status])));
      const stageMessages = Object.fromEntries(Object.entries(record.stages ?? {}).map(([key, value]) => [key, typeof value?.message === "string" ? value.message.slice(0, 500) : null]).filter(([, message]) => message));
      const stageSignature = JSON.stringify({ stages, stageMessages });
      if (stageSignature !== lastStages) {
        lastStages = stageSignature;
        stageTrace.push({ at: new Date().toISOString(), status: record.status, phase: record.phase, revision: record.revision, stages: JSON.parse(stages), ...(Object.keys(stageMessages).length ? { stageMessages } : {}) });
      }
    }
    if (record && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(record.status)) return record;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return record;
}

/**
 * Bounded, sanitized operational trace capture. The per-fixture Paseo trace and telemetry
 * event logs are the only durable record of watchdog/supervisor/context activity when the
 * detached controller cannot be attached to after the fact.
 */
async function captureTerminalArtifacts(fixtureRoot, record) {
  const artifacts = { acceptance: null, reviewers: [], specManagers: [], participants: [], failedParticipants: [], assessments: [], reviewerArtifactsError: null };
  const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
  const acceptancePath = typeof record?.result?.acceptanceOracleArtifact === "string" ? record.result.acceptanceOracleArtifact : undefined;
  if (acceptancePath) {
    try {
      const raw = await fs.readFile(path.join(fixtureRoot, acceptancePath));
      const parsed = JSON.parse(raw.toString("utf8"));
      // R7-F2: retain the acceptance artifact bytes themselves (bounded, sanitized) so the
      // disposition and digest are independently recomputable outside the disposed fixture.
      const rawText = raw.toString("utf8");
      const retained = sanitizeString(rawText);
      artifacts.acceptance = {
        path: acceptancePath,
        sha256: sha256(raw),
        rawSha256: sha256(Buffer.from(retained, "utf8")),
        sanitized: retained !== rawText,
        raw: retained,
        bytes: raw.byteLength,
        persistedAt: parsed.persistedAt ?? null,
        disposition: parsed.disposition?.disposition ?? null,
        dispositionDigest: parsed.disposition?.digest ?? null,
        evidenceBundleDigest: parsed.evidenceBundle?.digest ?? null,
        requiredAssertionIds: parsed.disposition?.requiredAssertionIds ?? [],
        coveredAssertionIds: parsed.disposition?.coveredAssertionIds ?? [],
        blockers: (parsed.disposition?.blockers ?? []).map((entry) => entry.code),
        evidence: (parsed.evidenceBundle?.evidence ?? []).map((item) => ({ id: item.id, assertionId: item.assertionId, kind: item.kind, status: item.status, strength: item.strength, dimension: item.dimension ?? null, reviewerIdentity: item.reviewerIdentity ?? null, provider: item.provider ?? null, artifact: item.provenance?.artifact ?? null, executionBindingDigest: item.provenance?.executionBindingDigest ?? null }))
      };
    } catch (error) { artifacts.acceptance = { path: acceptancePath, error: String(error) }; }
  }
  for (const [participantId, participant] of Object.entries(record?.participants ?? {})) {
    if (["Explorer", "Planner"].includes(participant?.role) && typeof participant.resultArtifact === "string") {
      try {
        const raw = await fs.readFile(path.join(fixtureRoot, participant.resultArtifact));
        const parsed = JSON.parse(raw.toString("utf8"));
        const payload = sanitizeEvidence(parsed);
        artifacts.participants.push({
          participantId,
          role: participant.role,
          status: participant.status,
          artifact: participant.resultArtifact,
          artifactSha256: sha256(raw),
          payloadSha256: crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
          bytes: raw.byteLength,
          payload
        });
      } catch (error) {
        artifacts.participants.push({ participantId, role: participant.role, status: participant.status, artifact: participant.resultArtifact, error: String(error) });
      }
    }
    if (participant?.role === "Spec Manager" && typeof participant.resultArtifact === "string") {
      try {
        const raw = await fs.readFile(path.join(fixtureRoot, participant.resultArtifact));
        const parsed = JSON.parse(raw.toString("utf8"));
        const payload = sanitizeEvidence(parsed);
        artifacts.specManagers.push({ participantId, status: participant.status, workspaceId: participant.workspaceId ?? null, artifact: participant.resultArtifact, artifactSha256: sha256(raw), payloadSha256: crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex"), bytes: raw.byteLength, payload });
      } catch (error) {
        artifacts.specManagers.push({ participantId, status: participant.status, workspaceId: participant.workspaceId ?? null, artifact: participant.resultArtifact, error: String(error) });
      }
    }
    if (participant?.role !== "Reviewer" || typeof participant.resultArtifact !== "string") continue;
    try {
      const raw = await fs.readFile(path.join(fixtureRoot, participant.resultArtifact));
      let parsed;
      try { parsed = JSON.parse(raw.toString("utf8")); } catch { parsed = undefined; }
      // Round 23: the reviewer result is a structured-result envelope; read the verdict/findings
      // from the payload and retain the bounded sanitized payload so a review stall or verdict is
      // diagnosable from the durable lane artifact after the fixture is disposed.
      const payload = parsed?.payload ?? parsed;
      artifacts.reviewers.push({
        participantId,
        sessionId: participant.executionBinding?.runtime?.sessionId ?? null,
        status: participant.status,
        phase: participant.phase ?? null,
        error: typeof participant.error === "string" ? participant.error.slice(0, 500) : null,
        artifact: participant.resultArtifact,
        sha256: sha256(raw),
        bytes: raw.byteLength,
        verdict: payload?.verdict ?? payload?.decision ?? payload?.status ?? null,
        findings: Array.isArray(payload?.findings) ? payload.findings.length : null,
        payload: payload ? sanitizeEvidence(payload) : null
      });
    } catch (error) { artifacts.reviewerArtifactsError = String(error); }
  }
  const assessmentDir = path.join(fixtureRoot, ".harness", "cache", "semantic-assessments-v1");
  try {
    for (const file of (await fs.readdir(assessmentDir)).filter((name) => name.endsWith(".json")).sort().slice(-12)) {
      const raw = await fs.readFile(path.join(assessmentDir, file));
      let parsed;
      try { parsed = JSON.parse(raw.toString("utf8")); } catch { parsed = undefined; }
      artifacts.assessments.push({
        file,
        sha256: sha256(raw),
        bytes: raw.byteLength,
        assessmentType: parsed?.assessmentType ?? parsed?.request?.assessmentType ?? null,
        mechanism: parsed?.mechanism ?? null,
        digest: parsed?.digest ?? null,
        modelId: parsed?.provenance?.modelId ?? parsed?.request?.profile?.modelId ?? null,
        sessionId: parsed?.provenance?.sessionId ?? parsed?.sessionId ?? null
      });
    }
  } catch { /* no semantic assessment cache in this lane */ }
  // R12-F4: retain per-run causal failure details for the participant identities that
  // failed, including the bounded artifact bytes when the candidate persisted one.
  for (const [participantId, participant] of Object.entries(record?.participants ?? {})) {
    const failed = participant?.status === "FAILED" || participant?.status === "BLOCKED" || typeof participant?.error === "string";
    if (!failed) continue;
    const entry = {
      participantId,
      role: participant.role ?? null,
      logicalAgent: participant.logicalAgent ?? null,
      status: participant.status ?? null,
      phase: participant.phase ?? null,
      workspaceId: participant.workspaceId ?? null,
      error: typeof participant.error === "string" ? participant.error.slice(0, 1_000) : null,
      artifact: typeof participant.resultArtifact === "string" ? participant.resultArtifact : null
    };
    if (entry.artifact) {
      try {
        const raw = await fs.readFile(path.join(fixtureRoot, entry.artifact));
        const retained = sanitizeString(raw.toString("utf8")).slice(0, 20_000);
        entry.artifactSha256 = sha256(raw);
        entry.bytes = raw.byteLength;
        entry.payload = (() => { try { return sanitizeEvidence(JSON.parse(retained)); } catch { return retained; } })();
      } catch (error) {
        entry.artifactError = String(error);
      }
    }
    artifacts.failedParticipants.push(entry);
  }
  return artifacts;
}

async function candidateWorkspaceObservations(record) {
  const candidate = record?.candidateRevision;
  if (!candidate) return { observations: [], error: "candidate revision unavailable" };
  const observations = [];
  const inspect = async (source, workspaceId, root) => {
    if (typeof root !== "string" || !root) return { source, workspaceId, root: root ?? null, status: "UNAVAILABLE", error: "workspace root unavailable" };
    try {
      const observedSourceDigest = await gitModule.computeWorktreeDigest(root);
      return { source, workspaceId, root, expectedSourceDigest: candidate.sourceDigest, observedSourceDigest, candidateIdentityDigest: candidate.identityDigest, candidateRevision: candidate.revision, status: observedSourceDigest === candidate.sourceDigest ? "MATCH" : "MISMATCH" };
    } catch (error) {
      return { source, workspaceId, root, expectedSourceDigest: candidate.sourceDigest, candidateIdentityDigest: candidate.identityDigest, candidateRevision: candidate.revision, status: "UNAVAILABLE", error: String(error) };
    }
  };
  observations.push(await inspect("CandidateRevision.worktree", null, candidate.worktree ?? record.workspaceRoot ?? record.root));
  const specManagerIds = Object.entries(record.participants ?? {}).filter(([, participant]) => participant?.role === "Spec Manager" && typeof participant.workspaceId === "string").map(([participantId, participant]) => ({ participantId, workspaceId: participant.workspaceId }));
  if (specManagerIds.length) {
    const listed = await paseoWorkspaces();
    for (const item of specManagerIds) {
      const workspace = listed.find((entry) => entry.workspaceId === item.workspaceId);
      observations.push(await inspect(`SpecManager:${item.participantId}`, item.workspaceId, workspace?.cwd));
    }
  }
  return { observations };
}

async function captureTraces(fixtureRoot) {
  const interesting = /(watchdog|supervisor|context\.status|agent\.wait|agent\.snapshot|sdk\.resolve|provider\.preflight|semantic|timeline|triage|stack|audit|harness\.(plan|wave|repair|quality|run\.finish|candidate\.assembled))/i;
  const result = { paseo: { total: 0, entries: [] }, events: { total: 0, entries: [] } };
  for (const [target, relative] of [["paseo", ".harness/telemetry/paseo.ndjson"], ["events", ".harness/telemetry/events.ndjson"]]) {
    const raw = await fs.readFile(path.join(fixtureRoot, relative), "utf8").catch(() => "");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    result[target].total = lines.length;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (!interesting.test(parsed.name ?? "")) continue;
        const attributes = parsed.attributes && typeof parsed.attributes === "object"
          ? Object.fromEntries(Object.entries(parsed.attributes).slice(0, 20).map(([key, value]) => [key, typeof value === "string" && value.length > 500 ? `${value.slice(0, 500)}…` : value]))
          : undefined;
        result[target].entries.push({ at: parsed.at, name: parsed.name, attributes });
      } catch { /* bounded observation only */ }
    }
    result[target].entries = result[target].entries.slice(-400);
  }
  return result;
}

async function postCampaignOperationRead(fixtureRoot, operationId, initialRecord, observationMs = 30_000) {
  const deadline = Date.now() + observationMs;
  let latest = initialRecord;
  let observations = 0;
  while (true) {
    latest = (await readJson(operationFile(fixtureRoot, operationId))) ?? latest;
    observations += 1;
    const controllerPid = latest?.pid ?? null;
    const controllerAlive = processAlive(controllerPid);
    const terminal = Boolean(latest && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(latest.status));
    const candidateWorktree = latest?.candidateRevision?.worktree ?? null;
    let candidateWorktreeAvailable = null;
    if (candidateWorktree) {
      try { await fs.access(candidateWorktree); candidateWorktreeAvailable = true; }
      catch { candidateWorktreeAvailable = false; }
    }
    if ((terminal && !controllerAlive) || !controllerAlive || Date.now() >= deadline) {
      return {
        operationId,
        observedAt: new Date().toISOString(),
        observationWindowMs: observationMs,
        observations,
        status: latest?.status ?? null,
        phase: latest?.phase ?? null,
        revision: latest?.revision ?? null,
        controllerPid,
        controllerAlive,
        terminal,
        candidateWorktree,
        candidateWorktreeAvailable
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

/**
 * Bounded diagnostic watcher: records transitions of the git-visible digest input set for any
 * Paseo worktree created for this fixture, so a transient non-source write is identifiable.
 */
function startWorkspaceWatcher(fixtureRoot) {
  const projectName = path.basename(fixtureRoot);
  const transitions = [];
  const snapshots = new Map();
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      const listed = run("paseo", ["workspace", "ls", "--json"], { timeoutMs: 30_000 });
      let workspaces = [];
      try { workspaces = JSON.parse(listed.stdout); } catch { return; }
      for (const workspace of workspaces) {
        if (workspace.project !== projectName || !workspace.cwd) continue;
        const files = run("git", ["-C", workspace.cwd, "ls-files", "-z", "-c", "-o", "--exclude-standard"], { timeoutMs: 30_000 });
        if (files.status !== 0) continue;
        const list = files.stdout.split("\0").filter(Boolean).sort();
        const previous = snapshots.get(workspace.cwd);
        if (previous && previous.join("\0") !== list.join("\0")) {
          transitions.push({
            at: new Date().toISOString(),
            cwd: workspace.cwd,
            added: list.filter((file) => !previous.includes(file)),
            removed: previous.filter((file) => !list.includes(file))
          });
        }
        snapshots.set(workspace.cwd, list);
      }
    } catch { /* bounded observation only */ }
  }, 400);
  timer.unref?.();
  return {
    transitions,
    states: () => Object.fromEntries([...snapshots].map(([cwd, list]) => [cwd, list])),
    stop: () => { stopped = true; clearInterval(timer); }
  };
}

async function cancelOperation(lane, fixtureRoot, operationId) {
  const result = run(process.execPath, [candidateBinary(fixtureRoot), "operation", "cancel", operationId, "."], {
    cwd: fixtureRoot,
    env: laneEnvironment(),
    timeoutMs: 120_000
  });
  return { exitCode: result.status, stdout: result.stdout.slice(0, 2_000), stderr: result.stderr.slice(0, 2_000) };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function collectSessionReceipts(record, extraIds = []) {
  const ids = new Set(extraIds.filter(Boolean));
  for (const participant of Object.values(record?.participants ?? {})) if (agentIdOf(participant.id)) ids.add(participant.id);
  for (const receipt of Object.values(record?.participantReceipts ?? {})) {
    for (const key of ["sessionId", "agentId", "participantId"]) if (agentIdOf(receipt?.[key])) ids.add(receipt[key]);
  }
  for (const generation of record?.supervision?.generations ?? []) if (agentIdOf(generation.agentId)) ids.add(generation.agentId);
  const receipts = [];
  for (const id of ids) receipts.push(inspectAgent(id));
  return receipts;
}

/**
 * R18-F2: a lane's workspace scope is not just the fixture project name. It includes every
 * workspace bound to the operation (participant/supervision workspace ids), every workspace whose
 * cwd lives inside the fixture root, and every workspace whose cwd names the operation (per-unit
 * directory workspaces created under the operation project). The previous project-name-only
 * inventory silently missed per-unit directory workspaces and pre-existing entries.
 */
function workspaceLaneScope({ projectName, fixtureRoot, operationId, operation }) {
  const boundIds = new Set();
  for (const participant of Object.values(operation?.participants ?? {})) if (participant?.workspaceId) boundIds.add(participant.workspaceId);
  for (const generation of operation?.supervision?.generations ?? []) if (generation?.workspaceId) boundIds.add(generation.workspaceId);
  const operationSlug = String(operationId ?? "").toLowerCase();
  const rootPrefix = fixtureRoot ? path.resolve(fixtureRoot) : undefined;
  return paseoWorkspaces().then((all) => all.filter((workspace) => {
    if (workspace.project === projectName || String(workspace.project ?? "").includes(projectName)) return true;
    if (boundIds.has(workspace.workspaceId)) return true;
    const cwd = String(workspace.cwd ?? "");
    if (rootPrefix && cwd.startsWith(rootPrefix)) return true;
    if (operationSlug && cwd.toLowerCase().includes(operationSlug)) return true;
    return false;
  }));
}

async function archiveLaneWorkspaces(scope, beforeIds) {
  const preExisting = [];
  const archived = [];
  for (const workspace of scope) {
    if (beforeIds.has(workspace.workspaceId)) { preExisting.push({ workspaceId: workspace.workspaceId, cwd: workspace.cwd ?? null }); continue; }
    const result = run("paseo", ["workspace", "archive", workspace.workspaceId], { timeoutMs: 60_000 });
    archived.push({ workspaceId: workspace.workspaceId, project: workspace.project, cwd: workspace.cwd ?? null, exitCode: result.status });
  }
  return { archived, preExisting };
}

// -------------------------------------------------------------------------------------------------
// Deterministic oracles
// -------------------------------------------------------------------------------------------------

function check(id, ok, message, evidence = {}) {
  return { id, status: ok ? "PASS" : "FAIL", required: true, message, evidence };
}

async function loadJsonRelative(root, relative) {
  return readJson(path.join(root, relative));
}

/**
 * The product archives operation-owned workspaces at terminalization (removing the
 * Paseo worktree); before archiving it persists the bounded `.harness` run-evidence
 * subtrees under `<fixtureRoot>/.harness/operations/<id>/workspace-evidence/latest`.
 * Verification reads the worktree when present and falls back to that product-owned
 * snapshot, so no check is weakened and no campaign-side copy is used.
 */
function worktreeEvidenceRoots(fixtureRoot, record, worktreeRoot) {
  const roots = [worktreeRoot, record?.workspaceRoot].filter((value) => typeof value === "string" && value);
  if (record?.id) roots.push(path.join(fixtureRoot, ".harness", "operations", record.id, "workspace-evidence", "latest"));
  return [...new Set(roots)];
}

async function loadJsonFromRoots(roots, relative) {
  for (const root of roots) {
    const value = await readJson(path.join(root, relative));
    if (value !== undefined) return value;
  }
  return undefined;
}

async function readEventEntries(fixtureRoot, names, extraRoots = []) {
  const entries = [];
  const roots = [...new Set([fixtureRoot, ...extraRoots.filter((value) => typeof value === "string" && value)])];
  for (const root of roots) {
    const raw = await fs.readFile(path.join(root, ".harness", "telemetry", "events.ndjson"), "utf8").catch(() => "");
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        if (!names || names.includes(parsed.name)) entries.push(parsed);
      } catch { /* bounded observation only */ }
    }
  }
  return entries;
}

async function readJsonDir(directory) {
  const files = await fs.readdir(directory).catch(() => []);
  const entries = [];
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    try { entries.push({ file, value: JSON.parse(await fs.readFile(path.join(directory, file), "utf8")) }); } catch { /* bounded */ }
  }
  return entries;
}

function scopeMatchesPath(scope, file) {
  if (scope === "**" || scope === "*") return true;
  const prefix = scope.replace(/\/+$/, "").replace(/\/\*\*$/, "");
  return file === scope || file === prefix || file.startsWith(`${prefix}/`);
}

async function operationCoreChecks(record) {
  const participantReceipts = Object.values(record?.participantReceipts ?? {});
  return [
    check("operation.terminal-succeeded", record?.status === "SUCCEEDED", `operation status=${record?.status ?? "missing"}`),
    check("operation.candidate-bound", typeof record?.candidateRevision?.identityDigest === "string" && /^[a-f0-9]{64}$/.test(record.candidateRevision.identityDigest), "candidate revision identity digest is bound", { revision: record?.candidateRevision?.revision ?? null }),
    check("operation.participant-receipts", participantReceipts.length > 0, `${participantReceipts.length} terminal participant receipt(s) persisted`),
    check("operation.revision-current", Number.isSafeInteger(record?.operationExecutionRevision) && record.operationExecutionRevision >= 1, "operation execution revision is durable")
  ];
}

const laneDefinitions = {
  audit: {
    kind: "audit",
    fixture: "audit",
    request: () => "Audit the fixture greeting module for correctness and clarity.",
    flags: { reviewer: "reviewer", risk: "low", file: "src/greeting.mjs" },
    timeoutMs: laneTimeoutSeconds * 1000,
    verify: async ({ fixtureRoot, record }) => {
      const checks = await operationCoreChecks(record);
      const auditRelative = record?.result?.report;
      const report = auditRelative ? await loadJsonRelative(fixtureRoot, auditRelative) : undefined;
      const reviewerSessions = (report?.sessions ?? []).filter((session) => agentIdOf(session.id));
      const validation = (report?.validationChecks ?? []).find((entry) => entry.id === "command.fixture-greeting");
      const synthetic = (report?.findings ?? []).filter((finding) => String(finding.id ?? "").includes("SYSTEM"));
      checks.push(
        check("audit-report", Boolean(report?.auditId) && Array.isArray(report?.findings), `audit report ${report?.auditId ?? "missing"} persisted at ${auditRelative ?? "-"}`, { status: report?.status ?? null, findings: report?.findings?.length ?? 0, productionSafe: report?.productionSafe ?? null }),
        check("audit-real-reviewer-session", reviewerSessions.length > 0, `${reviewerSessions.length} reviewer session(s) bound to the report`),
        check("audit-validation-command", validation?.status === "PASS", `configured fixture validation command ${validation?.status ?? "missing"}`),
        check("audit-no-system-failure", synthetic.length === 0, synthetic.length ? `${synthetic.length} synthetic audit-system finding(s)` : "reviewer output contract parsed without synthetic system failure"),
        check("audit-supervisor-generation", (record?.supervision?.generations ?? []).some((generation) => Boolean(generation.agentId) && ["ACTIVE", "ARCHIVED", "DRAINING"].includes(generation.status)), "semantic supervisor generation materialized", { generations: (record?.supervision?.generations ?? []).map((generation) => ({ generation: generation.generation, agentId: generation.agentId ?? null, status: generation.status })) })
      );
      return { checks, rows: { audit: ["audit-report", "audit-real-reviewer-session", "audit-validation-command"] }, reviewerSessions: (report?.sessions ?? []).map((session) => ({ id: session.id, provider: session.provider, model: session.model, exitCode: session.exitCode })), auditId: report?.auditId ?? null };
    }
  },
  "change-direct": {
    kind: "change",
    fixture: "change",
    request: () => "Add exactly one export line to src/greeting.mjs: export const FAREWELL = \"bye\"; Keep the existing greet export unchanged.",
    flags: { file: "src/greeting.mjs", title: "Add FAREWELL constant", accept: "node scripts/validate.mjs passes and src/greeting.mjs exports FAREWELL === \"bye\"" },
    timeoutMs: laneTimeoutSeconds * 1000,
    verify: verifyChangeLane
  },
  // Round-19 AEH-V2-0128 affected geometry: a concrete two-file scope (`--file` twice) previously
  // took the DIRECT branch at semantic triage while the sealed contract floor raised DELEGATED and
  // the supervisor failed closed `EXECUTION_POLICY_STALE`. Both floors now consume the single
  // `requiresDelegatedPlanningV1` predicate, so the lane must seal DIRECT and succeed.
  "change-multifile": {
    kind: "change",
    fixture: "change-multifile",
    request: () => "Add exactly one export line to src/greeting.mjs: export const FAREWELL = \"bye\"; and create src/format.mjs exporting function formatGreeting(name) that returns `Hello, ${name}!`. Keep the existing greet export and behavior unchanged.",
    flags: { file: ["src/greeting.mjs", "src/format.mjs"], title: "Two-file direct change", accept: "node scripts/validate.mjs passes with the FAREWELL export" },
    timeoutMs: laneTimeoutSeconds * 1000,
    verify: verifyMultiFileChangeLane
  },
  // Genuine DELEGATED conditions: a bounded, behavior-preserving internal refactor. The fixture
  // project's OpenSpec rules require real delta specs for behavior changes, so a behavior change
  // legitimately escalates to FORMAL_SDD (see change-formal); this lane certifies the delegated
  // trunk where formalization is not required.
  "change-delegated": {
    kind: "change",
    fixture: "change-delegated",
    request: () => "Refactor the greeting fixture internals: extract the greeting-string construction from src/greeting.mjs into a new internal module src/format.mjs and import it from src/greeting.mjs. Keep the exact public export surface (greet), observable behavior and both configured validators unchanged.",
    flags: { title: "Delegated internal refactor", accept: "node scripts/validate.mjs and node scripts/contract.mjs stay green with unchanged greet behavior" },
    timeoutMs: laneTimeoutSeconds * 1000,
    verify: verifyChangeLane
  },
  // A genuinely architecture-scoped request: the operator declares the architecture domain, which is
  // the deterministic explicit escalation path to FORMAL_SDD (resolveImplementationRoute). It does
  // not force the formal route inside the model; the route decision is explicit user evidence.
  "change-formal": {
    kind: "change",
    fixture: "change-formal",
    request: () => "Restructure the greeting fixture as a module-boundary contract: add the FAREWELL constant export in src/greeting.mjs and add a small usage module that re-exports it, keeping the exact public export surface green under the configured validators.",
    flags: { domain: "architecture", title: "Formal greeting boundary change", accept: "node scripts/validate.mjs and node scripts/contract.mjs pass with the FAREWELL export available" },
    timeoutMs: laneTimeoutSeconds * 1000,
    verify: verifyChangeLane
  },
  // Round-18 `multi-worker`: two separable deliverables (the `FAREWELL` export and the
  // `src/farewell.mjs` module) so the frozen Planner has a genuine multi-unit task DAG; the
  // deterministic oracle requires >=2 work units and a PASSed wave barrier with executed checks.
  "multi-worker": {
    kind: "change",
    fixture: "multi-worker",
    request: () => "Deliver a two-module feature in the greeting fixture as two separately verifiable deliverables: (A) create src/farewell.mjs exporting function farewell(name) that returns `Goodbye, ${name}!`, and (B) add `export const FAREWELL = \"bye\";` to src/greeting.mjs. Keep the existing greet export and behavior unchanged. Both configured validators must pass.",
    // Two acceptance requirements (AC-1/AC-2) give the Planner two frozen requirement ids so the
    // WorkGraph decomposition is requirement-derived; no `--file` flags, so the semantic and
    // deterministic delegation floors agree on DELEGATED (AEH-V2-0128).
    flags: { title: "Add farewell module and export", accept: ["src/farewell.mjs exports farewell(name) returning `Goodbye, ${name}!` and node scripts/validate.mjs passes", "src/greeting.mjs exports FAREWELL === \"bye\" and node scripts/contract.mjs passes"] },
    timeoutMs: laneTimeoutSeconds * 1000,
    verify: verifyMultiWorkerLane
  },
  // Round-19 `repair` / `product-repair` forcing geometry: a concrete six-file contract scope makes
  // the route deterministically DELEGATED (AEH-V2-0128 floor), the planner's two documentation work
  // units cannot touch src/config.mjs, and the baseline FAREWELL defect in src/config.mjs fails both
  // configured validators on the first pass. The canonical Repairer's contract scope authorizes the
  // repair, and the frozen validator paths prevent weakening the checks.
  // Round 23: the request resolves the REQUIREMENT_CONTRADICTION a Planner can legitimately detect
  // between "keep the API unchanged" and "the frozen validators must pass against the seeded
  // src/config.mjs FAREWELL defect" (r22-gov-4 and r23-gov-5 both escalated with
  // formalizationNeed REQUIRED / REQUIREMENT_CONTRADICTION). The request now explicitly assigns the
  // pre-existing defect to the governed repair step and excludes src/config.mjs from the
  // documentation change, so the task decomposition is unambiguous and the DELEGATED repair
  // geometry is legitimately forced by the configured validators.
  repair: {
    kind: "change",
    fixture: "repair",
    request: () => "Document the public greeting API with JSDoc comments: add a short JSDoc comment above greet() in src/greeting.mjs and above farewell() in src/farewell.mjs. Keep the greet() and farewell() function bodies and the public export surface unchanged, and do not edit src/config.mjs in this documentation change. The known pre-existing FAREWELL constant defect in src/config.mjs is explicitly assigned to the governed repair step; after that repair, both configured validators must pass.",
    flags: { file: "src/*.mjs", title: "Document the greeting API", accept: ["src/greeting.mjs documents greet() with a JSDoc comment and, after the governed repair, node scripts/validate.mjs passes", "src/farewell.mjs documents farewell() with a JSDoc comment and, after the governed repair, node scripts/contract.mjs passes"] },
    timeoutMs: laneTimeoutSeconds * 1000,
    verify: verifyRepairLane
  },
  // Round-18 `distributed-execution`: the same two-deliverable request runs through the
  // filesystem distributed queue with a real detached worker (`aeh worker run`) that leases the
  // job, materializes a real provider session, returns the patch and a worker receipt.
  distributed: {
    kind: "change",
    fixture: "distributed",
    request: () => "Deliver a two-module feature in the greeting fixture: (1) a new module src/farewell.mjs exporting function farewell(name) that returns `Goodbye, ${name}!`, and (2) an `export const FAREWELL = \"bye\";` line in src/greeting.mjs. Keep the existing greet export and behavior unchanged. The configured validators must pass.",
    flags: { title: "Distributed farewell module and export", accept: "node scripts/validate.mjs and node scripts/contract.mjs pass with the farewell module and FAREWELL export" },
    timeoutMs: laneTimeoutSeconds * 1000,
    verify: verifyDistributedLane,
    afterStart: startDistributedWorkerAfterStart
  }
};

const SPEC_DELTA_HEADER = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/m;
const SPEC_SCENARIO = /^####\s+Scenario:/m;
const SPEC_CAPABILITY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function formalLaneEvidence(fixtureRoot, record) {
  const specManager = Object.entries(record?.participants ?? {}).find(([, participant]) => participant?.role === "Spec Manager" && typeof participant.resultArtifact === "string");
  const evidence = { specManagerReady: false, compiledContract: false, canonicalDelta: false, canonicalDetail: "no Spec Manager result artifact", specs: [] };
  const taskId = record?.result?.taskId ?? null;
  if (taskId) {
    const roots = [record?.candidateRevision?.worktree, fixtureRoot].filter(Boolean);
    for (const root of roots) {
      try {
        const contract = YAML.parse(await fs.readFile(path.join(root, ".harness", "contracts", `${taskId}.yaml`), "utf8"));
        if (contract?.authoring?.provider === "openspec" && typeof contract?.authoring?.change === "string") { evidence.compiledContract = true; break; }
      } catch { /* keep looking in the other root */ }
    }
  }
  if (!specManager) return evidence;
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(fixtureRoot, specManager[1].resultArtifact), "utf8"));
    const payload = parsed?.payload ?? {};
    evidence.specManagerReady = payload.status === "READY";
    const deltas = Array.isArray(payload.artifacts?.specs) ? payload.artifacts.specs : [];
    evidence.specs = deltas.map((delta) => ({ capability: delta?.capability ?? null, bytes: typeof delta?.content === "string" ? delta.content.length : 0 }));
    const canonical = deltas.length > 0 && deltas.every((delta) => typeof delta?.capability === "string" && SPEC_CAPABILITY.test(delta.capability)
      && typeof delta?.content === "string" && SPEC_DELTA_HEADER.test(delta.content) && SPEC_SCENARIO.test(delta.content));
    evidence.canonicalDelta = canonical;
    evidence.canonicalDetail = `Spec Manager ${specManager[1].status ?? "?"} READY=${evidence.specManagerReady} deltas=${deltas.length} canonical=${canonical}`;
  } catch (error) {
    evidence.canonicalDetail = `Spec Manager artifact unreadable: ${String(error)}`;
  }
  return evidence;
}

async function verifyChangeLane({ fixtureRoot, record }) {
  const checks = await operationCoreChecks(record);
  const route = record?.intent?.route;
  const candidate = record?.candidateRevision;
  const worktreeRoot = candidate?.worktree ?? record?.workspaceRoot ?? fixtureRoot;
  const evidenceRoots = worktreeEvidenceRoots(fixtureRoot, record, worktreeRoot);
  const taskId = record?.result?.taskId ?? null;
  const report = taskId ? await loadJsonFromRoots(evidenceRoots, `.harness/reports/${taskId}.json`) : undefined;
  const capsule = taskId ? await loadJsonFromRoots(evidenceRoots, `.harness/capsules/${taskId}.json`) : undefined;
  const checksById = new Map((report?.checks ?? []).map((entry) => [entry.id, entry]));
  const candidateReceipts = Object.values(record?.participantReceipts ?? {}).filter((receipt) => agentIdOf(receipt?.sessionId ?? receipt?.agentId ?? receipt?.participantId));
  const validationPass = report?.status === "PASS" && (checksById.get("command.fixture-greeting")?.status === "PASS" || !checksById.size);
  // The route-specific rows are asserted only for the route this lane actually exercises; a
  // DIRECT lane must not fail on the delegated-change evidence it was never meant to produce.
  const directLane = route === "DIRECT";
  const formalLane = route === "FORMAL_SDD";
  const formal = formalLane ? await formalLaneEvidence(fixtureRoot, record) : null;
  checks.push(
    check("change.route", route === "DIRECT" || route === "DELEGATED" || route === "FORMAL_SDD", `implementation route=${route ?? "missing"}`, { assurance: record?.intent?.assurance ?? null, preflight: record?.changePreflight?.triage?.route ?? null }),
    ...(directLane
      ? [check("change.direct-route", true, `direct implementation route=${route ?? "missing"}`)]
      : formalLane
        ? [
          check("change.formal-route", route === "FORMAL_SDD", `formal implementation route=${route ?? "missing"}`),
          check("formal.spec-authoring", record?.stages?.["spec-authoring"]?.status === "COMPLETED" && formal?.specManagerReady === true, `Spec Manager READY=${formal?.specManagerReady ?? "missing"} stage=${record?.stages?.["spec-authoring"]?.status ?? "missing"}`),
          check("formal.spec-compilation", record?.stages?.["spec-compilation"]?.status === "COMPLETED" && formal?.compiledContract === true, `OpenSpec compile+seal contract=${formal?.compiledContract ?? "missing"} stage=${record?.stages?.["spec-compilation"]?.status ?? "missing"}`),
          check("formal.canonical-spec-delta", formal?.canonicalDelta === true, `canonical per-capability delta verified: ${formal?.canonicalDetail ?? "missing"}`, { specs: formal?.specs ?? [] })
        ]
        : [
          check("change.delegated-route", route === "DELEGATED", `delegated implementation route=${route ?? "missing"}`),
          check("delegated.feature-capsule", Boolean(capsule), `feature capsule artifact=${capsule ? "present" : "missing"}`),
          check("delegated.review", Boolean(record?.result?.acceptanceOracle?.coveredAssertionIds?.length), "accepted assertions covered by the reviewed candidate", { covered: record?.result?.acceptanceOracle?.coveredAssertionIds?.length ?? 0 })
        ]),
    check("change.candidate-revision", Number.isSafeInteger(candidate?.revision) && candidate.revision >= 2, `candidate revision=${candidate?.revision ?? "missing"}`),
    check("change.participant-receipt", candidateReceipts.length > 0, `${candidateReceipts.length} candidate-bound participant receipt(s)`),
    check("change.validation", validationPass, `validation report status=${report?.status ?? "missing"} fixture command=${checksById.get("command.fixture-greeting")?.status ?? "missing"}`, { checks: (report?.checks ?? []).map((entry) => ({ id: entry.id, status: entry.status })) }),
    check("change.acceptance-oracle", Boolean(record?.result?.acceptanceOracleArtifact), `acceptance oracle artifact=${record?.result?.acceptanceOracleArtifact ?? "missing"}`, { disposition: record?.result?.acceptanceOracle?.disposition ?? null }),
    check("change.objective-completion", Boolean(record?.result?.objectiveCompletionDecision), "objective completion decision persisted")
  );
  return {
    checks,
    rows: {
      change: ["change.candidate-revision", "change.participant-receipt", "change.validation"],
      ...(directLane
        ? { "direct-change": ["change.direct-route", "change.candidate-revision", "change.validation"] }
        : formalLane
          ? { "formal-sdd": ["change.formal-route", "formal.spec-authoring", "formal.spec-compilation", "formal.canonical-spec-delta", "change.validation"] }
          : { "delegated-change": ["change.delegated-route", "delegated.feature-capsule", "delegated.review"] })
    },
    candidate: candidate ? { candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest, sourceDigest: candidate.sourceDigest, worktree: candidate.worktree } : null,
    validationReport: report ? { status: report.status, checks: (report.checks ?? []).map((entry) => ({ id: entry.id, status: entry.status, message: entry.message })) } : null,
    capsule: capsule ? { taskId: capsule.taskId ?? taskId, scope: capsule.scope ?? null } : null,
    worktreeRoot
  };
}

async function verifyMultiFileChangeLane(args) {
  const base = await verifyChangeLane(args);
  const { fixtureRoot, record } = args;
  const taskId = record?.result?.taskId ?? null;
  const contractRoot = record?.candidateRevision?.worktree ?? record?.workspaceRoot ?? fixtureRoot;
  let sealedRoute;
  if (taskId) {
    for (const root of worktreeEvidenceRoots(fixtureRoot, record, contractRoot)) {
      try {
        sealedRoute = YAML.parse(await fs.readFile(path.join(root, ".harness", "contracts", `${taskId}.yaml`), "utf8"))?.routing?.route;
        if (sealedRoute !== undefined) break;
      } catch { sealedRoute = undefined; }
    }
  }
  const routeMatches = sealedRoute === "DIRECT" && sealedRoute === record?.intent?.route;
  base.checks.push(check("change.unified-route", routeMatches, `sealed contract route=${sealedRoute ?? "missing"} operation route=${record?.intent?.route ?? "missing"}`));
  base.rows = {
    ...base.rows,
    change: [...(base.rows.change ?? []), "change.unified-route"],
    ...(base.rows["direct-change"] ? { "direct-change": [...base.rows["direct-change"], "change.unified-route"] } : {})
  };
  base.sealedRoute = sealedRoute ?? null;
  return base;
}

async function verifyMultiWorkerLane({ fixtureRoot, record }) {
  const checks = await operationCoreChecks(record);
  const events = await readEventEntries(fixtureRoot, ["harness.plan.ready", "harness.wave.finish", "harness.run.finish", "harness.candidate.assembled"], [record?.candidateRevision?.worktree]);
  const plan = events.find((entry) => entry.name === "harness.plan.ready")?.attributes ?? {};
  const waveFinishes = events.filter((entry) => entry.name === "harness.wave.finish");
  const assemblies = events.filter((entry) => entry.name === "harness.candidate.assembled");
  const runFinish = events.find((entry) => entry.name === "harness.run.finish")?.attributes ?? {};
  const failedWaves = waveFinishes.filter((entry) => entry.attributes?.status !== "PASS");
  const barrierChecks = waveFinishes.reduce((sum, entry) => sum + (Number(entry.attributes?.checks) || 0), 0);
  checks.push(
    check("multi-worker.task-dag", Number(plan.workUnits) >= 2 && Number(plan.waves) >= 1, `planner task DAG workUnits=${plan.workUnits ?? "missing"} waves=${plan.waves ?? "missing"} conflicts=${plan.conflicts ?? "missing"} graphUsed=${plan.graphUsed ?? "missing"}`, { plan }),
    check("multi-worker.wave-barrier", waveFinishes.length >= 1 && failedWaves.length === 0 && barrierChecks >= 1, `${waveFinishes.length} wave finish event(s), ${barrierChecks} barrier check(s), failed waves=${failedWaves.length}`, { waveFinishes: waveFinishes.map((entry) => entry.attributes), runFinishWaves: runFinish.waves ?? null }),
    check("multi-worker.assembly-receipts", assemblies.length >= 2, `${assemblies.length} per-unit candidate assembly event(s)`, { assemblies: assemblies.map((entry) => entry.attributes) })
  );
  return { checks, rows: { "multi-worker": ["multi-worker.task-dag", "multi-worker.wave-barrier", "multi-worker.assembly-receipts"] }, plan: { plan, waveFinishes: waveFinishes.map((entry) => entry.attributes), assemblies: assemblies.map((entry) => entry.attributes), runFinishWaves: runFinish.waves ?? null } };
}

async function verifyRepairLane({ fixtureRoot, record }) {
  const checks = await operationCoreChecks(record);
  const events = await readEventEntries(fixtureRoot, ["harness.repair.start", "harness.repair.finish"], [record?.candidateRevision?.worktree]);
  const starts = events.filter((entry) => entry.name === "harness.repair.start");
  const finishes = events.filter((entry) => entry.name === "harness.repair.finish");
  // Round 19: `writeRepairPacket` persists under the executing workspace root, which for a managed
  // operation is the candidate worktree. The verifier must inspect every workspace root, not only
  // the fixture/control root, before the harness archives those workspaces.
  const packetEntries = [];
  for (const packetRoot of [...new Set([fixtureRoot, record?.candidateRevision?.worktree, record?.workspaceRoot].filter((value) => typeof value === "string" && value))]) {
    for (const entry of await readJsonDir(path.join(packetRoot, ".harness", "repairs"))) packetEntries.push({ ...entry, root: packetRoot });
  }
  const packets = packetEntries;
  const packet = packets.at(-1)?.value;
  const taskId = record?.result?.taskId ?? null;
  const worktreeRoot = record?.candidateRevision?.worktree ?? record?.workspaceRoot ?? fixtureRoot;
  let contract;
  if (taskId) { try { contract = YAML.parse(await fs.readFile(path.join(worktreeRoot, ".harness", "contracts", `${taskId}.yaml`), "utf8")); } catch { contract = undefined; } }
  const scopes = Array.isArray(contract?.task?.scope) && contract.task.scope.length ? contract.task.scope : ["**"];
  const changed = run("git", ["-C", worktreeRoot, "status", "--porcelain"], {}).stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim());
  const outOfScope = changed.filter((file) => !scopes.some((scope) => scopeMatchesPath(scope, file)));
  checks.push(
    check("repair.failure-packet", Boolean(packet) && starts.length >= 1 && (packet?.failures?.length ?? 0) >= 1, `${packets.length} repair packet(s); failures=${(packet?.failures ?? []).map((failure) => failure.id).join(",") || "none"}; repair starts=${starts.length}`, { packetFile: packets.at(-1)?.file ?? null, packet: packet ?? null, repairEvents: starts.map((entry) => entry.attributes) }),
    check("repair.oracle-recheck", record?.result?.acceptanceOracle?.disposition === "ACCEPTED" && finishes.some((entry) => entry.attributes?.status === "PASS") && Number(record?.candidateRevision?.revision) >= 3, `oracle=${record?.result?.acceptanceOracle?.disposition ?? "missing"} repairFinishes=${finishes.map((entry) => entry.attributes?.status).join(",") || "none"} candidateRevision=${record?.candidateRevision?.revision ?? "missing"}`),
    check("product-repair.repair-packet", packets.length >= 1 && (packet?.failures?.length ?? 0) >= 1, `bounded product repair packet persisted (${packets.at(-1)?.file ?? "missing"})`),
    check("product-repair.scope-check", outOfScope.length === 0, `${changed.length} changed file(s), 0 outside frozen contract scope [${scopes.join(", ")}]`, { changedFiles: changed, scopes, outOfScope })
  );
  return { checks, rows: { repair: ["repair.failure-packet", "repair.oracle-recheck"], "product-repair": ["product-repair.repair-packet", "product-repair.scope-check"] }, repairPackets: packets.map((entry) => ({ file: entry.file, failures: (entry.value?.failures ?? []).map((failure) => failure.id), failureType: entry.value?.failureType ?? null, recoveryAction: entry.value?.recoveryAction ?? null })), repairEvents: events.map((entry) => ({ name: entry.name, attributes: entry.attributes })), changedFiles: changed, scopes };
}

async function verifyDistributedLane({ fixtureRoot, record }) {
  const checks = await operationCoreChecks(record);
  const events = await readEventEntries(fixtureRoot, ["harness.plan.ready", "harness.wave.finish", "harness.candidate.assembled"], [record?.candidateRevision?.worktree]);
  const plan = events.find((entry) => entry.name === "harness.plan.ready")?.attributes ?? {};
  // Round 20: jobs are submitted under the operation's advanced candidate workspace; read the
  // queue from there first and fall back to the control root for older layouts.
  let queueRoot = path.join(record?.candidateRevision?.worktree ?? fixtureRoot, ".harness", "distributed");
  let prepared = await readJsonDir(path.join(queueRoot, "prepared"));
  let released = await readJsonDir(path.join(queueRoot, "released"));
  let completed = await readJsonDir(path.join(queueRoot, "completed"));
  if (!prepared.length && !released.length && !completed.length && path.resolve(record?.candidateRevision?.worktree ?? "") !== path.resolve(fixtureRoot)) {
    queueRoot = path.join(fixtureRoot, ".harness", "distributed");
    prepared = await readJsonDir(path.join(queueRoot, "prepared"));
    released = await readJsonDir(path.join(queueRoot, "released"));
    completed = await readJsonDir(path.join(queueRoot, "completed"));
  }
  const ready = prepared.at(-1)?.value;
  const release = released.at(-1)?.value;
  const result = completed.at(-1)?.value;
  const leaseBound = prepared.length >= 1 && released.length >= 1 && completed.length >= 1 && Boolean(ready?.leaseId)
    && release?.leaseId === ready?.leaseId && release?.jobId === ready?.jobId && release?.executionBinding?.digest
    && result?.jobId === ready?.jobId && result?.workerId === ready?.workerId;
  const session = result?.session ?? {};
  const workerReceiptOk = result?.status === "PASS" && typeof session?.id === "string" && session.id.length > 0
    && typeof result?.observedCandidateSourceDigest === "string" && Array.isArray(result?.changedFiles) && result.changedFiles.length > 0;
  checks.push(
    check("distributed-execution.lease", leaseBound && plan.distributed === true, `prepared=${prepared.length} released=${released.length} completed=${completed.length} distributedPlan=${plan.distributed ?? "missing"}`, { ready: ready ?? null, release: release ? { jobId: release.jobId, workerId: release.workerId, leaseId: release.leaseId, bindingDigest: release.executionBinding?.digest ?? null } : null, plan }),
    check("distributed-execution.worker-receipt", workerReceiptOk, `worker result=${result?.status ?? "missing"} session=${session?.id ?? "missing"} changedFiles=${(result?.changedFiles ?? []).length}`, { result: result ? { jobId: result.jobId, workerId: result.workerId, status: result.status, session: { id: session.id ?? null, provider: session.provider ?? null, model: session.model ?? null, logicalAgent: session.logicalAgent ?? null }, changedFiles: result.changedFiles, observedCandidateSourceDigest: result.observedCandidateSourceDigest ?? null } : null })
  );
  return { checks, rows: { "distributed-execution": ["distributed-execution.lease", "distributed-execution.worker-receipt"] }, distributed: { prepared, released: released.map((entry) => entry.value), completed: completed.map((entry) => entry.value), plan } };
}

function spawnDistributedWorker(workerRoot, binaryRoot = workerRoot) {
  const workerId = `s13-r${round}-${runId}-worker`;
  // Round 20: the advanced candidate worktree has no installed node_modules (gitignored); the
  // worker binary always comes from the fixture root while its cwd (the queue/control root) is the
  // candidate worktree where the product submits jobs.
  const child = spawn(process.execPath, [candidateBinary(binaryRoot), "worker", "run", "--worker-id", workerId], { cwd: workerRoot, env: laneEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk.toString()}`.slice(-20_000); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-20_000); });
  return {
    workerRoot,
    evidence: () => ({ workerId, workerRoot, pid: child.pid ?? null, exitCode: child.exitCode ?? null, signalCode: child.signalCode ?? null, stdout: sanitizeString(stdout), stderr: sanitizeString(stderr) }),
    cleanup: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const deadline = Date.now() + 10_000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }
  };
}

/**
 * Round 19: the product submits distributed jobs under the operation's candidate workspace
 * (`.harness/distributed/pending` there), so the worker must poll that exact root. The round-18
 * worker was started at the fixture root before the operation, saw an empty queue and the
 * coordinator waited on `waitForDistributedSessionReady` until its 1,800 s bound.
 */
async function startDistributedWorkerAfterStart(fixtureRoot, operationId) {
  // Round 20: the initial bootstrap candidate's worktree is the control root; the operation
  // advances the candidate to its isolated execution workspace (the Paseo worktree) before
  // planning, and that is where the product submits distributed jobs. Wait for a distinct,
  // existing candidate worktree rather than falling back to the control root.
  const deadline = Date.now() + 300_000;
  const resolvedFixture = path.resolve(fixtureRoot);
  let record = await readJson(operationFile(fixtureRoot, operationId));
  let workerRoot = fixtureRoot;
  while (Date.now() < deadline) {
    const worktree = record?.candidateRevision?.worktree;
    if (typeof worktree === "string" && path.resolve(worktree) !== resolvedFixture
      && await fs.stat(worktree).then(() => true).catch(() => false)) { workerRoot = worktree; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
    record = await readJson(operationFile(fixtureRoot, operationId));
  }
  return spawnDistributedWorker(workerRoot, fixtureRoot);
}

// -------------------------------------------------------------------------------------------------
// Campaign
// -------------------------------------------------------------------------------------------------
const harnessRevisions = await harnessRevisionV1(fileURLToPath(import.meta.url));

const summary = {
  version: 1,
  slice: "S13",
  round,
  runId,
  roundLabel: `round-${round}/${runId} (attempt-specific summary and lane artifacts are immutable evidence)`,
  campaign: "governed-operations",
  generatedAt: new Date().toISOString(),
  checkout,
  sourceCommit: run("git", ["rev-parse", "HEAD"]).stdout,
  harnessRevisions,
  harnessBuildIdentity: buildIdentity,
  candidate: null,
  lanes: [],
  result: "UNKNOWN",
  paseoIsolation: { hermetic: true, home: paseoIsolation.home, port: paseoIsolation.port, daemonUrl: paseoIsolation.daemonUrl, setupAt: paseoIsolation.startedAt }
};

const before = await trackedDigest();
const gitStatusBefore = run("git", ["status", "--short"]).stdout;
const candidate = await packCandidate();
summary.candidate = { artifact: candidate.filename, artifactDigest: candidate.artifactDigest };

const laneNames = laneFilter.length ? laneFilter : Object.keys(laneDefinitions);
for (const name of laneNames) {
  const lane = laneDefinitions[name];
  if (!lane) { summary.lanes.push({ capability: name, result: "FAIL", error: "unknown lane" }); continue; }
  console.log(`S13 governed lane: ${name}`);
  const laneEvidence = { version: 1, slice: "S13", round, runId, capability: name, kind: lane.kind, providerPath: "FULL_OPERATION_REAL_PASEO", harnessRevisions, startedAt: new Date().toISOString() };
  const laneCheckoutBefore = await trackedDigest();
  let fixture;
  let workspacesBefore;
  let laneLeadAgentId;
  let laneAux;
  try {
    fixture = await prepareFixture(lane.fixture, candidate);
    laneEvidence.fixtureRoot = fixture.root;
    laneEvidence.candidateBinding = fixture.candidateBinding;
    laneEvidence.fixtureTopology = fixture.topologyOverride ? { source: "S13_GOV_BRAIN_* override", brain: fixture.topologyOverride } : { source: "product-default" };
    if (prepareOnly) {
      laneEvidence.result = "PREPARED";
      const topologyCheck = run(process.execPath, [candidateBinary(fixture.root), "agents", "check", "."], { cwd: fixture.root, env: laneEnvironment(), timeoutMs: 120_000 });
      laneEvidence.topologyCheck = { exitCode: topologyCheck.status, stdout: topologyCheck.stdout.slice(0, 2_000), stderr: topologyCheck.stderr.slice(0, 2_000) };
      laneEvidence.doctor = run(process.execPath, [candidateBinary(fixture.root), "doctor", "."], { cwd: fixture.root, env: laneEnvironment(), timeoutMs: 120_000 }).stdout.slice(0, 2_000);
      await fs.writeFile(path.join(laneRoot, `${name}.json`), `${sanitizeEvidence(JSON.stringify(laneEvidence, null, 2))}\n`);
      summary.lanes.push({ capability: name, result: "PREPARED", fixture: fixture.root, artifact: `docs/evidence/s13/governed-lanes/round-${round}/${runId}/${name}.json` });
      continue;
    }
    if (lane.prepare) laneAux = await lane.prepare(fixture.root, lane);
    workspacesBefore = new Set((await paseoWorkspaces()).map((workspace) => workspace.workspaceId));
    const { argv, started, operationId, leadAgentId } = await startOperation(lane, fixture.root);
    laneLeadAgentId = leadAgentId;
    laneEvidence.start = { argv: argv.slice(2), exitCode: started.status, stdout: started.stdout.slice(0, 2_000), stderr: started.stderr.slice(0, 2_000), operationId, leadAgentId };
    if (!operationId) throw new Error(`operation start did not report an operationId: ${started.stderr || started.stdout}`);
    if (lane.afterStart) laneAux = await lane.afterStart(fixture.root, operationId, laneAux);
    const watcher = startWorkspaceWatcher(fixture.root);
    const stageTrace = [];
    const record = await waitForTerminal(fixture.root, operationId, lane.timeoutMs, stageTrace);
    watcher.stop();
    laneEvidence.stageTrace = stageTrace;
    laneEvidence.workspaceWatch = { transitions: watcher.transitions.slice(0, 50), finalStates: watcher.states() };
    if (!record) throw new Error(`operation ${operationId} never produced a durable record`);
    if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(record.status)) {
      laneEvidence.timeout = true;
      laneEvidence.controllerBeforeCancel = { pid: record.pid ?? null, alive: processAlive(record.pid), phase: record.phase, revision: record.revision };
      laneEvidence.cancel = await cancelOperation(lane, fixture.root, operationId);
      laneEvidence.controllerAfterCancel = { alive: processAlive(record.pid) };
      const lateWaitSeconds = Number(process.env.S13_GOV_LATE_WAIT_SECONDS ?? "0");
      if (lateWaitSeconds > 0 && laneEvidence.controllerAfterCancel.alive) {
        const deadline = Date.now() + lateWaitSeconds * 1000;
        let latest = await readJson(operationFile(fixture.root, operationId));
        while ((!latest || !["SUCCEEDED", "FAILED", "CANCELLED"].includes(latest.status)) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          latest = await readJson(operationFile(fixture.root, operationId));
        }
        laneEvidence.lateTerminal = {
          lateWaitSeconds,
          operationStatus: latest?.status ?? null,
          operationRevision: latest?.revision ?? null,
          terminal: Boolean(latest && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(latest.status)),
          observedAt: new Date().toISOString()
        };
      }
    }
    const finalRecord = (await readJson(operationFile(fixture.root, operationId))) ?? record;
    laneEvidence.stageTrace ??= stageTrace;
    laneEvidence.terminalRecord = { status: finalRecord.status, phase: finalRecord.phase, revision: finalRecord.revision, error: finalRecord.error ?? null, finishedAt: finalRecord.finishedAt ?? null };
    laneEvidence.artifacts = await captureTerminalArtifacts(fixture.root, finalRecord);
    laneEvidence.candidateWorkspaceObservations = await candidateWorkspaceObservations(finalRecord);
    laneEvidence.traces = await captureTraces(fixture.root);
    laneEvidence.routeDiagnostics = {
      classification: "HYBRID",
      plannerAssessmentMechanism: "MODEL",
      routeGateMechanism: "DETERMINISTIC",
      participantArtifacts: laneEvidence.artifacts.participants.filter((artifact) => ["Explorer", "Planner"].includes(artifact.role)),
      triageEscalatedEvents: laneEvidence.traces.events.entries.filter((entry) => entry.name === "harness.change.triage-escalated")
    };
    const verification = await lane.verify({ fixtureRoot: fixture.root, record: finalRecord });
    const receipts = await collectSessionReceipts(finalRecord);
    const rowResults = {};
    for (const [row, ids] of Object.entries(verification.rows ?? {})) {
      const subset = verification.checks.filter((entry) => ids.includes(entry.id));
      rowResults[row] = subset.length === ids.length && subset.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
    }
    // Matrix rows are route-scoped by the lane verifier. Only checks assigned to
    // those observed rows participate in the lane aggregate.
    const applicableCheckIds = new Set(Object.values(verification.rows ?? {}).flat());
    const applicableChecks = verification.checks.filter((entry) => applicableCheckIds.has(entry.id));
    // R15-F3: a lane result can never read PASS unless the durable operation terminal state is
    // SUCCEEDED and the lane finished inside its bound. A truthful terminal FAILED (run-8) and a
    // late-terminal observation (direct-1) are both non-PASS, independent of the internal
    // AcceptanceOracle disposition.
    const terminalStatusOk = finalRecord.status === "SUCCEEDED";
    const bounded = laneEvidence.timeout !== true;
    Object.assign(laneEvidence, {
      candidateAssemblyReceipts: finalRecord.candidateAssemblyReceipts ?? null,
      operation: {
        id: finalRecord.id,
        status: finalRecord.status,
        phase: finalRecord.phase,
        kind: finalRecord.kind,
        intent: finalRecord.intent,
        result: finalRecord.result,
        revision: finalRecord.revision,
        operationExecutionRevision: finalRecord.operationExecutionRevision,
        controllerPid: finalRecord.pid ?? null,
        error: finalRecord.error ?? null,
        candidateRevision: finalRecord.candidateRevision,
        participants: Object.fromEntries(Object.entries(finalRecord.participants ?? {}).map(([id, participant]) => [id, { role: participant.role ?? null, logicalAgent: participant.logicalAgent ?? null, status: participant.status, phase: participant.phase ?? null, workspaceId: participant.workspaceId ?? null, resultArtifact: participant.resultArtifact ?? null, error: typeof participant.error === "string" ? participant.error.slice(0, 1_000) : null }])),
        participantReceipts: finalRecord.participantReceipts,
        candidateAssemblyReceipts: finalRecord.candidateAssemblyReceipts ?? null,
        supervision: { required: finalRecord.supervision?.required, materialized: finalRecord.supervision?.materialized, generations: (finalRecord.supervision?.generations ?? []).map((generation) => ({ generation: generation.generation, status: generation.status, agentId: generation.agentId, contextRatio: generation.contextRatio ?? null, drainingAt: generation.drainingAt ?? null, initializationEvidence: generation.initializationEvidence })) },
        stages: Object.fromEntries(Object.entries(finalRecord.stages ?? {}).map(([key, value]) => [key, value.status]))
      },
      sessionReceipts: receipts,
      oracle: { checks: verification.checks, applicableChecks, rowResults, detail: verification },
      terminal: { status: finalRecord.status ?? null, bounded, lateTerminal: laneEvidence.lateTerminal ?? null },
      result: Object.keys(verification.rows ?? {}).length > 0 && Object.values(rowResults).every((status) => status === "PASS") && applicableChecks.length > 0 && applicableChecks.every((entry) => entry.status === "PASS") && terminalStatusOk && bounded ? "PASS" : "FAIL"
    });
  } catch (error) {
    laneEvidence.result = "FAIL";
    laneEvidence.error = String(error?.stack ?? error);
  }
  if (laneAux?.cleanup) {
    try { await laneAux.cleanup(); } catch (error) { laneEvidence.auxCleanupError = String(error); }
  }
  if (laneAux?.evidence) laneEvidence.workerProcess = laneAux.evidence();
  try {
    if (fixture) {
      const projectName = path.basename(fixture.root);
      const scopeArgs = { projectName, fixtureRoot: fixture.root, operationId: laneEvidence.operation?.id, operation: laneEvidence.operation };
      const inventory = await workspaceLaneScope(scopeArgs);
      const beforeIds = workspacesBefore ?? new Set();
      laneEvidence.workspaceInventory = inventory.map((workspace) => ({ workspaceId: workspace.workspaceId, project: workspace.project, cwd: workspace.cwd ?? null, laneCreated: !beforeIds.has(workspace.workspaceId) }));
      const archiveDecision = workspaceArchiveDecision(laneEvidence.terminalRecord?.status, Boolean(laneEvidence.operation?.controllerPid && processAlive(laneEvidence.operation.controllerPid)));
      const operationTerminal = archiveDecision.operationTerminal;
      const controllerExited = archiveDecision.controllerExited;
      if ((!keepStaging || archiveEvidence) && archiveDecision.eligible) {
        const archiveRun = await archiveLaneWorkspaces(inventory, beforeIds);
        const remainingAfter = await workspaceLaneScope(scopeArgs);
        const accounting = accountWorkspaceCleanupV1(inventory, archiveRun.archived, remainingAfter);
        laneEvidence.workspaceCleanup = {
          archived: archiveRun.archived,
          preExistingUntouched: archiveRun.preExisting,
          remaining: remainingAfter.map((workspace) => workspace.workspaceId),
          accounting
        };
        if (!accounting.accounted) laneEvidence.workspaceAccountingError = `R18-F2: unaccounted workspaces ${accounting.unaccounted.join(",")}`;
      } else if ((!keepStaging || archiveEvidence) && !archiveDecision.eligible) {
        const accounting = accountWorkspaceCleanupV1(inventory, [], inventory);
        laneEvidence.workspaceCleanup = { skipped: true, reason: "controller-not-terminal-or-still-alive", operationTerminal, controllerExited, remaining: inventory.map((workspace) => workspace.workspaceId), accounting };
      } else {
        const accounting = accountWorkspaceCleanupV1(inventory, [], inventory);
        laneEvidence.workspaceCleanup = { skipped: true, reason: "S13_GOV_KEEP=1", archiveEvidence: false, remaining: inventory.map((workspace) => workspace.workspaceId), accounting };
      }
      if (laneEvidence.timeout && laneEvidence.workspaceCleanup?.reason === "controller-not-terminal-or-still-alive") {
        laneEvidence.postCampaignOperationRead = await postCampaignOperationRead(fixture.root, laneEvidence.operation?.id, laneEvidence.operation);
        if (laneEvidence.postCampaignOperationRead.terminal && !laneEvidence.postCampaignOperationRead.controllerAlive) {
          const lateInventory = await workspaceLaneScope(scopeArgs);
          const lateRun = await archiveLaneWorkspaces(lateInventory, beforeIds);
          const lateRemaining = await workspaceLaneScope(scopeArgs);
          const lateAccounting = accountWorkspaceCleanupV1(lateInventory, lateRun.archived, lateRemaining);
          laneEvidence.workspaceCleanup.postCampaignArchive = { archived: lateRun.archived, preExistingUntouched: lateRun.preExisting, remaining: lateRemaining.map((workspace) => workspace.workspaceId), accounting: lateAccounting };
          laneEvidence.workspaceCleanup.archivedAfterControllerExit = true;
        } else {
          laneEvidence.workspaceCleanup.archivedAfterControllerExit = false;
        }
      }
      if (!laneEvidence.postCampaignOperationRead && laneEvidence.operation?.id) {
        laneEvidence.postCampaignOperationRead = await postCampaignOperationRead(fixture.root, laneEvidence.operation.id, laneEvidence.operation, 0);
      }
    }
  } catch (error) {
    laneEvidence.workspaceCleanupError = String(error);
  }
  // The lane Lead is a real Paseo agent owned by this run; delete it after the lane is terminal so
  // no certification fixture agent remains active.
  if (laneLeadAgentId) {
    const deleted = run("paseo", ["agent", "delete", laneLeadAgentId], { timeoutMs: 60_000 });
    laneEvidence.leadAgentCleanup = { agentId: laneLeadAgentId, exitCode: deleted.status };
  }
  // R7-F4: campaign-emitted checkout proof inside every durable lane envelope.
  const laneCheckoutAfter = await trackedDigest();
  laneEvidence.checkoutProof = {
    trackedDigestBefore: laneCheckoutBefore.digest,
    trackedDigestAfter: laneCheckoutAfter.digest,
    trackedFiles: laneCheckoutBefore.files,
    checkoutUntouched: laneCheckoutBefore.digest === laneCheckoutAfter.digest,
    postRunTrackedDocEditWindow: {
      opensAfterLaneFinish: true,
      note: "S13 tracked documentation/evidence is edited after lane execution; the recorded digest is the source-tree digest at lane end (R11-F6)."
    }
  };
  laneEvidence.finishedAt = new Date().toISOString();
  laneEvidence.durationMs = Date.parse(laneEvidence.finishedAt) - Date.parse(laneEvidence.startedAt);
  await fs.writeFile(path.join(laneRoot, `${name}.json`), `${sanitizeEvidence(JSON.stringify(laneEvidence, null, 2))}\n`);
  const archived = [...(laneEvidence.workspaceCleanup?.archived ?? []), ...(laneEvidence.workspaceCleanup?.postCampaignArchive?.archived ?? [])];
  const remaining = laneEvidence.workspaceCleanup?.postCampaignArchive?.remaining ?? laneEvidence.workspaceCleanup?.remaining;
  const workspaceAccounting = laneEvidence.workspaceCleanup?.postCampaignArchive?.accounting ?? laneEvidence.workspaceCleanup?.accounting ?? null;
  summary.lanes.push({ capability: name, result: laneEvidence.result, status: laneEvidence.operation?.status ?? null, terminal: laneEvidence.terminal ?? null, route: laneEvidence.operation?.intent?.route ?? null, sessions: laneEvidence.sessionReceipts?.length ?? 0, oracle: laneEvidence.result, acceptanceOracleDisposition: laneEvidence.operation?.result?.acceptanceOracle?.disposition ?? null, rows: laneEvidence.oracle?.rowResults ?? null, error: laneEvidence.error ?? null, durationMs: laneEvidence.durationMs, timeout: laneEvidence.timeout ?? false, lateTerminal: laneEvidence.lateTerminal ?? null, postCampaignOperationRead: laneEvidence.postCampaignOperationRead ?? null, checkoutUntouched: laneEvidence.checkoutProof?.checkoutUntouched ?? null, workspacesArchived: Array.isArray(archived) ? archived.length : null, workspacesRemaining: Array.isArray(remaining) ? remaining.length : null, workspaceAccounting, fixtureTopology: laneEvidence.fixtureTopology ?? null, artifact: `docs/evidence/s13/governed-lanes/round-${round}/${runId}/${name}.json` });
  console.log(JSON.stringify(summary.lanes.at(-1)));
}

const paseoCleanup = await teardownIsolatedPaseoHome(paseoIsolation);
summary.paseoCleanup = {
  hermetic: true,
  agentsDeleted: paseoCleanup.agentsDeleted,
  workspacesArchived: paseoCleanup.workspacesArchived,
  remainingAgents: paseoCleanup.remainingAgents ?? [],
  remainingWorkspaces: paseoCleanup.remainingWorkspaces ?? [],
  orphanFree: paseoCleanup.orphanFree ?? false,
  daemonStopped: paseoCleanup.daemonStopped,
  homeRemoved: paseoCleanup.homeRemoved
};
if (!summary.paseoCleanup.orphanFree) {
  for (const lane of summary.lanes) if (lane.result === "PASS") lane.result = "FAIL";
}
const after = await trackedDigest();
summary.checkoutProof = {
  trackedDigestBefore: before.digest,
  trackedDigestAfter: after.digest,
  trackedFiles: before.files,
  checkoutUntouched: before.digest === after.digest,
  gitStatusBefore,
  gitStatusAfter: run("git", ["status", "--short"]).stdout,
  note: "Tracked-file digest captured before packing and after all governed lanes; candidates execute only inside disposable /tmp fixtures with Paseo resources in the isolated daemon home.",
  // R11-F6: tracked documentation/evidence updates (S13 WorkGraph, STATUS, CONFORMANCE, LEDGER)
  // are written after the lanes finish; the recorded digest is the source-tree digest at run end.
  // A later repo-wide digest recomputation includes those documented edits and must be compared
  // against this window rather than read as candidate/source drift.
  postRunTrackedDocEditWindow: {
    opensAfter: new Date().toISOString(),
    note: "Tracked documentation writes after this timestamp are expected; compare source digests only within a run window."
  }
};
summary.result = summary.lanes.some((lane) => lane.result !== "PASS") ? "SLICE_BLOCKED" : "PASS";

const roundLaneRoot = path.join(evidenceRoot, `governed-lanes/round-${round}`, runId);
await fs.mkdir(roundLaneRoot, { recursive: true });
for (const entry of await fs.readdir(laneRoot)) await fs.copyFile(path.join(laneRoot, entry), path.join(roundLaneRoot, entry));
const summaryPath = path.join(evidenceRoot, `s13-governed-operations-round-${round}-${runId}.json`);
await fs.writeFile(summaryPath, `${sanitizeEvidence(JSON.stringify(summary, null, 2))}\n`);
const summaryDigest = crypto.createHash("sha256").update(await fs.readFile(summaryPath)).digest("hex");
if (!keepStaging) console.log(`staging=${staging}`);
console.log(JSON.stringify({ result: summary.result, lanes: summary.lanes, immutableSummaryDigest: summaryDigest, evidence: path.relative(checkout, summaryPath) }, null, 2));
process.exit(summary.lanes.some((lane) => lane.result !== "PASS") || !summary.checkoutProof.checkoutUntouched ? 1 : 0);
