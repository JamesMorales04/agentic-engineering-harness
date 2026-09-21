import { z } from "zod";
import type { CertificationPolicy } from "./types.js";

const policySchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  assurance: z.object({
    requireDeterministicOracle: z.boolean(),
    requireIndependentOracle: z.boolean(),
    allowRequiredSkippedChecks: z.boolean()
  }),
  budget: z.object({
    maxAttempts: z.number().int().nonnegative(),
    maxDurationMs: z.number().int().positive(),
    maxCostUsd: z.number().nonnegative().optional(),
    maxTotalTokens: z.number().int().nonnegative().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
    requireUsageForTokenBudget: z.boolean().optional()
  }),
  repair: z.object({ enabled: z.boolean(), maxAttempts: z.number().int().nonnegative(), humanOnExhaustion: z.boolean() }),
  review: z.object({ enabled: z.boolean(), required: z.boolean(), humanOnFailure: z.boolean() }),
  security: z.object({
    allowRecursiveCertification: z.boolean(),
    allowNetwork: z.boolean(),
    environmentAllowlist: z.array(z.string()),
    credentialEnvAllowlist: z.array(z.string()),
    maxOutputBytes: z.number().int().positive(),
    requireNetworkIsolation: z.boolean().optional()
  })
});

export function defaultCertificationPolicy(overrides: Partial<CertificationPolicy> = {}): CertificationPolicy {
  return freezePolicy({
    version: 1,
    id: "aeh-default-certification",
    assurance: { requireDeterministicOracle: true, requireIndependentOracle: true, allowRequiredSkippedChecks: false, ...overrides.assurance },
    budget: { maxAttempts: 1, maxDurationMs: 30 * 60_000, maxOutputBytes: 4 * 1024 * 1024, requireUsageForTokenBudget: true, ...overrides.budget },
    repair: { enabled: false, maxAttempts: 0, humanOnExhaustion: true, ...overrides.repair },
    review: { enabled: false, required: false, humanOnFailure: true, ...overrides.review },
    security: { allowRecursiveCertification: false, allowNetwork: false, environmentAllowlist: [], credentialEnvAllowlist: [], maxOutputBytes: 4 * 1024 * 1024, requireNetworkIsolation: false, ...overrides.security }
  });
}

export function validateCertificationPolicy(policy: CertificationPolicy): CertificationPolicy {
  const parsed = policySchema.parse(policy);
  if (parsed.repair.maxAttempts > parsed.budget.maxAttempts) throw new Error("Certification repair maxAttempts cannot exceed the total budget maxAttempts.");
  if (parsed.review.required && !parsed.review.enabled) throw new Error("A required certification review must be enabled.");
  if (parsed.security.credentialEnvAllowlist.some((name) => !parsed.security.environmentAllowlist.includes(name))) {
    throw new Error("Credential environment variables must also be present in environmentAllowlist.");
  }
  return freezePolicy(parsed);
}

function freezePolicy<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) freezePolicy(item);
  }
  return value;
}
