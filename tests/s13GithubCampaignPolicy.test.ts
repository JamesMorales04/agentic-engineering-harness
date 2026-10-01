import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const campaign = fileURLToPath(new URL("./packed/s13GithubEffectCampaign.mjs", import.meta.url));
const authorizationModule = fileURLToPath(new URL("./packed/s13ExternalEffectAuthorization.mjs", import.meta.url));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isolatedRoot(): { root: string; isolatedTmp: string; bin: string; marker: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "aeh-s13-gh-policy-"));
  roots.push(root);
  const isolatedTmp = path.join(root, "tmp");
  const bin = path.join(root, "bin");
  mkdirSync(isolatedTmp);
  mkdirSync(bin);
  const marker = path.join(root, "external-command-ran");
  return { root, isolatedTmp, bin, marker };
}

function fakeGh(bin: string, marker: string, mode: "fail-all" | "proceed" = "fail-all"): void {
  const gh = path.join(bin, "gh");
  const script = mode === "proceed"
    ? `#!/bin/sh\nprintf invoked > '${marker}'\ncase "$1" in\n  auth) if [ "$2" = "token" ]; then printf 'fake-token'; exit 0; fi; if [ "$2" = "status" ]; then printf 'Logged in to github.com account JamesMorales04\\n'; exit 0; fi;;\nesac\nexit 1\n`
    : `#!/bin/sh\nprintf invoked > '${marker}'\nexit 0\n`;
  writeFileSync(gh, script);
  chmodSync(gh, 0o755);
}

function authorizationDocument(overrides: { scope?: Record<string, unknown> } = {}): Record<string, unknown> {
  return {
    version: 1,
    slice: "S13",
    kind: "USER_EXTERNAL_EFFECT_AUTHORIZATION",
    authorizationId: "test-external-authorization",
    status: "ACTIVE_PROSPECTIVE",
    authorizedBy: "user",
    authoritySource: { kind: "explicit user instruction", retroactive: false },
    scope: {
      owner: "JamesMorales04",
      privacy: "PRIVATE_ONLY",
      resourceNamePrefix: "aeh-s13-",
      allowedEffects: ["git.push", "github.branch.create", "github.issue.create"],
      ...(overrides.scope ?? {})
    },
    governance: { ambientAuthorityGranted: false, campaignSelfAuthorization: "PROHIBITED — a campaign may not mint its own HumanDecision." },
    consumption: { requiredBeforeAnyExternalCommand: true },
    notAuthorized: ["repositories or resources owned by anyone other than JamesMorales04"]
  };
}

function writeAuthorization(root: string, overrides: Record<string, unknown> = {}): string {
  const file = path.join(root, "external-authorization.json");
  writeFileSync(file, `${JSON.stringify(authorizationDocument(overrides), null, 2)}\n`);
  return file;
}

function runCampaign(options: { isolatedTmp: string; bin: string; env: Record<string, string> }): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [campaign, process.cwd()], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${options.bin}${path.delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: options.isolatedTmp,
      S13_ROUND: "11",
      S13_GH_REUSE_REPO: "JamesMorales04/aeh-s13-authorized-fixture",
      ...options.env
    }
  });
  return { status: result.status, stderr: result.stderr ?? "" };
}

