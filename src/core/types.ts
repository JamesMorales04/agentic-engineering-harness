export type CheckStatus = "PASS" | "FAIL" | "SKIP" | "WARN";
export type TaskMode = "spec" | "quick";
export type ReviewSeverity = "critical" | "high" | "medium" | "low" | "note";
export type TaskRisk = "low" | "medium" | "high";
export type PaseoSessionPolicy = "fresh-on-start" | "reuse-compatible" | "resume-explicit";

export type ValidatorAdapter = "command" | "gherkin" | "graphify" | "opengrep" | "trivy" | "playwright" | "openapi" | "pact" | "mutation" | "property" | string;
export interface ValidationCommand { id: string; command: string; required?: boolean; timeoutSeconds?: number; workingDirectory?: string; }
export interface ValidatorSpec { id: string; adapter: ValidatorAdapter; command?: string; required?: boolean; timeoutSeconds?: number; workingDirectory?: string; options?: Record<string, unknown>; }
export interface UsageMetrics { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number; }
export type ContextMode = "observe" | "enforce";
export type ContextRole = "explorer" | "planner" | "spec-manager" | "implementer" | "reviewer" | "operation-supervisor" | string;
export interface ContextBudgetConfig { inputTokens?: number; maxTokens?: number; reserved?: { instructions?: number; normative?: number; evidence?: number; response?: number }; }
export interface ContextConfiguration {
  mode?: ContextMode;
  budgets?: { default?: ContextBudgetConfig; agents?: Record<string, ContextBudgetConfig>; phases?: Record<string, ContextBudgetConfig> };
  repositoryMap?: { enabled?: boolean; tokenBudget?: number; maxGraphHops?: number };
  semanticRetrieval?: { provider?: "serena" | string; required?: boolean; editing?: boolean };
  compression?: { provider?: "headroom" | string; required?: boolean; minTokens?: number; reversible?: boolean; command?: string };
  retrieval?: { maxRequestsPerTurn?: number; maxTokensPerRequest?: number; maxTotalTokensPerTurn?: number };
  outputPolicy?: { enabled?: boolean; modes?: Record<string, "terse" | "compact" | "normal"> };
}
export interface RunMetrics { firstPassSuccess: boolean; repairCount: number; humanInterventions: number; durationMs: number; usage: UsageMetrics; }
export interface ReviewEscalationStage { name: string; action?: "remediate" | "diagnose" | "replan"; agent?: string; model?: string; }

export interface McpServerConfig {
  description?: string;
  type: "local" | "remote";
  command?: string[];
  url?: string;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: boolean;
  enabled?: boolean;
  timeoutMs?: number;
  codemode?: boolean;
}

export interface OrganizationPolicySource {
  name: string;
  path?: string;
  url?: string;
  sha256?: string;
  required?: boolean;
  publicKey?: string;
  signature?: string;
}

