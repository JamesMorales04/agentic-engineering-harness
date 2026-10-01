import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { harnessRevisionV1 } from "./s13CampaignHarnessRevision.mjs";

/**
 * S13 real-provider certification campaign.
 *
 * Builds/packs the current checkout through the canonical packed bootstrap, then runs bounded
 * real-provider journeys against the disposable fixture and verifies durable artifacts with a
 * deterministic capability oracle. The candidate is never executed against the source checkout.
 *
 * Usage: node tests/packed/s13RealProviderCertification.mjs [checkout]
 * Optional: S13_LANES=startup,informational node ...
 */

const checkout = path.resolve(process.argv[2] ?? process.cwd());
const laneFilter = (process.env.S13_LANES ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const reuseLanes = process.env.S13_REUSE_LANES === "1";
const dist = path.join(checkout, "dist");
const releaseId = (await fs.readFile(path.join(dist, "current"), "utf8")).trim();
const release = path.join(dist, "releases", releaseId);
const certify = await import(pathToFileURL(path.join(release, "certification", "index.js")));
const buildIdentity = (await import(pathToFileURL(path.join(release, "build", "identity.js")))).getBuildIdentity();

const staging = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s13-campaign-"));
const evidenceRoot = path.join(checkout, "docs", "evidence", "s13");
const laneRoot = path.join(staging, "lanes");
const reportsRoot = path.join(staging, "reports");
await fs.mkdir(laneRoot, { recursive: true });
await fs.mkdir(reportsRoot, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeoutMs ?? 30_000, cwd: options.cwd ?? checkout, env: options.env ?? process.env });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim(), error: result.error ? String(result.error) : undefined };
}

function resolveBinary(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    try {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* next */ }
  }
  return undefined;
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

async function gitStatusShort() {
  return execFileSync("git", ["status", "--short"], { cwd: checkout, maxBuffer: 16 * 1024 * 1024 }).toString().trim();
}

async function toolchainFacts() {
  const codexLogin = run("codex", ["login", "status"], { timeoutMs: 30_000 });
  const codexText = `${codexLogin.stdout}\n${codexLogin.stderr}`;
  const ghStatus = run("gh", ["auth", "status"], { timeoutMs: 30_000 });
  const ghText = `${ghStatus.stdout}\n${ghStatus.stderr}`;
  const account = /account\s+(\S+)/.exec(ghText)?.[1];
  const scopes = /Token scopes:\s*(.+)/.exec(ghText)?.[1]?.trim();
  const absent = {};
  for (const tool of ["trivy", "podman", "opa", "cosign", "buildah", "crun", "opengrep"]) absent[tool] = resolveBinary(tool) ? "present" : "absent";
  return {
    codex: { version: run("codex", ["--version"]).stdout, authenticated: /Logged in/.test(codexText), authMode: /Logged in using (.+)/.exec(codexText)?.[1] ?? null },
    gh: { authenticated: ghStatus.status === 0, account: account ?? null, scopes: scopes ?? null },
    paseo: { version: run("paseo", ["--version"]).stdout },
    playwright: { version: run(path.join(checkout, "node_modules", ".bin", "playwright"), ["--version"]).stdout || null },
    node: process.version,
    python3: run("python3", ["--version"]).stdout,
    bwrap: run("bwrap", ["--version"]).stdout,
    tools: absent,
    s10TrivyPath: "/tmp/opencode/s10-tools/trivy/0.70.0/trivy"
  };
}

function canonicalGitignoreBlock() {
  return [
    "# BEGIN Agentic Engineering Harness generated state",
    ".harness/*",
    "!.harness/project.yaml",
    "!.harness/toolchain.yaml",
    "!.harness/provider-versions.json",
    "!.harness/agents.source.jsonc",
    "!.harness/otel-collector.yaml",
    ".config/mise/conf.d/aeh.toml",
    "# END Agentic Engineering Harness generated state"
  ].join("\n");
}