describe("S13 GitHub campaign external-effect policy", () => {
  it("fails before staging or invoking GitHub when the pre-authorized repository input is absent", () => {
    const { root, isolatedTmp, bin, marker } = isolatedRoot();
    fakeGh(bin, marker);
    const result = spawnSync(process.execPath, [campaign, process.cwd()], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        TMPDIR: isolatedTmp,
        S13_GH_REUSE_REPO: "",
        S13_GH_ISSUE: "1",
        S13_GH_CREATE_ISSUE: "",
        S13_ROUND: "11"
      }
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("S13_GH_REUSE_REPO is required; an explicit pre-authorized repository target must be supplied");
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  });

  it("defaults to the user-authorized existing issue #1 and fails closed with a typed error before any gh command or staging when no external authorization is supplied", () => {
    const { isolatedTmp, bin, marker } = isolatedRoot();
    fakeGh(bin, marker);
    const result = runCampaign({
      isolatedTmp,
      bin,
      env: { S13_GH_ISSUE: "", S13_GH_CREATE_ISSUE: "", S13_GH_AUTHORIZATION_FILE: "" }
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EXTERNAL_AUTHORIZATION_MISSING");
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  });

  it("fails closed with a typed error when the external authorization is unreadable", () => {
    const { root, isolatedTmp, bin, marker } = isolatedRoot();
    fakeGh(bin, marker);
    const result = runCampaign({
      isolatedTmp,
      bin,
      env: { S13_GH_ISSUE: "1", S13_GH_CREATE_ISSUE: "", S13_GH_AUTHORIZATION_FILE: path.join(root, "missing.json") }
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EXTERNAL_AUTHORIZATION_UNREADABLE");
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  });

  it("fails closed with a typed error before any gh command when the authorization does not cover the exact effect", () => {
    const { root, isolatedTmp, bin, marker } = isolatedRoot();
    fakeGh(bin, marker);
    const file = writeAuthorization(root, { scope: { allowedEffects: ["git.push"] } });
    const result = runCampaign({
      isolatedTmp,
      bin,
      env: { S13_GH_ISSUE: "1", S13_GH_CREATE_ISSUE: "", S13_GH_AUTHORIZATION_FILE: file }
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EXTERNAL_AUTHORIZATION_EFFECT_NOT_COVERED");
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  });

  it("fails closed with a typed error before any gh command when the authorization owner is out of scope", () => {
    const { root, isolatedTmp, bin, marker } = isolatedRoot();
    fakeGh(bin, marker);
    const file = writeAuthorization(root, { scope: { owner: "someone-else" } });
    const result = runCampaign({
      isolatedTmp,
      bin,
      env: { S13_GH_ISSUE: "1", S13_GH_CREATE_ISSUE: "", S13_GH_AUTHORIZATION_FILE: file }
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EXTERNAL_AUTHORIZATION_OUT_OF_SCOPE");
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  });

  it("fails closed before any gh command when issue-create coverage exists without an explicit user confirmation", () => {
    const { root, isolatedTmp, bin, marker } = isolatedRoot();
    fakeGh(bin, marker);
    const file = writeAuthorization(root);
    const result = runCampaign({
      isolatedTmp,
      bin,
      env: { S13_GH_ISSUE: "", S13_GH_CREATE_ISSUE: "1", S13_GH_AUTHORIZATION_FILE: file }
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EXTERNAL_AUTHORIZATION_ISSUE_CREATE_UNCONFIRMED");
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  });

  it("consumes a valid external authorization and only then proceeds to real GitHub interaction", () => {
    const { root, isolatedTmp, bin, marker } = isolatedRoot();
    fakeGh(bin, marker, "proceed");
    const file = writeAuthorization(root);
    const result = runCampaign({
      isolatedTmp,
      bin,
      env: { S13_GH_ISSUE: "1", S13_GH_CREATE_ISSUE: "", S13_GH_AUTHORIZATION_FILE: file }
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(result.stderr).toContain("pre-authorized repository verification failed");
    expect(readdirSync(isolatedTmp).length).toBeGreaterThan(0);
  });

  it("contains no repository creation/deletion command, no issue edit, and no fabricated HumanDecision approval", () => {
    const source = readFileSync(campaign, "utf8");
    expect(source).not.toMatch(/run\("gh",\s*\["repo",\s*"(?:create|delete)"/);
    expect(source).not.toMatch(/run\("gh",\s*\["issue",\s*"edit"/);
    expect(source).not.toContain("human:s13-github");
    expect(source).not.toMatch(/kind:\s*"APPROVE"/);
    expect(source).toContain('action: "github.issue.create"');
    expect(source).toContain("gated.executeGatedAction");
    expect(source).toContain("reconciliation.reconcileToolAction");
    expect(source).toContain("issueLane.result = skipImport &&");
    expect(source).toContain("S13_GH_AUTHORIZATION_FILE");
  });
});

describe("S13 external effect authorization consumption", () => {
  it("rejects a missing, unreadable, invalid, out-of-scope or effect-uncovering authorization with typed errors", async () => {
    const module = await import(pathToFileURL(authorizationModule).href);
    const root = mkdtempSync(path.join(os.tmpdir(), "aeh-s13-authz-"));
    roots.push(root);

    await expect(module.loadExternalEffectAuthorizationV1({ filePath: "", owner: "JamesMorales04", effects: ["git.push"] })).rejects.toMatchObject({ code: "EXTERNAL_AUTHORIZATION_MISSING" });
    await expect(module.loadExternalEffectAuthorizationV1({ filePath: path.join(root, "absent.json"), owner: "JamesMorales04", effects: ["git.push"] })).rejects.toMatchObject({ code: "EXTERNAL_AUTHORIZATION_UNREADABLE" });
    const invalid = path.join(root, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ version: 1, kind: "USER_EXTERNAL_EFFECT_AUTHORIZATION" }));
    await expect(module.loadExternalEffectAuthorizationV1({ filePath: invalid, owner: "JamesMorales04", effects: ["git.push"] })).rejects.toMatchObject({ code: "EXTERNAL_AUTHORIZATION_INVALID" });
    const outOfScope = writeAuthorization(root, { scope: { owner: "someone-else" } });
    await expect(module.loadExternalEffectAuthorizationV1({ filePath: outOfScope, owner: "JamesMorales04", effects: ["git.push"] })).rejects.toMatchObject({ code: "EXTERNAL_AUTHORIZATION_OUT_OF_SCOPE" });
    const uncovered = writeAuthorization(root, { scope: { allowedEffects: ["git.push"] } });
    await expect(module.loadExternalEffectAuthorizationV1({ filePath: uncovered, owner: "JamesMorales04", effects: ["github.issue.create"] })).rejects.toMatchObject({ code: "EXTERNAL_AUTHORIZATION_EFFECT_NOT_COVERED" });
    const badName = writeAuthorization(root);
    await expect(module.loadExternalEffectAuthorizationV1({ filePath: badName, owner: "JamesMorales04", effects: ["git.push"], resourceNames: ["other-repo"] })).rejects.toMatchObject({ code: "EXTERNAL_AUTHORIZATION_OUT_OF_SCOPE" });
  });

  it("requires an explicit external confirmation for issue-create coverage and refuses an unconfirmed approval", async () => {
    const module = await import(pathToFileURL(authorizationModule).href);
    const root = mkdtempSync(path.join(os.tmpdir(), "aeh-s13-authz-confirm-"));
    roots.push(root);
    const file = writeAuthorization(root);

    await expect(module.loadExternalEffectAuthorizationV1({ filePath: file, owner: "JamesMorales04", effects: ["github.issue.create"], issueCreateConfirmation: "" })).rejects.toMatchObject({ code: "EXTERNAL_AUTHORIZATION_ISSUE_CREATE_UNCONFIRMED" });
    await expect(module.loadExternalEffectAuthorizationV1({ filePath: file, owner: "JamesMorales04", effects: ["github.issue.create"], issueCreateConfirmation: "another-authorization" })).rejects.toMatchObject({ code: "EXTERNAL_AUTHORIZATION_ISSUE_CREATE_UNCONFIRMED" });

    const confirmed = await module.loadExternalEffectAuthorizationV1({ filePath: file, owner: "JamesMorales04", effects: ["github.issue.create"], issueCreateConfirmation: "test-external-authorization" });
    expect(confirmed.issueCreateConfirmed).toBe(true);
    const binding = { operationId: "CHANGE-TEST", candidate: { operationId: "CHANGE-TEST" }, operationExecutionRevision: 1, policyDigest: "a".repeat(64), controllerEpoch: 0 };
    expect(module.externalAuthorizationDecisionInputV1({ authorization: confirmed, binding, action: "github.issue.create", effectDigest: "c".repeat(64) }).actorId).toBe("human:external-authorization:test-external-authorization");

    const pushOnly = await module.loadExternalEffectAuthorizationV1({ filePath: file, owner: "JamesMorales04", effects: ["git.push"] });
    expect(pushOnly.issueCreateConfirmed).toBe(false);
    expect(() => module.externalAuthorizationDecisionInputV1({ authorization: pushOnly, binding, action: "github.issue.create", effectDigest: "c".repeat(64) })).toThrow(/EXTERNAL_AUTHORIZATION_ISSUE_CREATE_UNCONFIRMED/);
  });

  it("derives a bound approval only from a validated external authorization", async () => {
    const module = await import(pathToFileURL(authorizationModule).href);
    const root = mkdtempSync(path.join(os.tmpdir(), "aeh-s13-authz-"));
    roots.push(root);
    const file = writeAuthorization(root);
    const authorization = await module.loadExternalEffectAuthorizationV1({ filePath: file, owner: "JamesMorales04", effects: ["git.push"], resourceNames: ["aeh-s13-fixture"] });
    const pushOnly = await module.loadExternalEffectAuthorizationV1({ filePath: writeAuthorization(root, { scope: { allowedEffects: ["git.push"] } }), owner: "JamesMorales04", effects: ["git.push"] });

    const binding = { operationId: "CHANGE-TEST", candidate: { operationId: "CHANGE-TEST" }, operationExecutionRevision: 1, policyDigest: "a".repeat(64), controllerEpoch: 0 };
    expect(() => module.externalAuthorizationDecisionInputV1({ authorization: { allowedEffects: ["git.push"] }, binding, action: "git.push", effectDigest: "b".repeat(64) })).toThrow(/EXTERNAL_AUTHORIZATION_NOT_VALIDATED/);
    expect(() => module.externalAuthorizationDecisionInputV1({ authorization: pushOnly, binding, action: "github.issue.create", effectDigest: "b".repeat(64) })).toThrow(/EXTERNAL_AUTHORIZATION_EFFECT_NOT_COVERED/);
    const decision = module.externalAuthorizationDecisionInputV1({ authorization, binding, action: "git.push", effectDigest: "b".repeat(64) });
    expect(decision.actorId).toBe("human:external-authorization:test-external-authorization");
    expect(decision.reason).toContain(authorization.artifactDigest);
    expect(decision.reason).toContain("b".repeat(64));
    expect(decision.purpose).toEqual({ kind: "ACTION_AUTHORIZATION", action: "git.push", effectDigest: "b".repeat(64) });
    expect(module.assertExternalAuthorizationCoversFrozenPolicyV1({ authorization, policyAllowedEffects: ["git.push"], effects: ["git.push"] })).toBe(true);
    expect(() => module.assertExternalAuthorizationCoversFrozenPolicyV1({ authorization, policyAllowedEffects: ["github.issue.create"], effects: ["git.push"] })).toThrow(/EXTERNAL_AUTHORIZATION_POLICY_NOT_BOUND/);
  });
});