export interface HarnessProjectConfig {
  version: 1;
  project: { name: string };
  agents?: { configPath?: string; generatedPath?: string; activeProfile?: string; required?: boolean; findingsDir?: string; };
  controlPlane?: { snapshotDir?: string; include?: string[]; required?: boolean; };
  workflow?: {
    quick?: { maxFiles?: number; disallowedDomains?: string[]; };
    issueIntake?: { enabled?: boolean; snapshotDir?: string; verifyDriftOnRun?: boolean; requireOpen?: boolean; plannerAgent?: string; autoHandoff?: boolean; };
    planning?: { enabled?: boolean; plannerAgent?: string; worktreeIsolation?: boolean; barrierValidation?: boolean; maxWaveConcurrency?: number; distributed?: boolean; };
    reviews?: {
      enabled?: boolean;
      reviewQuick?: boolean;
      leadAcceptance?: boolean;
      leadAcceptanceQuick?: boolean;
      /** @deprecated Accepted for old project files but ignored by the convergence engine. */
      maxRemediationRounds?: number;
      /** @deprecated Accepted for old project files but superseded by finalQualityGate. */
      blockingSeverities?: ReviewSeverity[];
      quality?: { severityPoints?: Partial<Record<ReviewSeverity, number>>; };
      convergence?: { minimumDebtPointImprovement?: number; stagnationWindow?: number; cycleDetection?: boolean; regressionDetection?: boolean; };
      finalQualityGate?: { maxBySeverity?: Partial<Record<ReviewSeverity, number>>; maxDebtPoints?: number; };
      escalation?: { stages?: ReviewEscalationStage[]; criticalStartStage?: number; replanResumeStage?: number; };
    };
  };
  orchestration?: {
    provider: "paseo" | "podman" | "none" | string;
    required?: boolean;
    worker?: { provider?: string; model?: string; maxRepairAttempts?: number; timeoutSeconds?: number; titlePrefix?: string; };
    interactive?: {
      autoSetup?: boolean;
      webUi?: boolean;
      leadAgent?: string;
      /** @deprecated Prefer sessionPolicy. */
      reuseSession?: boolean;
      sessionPolicy?: PaseoSessionPolicy;
      usePaseoTools?: boolean;
      context?: { pressureThreshold?: number; handoffThreshold?: number; hardHandoffThreshold?: number; };
      stateDir?: string;
      title?: string;
    };
  };
  toolchain?: { configPath?: string; lockPath?: string; statePath?: string; generatedMisePath?: string; };
  mcp?: {
    servers?: Record<string, McpServerConfig>;
    benchmark?: { enabled?: boolean; resultsDir?: string; repetitions?: number; };
    packs?: Record<string, { servers: string[]; enabled?: boolean }>;
  };
  delivery?: {
    stateDir?: string;
    github?: {
      enabled?: boolean;
      tokenEnv?: string;
      repository?: string;
      apiBaseUrl?: string;
      assignTokenOwner?: boolean;
      labels?: string[];
      branchPattern?: string;
      finalizeOnAcceptance?: boolean;
      pullRequestDraft?: boolean;
    };
    paseo?: {
      enabled?: boolean;
      createWorkspace?: boolean;
      autoUseWorkspace?: boolean;
      worktreeSlugPattern?: string;
    };
  };
  memory?: { provider: "engram" | "none" | string; required?: boolean; benchmark?: { casesDir?: string; resultsDir?: string; providers?: Array<{ name: string; command: string; timeoutSeconds?: number; }>; }; };
  codeIntelligence?: {
    provider: "graphify" | "none" | string;
    required?: boolean;
    graphPath?: string;
    snapshotDir?: string;
    refreshCommand?: string;
    scheduling?: { useEdges?: boolean; maxGraphHops?: number; maxSharedNodes?: number; centralityConflictThreshold?: number; };
  };
  context?: ContextConfiguration;
  evidence?: { enabled?: boolean; outputDir?: string; requireComplete?: boolean; };
  organization?: { policyBundles?: { cacheDir?: string; required?: boolean; sources?: OrganizationPolicySource[]; }; };
  distributed?: {
    enabled?: boolean;
    provider?: "filesystem" | "http" | string;
    queueDir?: string;
    endpoint?: string;
    tokenEnv?: string;
    pollIntervalMs?: number;
    leaseSeconds?: number;
    workerId?: string;
  };
  sdd?: {
    specsDir?: string;
    contractsDir?: string;
    reportsDir?: string;
    repairsDir?: string;
    runsDir?: string;
    authoring?: { provider?: "openspec" | "native" | string; schema?: string; managerAgent?: string; };
  };
  validation?: { baseRef?: string; commands?: ValidationCommand[]; validators?: ValidatorSpec[]; frozenPaths?: string[]; requireSeal?: boolean; opa?: { enabled?: boolean; policyDirs?: string[]; }; };
  security?: {
    sandbox?: {
      provider?: "podman" | "docker" | "none" | string;
      required?: boolean;
      image?: string;
      imageDigest?: string;
      network?: boolean;
      extraArgs?: string[];
      readOnlyRoot?: boolean;
      ephemeralHome?: boolean;
      noNewPrivileges?: boolean;
      capDropAll?: boolean;
      pidsLimit?: number;
      memory?: string;
      cpus?: number;
      tmpfs?: string[];
      forceForRisks?: TaskRisk[];
      environmentAllowlist?: string[];
      credentialEnvAllowlist?: string[];
    };
    tools?: string[];
  };
  telemetry?: { enabled?: boolean; required?: boolean; localEventsFile?: string; exporter?: "none" | "otlp-http-json" | string; endpoint?: string; headers?: Record<string, string>; serviceName?: string; };
  evals?: { corpusDir?: string; resultsDir?: string; workspacesDir?: string; defaultRuns?: number; confidenceLevel?: number; fullStack?: { enabled?: boolean; required?: boolean; strictSupplyChain?: boolean } };
  provenance?: { outputDir?: string; buildType?: string; cosignKey?: string; };
}

