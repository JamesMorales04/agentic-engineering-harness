import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sha256Canonical } from "../core/digest.js";
import type { HarnessProjectConfig, TaskContract, ValidationCapability, ValidatorSpec } from "../core/types.js";
import type { ProjectStackProfileV1 } from "../participants/stack.js";
import type { ToolAvailabilityV1 } from "../participants/toolRegistry.js";
import { isValidationCapability, validationCapabilityValues } from "../validation/capabilityCatalog.js";

export const validationRequirementKindValues = validationCapabilityValues;

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
  testSelectors?: string[];
}

export const validationRequirementSchema = z.object({
  version: z.literal(1),
  id: z.string().trim().min(1).max(120),
  property: z.string().trim().min(1).max(500),
  kind: z.enum(validationRequirementKindValues),
  scope: z.array(z.string().trim().min(1).max(500)).min(1).max(128),
  evidenceNeeded: z.array(z.string().trim().min(1).max(300)).min(1).max(64),
  requirementRefs: z.array(z.string().trim().min(1).max(120)).max(128),
  acceptanceRefs: z.array(z.string().trim().min(1).max(120)).max(128),
  testSelectors: z.array(z.string().trim().min(1).max(300)).min(1).max(64).optional()
}).strict();

/**
 * Deterministic check-id → validation-kind mapping for the frozen contract requirement →
 * configured validation traceability convention: configured commands persist as `command.<id>`
 * (src/validators/commands.ts) and configured validators persist under their own id, which is
 * what the requirement evidence graph matches against (src/evidence/graph.ts). A check id with
 * no configured command/validator behind it has no deterministic kind and is never fabricated.
 */
export function configuredValidationKindForCheckV1(
  checkId: string,
  input: { commands?: readonly { id: string }[]; validators?: readonly { id: string; adapter: string }[]; providers?: readonly { id: string; capability: ValidationCapability; provider: string }[] } = {}
): ValidationRequirementKindV1 | undefined {
  if (input.commands?.some((command) => `command.${command.id}` === checkId)) return "command";
  if (checkId.startsWith("capability:")) {
    const capability = checkId.slice("capability:".length);
    if (!isValidationCapability(capability) || !input.providers?.some((provider) => provider.capability === capability)) return undefined;
    return adapterKinds[capability];
  }
  const validator = input.validators?.find((candidate) => candidate.id === checkId);
  if (validator) return adapterKinds[validator.adapter];
  return undefined;
}

// Schema caps mirrored from validationRequirementSchema below (property max 500,
// evidence entry max 300). Mechanism=DETERMINISTIC: pure string-length bound, no model judgment.
const CONTRACT_PROPERTY_MAX = 500;
const CONTRACT_EVIDENCE_MAX = 300;

function truncateCheckIdDisplay(checkId: string, budget: number): string {
  if (budget <= 0) return "";
  if (checkId.length <= budget) return checkId;
  if (budget === 1) return "…";
  return `${checkId.slice(0, budget - 1)}…`;
}

/**
 * Deterministic bound for contract-derived validation text. The full binding stays
 * recoverable via requirement.id (check id) plus requirementRefs/acceptanceRefs and the
 * validation-resolution/assurance digests; the 500/300-char display fields carry a
 * bounded summary when the detailed join would overflow. Refs are never truncated or
 * dropped; only the human-readable summary falls back to a count.
 */
function contractValidationTextV1(checkId: string, requirementRefs: readonly string[]): { property: string; evidence: string } {
  const detailedProperty = `Frozen contract requirement(s) ${requirementRefs.join(", ")} must be validated by '${checkId}'.`;
  const detailedEvidence = `passing '${checkId}' validation evidence for the frozen contract requirement(s) ${requirementRefs.join(", ")}.`;
  if (detailedProperty.length <= CONTRACT_PROPERTY_MAX && detailedEvidence.length <= CONTRACT_EVIDENCE_MAX) {
    return { property: detailedProperty, evidence: detailedEvidence };
  }
  const count = requirementRefs.length;
  const propertyOverhead = `Frozen contract requirement(s) (${count}) must be validated by ''.`.length;
  const evidenceOverhead = `passing '' validation evidence for ${count} frozen contract requirement(s).`.length;
  const propertyBudget = Math.max(0, CONTRACT_PROPERTY_MAX - propertyOverhead);
  const evidenceBudget = Math.max(0, CONTRACT_EVIDENCE_MAX - evidenceOverhead);
  return {
    property:
      detailedProperty.length <= CONTRACT_PROPERTY_MAX
        ? detailedProperty
        : `Frozen contract requirement(s) (${count}) must be validated by '${truncateCheckIdDisplay(checkId, propertyBudget)}'.`,
    evidence:
      detailedEvidence.length <= CONTRACT_EVIDENCE_MAX
        ? detailedEvidence
        : `passing '${truncateCheckIdDisplay(checkId, evidenceBudget)}' validation evidence for ${count} frozen contract requirement(s).`
  };
}

/**
 * Compile the frozen contract requirements' bound validators into explicit candidate-bound
 * ValidationRequirements. Each distinct validator check id becomes exactly one requirement whose
 * id is the deterministic validation check id and whose `requirementRefs`/`acceptanceRefs` name
 * every contract requirement that declared it, so `resolveVerificationRequirementsV1` binds the
 * assertion to the exact evidence path. Validators without a configured deterministic kind are
 * skipped; the AcceptanceOracle then fails closed with no fabricated correspondence.
 */
