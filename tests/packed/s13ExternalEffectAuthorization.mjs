import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Typed consumption of an externally provided user authorization artifact for S13 GitHub effects.
 *
 * AEH-V2-0114 (HISTORICAL_POLICY_VIOLATION_CONFIRMED): the Round-10 campaign fabricated its own
 * HumanDecision approvals (`actorId: "human:s13-github"`). A campaign can never grant itself
 * authority. This module is the only producer of `ACTION_AUTHORIZATION` approvals for the S13
 * GitHub certification campaign: it converts a user-supplied, scoped authorization file (path
 * supplied externally through `S13_GH_AUTHORIZATION_FILE`) into a bound `HumanDecision` input whose
 * provenance is the exact artifact bytes and the exact effect digest. When the artifact is absent,
 * unreadable, out of scope, or does not cover the exact effect, the campaign fails closed before
 * any `gh` command, any staging directory, and any approval.
 *
 * The authorization artifact is data: it can narrow the user grant (and this module rejects any
 * requested effect it does not cover), but it cannot widen it, cannot grant ambient authority and
 * cannot delegate authorization back to the campaign. The frozen allowed-effect policy is checked
 * separately, and the effective effect set is the intersection of both.
 */

export const EXTERNAL_AUTHORIZATION_ENV = "S13_GH_AUTHORIZATION_FILE";
/**
 * R11-F1-residual: even though the prospective artifact lists `github.issue.create` in its allowed
 * effects, the user's most recent explicit instruction was "Do not create a repo or issue". A
 * covered effect is therefore still not an instruction to create an issue: the operator must
 * confirm explicitly, per authorization identity, before any issue-create effect. The confirmation
 * is an external typed input (like the artifact itself) and is never inferred or self-minted.
 */
export const EXTERNAL_AUTHORIZATION_ISSUE_CREATE_CONFIRMATION_ENV = "S13_GH_ISSUE_CREATE_CONFIRMATION";

const validatedAuthorization = Symbol("s13.externalEffectAuthorization.validated");

export class ExternalEffectAuthorizationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ExternalEffectAuthorizationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ExternalEffectAuthorizationError(code, message);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function loadExternalEffectAuthorizationV1({ filePath, owner, effects = [], resourceNames = [], issueCreateConfirmation = process.env[EXTERNAL_AUTHORIZATION_ISSUE_CREATE_CONFIRMATION_ENV] } = {}) {
  const authorizationPath = nonEmpty(filePath);
  if (!authorizationPath) fail("EXTERNAL_AUTHORIZATION_MISSING", `no external user authorization was supplied through ${EXTERNAL_AUTHORIZATION_ENV}`);
  let bytes;
  try {
    bytes = await fs.readFile(path.resolve(authorizationPath));
  } catch (error) {
    fail("EXTERNAL_AUTHORIZATION_UNREADABLE", `the external user authorization could not be read (${error?.code ?? "read error"})`);
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("EXTERNAL_AUTHORIZATION_UNREADABLE", "the external user authorization is not valid JSON");
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) fail("EXTERNAL_AUTHORIZATION_INVALID", "the external user authorization must be a JSON object");
  if (document.version !== 1) fail("EXTERNAL_AUTHORIZATION_INVALID", "the external user authorization version is unsupported");
  if (document.kind !== "USER_EXTERNAL_EFFECT_AUTHORIZATION") fail("EXTERNAL_AUTHORIZATION_INVALID", "the artifact kind is not USER_EXTERNAL_EFFECT_AUTHORIZATION");
  if (document.authorizedBy !== "user") fail("EXTERNAL_AUTHORIZATION_INVALID", "the artifact must be granted by the user");
  if (!["ACTIVE", "ACTIVE_PROSPECTIVE"].includes(document.status)) fail("EXTERNAL_AUTHORIZATION_INVALID", "the authorization is not active");
  const scope = document.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) fail("EXTERNAL_AUTHORIZATION_INVALID", "the authorization must declare a scope object");
  const scopeOwner = nonEmpty(scope.owner);
  const privacy = nonEmpty(scope.privacy);
  const allowedEffects = Array.isArray(scope.allowedEffects)
    ? scope.allowedEffects.filter((value) => nonEmpty(value)).map((value) => value.trim())
    : undefined;
  const resourceNamePrefix = nonEmpty(scope.resourceNamePrefix);
  if (!scopeOwner || !privacy || !allowedEffects?.length || !resourceNamePrefix) {
    fail("EXTERNAL_AUTHORIZATION_INVALID", "the authorization must declare scope.owner, scope.privacy, a non-empty scope.allowedEffects and scope.resourceNamePrefix");
  }
  const governance = document.governance ?? {};
  if (governance.ambientAuthorityGranted !== false) fail("EXTERNAL_AUTHORIZATION_INVALID", "the authorization must not grant ambient authority");
  if (typeof governance.campaignSelfAuthorization !== "string" || !governance.campaignSelfAuthorization.startsWith("PROHIBITED")) {
    fail("EXTERNAL_AUTHORIZATION_INVALID", "the authorization must prohibit campaign self-authorization");
  }
  const consumption = document.consumption ?? {};
  if (consumption.requiredBeforeAnyExternalCommand !== true) fail("EXTERNAL_AUTHORIZATION_INVALID", "the authorization must require consumption before any external command");

  if (owner !== undefined && scopeOwner.toLowerCase() !== String(owner).toLowerCase()) {
    fail("EXTERNAL_AUTHORIZATION_OUT_OF_SCOPE", `authorized owner '${scopeOwner}' does not cover '${String(owner)}'`);
  }
  if (privacy !== "PRIVATE_ONLY") fail("EXTERNAL_AUTHORIZATION_OUT_OF_SCOPE", "the authorization is not limited to PRIVATE resources");

  const requestedEffects = (effects ?? []).map((value) => String(value).trim()).filter(Boolean);
  const uncoveredEffects = requestedEffects.filter((effect) => !allowedEffects.includes(effect));
  if (uncoveredEffects.length) {
    fail("EXTERNAL_AUTHORIZATION_EFFECT_NOT_COVERED", `the external authorization does not cover the exact external effect(s): ${uncoveredEffects.join(", ")}`);
  }
  const names = (resourceNames ?? []).map((value) => String(value).trim()).filter(Boolean);
  const outOfScopeNames = names.filter((name) => !name.startsWith(resourceNamePrefix));
  if (outOfScopeNames.length) {
    fail("EXTERNAL_AUTHORIZATION_OUT_OF_SCOPE", `resource name(s) outside the authorized '${resourceNamePrefix}' namespace: ${outOfScopeNames.join(", ")}`);
  }

  const authorizationId = nonEmpty(document.authorizationId) ?? "unnamed-external-authorization";
  const issueCreateConfirmed = requestedEffects.includes("github.issue.create")
    && nonEmpty(issueCreateConfirmation) === authorizationId;
  if (requestedEffects.includes("github.issue.create") && !issueCreateConfirmed) {
    fail("EXTERNAL_AUTHORIZATION_ISSUE_CREATE_UNCONFIRMED", `github.issue.create requires an explicit external user confirmation matching authorization '${authorizationId}' (${EXTERNAL_AUTHORIZATION_ISSUE_CREATE_CONFIRMATION_ENV}); a covered effect is not an instruction to create an issue`);
  }

  const authorization = {
    authorizationId,
    artifactPath: path.resolve(authorizationPath),
    artifactDigest: crypto.createHash("sha256").update(bytes).digest("hex"),
    owner: scopeOwner,
    privacy,
    allowedEffects,
    resourceNamePrefix,
    issueCreateConfirmed,
    status: document.status
  };
  Object.defineProperty(authorization, validatedAuthorization, { value: true, enumerable: false });
  return Object.freeze(authorization);
}

