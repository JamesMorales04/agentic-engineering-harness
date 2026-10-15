import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadProjectConfig } from "../src/core/config.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { bindProvisionedWorkspaceCandidate } from "../src/operations/controller.js";
import {
  claimControllerEpoch,
  loadOperation,
  saveOperation,
} from "../src/operations/state.js";

async function tempRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function controlWithCandidate(): Promise<{ root: string; operationId: string }> {
  const root = await tempRoot("aeh-provision-bind-");
  const now = new Date().toISOString();
  const operationId = `OP-PROVISION-${Date.now().toString(36).toUpperCase()}`;
  await saveOperation(root, { version: 1, id: operationId, kind: "change", status: "RUNNING", phase: "preparing", root, payload: { request: "bounded fixture change" }, createdAt: now, updatedAt: now });
  await claimControllerEpoch(root, operationId, "controller:test", { pid: process.pid });
  return { root, operationId };
}

describe("provision-before-bind workspace candidate", () => {
  it("provisions isolated workspaces before digesting and binding (order enforced)", async () => {
    const { root, operationId } = await controlWithCandidate();
    const executionRoot = await tempRoot("aeh-provision-exec-");
    await fs.writeFile(path.join(executionRoot, "source.txt"), "original\n");
    const config = await loadProjectConfig(process.cwd()).catch(() => ({ version: 1, project: { name: "fixture-project" } }) as never);
    const prior = (await loadOperation(root, operationId)).candidateRevision!;
    const preDigest = await computeWorktreeDigest(executionRoot);
    const setupCalls: unknown[][] = [];
    const traces: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const setup = vi.fn(async (setupRoot: string) => {
      setupCalls.push([setupRoot]);
      await fs.writeFile(path.join(setupRoot, ".provision-marker"), "provisioned\n");
      return {};
    });
    const record = await bindProvisionedWorkspaceCandidate({
      root,
      operationId,
      priorCandidate: prior,
      workspaceId: "wks_fixture",
      executionRoot,
      kind: "change",
      config,
      trace: async (event, detail) => { traces.push({ event, detail }); },
      setup: setup as never,
    });
    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledWith(executionRoot, config, { skipProjectDependencies: true });
    expect(traces.some((trace) => trace.event === "operation.toolchain.prepared")).toBe(true);
    // The marker written by provisioning must be covered by the bound digest:
    // setup ran BEFORE the digest, not after.
    expect(record.candidateRevision!.revision).toBe(prior.revision + 1);
    expect(record.candidateRevision!.sourceDigest).not.toBe(preDigest);
    expect(record.candidateRevision!.sourceDigest).toBe(await computeWorktreeDigest(executionRoot));
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(executionRoot, { recursive: true, force: true });
  });

  it("discards a snapshot-propagated machine-local lock before provisioning", async () => {
    const { root, operationId } = await controlWithCandidate();
    const executionRoot = await tempRoot("aeh-provision-exec-");
    await fs.writeFile(path.join(executionRoot, "source.txt"), "original\n");
    // Simulate snapshot materialization copying the control root's
    // machine-local lock (stale resolutions for another checkout state).
    await fs.mkdir(path.join(executionRoot, ".harness"), { recursive: true });
    await fs.writeFile(
      path.join(executionRoot, ".harness", "toolchain.lock.json"),
      JSON.stringify({ version: 1, tools: { node: { requestedVersion: "0.0.0-stale" } } })
    );
    await fs.writeFile(
      path.join(executionRoot, ".harness", "toolchain.yaml"),
      "version: 1\nmanager:\n  provider: mise\ntools: {}\n"
    );
    const config = await loadProjectConfig(process.cwd()).catch(() => ({ version: 1, project: { name: "fixture-project" } }) as never);
    const prior = (await loadOperation(root, operationId)).candidateRevision!;
    let lockPresentAtSetup = true;
    const setup = vi.fn(async (setupRoot: string) => {
      try {
        await fs.access(path.join(setupRoot, ".harness", "toolchain.lock.json"));
        lockPresentAtSetup = true;
      } catch {
        lockPresentAtSetup = false;
      }
      return {};
    });
    await bindProvisionedWorkspaceCandidate({
      root,
      operationId,
      priorCandidate: prior,
      workspaceId: "wks_fixture",
      executionRoot,
      kind: "change",
      config,
      trace: async () => undefined,
      setup: setup as never,
    });
    expect(setup).toHaveBeenCalledTimes(1);
    expect(lockPresentAtSetup).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(executionRoot, { recursive: true, force: true });
  });

  it("discards an absolute-path machine-local lock before provisioning", async () => {
    const { root, operationId } = await controlWithCandidate();
    const executionRoot = await tempRoot("aeh-provision-exec-");
    await fs.writeFile(path.join(executionRoot, "source.txt"), "original\n");
    await fs.mkdir(path.join(executionRoot, ".harness"), { recursive: true });
    await fs.writeFile(
      path.join(executionRoot, ".harness", "toolchain.yaml"),
      "version: 1\nmanager:\n  provider: mise\ntools: {}\n"
    );
    const absoluteLock = path.join(executionRoot, "abs-lock", "toolchain.lock.json");
    await fs.mkdir(path.dirname(absoluteLock), { recursive: true });
    await fs.writeFile(absoluteLock, JSON.stringify({ version: 1, tools: {} }));
    const base = await loadProjectConfig(process.cwd()).catch(() => ({ version: 1, project: { name: "fixture-project" } }) as never);
    const config = { ...base, toolchain: { configPath: ".harness/toolchain.yaml", lockPath: absoluteLock } };
    const prior = (await loadOperation(root, operationId)).candidateRevision!;
    let lockPresentAtSetup = true;
    const setup = vi.fn(async (setupRoot: string) => {
      lockPresentAtSetup = await fs.access(absoluteLock).then(() => true).catch(() => false);
      expect(setupRoot).toBe(executionRoot);
      return {};
    });
    await bindProvisionedWorkspaceCandidate({
      root,
      operationId,
      priorCandidate: prior,
      workspaceId: "wks_fixture",
      executionRoot,
      kind: "change",
      config: config as never,
      trace: async () => undefined,
      setup: setup as never,
    });
    expect(setup).toHaveBeenCalledTimes(1);
    expect(lockPresentAtSetup).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(executionRoot, { recursive: true, force: true });
  });

  it("never provisions audits or control-root execution", async () => {    const { root, operationId } = await controlWithCandidate();
    const executionRoot = await tempRoot("aeh-provision-exec-");
    await fs.writeFile(path.join(executionRoot, "source.txt"), "original\n");
    const config = await loadProjectConfig(process.cwd()).catch(() => ({ version: 1, project: { name: "fixture-project" } }) as never);
    const prior = (await loadOperation(root, operationId)).candidateRevision!;
    const setup = vi.fn();
    const auditBound = await bindProvisionedWorkspaceCandidate({
      root, operationId, priorCandidate: prior, executionRoot, kind: "audit", config,
      trace: async () => undefined, setup: setup as never,
    });
    expect(setup).not.toHaveBeenCalled();
    expect(auditBound.candidateRevision!.revision).toBe(prior.revision + 1);
    const localBound = await bindProvisionedWorkspaceCandidate({
      root, operationId,
      priorCandidate: (await loadOperation(root, operationId)).candidateRevision!,
      executionRoot: root, kind: "change", config,
      trace: async () => undefined, setup: setup as never,
    });
    expect(setup).not.toHaveBeenCalled();
    expect(localBound.candidateRevision!.revision).toBe(prior.revision + 2);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(executionRoot, { recursive: true, force: true });
  });
});
