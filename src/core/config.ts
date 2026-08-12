import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { HarnessProjectConfig, TaskContract } from "./types.js";

const validationCommandSchema = z.object({ id: z.string().min(1), command: z.string().min(1), required: z.boolean().optional(), timeoutSeconds: z.number().int().positive().optional(), workingDirectory: z.string().optional() });
const validatorSpecSchema = z.object({ id: z.string().min(1), adapter: z.string().min(1), command: z.string().min(1).optional(), required: z.boolean().optional(), timeoutSeconds: z.number().int().positive().optional(), workingDirectory: z.string().optional(), options: z.record(z.string(), z.unknown()).optional() });
const memoryBenchmarkProviderSchema = z.object({ name: z.string().min(1), command: z.string().min(1), timeoutSeconds: z.number().int().positive().optional() });
const severitySchema = z.enum(["critical", "high", "medium", "low", "note"]);
const riskSchema = z.enum(["low", "medium", "high"]);
const severityNumberSchema = z.object({ critical: z.number().int().nonnegative().optional(), high: z.number().int().nonnegative().optional(), medium: z.number().int().nonnegative().optional(), low: z.number().int().nonnegative().optional(), note: z.number().int().nonnegative().optional() });
const escalationStageSchema = z.object({ name: z.string().min(1), action: z.enum(["remediate", "diagnose", "replan"]).optional(), agent: z.string().min(1).optional(), model: z.string().min(1).optional() });
const mcpServerSchema = z.object({ description: z.string().optional(), type: z.enum(["local", "remote"]), command: z.array(z.string().min(1)).optional(), url: z.string().url().optional(), environment: z.record(z.string(), z.string()).optional(), headers: z.record(z.string(), z.string()).optional(), oauth: z.boolean().optional(), enabled: z.boolean().optional(), timeoutMs: z.number().int().positive().optional(), codemode: z.boolean().optional() }).superRefine((value, ctx) => { if (value.type === "local" && !value.command?.length) ctx.addIssue({ code: "custom", message: "local MCP servers require command" }); if (value.type === "remote" && !value.url) ctx.addIssue({ code: "custom", message: "remote MCP servers require url" }); });
const organizationPolicySourceSchema = z.object({ name: z.string().min(1), path: z.string().optional(), url: z.string().url().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), required: z.boolean().optional(), publicKey: z.string().optional(), signature: z.string().optional() }).superRefine((value, ctx) => { if (!value.path && !value.url) ctx.addIssue({ code: "custom", message: "policy bundle source requires path or url" }); });
const interactiveContextSchema = z.object({ pressureThreshold: z.number().min(0).max(1).optional(), handoffThreshold: z.number().min(0).max(1).optional(), hardHandoffThreshold: z.number().min(0).max(1).optional() }).superRefine((value, ctx) => { const pressure = value.pressureThreshold ?? 0.7; const handoff = value.handoffThreshold ?? 0.8; const hard = value.hardHandoffThreshold ?? 0.9; if (handoff < pressure) ctx.addIssue({ code: "custom", message: "handoffThreshold must be >= pressureThreshold" }); if (hard < handoff) ctx.addIssue({ code: "custom", message: "hardHandoffThreshold must be >= handoffThreshold" }); });