export function assertExternalAuthorizationResourceNamesV1({ authorization, resourceNames }) {
  assertValidatedAuthorization(authorization);
  const names = (resourceNames ?? []).map((value) => String(value).trim()).filter(Boolean);
  const outOfScopeNames = names.filter((name) => !name.startsWith(authorization.resourceNamePrefix));
  if (outOfScopeNames.length) {
    fail("EXTERNAL_AUTHORIZATION_OUT_OF_SCOPE", `resource name(s) outside the authorized '${authorization.resourceNamePrefix}' namespace: ${outOfScopeNames.join(", ")}`);
  }
  return true;
}

export function assertExternalAuthorizationCoversFrozenPolicyV1({ authorization, policyAllowedEffects, effects }) {
  assertValidatedAuthorization(authorization);
  const policyEffects = Array.isArray(policyAllowedEffects) ? policyAllowedEffects : [];
  const requested = (effects ?? []).map((value) => String(value).trim()).filter(Boolean);
  const outsidePolicy = requested.filter((effect) => !policyEffects.includes(effect));
  if (outsidePolicy.length) {
    fail("EXTERNAL_AUTHORIZATION_POLICY_NOT_BOUND", `the frozen allowed-effect policy does not authorize: ${outsidePolicy.join(", ")}`);
  }
  const uncovered = requested.filter((effect) => !authorization.allowedEffects.includes(effect));
  if (uncovered.length) {
    fail("EXTERNAL_AUTHORIZATION_EFFECT_NOT_COVERED", `the external authorization does not cover the exact external effect(s): ${uncovered.join(", ")}`);
  }
  return true;
}

export function externalAuthorizationDecisionInputV1({ authorization, binding, action, effectDigest, now = new Date(), ttlMs = 300_000 }) {
  assertValidatedAuthorization(authorization);
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) fail("EXTERNAL_AUTHORIZATION_INVALID", "the HumanDecision binding is required");
  if (!authorization.allowedEffects.includes(action)) {
    fail("EXTERNAL_AUTHORIZATION_EFFECT_NOT_COVERED", `the external authorization does not cover '${String(action)}'`);
  }
  if (action === "github.issue.create" && authorization.issueCreateConfirmed !== true) {
    fail("EXTERNAL_AUTHORIZATION_ISSUE_CREATE_UNCONFIRMED", `github.issue.create requires an explicit external user confirmation matching authorization '${authorization.authorizationId}'`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(effectDigest))) fail("EXTERNAL_AUTHORIZATION_INVALID", "the exact effect digest is required before an approval can be derived");
  return {
    ...binding,
    purpose: { kind: "ACTION_AUTHORIZATION", action, effectDigest },
    kind: "APPROVE",
    actorId: `human:external-authorization:${authorization.authorizationId}`,
    reason: `External user authorization '${authorization.authorizationId}' (sha256 ${authorization.artifactDigest}) covers ${action} for owner ${authorization.owner} on PRIVATE_ONLY resources bound to effect digest ${effectDigest}.`,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMs)
  };
}

function assertValidatedAuthorization(authorization) {
  if (!authorization || authorization[validatedAuthorization] !== true) {
    fail("EXTERNAL_AUTHORIZATION_NOT_VALIDATED", "an approval may only be derived from loadExternalEffectAuthorizationV1 output");
  }
}
