export type CheckStatus = "PASS" | "FAIL" | "SKIP" | "WARN";
export type TaskMode = "spec" | "quick";
export type ReviewSeverity = "critical" | "high" | "medium" | "low" | "note";

export type ValidatorAdapter = "command" | "gherkin" | "graphify" | "opengrep" | "trivy" | "playwright" | "openapi" | "pact" | "mutation" | "property" | string;
export interface ValidationCommand { id: string; command: string; required?: boolean; timeoutSeconds?: number; workingDirectory?: string; }
export interface ValidatorSpec { id: string; adapter: ValidatorAdapter; command?: string; required?: boolean; timeoutSeconds?: number; workingDirectory?: string; options?: Record<string, unknown>; }
export interface UsageMetrics { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number; }
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

export interface HarnessProjectConfig {
  version: 1;
  project: { name: string };
  agents?: { configPath?: string; generatedPath?: string; activeProfile?: string; required?: boolean; findingsDir?: string; };
  workflow?: {
    quick?: { maxFiles?: number; disallowedDomains?: string[]; };
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
  orchestration?: { provider: "paseo" | "podman" | "none" | string; required?: boolean; worker?: { provider?: string; model?: string; maxRepairAttempts?: number; timeoutSeconds?: number; titlePrefix?: string; }; };
  mcp?: { servers?: Record<string, McpServerConfig>; };
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
    };
    paseo?: {
      enabled?: boolean;
      createWorkspace?: boolean;
      autoUseWorkspace?: boolean;
      worktreeSlugPattern?: string;
    };
  };
  memory?: { provider: "engram" | "none" | string; required?: boolean; benchmark?: { casesDir?: string; resultsDir?: string; providers?: Array<{ name: string; command: string; timeoutSeconds?: number; }>; }; };
  codeIntelligence?: { provider: "graphify" | "none" | string; required?: boolean; graphPath?: string; snapshotDir?: string; refreshCommand?: string; };
  sdd?: { specsDir?: string; contractsDir?: string; reportsDir?: string; repairsDir?: string; runsDir?: string; };
  validation?: { baseRef?: string; commands?: ValidationCommand[]; validators?: ValidatorSpec[]; frozenPaths?: string[]; requireSeal?: boolean; opa?: { enabled?: boolean; policyDirs?: string[]; }; };
  security?: { sandbox?: { provider?: "podman" | "docker" | "none" | string; required?: boolean; image?: string; network?: boolean; extraArgs?: string[]; }; tools?: string[]; };
  telemetry?: { enabled?: boolean; required?: boolean; localEventsFile?: string; exporter?: "none" | "otlp-http-json" | string; endpoint?: string; headers?: Record<string, string>; serviceName?: string; };
  evals?: { corpusDir?: string; resultsDir?: string; workspacesDir?: string; };
  provenance?: { outputDir?: string; buildType?: string; cosignKey?: string; };
}

export interface TaskRequirement { id: string; description?: string; validator?: string; validators?: string[]; }
export interface QuickTaskMetadata {
  request: string;
  acceptance: string[];
  triage: { mode: TaskMode; reasons: string[]; evaluatedAt: string; };
}
export interface TaskContract {
  version: 1;
  mode?: TaskMode;
  task: { id: string; title: string };
  quick?: QuickTaskMetadata;
  source?: { proposal?: string; spec?: string; design?: string; tasks?: string; acceptance?: string; };
  git?: { baseRef?: string; originatingBranch?: string };
  scope?: { allowed?: string[]; forbidden?: string[]; frozen?: string[]; };
  routing?: { intent?: string; domains?: string[]; risk?: "low" | "medium" | "high"; agent?: string; reviewers?: string[]; profile?: string; };
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
export interface WorkerSession { id?: string; provider: string; model?: string; logicalAgent?: string; nativeAgent?: string; runtime?: string; profile?: string; exitCode: number; stdout: string; stderr: string; metrics?: UsageMetrics; }
