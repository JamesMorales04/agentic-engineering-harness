import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DuplicateProjectError, ProjectPathUnavailableError, ProjectRegistryV1 } from "../src/projects/index.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "project-registry-"));
  const first = await fs.mkdir(path.join(root, "first"));
  void first;
  await fs.mkdir(path.join(root, "second"));
  return { root, registry: new ProjectRegistryV1(path.join(root, "registry.json")) };
}

describe("ProjectRegistryV1", () => {
  it("keeps same-name projects distinct by repository identity and derives a stable id", async () => {
    const { root, registry } = await fixture();
    const first = await registry.register({ rootPath: path.join(root, "first"), repositoryIdentity: "https://github.com/acme/one.git", displayName: "service", config: { port: 1 } });
    const second = await registry.register({ rootPath: path.join(root, "second"), repositoryIdentity: "https://github.com/acme/two.git", displayName: "service", config: { port: 2 } });

    expect(first.projectId).not.toBe(second.projectId);
    expect((await registry.find({ displayName: "service", repositoryIdentity: "github.com/acme/one" }))?.projectId).toBe(first.projectId);
    await expect(registry.find({ displayName: "service" })).rejects.toThrow("more than one");
    expect((await new ProjectRegistryV1(path.join(root, "registry.json")).register({ rootPath: path.join(root, "first"), repositoryIdentity: "https://github.com/acme/one", displayName: "service", config: { port: 1 } })).projectId).toBe(first.projectId);
  });

  it("persists only allowlisted identity and safe health metadata, and verifies runtime without trusting pid", async () => {
    const { root, registry } = await fixture();
    const project = await registry.register({
      rootPath: path.join(root, "first"),
      repositoryIdentity: "acme/one",
      displayName: "service",
      config: { secret: "do-not-store", nested: { value: true } },
      health: { healthUrl: "http://127.0.0.1:4317/health", nonce: "runtime-secret", pid: 42 }
    });

    expect(await registry.verifyRuntime({ projectId: project.projectId, nonce: "runtime-secret", healthUrl: "http://127.0.0.1:4317/health" })).toBe(true);
    expect(await registry.verifyRuntime({ projectId: project.projectId, nonce: "runtime-secret", healthUrl: "http://127.0.0.1:4317/health", })).toBe(true);
    expect(await registry.verifyRuntime({ projectId: project.projectId, nonce: "runtime-secret", healthUrl: "http://127.0.0.1:4317/other" })).toBe(false);

    const raw = await fs.readFile(path.join(root, "registry.json"), "utf8");
    expect(raw).not.toContain("runtime-secret");
    expect(raw).not.toContain("do-not-store");
    expect(raw).not.toContain("pairingData");
    expect(raw).not.toContain("operations");
    expect(await registry.getHealth(project.projectId)).toMatchObject({ healthUrl: "http://127.0.0.1:4317/health", pid: 42, nonceRegistered: true });
  });

  it("keeps separate worktrees of one repository isolated", async () => {
    const { root, registry } = await fixture();
    const first = await registry.register({ rootPath: path.join(root, "first"), repositoryIdentity: "acme/one", displayName: "service", configDigest: "one" });
    const second = await registry.register({ rootPath: path.join(root, "second"), repositoryIdentity: "acme/one", displayName: "service", configDigest: "two" });
    expect(second.projectId).not.toBe(first.projectId);
    expect((await registry.list()).map((item) => item.projectId)).toEqual(expect.arrayContaining([first.projectId, second.projectId]));
  });

  it("is idempotent for the same runtime and rejects conflicting duplicate starts", async () => {
    const { root, registry } = await fixture();
    const input = { rootPath: path.join(root, "first"), repositoryIdentity: "acme/one", displayName: "service", configDigest: "digest", health: { healthUrl: "http://localhost:1234/health", nonce: "one", pid: 10 } } as const;
    const registered = await registry.register(input);
    expect((await registry.register(input)).projectId).toBe(registered.projectId);
    await expect(registry.register({ ...input, health: { ...input.health, nonce: "two", pid: 11 } })).rejects.toBeInstanceOf(DuplicateProjectError);
    expect((await registry.list())).toHaveLength(1);
  });

  it("marks deleted projects unavailable, allows explicit removal, and rejects registration of missing paths", async () => {
    const { root, registry } = await fixture();
    const project = await registry.register({ rootPath: path.join(root, "first"), repositoryIdentity: "acme/one", configDigest: "digest" });
    await fs.rm(path.join(root, "first"), { recursive: true });

    expect((await registry.list())[0]).toMatchObject({ projectId: project.projectId, availability: "moved-or-missing" });
    expect(await registry.remove(project.projectId)).toBe(true);
    await expect(registry.register({ rootPath: path.join(root, "first"), repositoryIdentity: "acme/one", configDigest: "digest" })).rejects.toBeInstanceOf(ProjectPathUnavailableError);
  });

  it("does not treat a project path redirected to another directory as available", async () => {
    const { root, registry } = await fixture();
    const project = await registry.register({ rootPath: path.join(root, "first"), repositoryIdentity: "acme/one", configDigest: "digest" });
    await fs.rm(path.join(root, "first"), { recursive: true });
    await fs.symlink(path.join(root, "second"), path.join(root, "first"), "dir");
    expect((await registry.list()).find((item) => item.projectId === project.projectId)).toMatchObject({ availability: "moved-or-missing" });
  });

  it("refuses health URLs that could persist credentials or query secrets", async () => {
    const { root, registry } = await fixture();
    await expect(registry.register({ rootPath: path.join(root, "first"), repositoryIdentity: "acme/one", configDigest: "digest", health: { healthUrl: "http://user:password@localhost/health", nonce: "one" } })).rejects.toThrow("without credentials");
    await expect(registry.register({ rootPath: path.join(root, "first"), repositoryIdentity: "acme/one", configDigest: "digest", health: { healthUrl: "http://localhost/health?token=secret", nonce: "one" } })).rejects.toThrow("without credentials");
    await expect(registry.register({ rootPath: path.join(root, "first"), repositoryIdentity: "acme/one", configDigest: "digest", health: { healthUrl: "http://169.254.169.254/latest/meta-data", nonce: "one" } })).rejects.toThrow("loopback");
  });
});
