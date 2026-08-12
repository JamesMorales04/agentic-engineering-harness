import type { AgentExecutionSelection } from "../agents/types.js";
import type { HarnessProjectConfig, TaskRisk } from "../core/types.js";

export interface SandboxDecision {
  required: boolean;
  provider: string;
  reasons: string[];
  selection: AgentExecutionSelection;
}

export function enforceSandboxPolicy(selection: AgentExecutionSelection, config: HarnessProjectConfig, risk: TaskRisk = "low"): SandboxDecision {
  const sandbox = config.security?.sandbox;
  const force = (sandbox?.forceForRisks ?? []).includes(risk);
  const required = sandbox?.required === true || force;
  const provider = sandbox?.provider ?? "podman";
  if (!required) return { required: false, provider, reasons: [], selection };
  if (provider === "none") throw new Error(`Sandbox is required for ${risk}-risk work but security.sandbox.provider is none.`);
  if (selection.runtimeAdapter !== "opencode") throw new Error(`Sandbox policy requires ${provider}, but runtime ${selection.runtimeAdapter} is not supported by the hardened worker sandbox.`);
  if (!sandbox?.image) throw new Error("Sandbox policy requires security.sandbox.image.");
  return { required: true, provider, reasons: force ? [`risk:${risk}`] : ["security.sandbox.required"], selection: { ...selection, transport: provider === "podman" ? "podman" : selection.transport } };
}

export function hardenedPodmanArgs(config: HarnessProjectConfig, selection: AgentExecutionSelection, writable: boolean): string[] {
  const sandbox = config.security?.sandbox;
  const args: string[] = ["--rm", "-i", "--userns=keep-id"];
  if (sandbox?.readOnlyRoot !== false) args.push("--read-only");
  if (sandbox?.capDropAll !== false) args.push("--cap-drop=ALL");
  if (sandbox?.noNewPrivileges !== false) args.push("--security-opt=no-new-privileges");
  args.push(`--pids-limit=${sandbox?.pidsLimit ?? 512}`);
  if (sandbox?.memory) args.push(`--memory=${sandbox.memory}`);
  if (sandbox?.cpus) args.push(`--cpus=${sandbox.cpus}`);
  if (sandbox?.network === false || selection.permissions.network === "deny") args.push("--network=none");
  const tmpfs = sandbox?.tmpfs ?? ["/tmp:rw,nosuid,nodev,noexec,size=1g"];
  for (const mount of tmpfs) args.push(`--tmpfs=${mount}`);
  if (sandbox?.ephemeralHome !== false) {
    args.push("--tmpfs=/home/aeh:rw,nosuid,nodev,size=256m");
    args.push("--env=HOME=/home/aeh");
  }
  if (!writable) args.push("--env=AEH_WORKSPACE_READ_ONLY=1");
  for (const extra of sandbox?.extraArgs ?? []) args.push(extra);
  return args;
}

export function sandboxImage(config: HarnessProjectConfig): string {
  const sandbox = config.security?.sandbox;
  if (!sandbox?.image) throw new Error("security.sandbox.image is required for Podman execution.");
  if (!sandbox.imageDigest || sandbox.image.includes("@sha256:")) return sandbox.image;
  const digest = sandbox.imageDigest.startsWith("sha256:") ? sandbox.imageDigest : `sha256:${sandbox.imageDigest}`;
  return `${sandbox.image.replace(/:[^/@]+$/, "")}@${digest}`;
}

export function allowedSandboxEnvironment(config: HarnessProjectConfig, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const sandbox = config.security?.sandbox;
  const allowed = new Set(sandbox?.environmentAllowlist ?? []);
  const credentials = new Set(sandbox?.credentialEnvAllowlist ?? []);
  const result: Record<string, string> = {};
  for (const name of [...allowed, ...credentials]) if (source[name] !== undefined) result[name] = source[name]!;
  return result;
}
