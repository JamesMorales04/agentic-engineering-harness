export type CheckStatus = "PASS" | "FAIL" | "SKIP" | "WARN";

export interface HarnessProjectConfig {
  version: 1;
  project: {
    name: string;
  };
  orchestration?: {
    provider: "paseo" | "none" | string;
    required?: boolean;
  };
  memory?: {
    provider: "engram" | "none" | string;
    required?: boolean;
  };
  codeIntelligence?: {
    provider: "graphify" | "none" | string;
    required?: boolean;
  };
  sdd?: {
    specsDir?: string;
    contractsDir?: string;
    reportsDir?: string;
  };
  validation?: {
    baseRef?: string;
    commands?: ValidationCommand[];
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
    };
    tools?: string[];
  };
  telemetry?: {
    enabled?: boolean;
    localEventsFile?: string;
  };
}

export interface ValidationCommand {
  id: string;
  command: string;
  required?: boolean;
  timeoutSeconds?: number;
  workingDirectory?: string;
}

export interface TaskContract {
  version: 1;
  task: {
    id: string;
    title: string;
  };
  source?: {
    proposal?: string;
    spec?: string;
    design?: string;
    acceptance?: string;
  };
  git?: {
    baseRef?: string;
  };
  scope?: {
    allowed?: string[];
    forbidden?: string[];
    frozen?: string[];
  };
  requirements?: Array<{
    id: string;
    description?: string;
    validator?: string;
  }>;
  constraints?: {
    breakingApiChanges?: boolean;
    newDependencies?: boolean;
    schemaChanges?: boolean;
    maxFilesChanged?: number;
    maxLinesAdded?: number;
    maxLinesDeleted?: number;
  };
  verification?: {
    commands?: ValidationCommand[];
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
