import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../src/core/config.js";
import { initializeProject } from "../src/core/init.js";
import {
  assertIsolatedSelfHostingCharterV1,
  canonicalCharterDigest,
  issueSelfHostingCharterV1,
} from "../src/operations/selfHostingCharter.js";
import { VERSION } from "../src/version.js";
import {
  issueDelegatedOwnerGrantV1,
  revokeDelegatedOwnerGrantV1,
} from "../src/security/ownerAuthority.js";

const roots: string[] = [];
afterEach(async () => {
  delete process.env.AEH_MANAGED_AGENT;
  delete process.env.AEH_INTERACTIVE_LEAD;
  delete process.env.AEH_ORCHESTRATION_ALLOWED;
  delete process.env.AEH_OPERATION_ID;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-delegated-charter-"));
  roots.push(root);
  return root;
}

const TEST_CTX = { via: "test" as const, allowManagedContext: true };
const GRANTOR = "human:owner-test";
const DELEGATE = "delegate:charter-agent";
const future = () => new Date(Date.now() + 3_600_000).toISOString();

async function harnessIdentity(root: string): Promise<void> {
  const pkg = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "..", "package.json"), "utf8")) as {
    name: string; repository: { type: string; url: string };
  };
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: pkg.name, repository: pkg.repository }));
}

async function controllerRoot(): Promise<{ root: string; projectId: string }> {
  const root = await tempRoot();
  await initializeProject(root);
  await harnessIdentity(root);
  const config = await loadProjectConfig(root);
  return { root, projectId: config.project.name };
}

async function isolatedTarget(controllerRootPath: string): Promise<string> {
  const target = await tempRoot();
  await fs.mkdir(path.join(target, ".git"));
  await harnessIdentity(target);
  // Shape the target as a worktree of the controller checkout for git-based
  // classification when callers do not pin the controller seam.
  void controllerRootPath;
  return target;
}

