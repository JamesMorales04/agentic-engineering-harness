import path from "node:path";
import type { ValidationCapability } from "../../core/types.js";
import { commandExists } from "../../utils/process.js";
import { configuredCommand, doctorForCommand, executePlan, resolveCwd } from "./providerUtils.js";
import { persistRawArtifact } from "./protocol.js";
import type { IntegrationEnvironmentRequirement, IntegrationEnvironmentResult, ProviderDetection, ProviderDoctorResult, ProviderExecution, ProviderPlan, ValidationProvider, ValidationProviderContext } from "./types.js";

export class IntegrationEnvironmentProvider implements ValidationProvider<IntegrationEnvironmentResult> {
  readonly id = "integration-environment";
  readonly capabilities: ValidationCapability[] = ["integration-test"];

  async detect(context: ValidationProviderContext): Promise<ProviderDetection | undefined> {
    const configured = await configuredCommand(context);
    const options = context.spec?.options ?? context.providerSpec?.options ?? {};
    if (configured.command || typeof options.provisionCommand === "string") return { provider: configured.provider === "configured-command" ? String(options.provider ?? "configured-environment") : configured.provider, command: configured.command ?? String(options.provisionCommand), runtime: "oci-or-project", reason: "explicit integration environment lifecycle" };
    if (typeof options.image === "string" && (await commandExists("podman", context.root) || await commandExists("docker", context.root))) return { provider: "oci", command: `${await commandExists("podman", context.root) ? "podman" : "docker"} run --rm --network=none ${options.image}`, runtime: "oci", reason: "explicit OCI image and available runtime" };
    return undefined;
  }

  async doctor(context: ValidationProviderContext): Promise<ProviderDoctorResult> {
    const detection = await this.detect(context);
    if (!detection) return { provider: this.id, available: false, message: "No integration environment provider was configured." };
    const security = validateEnvironmentRequirements(context); if (security.length) return { provider: detection.provider, available: false, message: security.join(" "), details: { securityFailures: security } };
    return doctorForCommand(detection.command, resolveCwd(context), detection.provider, { runtime: detection.runtime });
  }

  async plan(context: ValidationProviderContext, detection?: ProviderDetection): Promise<ProviderPlan> {
    const selected = detection ?? await this.detect(context); if (!selected?.command) throw new Error("No integration environment provider or lifecycle command is configured.");
    return { provider: selected.provider, capability: "integration-test", command: selected.command, cwd: resolveCwd(context), runtime: selected.runtime, env: connectionData(context), options: { timeoutMs: (context.spec?.timeoutSeconds ?? context.providerSpec?.timeoutSeconds ?? 900) * 1000 } };
  }

  async execute(context: ValidationProviderContext, plan: ProviderPlan): Promise<ProviderExecution> {
    const options = context.spec?.options ?? context.providerSpec?.options ?? {}; const lifecycle: string[] = [];
    const provision = String(options.provisionCommand ?? plan.command); const readiness = typeof options.readinessCommand === "string" ? options.readinessCommand : undefined; const test = typeof options.testCommand === "string" ? options.testCommand : undefined; const cleanup = typeof options.cleanupCommand === "string" ? options.cleanupCommand : undefined;
    const started = Date.now(); let stdout = ""; let stderr = ""; let exitCode = 0;
    const run = async (label: string, command: string): Promise<void> => { const result = await executePlan({ ...plan, command }); stdout += `--- ${label} ---\n${result.stdout}\n`; stderr += result.stderr ? `--- ${label} stderr ---\n${result.stderr}\n` : ""; if (result.exitCode !== 0 && exitCode === 0) exitCode = result.exitCode; lifecycle.push(`${label}:${result.exitCode === 0 ? "PASS" : "FAIL"}`); };
    try { await run("provision", provision); if (readiness) await run("readiness", readiness); if (test) await run("test", test); } finally { if (cleanup) await run("cleanup", cleanup); }
    return { plan, exitCode, stdout: `${lifecycle.join(" ")}\n${stdout}`, stderr, durationMs: Date.now() - started, rawArtifact: await persistRawArtifact(context.root, context.rawArtifactDirectory, context.spec?.id ?? context.providerSpec?.id ?? "integration-environment", stdout, stderr) };
  }

  async normalize(context: ValidationProviderContext, execution: ProviderExecution): Promise<IntegrationEnvironmentResult> {
    const lifecycle = { provisioned: /provision:PASS/.test(execution.stdout), ready: !/readiness:FAIL/.test(execution.stdout), tested: !/test:FAIL/.test(execution.stdout), cleaned: /cleanup:PASS/.test(execution.stdout), durationMs: execution.durationMs };
    const requirements = environmentRequirements(context); const failed = execution.exitCode !== 0 || !lifecycle.provisioned || !lifecycle.cleaned;
    return { version: 1, provider: execution.plan.provider, capability: "integration-test", status: failed ? "FAIL" : "PASS", requirements, lifecycle, connectionData: redactConnectionData(execution.plan.env), rawArtifact: execution.rawArtifact };
  }
}

export function validateEnvironmentRequirements(context: ValidationProviderContext): string[] {
  const options = context.spec?.options ?? context.providerSpec?.options ?? {}; const failures: string[] = []; const network = String(options.network ?? "isolated");
  if (!["isolated", "none", "project"].includes(network)) failures.push(`Unsupported integration network '${network}'.`);
  if (options.privileged === true) failures.push("Privileged integration environments are not allowed by default.");
  if (network === "host") failures.push("Host networking must not be implicit.");
  if (options.dockerSocket === true) failures.push("Docker socket access is not allowed by default.");
  if (Array.isArray(options.mounts) && options.mounts.some((mount) => String(mount).startsWith("/"))) failures.push("Absolute host mounts require an explicit policy adapter.");
  if (Array.isArray(options.credentials) && options.credentials.length && options.credentialsAllowlist !== true) failures.push("Credentials require an explicit allowlist.");
  const data = options.connectionData; if (data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).some((key) => /(password|token|secret|private.?key)/i.test(key)) && options.connectionDataAllowlist !== true) failures.push("Sensitive connection data requires an explicit allowlist.");
  return failures;
}

function environmentRequirements(context: ValidationProviderContext): IntegrationEnvironmentRequirement[] {
  const options = context.spec?.options ?? context.providerSpec?.options ?? {}; const network = String(options.network ?? "isolated") as IntegrationEnvironmentRequirement["network"];
  return [{ kind: String(options.kind ?? "service"), image: typeof options.image === "string" ? options.image : undefined, network, ephemeral: options.ephemeral !== false, ports: Array.isArray(options.ports) ? options.ports.map(Number).filter(Number.isFinite) : undefined, environment: Array.isArray(options.environment) ? options.environment.map(String) : undefined, mounts: Array.isArray(options.mounts) ? options.mounts.map(String) : undefined }];
}

function connectionData(context: ValidationProviderContext): Record<string, string> | undefined {
  const value = context.spec?.options?.connectionData ?? context.providerSpec?.options?.connectionData;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => typeof item === "string").map(([key, item]) => [key, item as string]));
}

function redactConnectionData(value: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(password|token|secret|private.?key)/i.test(key) ? "<redacted>" : item]));
}
