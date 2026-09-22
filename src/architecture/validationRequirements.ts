import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sha256Canonical } from "../core/digest.js";
import type { HarnessProjectConfig, TaskContract, ValidationCapability, ValidatorSpec } from "../core/types.js";
import type { ProjectStackProfileV1 } from "../participants/stack.js";
import type { ToolAvailabilityV1 } from "../participants/toolRegistry.js";

export const validationRequirementKindValues = [
  "unit-test",
  "integration-test",
  "bdd",
  "contract-test",
  "browser-test",
  "static-security",
  "dependency-security",
  "architecture",
  "policy",
  "command"
] as const;

export type ValidationRequirementKindV1 = (typeof validationRequirementKindValues)[number];

export interface ValidationRequirementV1 {
  version: 1;
  id: string;
  property: string;
  kind: ValidationRequirementKindV1;
  scope: string[];
  evidenceNeeded: string[];
  requirementRefs: string[];
  acceptanceRefs: string[];
}

export const validationRequirementSchema = z.object({
  version: z.literal(1),
  id: z.string().trim().min(1).max(120),
  property: z.string().trim().min(1).max(500),
  kind: z.enum(validationRequirementKindValues),
  scope: z.array(z.string().trim().min(1).max(500)).min(1).max(128),
  evidenceNeeded: z.array(z.string().trim().min(1).max(300)).min(1).max(64),
  requirementRefs: z.array(z.string().trim().min(1).max(120)).max(128),
  acceptanceRefs: z.array(z.string().trim().min(1).max(120)).max(128)
}).strict();

export interface ResolvedValidationActionV1 {
  version: 1;
  requirementId: string;
  kind: ValidationRequirementKindV1;
  source: "project-script" | "configured-command" | "configured-validator" | "approved-provider";
  selector: string;
  command?: string;
  provider?: string;
  scope: string[];
  evidenceNeeded: string[];
}

export interface ValidationResolutionV1 {
  version: 1;
  requirements: ValidationRequirementV1[];
  actions: ResolvedValidationActionV1[];
  blocked: Array<{ requirementId: string; reason: string }>;
  digest: string;
}

export interface ValidationResolverOptionsV1 {
  root: string;
  requirements: readonly ValidationRequirementV1[];
  config?: HarnessProjectConfig;
  contract?: TaskContract;
  projectStack?: ProjectStackProfileV1;
  availableTools?: readonly ToolAvailabilityV1[];
  allowedKinds?: readonly ValidationRequirementKindV1[];
}

const scriptCandidates: Readonly<Record<ValidationRequirementKindV1, readonly string[]>> = {
  "unit-test": ["test"],
  "integration-test": ["integration", "test:integration", "integration-test"],
  bdd: ["bdd", "acceptance", "test:bdd"],
  "contract-test": ["contract", "test:contract"],
  "browser-test": ["e2e", "test:e2e", "browser"],
  "static-security": ["security", "lint", "check"],
  "dependency-security": ["audit", "security:dependencies"],
  architecture: ["architecture", "check:architecture"],
  policy: ["policy", "check:policy"],
  command: []
};

const adapterKinds: Readonly<Record<string, ValidationRequirementKindV1>> = {
  bdd: "bdd",
  gherkin: "bdd",
  reqnroll: "bdd",
  "test-execution": "unit-test",
  "unit-test": "unit-test",
  "integration-test": "integration-test",
  "integration-environment": "integration-test",
  "contract-test": "contract-test",
  pact: "contract-test",
  playwright: "browser-test",
  opengrep: "static-security",
  trivy: "dependency-security",
  architecture: "architecture",
  policy: "policy",
  command: "command"
};

/**
 * Resolves semantic validation needs to project/configured actions. The model
 * supplies only the requirement; it cannot select an executable command,
 * provider, tool or credential.
 */
export async function resolveValidationRequirements(input: ValidationResolverOptionsV1): Promise<ValidationResolutionV1> {
  const requirements = input.requirements.map((requirement) => validationRequirementSchema.parse(requirement));
  const allowed = new Set(input.allowedKinds ?? validationRequirementKindValues);
  const scripts = await projectScripts(input.root);
  const commands = [...(input.config?.validation?.commands ?? []), ...(input.contract?.verification?.commands ?? [])];
  const validators = [...(input.config?.validation?.validators ?? []), ...(input.contract?.verification?.validators ?? [])];
  const providers = input.config?.validation?.providers ?? [];
  const actions: ResolvedValidationActionV1[] = [];
  const blocked: Array<{ requirementId: string; reason: string }> = [];

  for (const requirement of requirements) {
    if (!allowed.has(requirement.kind)) {
      blocked.push({ requirementId: requirement.id, reason: `validation kind '${requirement.kind}' is disallowed by policy.` });
      continue;
    }
    const action = resolveConfigured(requirement, commands, validators, providers, input.availableTools) ?? resolveProjectScript(requirement, scripts, input.projectStack);
    if (!action) blocked.push({ requirementId: requirement.id, reason: `no approved project script, command, validator, or provider resolves '${requirement.kind}'.` });
    else actions.push(action);
  }

  const withoutDigest = { version: 1 as const, requirements, actions, blocked };
  return { ...withoutDigest, digest: sha256Canonical(withoutDigest) };
}

function resolveConfigured(
  requirement: ValidationRequirementV1,
  commands: readonly { id: string; command: string }[],
  validators: readonly ValidatorSpec[],
  providers: readonly { id: string; capability: ValidationCapability; provider: string; command?: string; options?: Record<string, unknown> }[],
  availableTools: readonly ToolAvailabilityV1[] | undefined
): ResolvedValidationActionV1 | undefined {
  const command = commands.find((candidate) => candidate.id === requirement.id || candidate.id === requirement.kind);
  if (command) return action(requirement, "configured-command", command.id, command.command);

  const validator = validators.find((candidate) => adapterKinds[candidate.adapter] === requirement.kind && (candidate.id === requirement.id || candidate.id === requirement.kind || validators.length === 1));
  if (validator) return action(requirement, "configured-validator", validator.id, validator.command);

  const provider = providers.find((candidate) => providerKind(candidate.capability) === requirement.kind && (candidate.id === requirement.id || candidate.provider === requirement.kind || providers.length === 1));
  if (!provider) return undefined;
  const requiredTool = typeof provider.options?.tool === "string" ? provider.options.tool : undefined;
  if (requiredTool && !availableTools?.some((tool) => tool.id === requiredTool && tool.available)) return undefined;
  return { ...action(requirement, "approved-provider", provider.id, provider.command), provider: provider.provider };
}

function resolveProjectScript(requirement: ValidationRequirementV1, scripts: Readonly<Record<string, string>>, stack: ProjectStackProfileV1 | undefined): ResolvedValidationActionV1 | undefined {
  const script = scriptCandidates[requirement.kind].find((name) => typeof scripts[name] === "string" && scripts[name]!.trim());
  if (!script) return undefined;
  return action(requirement, "project-script", script, script === "test" ? "npm test" : `npm run ${script}`);
}

function action(requirement: ValidationRequirementV1, source: ResolvedValidationActionV1["source"], selector: string, command?: string): ResolvedValidationActionV1 {
  return { version: 1, requirementId: requirement.id, kind: requirement.kind, source, selector, ...(command ? { command } : {}), scope: [...requirement.scope], evidenceNeeded: [...requirement.evidenceNeeded] };
}

function providerKind(capability: ValidationCapability): ValidationRequirementKindV1 | undefined {
  return adapterKinds[capability];
}

async function projectScripts(root: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(parsed.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}