describe("delegated self-hosting charter issuance (DETERMINISTIC)", () => {
  it("issues human charters that the gate accepts with HUMAN_OWNER provenance", async () => {
    const { root } = await controllerRoot();
    const target = await isolatedTarget(root);
    const charter = await issueSelfHostingCharterV1(root, {
      targetRoot: target, kinds: ["change"], expiresAt: future(), authorizedBy: GRANTOR,
    }, TEST_CTX);
    expect(charter.provenance).toMatchObject({ issuedBy: "HUMAN_OWNER" });
    const accepted = await assertIsolatedSelfHostingCharterV1(target, "change", { controllerRoot: root });
    expect(accepted?.charterDigest).toBe(charter.charterDigest);
  });

  it("issues delegated charters under a valid FULL_PROJECT_OWNER grant without involving the human again", async () => {
    const { root, projectId } = await controllerRoot();
    const target = await isolatedTarget(root);
    const grant = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId, expiresAt: future(),
    }, TEST_CTX);
    const charter = await issueSelfHostingCharterV1(root, {
      targetRoot: target, kinds: ["change", "run"], expiresAt: future(), authorizedBy: DELEGATE, delegationId: grant.delegationId,
    }, TEST_CTX);
    expect(charter.provenance).toMatchObject({ issuedBy: "DELEGATED_OWNER", grantorOwnerId: GRANTOR, delegationId: grant.delegationId });
    expect(charter.authorizedBy).toBe(DELEGATE);
    expect(await assertIsolatedSelfHostingCharterV1(target, "change", { controllerRoot: root })).toMatchObject({ charterDigest: charter.charterDigest });
    expect(await assertIsolatedSelfHostingCharterV1(target, "run", { controllerRoot: root })).toMatchObject({ charterDigest: charter.charterDigest });
  });

  it("renews charters under the original delegation after expiry or version drift", async () => {
    const { root, projectId } = await controllerRoot();
    const target = await isolatedTarget(root);
    const grant = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId, expiresAt: future(),
    }, TEST_CTX);
    const first = await issueSelfHostingCharterV1(root, {
      targetRoot: target, kinds: ["change"], expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      authorizedBy: DELEGATE, delegationId: grant.delegationId,
    }, TEST_CTX);
    // A version-drifted charter fails closed even with a valid delegation, and
    // never poisons the remaining valid charter.
    const drifted = { ...first, controller: { aehVersion: "0.0.0-drift" } };
    const dir = path.join(root, ".harness", "self-hosting-charters");
    await fs.writeFile(path.join(dir, "drifted.json"), JSON.stringify({ ...drifted, charterDigest: canonicalCharterDigest(drifted) }));
    expect(await assertIsolatedSelfHostingCharterV1(target, "change", { controllerRoot: root }))
      .toMatchObject({ charterDigest: first.charterDigest });
    // Renewal under the original delegation succeeds without the human; after
    // rotation (old charter removed) the renewed charter carries authority.
    const renewed = await issueSelfHostingCharterV1(root, {
      targetRoot: target, kinds: ["change"], expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      authorizedBy: DELEGATE, delegationId: grant.delegationId,
    }, TEST_CTX);
    expect(renewed.charterDigest).not.toBe(first.charterDigest);
    for (const entry of await fs.readdir(dir)) {
      if (!entry.endsWith(".json") || entry === "drifted.json") continue;
      const stored = JSON.parse(await fs.readFile(path.join(dir, entry), "utf8")) as Record<string, unknown>;
      if (stored.charterDigest === first.charterDigest) await fs.unlink(path.join(dir, entry));
    }
    expect(await assertIsolatedSelfHostingCharterV1(target, "change", { controllerRoot: root }))
      .toMatchObject({ charterDigest: renewed.charterDigest });
    expect(VERSION).not.toBe("0.0.0-drift");
  });

  it("strands delegated charters fail-closed on revocation", async () => {
    const { root, projectId } = await controllerRoot();
    const target = await isolatedTarget(root);
    const grant = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId, expiresAt: future(),
    }, TEST_CTX);
    await issueSelfHostingCharterV1(root, {
      targetRoot: target, kinds: ["change"], expiresAt: future(), authorizedBy: DELEGATE, delegationId: grant.delegationId,
    }, TEST_CTX);
    await revokeDelegatedOwnerGrantV1(root, grant.delegationId, { revokedBy: GRANTOR }, TEST_CTX);
    await expect(assertIsolatedSelfHostingCharterV1(target, "change", { controllerRoot: root }))
      .rejects.toThrow(/SELF_HOSTING_CHARTER_STALE/);
    await expect(issueSelfHostingCharterV1(root, {
      targetRoot: target, kinds: ["change"], expiresAt: future(), authorizedBy: DELEGATE, delegationId: grant.delegationId,
    }, TEST_CTX)).rejects.toThrow(/DELEGATION_REVOKED/);
  });

  it("refuses delegated issuance without a grant, with a foreign grant, or from worker contexts", async () => {
    const { root, projectId } = await controllerRoot();
    const target = await isolatedTarget(root);
    await expect(issueSelfHostingCharterV1(root, {
      targetRoot: target, kinds: ["change"], expiresAt: future(), authorizedBy: DELEGATE,
    }, TEST_CTX)).rejects.toThrow(/requires the authorizing delegationId/);
    await expect(issueSelfHostingCharterV1(root, {
      targetRoot: target, kinds: ["change"], expiresAt: future(), authorizedBy: DELEGATE, delegationId: "delegation:00000000-0000-4000-8000-000000000000",
    }, TEST_CTX)).rejects.toThrow(/DELEGATION_UNKNOWN/);
    const foreign = await tempRoot();
    await initializeProject(foreign);
    await harnessIdentity(foreign);
    const foreignGrant = await issueDelegatedOwnerGrantV1(foreign, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId: "another-project", expiresAt: future(),
    }, TEST_CTX);
    await expect(issueSelfHostingCharterV1(root, {
      targetRoot: target, kinds: ["change"], expiresAt: future(), authorizedBy: DELEGATE, delegationId: foreignGrant.delegationId,
    }, TEST_CTX)).rejects.toThrow(/DELEGATION_UNKNOWN/);
    void projectId;
    process.env.AEH_MANAGED_AGENT = "1";
    await expect(issueSelfHostingCharterV1(root, {
      targetRoot: target, kinds: ["change"], expiresAt: future(), authorizedBy: GRANTOR,
    }, { via: "cli-direct" })).rejects.toThrow(/DELEGATION_ISSUANCE_CONTEXT_INVALID/);
  });

  it("keeps the live controller frozen even with a delegated charter", async () => {
    const { root, projectId } = await controllerRoot();
    await fs.mkdir(path.join(root, ".git"));
    const grant = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId, expiresAt: future(),
    }, TEST_CTX);
    const target = await isolatedTarget(root);
    await issueSelfHostingCharterV1(root, {
      targetRoot: target, kinds: ["change"], expiresAt: future(), authorizedBy: DELEGATE, delegationId: grant.delegationId,
    }, TEST_CTX);
    await expect(assertIsolatedSelfHostingCharterV1(root, "change", { controllerRoot: root }))
      .rejects.toThrow(/SELF_HOSTING_CONTROLLER_FROZEN/);
  });

  it("rejects tampered delegated charters through the digest pin", async () => {
    const { root, projectId } = await controllerRoot();
    const target = await isolatedTarget(root);
    const grant = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId, expiresAt: future(),
    }, TEST_CTX);
    const charter = await issueSelfHostingCharterV1(root, {
      targetRoot: target, kinds: ["change"], expiresAt: future(), authorizedBy: DELEGATE, delegationId: grant.delegationId,
    }, TEST_CTX);
    const dir = path.join(root, ".harness", "self-hosting-charters");
    for (const entry of await fs.readdir(dir)) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(dir, entry);
      const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
      if (stored.charterDigest === charter.charterDigest) {
        await fs.writeFile(file, JSON.stringify({ ...stored, scope: { kinds: ["change", "run", "admin"] } }));
      }
    }
    await expect(assertIsolatedSelfHostingCharterV1(target, "change", { controllerRoot: root }))
      .rejects.toThrow(/SELF_HOSTING_CHARTER_STALE/);
  });
});