export function contractValidationRequirementsV1(input: {
  requirements: readonly { id: string; validators?: readonly string[] }[];
  scope: readonly string[];
  commands?: readonly { id: string }[];
  validators?: readonly { id: string; adapter: string }[];
  providers?: readonly { id: string; capability: ValidationCapability; provider: string }[];
}): ValidationRequirementV1[] {
  const scope = [...new Set(input.scope.map((entry) => entry.trim()).filter(Boolean))];
  const byCheckId = new Map<string, Set<string>>();
  for (const requirement of input.requirements) {
    for (const checkId of new Set(requirement.validators ?? [])) {
      if (!checkId.trim()) continue;
      const refs = byCheckId.get(checkId) ?? new Set<string>();
      refs.add(requirement.id);
      byCheckId.set(checkId, refs);
    }
  }
  const output: ValidationRequirementV1[] = [];
  for (const [checkId, refs] of [...byCheckId.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const kind = configuredValidationKindForCheckV1(checkId, input);
    if (!kind) continue;
    const requirementRefs = [...refs].sort();
    const text = contractValidationTextV1(checkId, requirementRefs);
    output.push({
      version: 1,
      id: checkId,
      property: text.property,
      kind,
      scope: scope.length ? scope : ["**"],
      evidenceNeeded: [text.evidence],
      requirementRefs,
      acceptanceRefs: [...requirementRefs]
    });
  }
  return output;
}

/**
 * Merge frozen-contract-derived validation requirements into the plan-declared base set. A plan
 * requirement that names the same deterministic validation check id as a contract-derived
 * requirement is the same validation need (the compiled plan is allowed to name the configured
 * validator ids it observes); the contract-derived requirement is normative and replaces it when
 * the declared kind agrees. An incompatible same-id declaration is a genuine deterministic
 * conflict and fails closed instead of silently dropping a requirement.
 */
export function mergeContractValidationRequirementsV1(
  base: readonly ValidationRequirementV1[],
  contractDerived: readonly ValidationRequirementV1[]
): ValidationRequirementV1[] {
  const byId = new Map(base.map((requirement) => [requirement.id, requirement]));
  for (const derived of contractDerived) {
    const existing = byId.get(derived.id);
    if (existing && existing.kind !== derived.kind) {
      throw new Error(`VALIDATION_REQUIREMENT_ID_CONFLICT: plan requirement '${derived.id}' declares kind '${existing.kind}' but the frozen contract-derived requirement declares '${derived.kind}'.`);
    }
    // Preserve plan-declared test attribution when the normative contract-derived
    // requirement carries none; union is fail-closed (more selectors = more evidence required).
    const preserved = existing?.testSelectors?.length
      ? [...new Set([...(existing.testSelectors ?? []), ...(derived.testSelectors ?? [])])]
      : derived.testSelectors;
    byId.set(derived.id, preserved?.length ? { ...derived, testSelectors: preserved } : derived);
  }
  return [...byId.values()];
}

/**
 * Split plan-declared validation requirements into the resolvable set and the advisory set that no
 * approved project script, configured command, validator, or provider resolves. Only the resolvable
 * set may compile into the participant plan; the frozen contract's own validators are compiled and
 * enforced independently, so an unresolvable advisory requirement is recorded and dropped instead
 * of rejecting the entire implementation plan before any work runs (AEH-V2-0118).
 */
export function dropUnresolvablePlanValidationRequirementsV1(
  requirements: readonly ValidationRequirementV1[],
  resolution: ValidationResolutionV1
): { kept: ValidationRequirementV1[]; dropped: ValidationRequirementV1[] } {
  const blockedIds = new Set(resolution.blocked.map((item) => item.requirementId));
  return {
    kept: requirements.filter((requirement) => !blockedIds.has(requirement.id)),
    dropped: requirements.filter((requirement) => blockedIds.has(requirement.id))
  };
}

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
  "browser-test": ["test:browser-e2e", "e2e", "test:e2e", "browser"],
  "visual-test": ["test:browser-visual", "visual", "test:visual", "visual-regression"],
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
  openapi: "contract-test",
  playwright: "browser-test",
  "browser-test": "browser-test",
  visual: "visual-test",
  "visual-test": "visual-test",
  opengrep: "static-security",
  "static-security": "static-security",
  trivy: "dependency-security",
  "dependency-security": "dependency-security",
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
  // A `command`-kind requirement states the property to demonstrate; the Planner must not select a
  // concrete command. When it does not name one of the approved command ids and the frozen project
  // config approves exactly one command, that command is the deterministic resolution (matching the
  // single-configured-validator/provider rule below) instead of a fail-closed block (AEH-V2-0110).
  const command = commands.find((candidate) => candidate.id === requirement.id || candidate.id === requirement.kind || `command.${candidate.id}` === requirement.id)
    ?? (requirement.kind === "command" && commands.length === 1 ? commands[0] : undefined);
  if (command) return action(requirement, "configured-command", command.id, command.command);

  const validator = validators.find((candidate) => adapterKinds[candidate.adapter] === requirement.kind && (candidate.id === requirement.id || candidate.id === requirement.kind || validators.length === 1));
  if (validator) return action(requirement, "configured-validator", validator.id, validator.command);

  const matchingProviders = providers.filter((candidate) => providerKind(candidate.capability) === requirement.kind);
  const provider = matchingProviders.find((candidate) => candidate.id === requirement.id || candidate.provider === requirement.kind)
    ?? (matchingProviders.length === 1 ? matchingProviders[0] : undefined);
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