async function createFixtureSource() {
  const source = path.join(staging, "fixture-source");
  await fs.mkdir(path.join(source, ".harness"), { recursive: true });
  await fs.mkdir(path.join(source, "openspec"), { recursive: true });
  const templates = path.join(checkout, "templates");
  for (const [from, to] of [
    ["toolchain.yaml", ".harness/toolchain.yaml"],
    ["provider-versions.json", ".harness/provider-versions.json"],
    ["otel-collector.yaml", ".harness/otel-collector.yaml"],
    ["AGENTS.md", "AGENTS.md"],
    ["openspec-config.yaml", "openspec/config.yaml"]
  ]) await fs.copyFile(path.join(templates, from), path.join(source, to));
  await fs.writeFile(path.join(source, ".harness", "project.yaml"), [
    "version: 1",
    "",
    "project:",
    "  name: s13-real-provider-fixture",
    "",
    "validation:",
    "  baseRef: HEAD",
    ""
  ].join("\n"));
  await fs.writeFile(path.join(source, ".harness", "agents.source.jsonc"), `${JSON.stringify({
    version: 1,
    extends: ["aeh:orchestration"],
    activeProfile: "balanced",
    models: {},
    agents: {},
    routing: []
  }, null, 2)}\n`);
  await fs.writeFile(path.join(source, "package.json"), `${JSON.stringify({ name: "s13-real-provider-fixture", version: "1.0.0", private: true }, null, 2)}\n`);
  await fs.writeFile(path.join(source, ".gitignore"), `node_modules/\ndist/\n\n${canonicalGitignoreBlock()}\n`);
  return source;
}

const FIXTURE_SETUP = [
  { command: "git", args: ["init", "-q"] },
  { command: "git", args: ["config", "core.fsmonitor", "false"] },
  { command: "git", args: ["config", "user.email", "s13@aeh.invalid"] },
  { command: "git", args: ["config", "user.name", "S13 Campaign"] }
];

function policyFor(capability) {
  return certify.defaultCertificationPolicy({
    id: `s13-real-provider-${capability}`,
    budget: { maxAttempts: 1, maxDurationMs: 10 * 60_000, maxOutputBytes: 4 * 1024 * 1024 },
    security: { ...certify.defaultCertificationPolicy().security, allowNetwork: true, maxOutputBytes: 8 * 1024 * 1024 }
  });
}

function actorRequest(capability, candidateRoot, prompt) {
  return {
    version: 1,
    requestId: `s13-${capability}-${Date.now()}`,
    role: "actor",
    prompt,
    cwd: path.resolve(candidateRoot),
    command: "codex",
    args: [],
    timeoutMs: 5 * 60_000,
    maxOutputBytes: 4 * 1024 * 1024,
    allowNetwork: true,
    environmentAllowlist: [],
    credentialEnvAllowlist: []
  };
}

/**
 * Direct transport for a packed product command whose real provider is an inner Paseo model session.
 * It records the exact argv, exit code, and captured output as a provider receipt; the real model
 * receipt is the durable semantic assessment plus the daemon session snapshot captured after the run.
 */
function createDirectProvider() {
  return {
    name: "packed-direct",
    networkIsolation: "enforced",
    async execute(request) {
      const began = Date.now();
      const result = await certify.executeArgv(request.command, request.args, {
        cwd: request.cwd,
        env: certify.buildProviderEnvironment(request),
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
        allowNetwork: request.allowNetwork
      });
      const command = [request.command, ...request.args].join(" ");
      const events = [
        { at: new Date(began).toISOString(), type: "started", data: { requestId: request.requestId } },
        { at: new Date().toISOString(), type: "json", data: { type: "item.completed", item: { type: "command_execution", command, exit_code: result.exitCode, aggregated_output: `${result.stdout}\n${result.stderr}` } } },
        { at: new Date().toISOString(), type: result.status === "TIMED_OUT" ? "timeout" : "finished", data: { exitCode: result.exitCode, status: result.status } }
      ];
      let structuredOutput;
      try {
        const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
        structuredOutput = line ? JSON.parse(line) : { executed: true };
      } catch { structuredOutput = { executed: true }; }
      return {
        version: 1,
        provider: "packed-direct",
        requestId: request.requestId,
        role: request.role,
        ...result,
        events,
        structuredOutput,
        usage: {},
        usageKnown: false,
        executionEvidence: { started: true, provider: "packed-direct", command: request.command, startedAt: new Date(began).toISOString(), finishedAt: new Date().toISOString(), processExitCode: result.exitCode }
      };
    }
  };
}

