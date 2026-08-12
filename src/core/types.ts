export type CheckStatus = "PASS" | "FAIL" | "SKIP" | "WARN";

export type ValidatorAdapter =
  | "command"
  | "gherkin"
  | "graphify"
  | "opengrep"
  | "trivy"
  | "playwright"
  | "openapi"
  | "pact"
  | string;

export interface ValidationCommand {
  id: string;
  command: string;
  required?: boolean;
  timeoutSeconds?: number;
  workingDirectory?: string;
}

export interface ValidatorSpec {
  id: string;
  adapter: ValidatorAdapter;
  command?: string;
  required?: boolean;
  timeoutSeconds?: number;
  workingDirectory?: string;
  options?: Record<string, unknown>;
}

export interface HarnessProjectConfig {
  version: 1;
  project: { name: string };
  orchestration?: {
    provider: "paseo" | "podman" | "none" | string;
    required?: boolean;
    worker?: {
      provider?: string;
      model?: string;
      maxRepairAttempts?: number;
      timeoutSeconds?: number;
      titlePrefix?: string;
    };
  };
  memory?: {
    provider: "engram" | "none" | string;
    required?: boolean;
  };
  codeIntelligence?: {
    provider: "graphify" | "none" | string;
    required?: boolean;
    graphPath?: string;
    snapshotDir?: string;
    refreshCommand?: string;
  };
  sdd?: {
    specsDir?: string;
    contractsDir?: string;
    reportsDir?: string;
    repairsDir?: string;
    runsDir?: string;
  };
  validation?: {
    baseRef?: string;
    commands?: ValidationCommand[];
    validators?: ValidatorSpec[];
    frozenPaths?: string[];
    requireSeal?: boolean;
    opa?: {
      enabled?: boolean;
      policyDirs?: string[];
    };
  };
  security?: {
    sandbox?: {
      provider?: "podman" | "docker" | "none" | string;
      required?: boolean;
      image?: string;
      network?: boolean;
      extraArgs?: string[];
    };
    tools?: string[];
  };
  telemetry?: {
    enabled?: boolean;
    localEventsFile?: string;
  };
}

export interface TaskRequirement {
  id: string;
  description?: string;
  /** Deprecated compatibility field. Prefer validators. */
  validator?: string;
  validators?: string[];
}

export interface TaskContract {
  version: 1;
  task: { id: string; title: string };
  source?: {
    proposal?: string;
    spec?: string;
    design?: string;
    tasks?: string;
    acceptance?: string;
  };
  git?: { baseRef?: string };
  scope?: {
    allowed?: string[];
    forbidden?: string[];
    frozen?: string[];
  };
  requirements?: TaskRequirement[];
  constraints?: {
    breakingApiChanges?: boolean;
    newDependencies?: boolean;
    schemaChanges?: boolean;
    maxFilesChanged?: number;
    maxLinesAdded?: number;
    maxLinesDeleted?: number;
  };
  impact?: {
    forbiddenEdges?: string[];
    forbiddenNodes?: string[];
    allowedCommunities?: string[];
  };
  repair?: { maxAttempts?: number };
  verification?: {
    commands?: ValidationCommand[];
    validators?: ValidatorSpec[];
  };
}

export interface ValidationCheck {
  id: string;
  category: string;
  status: CheckStatus;
  message: string;
  durationMs?: number;
  details?: Record<string, unknown>;
}

export interface ValidationReport {
  version: 1;
  taskId: string;
  status: "PASS" | "FAIL";
  startedAt: string;
  finishedAt: string;
  checks: ValidationCheck[];
  changedFiles: string[];
  metadata: {
    project: string;
    baseRef: string;
  };
}

export interface RequirementTrace {
  id: string;
  proposal: boolean;
  spec: boolean;
  design: boolean;
  acceptance: boolean;
  tasks: boolean;
  contract: boolean;
  validators: string[];
}

export interface RepairPacket {
  version: 1;
  taskId: string;
  attempt: number;
  createdAt: string;
  failures: Array<{
    id: string;
    category: string;
    message: string;
    details?: Record<string, unknown>;
  }>;
}

export interface WorkerSession {
  id?: string;
  provider: string;
  model?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}