export interface TaskRequirement { id: string; description?: string; validator?: string; validators?: string[]; }
export interface QuickTaskMetadata {
  request: string;
  acceptance: string[];
  triage: { mode: TaskMode; reasons: string[]; evaluatedAt: string; };
}
export interface TaskIssueMetadata {
  provider: "github";
  repository: string;
  number: number;
  url: string;
  state: string;
  fetchedAt: string;
  updatedAt: string;
  contentSha256: string;
  snapshotPath: string;
}
export interface TaskAuthoringMetadata { provider: string; change: string; sourceSha256: string; }
export interface TaskContract {
  version: 1;
  mode?: TaskMode;
  task: { id: string; title: string };
  quick?: QuickTaskMetadata;
  source?: { proposal?: string; spec?: string; design?: string; tasks?: string; acceptance?: string; issue?: string; };
  authoring?: TaskAuthoringMetadata;
  issue?: TaskIssueMetadata;
  git?: { baseRef?: string; originatingBranch?: string };
  scope?: { allowed?: string[]; forbidden?: string[]; frozen?: string[]; };
  routing?: { intent?: string; domains?: string[]; risk?: TaskRisk; agent?: string; reviewers?: string[]; profile?: string; };
  requirements?: TaskRequirement[];
  constraints?: { breakingApiChanges?: boolean; newDependencies?: boolean; schemaChanges?: boolean; maxFilesChanged?: number; maxLinesAdded?: number; maxLinesDeleted?: number; };
  impact?: { forbiddenEdges?: string[]; forbiddenNodes?: string[]; allowedCommunities?: string[]; };
  repair?: { maxAttempts?: number };
  verification?: { commands?: ValidationCommand[]; validators?: ValidatorSpec[]; };
}

export interface ValidationCheck { id: string; category: string; status: CheckStatus; message: string; durationMs?: number; details?: Record<string, unknown>; }
export interface ValidationReport { version: 1; taskId: string; status: "PASS" | "FAIL"; startedAt: string; finishedAt: string; checks: ValidationCheck[]; changedFiles: string[]; metadata: { project: string; baseRef: string; }; }
export interface RequirementTrace { id: string; proposal: boolean; spec: boolean; design: boolean; acceptance: boolean; tasks: boolean; contract: boolean; validators: string[]; }
export interface RepairPacket { version: 1; taskId: string; attempt: number; createdAt: string; failureType?: string; failedAgent?: string; recoveryAction?: string; failures: Array<{ id: string; category: string; message: string; details?: Record<string, unknown>; }>; }
export interface WorkerSession {
  id?: string;
  provider: string;
  model?: string;
  logicalAgent?: string;
  nativeAgent?: string;
  runtime?: string;
  profile?: string;
  transport?: string;
  workspaceId?: string;
  title?: string;
  operationId?: string;
  operationKind?: string;
  phase?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  metrics?: UsageMetrics;
}