const projectSchema = z.object({
  version: z.literal(1), project: z.object({ name: z.string().min(1) }),
  agents: z.object({ configPath: z.string().optional(), generatedPath: z.string().optional(), activeProfile: z.string().optional(), required: z.boolean().optional(), findingsDir: z.string().optional() }).optional(),
  controlPlane: z.object({ snapshotDir: z.string().optional(), include: z.array(z.string()).optional(), required: z.boolean().optional() }).optional(),
  workflow: z.object({
    quick: z.object({ maxFiles: z.number().int().positive().optional(), disallowedDomains: z.array(z.string()).optional() }).optional(),
    issueIntake: z.object({ enabled: z.boolean().optional(), snapshotDir: z.string().optional(), verifyDriftOnRun: z.boolean().optional(), requireOpen: z.boolean().optional(), plannerAgent: z.string().min(1).optional(), autoHandoff: z.boolean().optional() }).optional(),
    planning: z.object({ enabled: z.boolean().optional(), plannerAgent: z.string().min(1).optional(), worktreeIsolation: z.boolean().optional(), barrierValidation: z.boolean().optional(), maxWaveConcurrency: z.number().int().positive().optional(), distributed: z.boolean().optional() }).optional(),
    reviews: z.object({
      enabled: z.boolean().optional(), reviewQuick: z.boolean().optional(), leadAcceptance: z.boolean().optional(), leadAcceptanceQuick: z.boolean().optional(),
      maxRemediationRounds: z.number().int().nonnegative().optional(), blockingSeverities: z.array(severitySchema).optional(),
      quality: z.object({ severityPoints: severityNumberSchema.optional() }).optional(),
      convergence: z.object({ minimumDebtPointImprovement: z.number().int().nonnegative().optional(), stagnationWindow: z.number().int().positive().optional(), cycleDetection: z.boolean().optional(), regressionDetection: z.boolean().optional() }).optional(),
      finalQualityGate: z.object({ maxBySeverity: severityNumberSchema.optional(), maxDebtPoints: z.number().int().nonnegative().optional() }).optional(),
      escalation: z.object({ stages: z.array(escalationStageSchema).optional(), criticalStartStage: z.number().int().nonnegative().optional(), replanResumeStage: z.number().int().nonnegative().optional() }).optional()
    }).optional()
  }).optional(),
  orchestration: z.object({
    provider: z.string(),
    required: z.boolean().optional(),
    worker: z.object({ provider: z.string().optional(), model: z.string().optional(), maxRepairAttempts: z.number().int().nonnegative().optional(), timeoutSeconds: z.number().int().positive().optional(), titlePrefix: z.string().optional() }).optional(),
    interactive: z.object({ autoSetup: z.boolean().optional(), webUi: z.boolean().optional(), leadAgent: z.string().min(1).optional(), reuseSession: z.boolean().optional(), sessionPolicy: z.enum(["fresh-on-start", "reuse-compatible", "resume-explicit"]).optional(), usePaseoTools: z.boolean().optional(), context: interactiveContextSchema.optional(), stateDir: z.string().min(1).optional(), title: z.string().min(1).optional() }).optional()
  }).optional(),
  toolchain: z.object({ configPath: z.string().optional(), lockPath: z.string().optional(), statePath: z.string().optional(), generatedMisePath: z.string().optional() }).optional(),
  mcp: z.object({
    servers: z.record(z.string(), mcpServerSchema).optional(),
    benchmark: z.object({ enabled: z.boolean().optional(), resultsDir: z.string().optional(), repetitions: z.number().int().positive().optional() }).optional(),
    packs: z.record(z.string(), z.object({ servers: z.array(z.string()), enabled: z.boolean().optional() })).optional()
  }).optional(),
  delivery: z.object({
    stateDir: z.string().optional(),
    github: z.object({ enabled: z.boolean().optional(), tokenEnv: z.string().min(1).optional(), repository: z.string().regex(/^[^/]+\/[^/]+$/).optional(), apiBaseUrl: z.string().url().optional(), assignTokenOwner: z.boolean().optional(), labels: z.array(z.string()).optional(), branchPattern: z.string().min(1).optional(), finalizeOnAcceptance: z.boolean().optional(), pullRequestDraft: z.boolean().optional() }).optional(),
    paseo: z.object({ enabled: z.boolean().optional(), createWorkspace: z.boolean().optional(), autoUseWorkspace: z.boolean().optional(), worktreeSlugPattern: z.string().min(1).optional() }).optional()
  }).optional(),
  memory: z.object({ provider: z.string(), required: z.boolean().optional(), benchmark: z.object({ casesDir: z.string().optional(), resultsDir: z.string().optional(), providers: z.array(memoryBenchmarkProviderSchema).optional() }).optional() }).optional(),
  codeIntelligence: z.object({ provider: z.string(), required: z.boolean().optional(), graphPath: z.string().optional(), snapshotDir: z.string().optional(), refreshCommand: z.string().optional(), scheduling: z.object({ useEdges: z.boolean().optional(), maxGraphHops: z.number().int().positive().optional(), maxSharedNodes: z.number().int().nonnegative().optional(), centralityConflictThreshold: z.number().nonnegative().optional() }).optional() }).optional(),
  evidence: z.object({ enabled: z.boolean().optional(), outputDir: z.string().optional(), requireComplete: z.boolean().optional() }).optional(),
  organization: z.object({ policyBundles: z.object({ cacheDir: z.string().optional(), required: z.boolean().optional(), sources: z.array(organizationPolicySourceSchema).optional() }).optional() }).optional(),
  distributed: z.object({ enabled: z.boolean().optional(), provider: z.string().optional(), queueDir: z.string().optional(), endpoint: z.string().url().optional(), tokenEnv: z.string().optional(), pollIntervalMs: z.number().int().positive().optional(), leaseSeconds: z.number().int().positive().optional(), workerId: z.string().optional() }).optional(),
  sdd: z.object({ specsDir: z.string().optional(), contractsDir: z.string().optional(), reportsDir: z.string().optional(), repairsDir: z.string().optional(), runsDir: z.string().optional(), authoring: z.object({ provider: z.string().min(1).optional(), schema: z.string().min(1).optional(), managerAgent: z.string().min(1).optional() }).optional() }).optional(),
  validation: z.object({ baseRef: z.string().optional(), commands: z.array(validationCommandSchema).optional(), validators: z.array(validatorSpecSchema).optional(), frozenPaths: z.array(z.string()).optional(), requireSeal: z.boolean().optional(), opa: z.object({ enabled: z.boolean().optional(), policyDirs: z.array(z.string()).optional() }).optional() }).optional(),
  security: z.object({ sandbox: z.object({ provider: z.string().optional(), required: z.boolean().optional(), image: z.string().optional(), imageDigest: z.string().optional(), network: z.boolean().optional(), extraArgs: z.array(z.string()).optional(), readOnlyRoot: z.boolean().optional(), ephemeralHome: z.boolean().optional(), noNewPrivileges: z.boolean().optional(), capDropAll: z.boolean().optional(), pidsLimit: z.number().int().positive().optional(), memory: z.string().optional(), cpus: z.number().positive().optional(), tmpfs: z.array(z.string()).optional(), forceForRisks: z.array(riskSchema).optional(), environmentAllowlist: z.array(z.string()).optional(), credentialEnvAllowlist: z.array(z.string()).optional() }).optional(), tools: z.array(z.string()).optional() }).optional(),
  telemetry: z.object({ enabled: z.boolean().optional(), required: z.boolean().optional(), localEventsFile: z.string().optional(), exporter: z.string().optional(), endpoint: z.string().optional(), headers: z.record(z.string(), z.string()).optional(), serviceName: z.string().optional() }).optional(),
  evals: z.object({ corpusDir: z.string().optional(), resultsDir: z.string().optional(), workspacesDir: z.string().optional(), defaultRuns: z.number().int().positive().optional(), confidenceLevel: z.number().gt(0).lt(1).optional() }).optional(),
  provenance: z.object({ outputDir: z.string().optional(), buildType: z.string().optional(), cosignKey: z.string().optional() }).optional()
});
const requirementSchema = z.object({ id: z.string().min(1), description: z.string().optional(), validator: z.string().optional(), validators: z.array(z.string()).optional() });
const quickMetadataSchema = z.object({ request: z.string().min(1), acceptance: z.array(z.string().min(1)).min(1), triage: z.object({ mode: z.enum(["spec", "quick"]), reasons: z.array(z.string()), evaluatedAt: z.string() }) });
const taskSchema = z.object({
  version: z.literal(1), mode: z.enum(["spec", "quick"]).optional(), task: z.object({ id: z.string().min(1), title: z.string().min(1) }), quick: quickMetadataSchema.optional(),
  source: z.object({ proposal: z.string().optional(), spec: z.string().optional(), design: z.string().optional(), tasks: z.string().optional(), acceptance: z.string().optional(), issue: z.string().optional() }).optional(),
  authoring: z.object({ provider: z.string().min(1), change: z.string().min(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  issue: z.object({ provider: z.literal("github"), repository: z.string().regex(/^[^/]+\/[^/]+$/), number: z.number().int().positive(), url: z.string().url(), state: z.string().min(1), fetchedAt: z.string().min(1), updatedAt: z.string().min(1), contentSha256: z.string().regex(/^[a-f0-9]{64}$/), snapshotPath: z.string().min(1) }).optional(),
  git: z.object({ baseRef: z.string().optional(), originatingBranch: z.string().optional() }).optional(), scope: z.object({ allowed: z.array(z.string()).optional(), forbidden: z.array(z.string()).optional(), frozen: z.array(z.string()).optional() }).optional(),
  routing: z.object({ intent: z.string().optional(), domains: z.array(z.string()).optional(), risk: riskSchema.optional(), agent: z.string().optional(), reviewers: z.array(z.string()).optional(), profile: z.string().optional() }).optional(),
  requirements: z.array(requirementSchema).optional(), constraints: z.object({ breakingApiChanges: z.boolean().optional(), newDependencies: z.boolean().optional(), schemaChanges: z.boolean().optional(), maxFilesChanged: z.number().int().positive().optional(), maxLinesAdded: z.number().int().nonnegative().optional(), maxLinesDeleted: z.number().int().nonnegative().optional() }).optional(),
  impact: z.object({ forbiddenEdges: z.array(z.string()).optional(), forbiddenNodes: z.array(z.string()).optional(), allowedCommunities: z.array(z.string()).optional() }).optional(), repair: z.object({ maxAttempts: z.number().int().nonnegative().optional() }).optional(), verification: z.object({ commands: z.array(validationCommandSchema).optional(), validators: z.array(validatorSpecSchema).optional() }).optional()
});
export async function loadProjectConfig(root: string): Promise<HarnessProjectConfig> { return projectSchema.parse(YAML.parse(await fs.readFile(path.join(root, ".harness", "project.yaml"), "utf8"))) as HarnessProjectConfig; }
export async function loadTaskContract(root: string, taskId: string, config: HarnessProjectConfig): Promise<TaskContract> { const file = path.join(root, config.sdd?.contractsDir ?? ".harness/contracts", `${taskId}.yaml`); return taskSchema.parse(YAML.parse(await fs.readFile(file, "utf8"))) as TaskContract; }
