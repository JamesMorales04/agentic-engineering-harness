import type { HarnessProjectConfig, TaskContract, ValidationCapability, ValidationProviderSpec, ValidatorSpec } from "../../core/types.js";
import { GenericBddExecutionProvider, runBddExecution } from "./bddExecution.js";
import { IntegrationEnvironmentProvider } from "./integrationEnvironment.js";
import { PactContractTestingProvider, runPactVerification } from "./pact.js";
import { ReqnrollBddProvider } from "./reqnroll.js";
import { resultCheck } from "./protocol.js";
import { ProjectNativeTestExecutionProvider, runTestExecution } from "./testExecution.js";
import type { BddExecutionResult, ContractVerificationResult, IntegrationEnvironmentResult, TestExecutionResult, ValidationProvider, ValidationProviderContext } from "./types.js";

export type ValidationProviderResult = TestExecutionResult | BddExecutionResult | IntegrationEnvironmentResult | ContractVerificationResult;

export interface CapabilityResolution {
  capability: ValidationCapability;
  provider: string;
  source: "explicit" | "detected" | "fallback";
  command?: string;
}

export class ValidationCapabilityRegistry {
  private readonly providers: Array<ValidationProvider<ValidationProviderResult>> = [];

  constructor() {
    this.register(new ProjectNativeTestExecutionProvider() as ValidationProvider<ValidationProviderResult>);
    this.register(new GenericBddExecutionProvider() as ValidationProvider<ValidationProviderResult>);
    this.register(new IntegrationEnvironmentProvider() as ValidationProvider<ValidationProviderResult>);
    this.register(new PactContractTestingProvider() as ValidationProvider<ValidationProviderResult>);
  }

  register(provider: ValidationProvider<ValidationProviderResult>): void { this.providers.push(provider); }

  list(capability?: ValidationCapability): string[] { return this.providers.filter((provider) => !capability || provider.capabilities.includes(capability)).map((provider) => provider.id); }

  async resolve(context: ValidationProviderContext): Promise<CapabilityResolution | undefined> {
    const candidates = this.providers.filter((candidate) => candidate.capabilities.includes(context.capability));
    const provider = (context.providerSpec?.provider ? candidates.find((candidate) => candidate.id === context.providerSpec?.provider) : undefined) ?? candidates[0];
    if (!provider) return undefined;
    const detection = await provider.detect(context); if (!detection) return undefined;
    return { capability: context.capability, provider: detection.provider, source: context.providerSpec || context.spec?.command ? "explicit" : "detected", command: detection.command };
  }
}

export const validationCapabilityRegistry = new ValidationCapabilityRegistry();

export async function runCapabilityValidator(context: ValidationProviderContext, id: string, capability: ValidationCapability, required: boolean): Promise<ReturnType<typeof resultCheck>> {
  const effective = { ...context, capability };
  if (capability === "bdd") {
    const execution = await runBddExecution(effective, effective.spec?.options?.provider === "reqnroll" ? new ReqnrollBddProvider() as any : undefined);
    return resultCheck(id, "bdd", execution.result, required);
  }
  if (capability === "contract-test") return resultCheck(id, "contract", (await runPactVerification(effective)).result, required);
  if (effective.spec?.adapter === "integration-environment" || ["integration-environment", "oci", "docker", "podman"].includes(effective.providerSpec?.provider ?? "") || typeof (effective.spec?.options ?? effective.providerSpec?.options)?.provisionCommand === "string") {
    const provider = new IntegrationEnvironmentProvider(); const doctor = await provider.doctor(effective); if (!doctor.available) return resultCheck(id, "integration-environment", { version: 1, provider: doctor.provider, capability: "integration-test", status: doctor.details?.securityFailures ? "FAIL" : "SKIP", requirements: [], lifecycle: { provisioned: false, ready: false, tested: false, cleaned: false, durationMs: 0 }, rawArtifact: "" }, required); const detection = await provider.detect(effective); if (!detection) return resultCheck(id, "integration-environment", { version: 1, provider: provider.id, capability: "integration-test", status: "SKIP", requirements: [], lifecycle: { provisioned: false, ready: false, tested: false, cleaned: false, durationMs: 0 }, rawArtifact: "" }, required); const plan = await provider.plan(effective, detection); const execution = await provider.execute(effective, plan); return resultCheck(id, "integration-environment", await provider.normalize(effective, execution), required);
  }
  return resultCheck(id, capability, (await runTestExecution(effective)).result, required);
}

export function providerSpecFor(config: HarnessProjectConfig, capability: ValidationCapability, spec?: ValidatorSpec): ValidationProviderSpec | undefined {
  const providerName = typeof spec?.options?.provider === "string" ? spec.options.provider : undefined;
  return config.validation?.providers?.find((item) => item.capability === capability && (!providerName || item.provider === providerName || item.id === providerName));
}

export function capabilityRequirements(contract: TaskContract): ValidationCapability[] {
  const declared = [...(contract.verification?.capabilities ?? []), ...(contract.requirements ?? []).flatMap((item) => item.capabilities ?? [])]; return [...new Set(declared)];
}
