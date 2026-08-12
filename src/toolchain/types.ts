export type ToolchainToolKind = "system" | "mise";
export type ValidatorProvisioningStrategy = "local" | "prefer-container";

export interface ToolchainManagerConfig {
  provider: "mise" | string;
  generatedConfig?: string;
  lockFile?: string;
  stateFile?: string;
  minimumVersion?: string;
}

export interface ToolchainProfile {
  extends?: string[];
  tools?: string[];
}

export interface ToolchainContainerAlternative {
  image: string;
  engine?: "podman" | "docker" | string;
}

export interface ToolchainToolDefinition {
  kind: ToolchainToolKind;
  command: string;
  source?: string;
  version?: string;
  required?: boolean;
  dependsOn?: string[];
  activateWhen?: string[];
  container?: ToolchainContainerAlternative;
}

export interface ToolchainConfig {
  version: 1;
  manager: ToolchainManagerConfig;
  strategy?: {
    validators?: ValidatorProvisioningStrategy;
    containerEngine?: "podman" | "docker" | string;
  };
  profiles?: Record<string, ToolchainProfile>;
  tools: Record<string, ToolchainToolDefinition>;
  projectDependencies?: {
    autoDetect?: boolean;
    commands?: string[];
  };
}

export interface ResolvedToolchainTool extends ToolchainToolDefinition {
  name: string;
  selectedBy: string[];
  provisioning: "system" | "mise" | "container";
}

export interface ResolvedToolchain {
  profile: string;
  tools: ResolvedToolchainTool[];
}

export interface ToolchainLockTool {
  source?: string;
  requestedVersion?: string;
  resolvedVersion?: string;
  command: string;
  provisioning: "system" | "mise" | "container";
  image?: string;
  digestRef?: string;
}

export interface ToolchainLock {
  version: 1;
  generatedAt: string;
  profile: string;
  tools: Record<string, ToolchainLockTool>;
}

export interface ToolchainState {
  version: 1;
  generatedAt: string;
  manager: { provider: string; command: string; version?: string };
  binPaths: string[];
  wrappersDir?: string;
  projectDependencyCommands: string[];
}

export interface ToolchainSetupOptions {
  profile?: string;
  dryRun?: boolean;
  updateLock?: boolean;
  skipProjectDependencies?: boolean;
  preferContainers?: boolean;
}

export interface ToolchainSetupResult {
  profile: string;
  generatedConfig: string;
  lockFile: string;
  stateFile: string;
  installed: string[];
  containers: string[];
  systemMissing: string[];
  projectDependencyCommands: string[];
  dryRun: boolean;
}