async function capturePaseoSessionReceipt(report) {
  const detail = report?.oracle?.evidence?.answer?.detail ?? report?.oracle?.evidence?.intent?.detail;
  const agentId = detail?.paseoSession?.agentId ?? detail?.assessments?.[0]?.paseoSession?.agentId;
  if (!agentId) return null;
  const inspected = run("paseo", ["inspect", agentId, "--json"], { timeoutMs: 30_000 });
  let snapshot;
  try { const parsed = JSON.parse(inspected.stdout); snapshot = parsed.snapshot ?? parsed; } catch { snapshot = undefined; }
  const pick = (...keys) => { for (const key of keys) if (snapshot && snapshot[key] !== undefined) return snapshot[key]; return null; };
  const receipt = snapshot ? {
    agentId,
    provider: pick("provider", "Provider"),
    model: pick("model", "Model"),
    thinkingOptionId: pick("thinkingOptionId", "Thinking"),
    status: pick("status", "Status"),
    sessionId: pick("sessionId", "SessionId"),
    modeId: pick("currentModeId", "Mode"),
    lastUsage: pick("lastUsage", "LastUsage"),
    labels: pick("labels", "Labels"),
    createdAt: pick("createdAt", "CreatedAt"),
    updatedAt: pick("updatedAt", "UpdatedAt")
  } : { agentId, inspectExitCode: inspected.status, raw: inspected.stdout.slice(0, 1_000) };
  run("paseo", ["delete", agentId], { timeoutMs: 30_000 });
  return receipt;
}

function registryPath(candidateRoot) { return path.join(candidateRoot, ".harness", "s13-registry", "registry.json"); }

