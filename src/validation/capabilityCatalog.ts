/** Capability names accepted in requirement traces across authoring and runtime validation. */
export const validationCapabilityValues = [
  "unit-test",
  "integration-test",
  "bdd",
  "contract-test",
  "browser-test",
  "visual-test",
  "static-security",
  "dependency-security",
  "architecture",
  "policy",
  "command"
] as const;

export type ValidationCapabilityName = (typeof validationCapabilityValues)[number];

export function isValidationCapability(value: string): value is ValidationCapabilityName {
  return (validationCapabilityValues as readonly string[]).includes(value);
}
