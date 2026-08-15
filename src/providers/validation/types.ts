import type { HarnessProjectConfig, TaskContract, ValidationCapability, ValidationProviderSpec, ValidatorSpec } from "../../core/types.js";

export type ProviderStatus = "PASS" | "FAIL" | "SKIP";

export interface ValidationProviderContext {
  root: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  capability: ValidationCapability;
  spec?: ValidatorSpec;
  providerSpec?: ValidationProviderSpec;
  rawArtifactDirectory: string;
  baseRef?: string;
}

export interface ProviderDetection {
  provider: string;
  reason: string;
  command?: string;
  runtime?: string;
}

export interface ProviderDoctorResult {
  provider: string;
  available: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface ProviderPlan {
  provider: string;
  capability: ValidationCapability;
  command: string;
  cwd: string;
  runtime?: string;
  env?: Record<string, string>;
  options?: Record<string, unknown>;
}

export interface ProviderExecution {
  plan: ProviderPlan;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  rawArtifact: string;
}

export interface TestFailure {
  id?: string;
  message: string;
  source?: { file?: string; line?: number; column?: number };
}

export interface TestExecutionResult {
  version: 1;
  provider: string;
  capability: ValidationCapability;
  command: string;
  runtime?: string;
  status: ProviderStatus;
  summary: { total: number; passed: number; failed: number; skipped: number; durationMs: number };
  failures: TestFailure[];
  requirements: string[];
  rawArtifact: string;
}

export interface BddScenarioResult {
  feature: string;
  rule?: string;
  scenario: string;
  examplesRow?: number;
  tags: string[];
  status: ProviderStatus;
  durationMs?: number;
  failingStep?: string;
  source?: { file?: string; line?: number; column?: number };
  error?: string;
  requirementIds: string[];
}

export interface BddExecutionResult {
  version: 1;
  provider: string;
  capability: "bdd";
  command: string;
  runtime?: string;
  status: ProviderStatus;
  scenarios: BddScenarioResult[];
  summary: { total: number; passed: number; failed: number; skipped: number; durationMs: number };
  rawArtifact: string;
}

export interface IntegrationEnvironmentRequirement {
  kind: string;
  image?: string;
  network: "isolated" | "none" | "project";
  ephemeral: boolean;
  ports?: number[];
  environment?: string[];
  mounts?: string[];
}

export interface IntegrationEnvironmentResult {
  version: 1;
  provider: string;
  capability: "integration-test";
  status: ProviderStatus;
  requirements: IntegrationEnvironmentRequirement[];
  lifecycle: { provisioned: boolean; ready: boolean; tested: boolean; cleaned: boolean; durationMs: number };
  connectionData?: Record<string, string>;
  rawArtifact: string;
}

export interface ContractVerificationResult {
  version: 1;
  provider: string;
  capability: "contract-test";
  status: ProviderStatus;
  verifierCommand: string;
  pactFile?: string;
  providerUrl?: string;
  summary: { total: number; passed: number; failed: number; durationMs: number };
  failures: TestFailure[];
  requirements: string[];
  rawArtifact: string;
}

export interface ValidationProvider<T> {
  readonly id: string;
  readonly capabilities: ValidationCapability[];
  detect(context: ValidationProviderContext): Promise<ProviderDetection | undefined>;
  doctor(context: ValidationProviderContext): Promise<ProviderDoctorResult>;
  plan(context: ValidationProviderContext, detection?: ProviderDetection): Promise<ProviderPlan>;
  execute(context: ValidationProviderContext, plan: ProviderPlan): Promise<ProviderExecution>;
  normalize(context: ValidationProviderContext, execution: ProviderExecution): Promise<T>;
}

export type TestExecutionProvider = ValidationProvider<TestExecutionResult>;
export type BddExecutionProvider = ValidationProvider<BddExecutionResult>;
export type ContractTestingProvider = ValidationProvider<ContractVerificationResult>;
export type IntegrationEnvironmentProviderContract = ValidationProvider<IntegrationEnvironmentResult>;