/** Strip pairing fragments and one-use route credentials before any evidence artifact is persisted. */
function sanitizeString(value) {
  return value
    .replace(/#pair=[^\s"'\\]+/g, "#pair=REDACTED")
    .replace(/controlCenterPairing=[^\s"'\\]+/g, "controlCenterPairing=REDACTED")
    .replace(/([?&](?:token|code|nonce|csrf)=)[^\s"'\\&]+/gi, "$1REDACTED");
}

function sanitizeEvidence(value) {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeEvidence(item)]));
  return value;
}

async function readRegistry(candidateRoot) {
  const raw = await fs.readFile(registryPath(candidateRoot), "utf8");
  return JSON.parse(raw);
}

function commandsFrom(actor) {
  return certify.actorCommandExecutions(actor).map((execution) => ({ command: execution.command, exitCode: execution.exitCode, output: execution.output }));
}

const laneDefinitions = {
  startup: {
    actorCommands: [
      { label: "init", contains: "node_modules/agentic-engineering-harness/dist/main.js init" },
      { label: "doctor", contains: "node_modules/agentic-engineering-harness/dist/main.js doctor" }
    ],
    prompt: () => [
      "You are the external provider actor for a bounded AEH certification journey inside a disposable fixture.",
      "Working directory is the fixture root; the fixture contains only the freshly packed candidate and fixture project files.",
      "Run exactly these two commands with the shell, one after the other, and wait for each to finish:",
      "1) node node_modules/agentic-engineering-harness/dist/main.js init .",
      "2) node node_modules/agentic-engineering-harness/dist/main.js doctor .",
      "Do not modify, create, or delete any files directly. Do not run any other commands. Then reply with the two exit codes."
    ].join("\n"),
    verify: async ({ candidateRoot, actor }) => {
      const packageRoot = path.join(candidateRoot, "node_modules", "agentic-engineering-harness");
      const distCurrent = await fs.readFile(path.join(packageRoot, "dist", "current"), "utf8").catch(() => "");
      const installedIdentity = JSON.parse(await fs.readFile(path.join(packageRoot, "dist", "releases", distCurrent.trim(), "build-identity.json"), "utf8").catch(() => "null"));
      const projectYaml = await fs.readFile(path.join(candidateRoot, ".harness", "project.yaml"), "utf8").catch(() => "");
      const agentsSource = await fs.readFile(path.join(candidateRoot, ".harness", "agents.source.jsonc"), "utf8").catch(() => "");
      const agentsDoc = await fs.readFile(path.join(candidateRoot, "AGENTS.md"), "utf8").catch(() => "");
      const commands = commandsFrom(actor);
      const doctor = commands.find((entry) => entry.command.includes("dist/main.js doctor"));
      return {
        install: { ok: Boolean(installedIdentity?.releaseId && installedIdentity.buildDigest), detail: { releaseId: installedIdentity?.releaseId ?? null, buildDigest: installedIdentity?.buildDigest ?? null, packageVersion: installedIdentity?.packageVersion ?? null } },
        doctor: { ok: doctor?.exitCode === 0, detail: { exitCode: doctor?.exitCode ?? null, output: (doctor?.output ?? "").slice(-1_000) } },
        startup: { ok: projectYaml.includes("version: 1") && projectYaml.includes("name: s13-real-provider-fixture") && agentsSource.length > 0 && agentsDoc.length > 0, detail: { projectConfig: projectYaml.split("\n").slice(0, 6).join("\n"), agentsSourceBytes: agentsSource.length, agentsDocBytes: agentsDoc.length } }
      };
    }
  },
  informational: {
    direct: true,
    actorCommands: [{ label: "intent", contains: "node_modules/agentic-engineering-harness/dist/main.js intent", output: /INFORMATIONAL/i }],
    prompt: () => [
      "You are the external provider actor for a bounded AEH certification journey inside a disposable fixture.",
      "Working directory is the fixture root; the fixture contains the freshly packed candidate.",
      "Run exactly this command with the shell and wait for it to finish (it may fail):",
      'node node_modules/agentic-engineering-harness/dist/main.js intent "Explain how the validation system works." .',
      "Do not modify, create, or delete any files directly and do not run any other commands. Report the command exit code and any error text."
    ].join("\n"),
    verify: async ({ candidateRoot }) => {
      const cacheDirectory = path.join(candidateRoot, ".harness", "cache", "semantic-assessments-v1");
      const entries = await fs.readdir(cacheDirectory).catch(() => []);
      const assessments = [];
      for (const entry of entries.filter((name) => name.endsWith(".json")).slice(0, 8)) {
        const parsed = JSON.parse(await fs.readFile(path.join(cacheDirectory, entry), "utf8").catch(() => "null"));
        if (parsed) assessments.push({
          file: entry,
          judgmentType: parsed.judgment?.type ?? null,
          intent: parsed.judgment?.intent ?? null,
          assessmentDigest: parsed.assessmentDigest ?? null,
          mechanism: parsed.mechanism ?? null,
          paseoSession: parsed.paseoSession ?? null,
          assessor: parsed.assessor ?? null,
          model: parsed.model ?? null
        });
      }
      const intent = assessments.find((entry) => entry.judgmentType === "INTENT");
      const session = intent?.paseoSession ?? null;
      return {
        intent: { ok: Boolean(intent && /^[a-f0-9]{64}$/.test(String(intent.assessmentDigest)) && typeof session?.provider === "string" && typeof session?.agentId === "string"), detail: { assessments } },
        answer: { ok: Boolean(intent && typeof intent.intent === "string" && typeof session?.agentId === "string"), detail: { intent: intent?.intent ?? null, paseoSession: session } }
      };
    }
  },
  "project-home": {
    actorCommands: [
      { label: "register", contains: "node_modules/agentic-engineering-harness/dist/main.js project register" },
      { label: "home", contains: "node_modules/agentic-engineering-harness/dist/main.js home", output: /AEH Home ready at http:\/\/127\.0\.0\.1:\d+/ }
    ],
    prompt: (candidateRoot) => [
      "You are the external provider actor for a bounded AEH certification journey inside a disposable fixture.",
      `Run exactly this command with the shell and wait for it: node node_modules/agentic-engineering-harness/dist/main.js project register . --repository https://example.invalid/s13/project-home --display-name "S13 Home" --registry ${registryPath(candidateRoot)}`,
      `Then run exactly: node node_modules/agentic-engineering-harness/dist/main.js home --once --registry ${registryPath(candidateRoot)}`,
      "Do not modify, create, or delete any files directly and do not run any other commands. Then reply with both exit codes."
    ].join("\n"),
    verify: async ({ candidateRoot }) => {
      const registry = await readRegistry(candidateRoot).catch(() => undefined);
      const projects = Array.isArray(registry?.projects) ? registry.projects : [];
      const project = projects[0];
      const canonical = project?.canonicalRealpath ? await fs.realpath(project.canonicalRealpath).catch(() => null) : null;
      const available = canonical ? (await fs.stat(canonical).catch(() => undefined))?.isDirectory() === true : false;
      return {
        "project-id": { ok: typeof project?.projectId === "string" && project.projectId.length > 0, detail: { projectId: project?.projectId ?? null, repositoryIdentity: project?.repositoryIdentity ?? null, canonicalRealpath: canonical } },
        health: { ok: available, detail: { availability: available ? "available" : "moved-or-missing", health: project?.health ?? null } }
      };
    }
  },
  "multi-project": {
    actorCommands: [
      { label: "init-b", contains: "node_modules/agentic-engineering-harness/dist/main.js init .harness/projects/project-b" },
      { label: "register-a", contains: "node_modules/agentic-engineering-harness/dist/main.js project register . --repository https://example.invalid/s13/project-a" },
      { label: "register-b", contains: "node_modules/agentic-engineering-harness/dist/main.js project register .harness/projects/project-b --repository https://example.invalid/s13/project-b" },
      { label: "list", contains: "node_modules/agentic-engineering-harness/dist/main.js project list" }
    ],
    prompt: (candidateRoot) => [
      "You are the external provider actor for a bounded AEH certification journey inside a disposable fixture.",
      "Run exactly these commands with the shell, one after the other, and wait for each:",
      "1) node node_modules/agentic-engineering-harness/dist/main.js init .harness/projects/project-b",
      `2) node node_modules/agentic-engineering-harness/dist/main.js project register . --repository https://example.invalid/s13/project-a --display-name "S13 Shared Name" --registry ${registryPath(candidateRoot)}`,
      `3) node node_modules/agentic-engineering-harness/dist/main.js project register .harness/projects/project-b --repository https://example.invalid/s13/project-b --display-name "S13 Shared Name" --registry ${registryPath(candidateRoot)}`,
      `4) node node_modules/agentic-engineering-harness/dist/main.js project list --registry ${registryPath(candidateRoot)}`,
      "Do not modify, create, or delete any files directly and do not run any other commands. Then reply with the four exit codes."
    ].join("\n"),
    verify: async ({ candidateRoot }) => {
      const registry = await readRegistry(candidateRoot).catch(() => undefined);
      const projects = Array.isArray(registry?.projects) ? registry.projects : [];
      const identities = projects.map((project) => project.repositoryIdentity).filter(Boolean);
      const projectIds = projects.map((project) => project.projectId).filter(Boolean);
      const paths = projects.map((project) => project.canonicalRealpath).filter(Boolean);
      const displayNames = new Set(projects.map((project) => project.displayName).filter(Boolean));
      return {
        "repository-identity": { ok: projects.length === 2 && new Set(identities).size === 2 && new Set(projectIds).size === 2 && new Set(paths).size === 2, detail: { count: projects.length, repositoryIdentities: identities, projectIds, canonicalRealpaths: paths } },
        "project-selection": { ok: displayNames.size === 1 && projects.length === 2, detail: { displayNames: [...displayNames], isolatedBy: ["repositoryIdentity", "projectId", "canonicalRealpath"] } }
      };
    }
  }
};

async function runLane(capability, fixtureSource, summary) {
  const definition = laneDefinitions[capability];
  const laneEvidence = { version: 1, capability, provider: definition.direct ? "packed-direct+paseo" : "codex", harnessRevisions, startedAt: new Date().toISOString() };
  try {
    const oracle = certify.createCapabilityJourneyOracle({
      id: `s13-journey:${capability}`,
      capability,
      verify: definition.verify,
      actorCommands: definition.actorCommands
    });
    const provider = definition.direct
      ? createDirectProvider()
      : new certify.CodexAgentProvider({
        model: "gpt-6-luna",
        reasoningEffort: "low",
        extraArgs: ["-c", "sandbox_workspace_write.network_access=true"]
      });
    const actorFactory = definition.direct
      ? (candidateRoot) => ({
        version: 1,
        requestId: `s13-${capability}-direct-${Date.now()}`,
        role: "actor",
        prompt: "",
        cwd: path.resolve(candidateRoot),
        command: process.execPath,
        args: ["node_modules/agentic-engineering-harness/dist/main.js", "intent", "Explain how the validation system works.", "."],
        timeoutMs: 8 * 60_000,
        maxOutputBytes: 4 * 1024 * 1024,
        allowNetwork: true,
        environmentAllowlist: [],
        credentialEnvAllowlist: []
      })
      : (candidateRoot) => actorRequest(capability, candidateRoot, definition.prompt(candidateRoot));
    const report = await certify.runExternalSelfDogfood({
      root: checkout,
      fixture: { sourceDir: fixtureSource, setup: FIXTURE_SETUP },
      oracle,
      policy: policyFor(capability),
      provider,
      actor: actorFactory,
      capability,
      requireModelE2E: true,
      persistRoot: staging,
      persistDirectory: "reports"
    });
    const actor = report.providerResults[0];
    laneEvidence.report = {
      certificationId: report.certificationId,
      state: report.state,
      accepted: report.accepted,
      assurance: report.assurance,
      policyId: report.policyId,
      harnessBuildIdentity: report.buildIdentity,
      candidate: report.candidate,
      networkPolicy: report.networkPolicy,
      budget: report.budget,
      attempts: report.attempts,
      oracle: {
        status: report.oracle.status,
        oracleId: report.oracle.oracleId,
        checks: report.oracle.checks.map((check) => ({ id: check.id, category: check.category, status: check.status, required: check.required, message: check.message, evidence: check.evidence })),
        failures: report.oracle.failures,
        evidence: report.oracle.evidence
      },
      provider: actor ? {
        provider: actor.provider,
        status: actor.status,
        exitCode: actor.exitCode,
        usage: actor.usage,
        usageKnown: actor.usageKnown,
        outputTruncated: actor.outputTruncated,
        executionEvidence: actor.executionEvidence,
        commandExecutions: certify.actorCommandExecutions(actor).map((execution) => ({ command: execution.command.slice(0, 500), exitCode: execution.exitCode, output: execution.output.slice(-2_000) }))
      } : null,
      capability: report.capability
    };
    if (capability === "informational") laneEvidence.paseoSessionReceipt = await capturePaseoSessionReceipt(report);
    laneEvidence.result = report.accepted ? "PASS" : "FAIL";
  } catch (error) {
    laneEvidence.result = "FAIL";
    laneEvidence.error = String(error);
  }
  laneEvidence.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(laneRoot, `${capability}.json`), `${sanitizeEvidence(JSON.stringify(laneEvidence, null, 2))}\n`);
  summary.lanes.push({ capability, result: laneEvidence.result, accepted: laneEvidence.report?.accepted ?? false, oracleStatus: laneEvidence.report?.oracle.status ?? null, error: laneEvidence.error ?? null, artifact: `docs/evidence/s13/lanes/${capability}.json` });
  return laneEvidence;
}

const MATRIX = [
  { capability: "startup", providerPath: "PACKED_CODEX", disposition: "CERTIFIABLE_NOW", requiredAction: null },
  { capability: "informational", providerPath: "PACKED_PASEO_MODEL", disposition: "CERTIFIABLE_NOW", requiredAction: null },
  { capability: "audit", providerPath: "FULL_OPERATION", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Build and authorize the packed governed-operation campaign (fresh npm pack candidate, real Paseo + real local model provider, deterministic per-row oracle). The default workhorse model alias is fixed and resolves to a real session." },
  { capability: "change", providerPath: "FULL_OPERATION", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Same as audit: build and authorize the packed governed-operation campaign." },
  { capability: "direct-change", providerPath: "FULL_OPERATION", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Same as audit: build and authorize the packed governed-operation campaign." },
  { capability: "delegated-change", providerPath: "FULL_OPERATION", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Same as audit, plus multi-worker Paseo provider sessions." },
  { capability: "formal-sdd", providerPath: "FULL_OPERATION", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Same as audit, plus an installed OpenSpec authoring provider." },
  { capability: "multi-worker", providerPath: "FULL_OPERATION", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Same as audit, plus a real wave/multi-participant provider harness." },
  { capability: "cancel", providerPath: "REAL_PASEO_SESSION", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Extend the packed lifecycle campaign to real Paseo inspect/stop/takeover instead of the S9 deterministic stubs (production inspectManagedPaseoAgent/stopManagedPaseoAgent exist)." },
  { capability: "recovery", providerPath: "REAL_PASEO_SESSION", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Same as cancel: real provider session takeover/restart receipts are required and the S9 harness is deterministic-stubbed." },
  { capability: "product-repair", providerPath: "FULL_OPERATION", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Same as audit: build and authorize the packed governed-operation campaign." },
  { capability: "certification-repair", providerPath: "FULL_OPERATION", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Same as product-repair; the CertificationCore repair loop is not the product repair capability." },
  { capability: "repair", providerPath: "FULL_OPERATION", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Same as product-repair; the CertificationCore repair loop is not the product repair capability." },
  { capability: "context-handoff", providerPath: "FULL_OPERATION", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Same as audit, plus a real multi-session continuation journey." },
  { capability: "permission-delegation", providerPath: "FULL_OPERATION", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Same as audit, plus a real multi-participant lease delegation journey." },
  { capability: "issue-driven", providerPath: "FULL_OPERATION+GITHUB_WRITE", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Provide an authorized disposable GitHub repository for real issue/branch/push/PR effects, plus the packed governed-operation campaign." },
  { capability: "delivery", providerPath: "FULL_OPERATION+GITHUB_WRITE", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Provide an authorized disposable GitHub repository plus an accepted packed candidate; no public effects are authorized in this environment." },
  { capability: "distributed-execution", providerPath: "FULL_OPERATION", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Same as audit, plus a real distributed worker queue journey." },
  { capability: "project-home", providerPath: "PACKED_CODEX", disposition: "CERTIFIABLE_NOW", requiredAction: null },
  { capability: "multi-project", providerPath: "PACKED_CODEX", disposition: "CERTIFIABLE_NOW", requiredAction: null },
  { capability: "control-center", providerPath: "BROWSER", disposition: "NOT_APPLICABLE", requiredAction: "No model/provider journey; the real Playwright Chromium lane is separately reported (S11)." },
  { capability: "authority", providerPath: "FULL_OPERATION+HUMAN", disposition: "BLOCKED_UNAVAILABLE_PROVIDER", requiredAction: "Provide the packed governed-operation campaign and an authorized gated external effect target for a human-approved action." }
];

const ORACLE_CONTRACTS = {
  startup: "packed install identity (dist/current + build-identity.json) + init/doctor exit 0 + durable .harness project config and agents source",
  informational: "packed intent exit 0 + typed INFORMATIONAL output + durable semantic assessment cache entry with INTENT judgment and assessment digest",
  audit: "audit report + findings bound to the current candidate revision",
  change: "candidate revision + participant receipt + validation evidence for the delivered change",
  "direct-change": "direct-route evidence + candidate revision + validation",
  "delegated-change": "FeatureCapsule + delegated implementer evidence + independent review",
  "formal-sdd": "OpenSpec traceability + sealed TaskContract",
  "multi-worker": "task DAG + wave barrier evidence",
  cancel: "cancel request + terminal state + drained descendants",
  recovery: "recovery event + preserved operation state",
  "product-repair": "repair packet + scope check",
  "certification-repair": "failure packet + oracle re-check",
  repair: "failure packet + oracle re-check",
  "context-handoff": "context refs + continuation binding",
  "permission-delegation": "parent lease + monotonic child decision",
  "issue-driven": "issue snapshot + drift check",
  delivery: "delivery record + provenance",
  "distributed-execution": "lease + worker receipt",
  "project-home": "real registry project id + health/availability derived from the canonical project path",
  "multi-project": "two distinct real repository identities + project selection isolation",
  "control-center": "loopback token/CSRF overview + human decision (BROWSER lane)",
  authority: "capability lease + external human decision for a gated action"
};

const harnessRevisions = await harnessRevisionV1(fileURLToPath(import.meta.url));

const summary = {
  version: 1,
  slice: "S13",
  generatedAt: new Date().toISOString(),
  checkout,
  branch: run("git", ["branch", "--show-current"]).stdout,
  sourceCommit: run("git", ["rev-parse", "HEAD"]).stdout,
  harnessRevisions,
  harnessBuildIdentity: buildIdentity,
  lanes: [],
  result: "UNKNOWN"
};

const before = await trackedDigest();
const gitStatusBefore = await gitStatusShort();
const fixtureSource = await createFixtureSource();
const toolchain = await toolchainFacts();

for (const capability of Object.keys(laneDefinitions)) {
  if (laneFilter.length && !laneFilter.includes(capability)) continue;
  if (reuseLanes) {
    const reused = JSON.parse(await fs.readFile(path.join(evidenceRoot, "lanes", `${capability}.json`), "utf8"));
    summary.lanes.push({ capability, result: reused.result, accepted: reused.report?.accepted ?? false, oracleStatus: reused.report?.oracle?.status ?? null, error: reused.error ?? null, artifact: `docs/evidence/s13/lanes/${capability}.json`, reused: true });
    continue;
  }
  console.log(`S13 lane: ${capability}`);
  await runLane(capability, fixtureSource, summary);
}

const after = await trackedDigest();
const gitStatusAfter = await gitStatusShort();
const checkoutUntouched = before.digest === after.digest;

summary.checkoutProof = {
  trackedDigestBefore: before.digest,
  trackedDigestAfter: after.digest,
  trackedFiles: before.files,
  checkoutUntouched,
  postRunTrackedDocEditWindow: { opensAfter: new Date().toISOString(), note: "R17-F8: tracked documentation/evidence writes after this timestamp are expected; compare source digests only within a run window." },
  gitStatusBefore,
  gitStatusAfter,
  note: "The digest is captured before and after all provider journeys and before S13 evidence is written; candidate execution happens only inside disposable /tmp fixtures."
};
summary.toolchain = toolchain;
summary.matrix = MATRIX.map((row) => ({ ...row, oracleContract: ORACLE_CONTRACTS[row.capability] }));
summary.blockedRows = MATRIX.filter((row) => row.disposition === "BLOCKED_UNAVAILABLE_PROVIDER");
summary.notApplicableRows = MATRIX.filter((row) => row.disposition === "NOT_APPLICABLE");
summary.executableRows = MATRIX.filter((row) => row.disposition === "CERTIFIABLE_NOW").map((row) => row.capability);
summary.result = summary.blockedRows.length ? "SLICE_BLOCKED" : (summary.lanes.every((lane) => lane.result === "PASS") ? "PASS" : "FAIL");

await fs.mkdir(path.join(evidenceRoot, "lanes"), { recursive: true });
for (const entry of await fs.readdir(laneRoot)) await fs.copyFile(path.join(laneRoot, entry), path.join(evidenceRoot, "lanes", entry));
const summaryPath = path.join(evidenceRoot, "s13-real-provider-certification.json");
await fs.writeFile(summaryPath, `${sanitizeEvidence(JSON.stringify(summary, null, 2))}\n`);
const summaryDigest = crypto.createHash("sha256").update(await fs.readFile(summaryPath)).digest("hex");
console.log(JSON.stringify({ result: summary.result, lanes: summary.lanes, immutableSummaryDigest: summaryDigest, evidence: path.relative(checkout, summaryPath) }, null, 2));
process.exit(summary.lanes.some((lane) => lane.result !== "PASS") || !checkoutUntouched ? 1 : 0);
