import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../../src/core/types.js";

const state = vi.hoisted(() => ({ runIsolatedCommand: vi.fn() }));

vi.mock("../../src/security/isolation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/security/isolation.js")>();
  return { ...actual, runIsolatedCommand: state.runIsolatedCommand };
});

import { ISOLATION_PROVIDER_UNAVAILABLE, ISOLATION_PROVIDER_UNSUPPORTED, IsolationProviderUnavailableError } from "../../src/security/isolation.js";
import { runExternalToolValidator } from "../../src/validators/external.js";
import { runSpecCommand } from "../../src/validators/toolCommand.js";
import { runValidationCommand } from "../../src/validators/commands.js";

const contract: TaskContract = { version: 1, task: { id: "ISO-FAIL-1", title: "isolation fail closed" } };
const roots: string[] = [];

function isolatedConfig(): HarnessProjectConfig {
  return { version: 1, project: { name: "isolation-fail-closed" }, evidence: { outputDir: ".harness/evidence" }, security: { isolation: { required: true } } };
}

beforeEach(() => {
  state.runIsolatedCommand.mockReset();
  state.runIsolatedCommand.mockRejectedValue(new IsolationProviderUnavailableError("no rootless isolation provider is executable in this test"));
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("validator isolation fails closed", () => {
  it("never runs a required external validator when the isolation provider is unavailable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-iso-fail-"));
    roots.push(root);
    const check = await runExternalToolValidator({ root, config: isolatedConfig(), contract, spec: { id: "iso-external", adapter: "opengrep", command: "node -e 0", required: true }, baseRef: "HEAD", changedFiles: [] });
    expect(check.status).toBe("FAIL");
    expect(check.message).toContain(ISOLATION_PROVIDER_UNAVAILABLE);
    expect(check.details?.blocker).toBe(ISOLATION_PROVIDER_UNAVAILABLE);
    expect(state.runIsolatedCommand).toHaveBeenCalledTimes(1);
  });

  it("keeps an optional validator as explicit degradation rather than a silent pass", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-iso-fail-"));
    roots.push(root);
    const check = await runExternalToolValidator({ root, config: isolatedConfig(), contract, spec: { id: "iso-optional", adapter: "trivy", command: "node -e 0", required: false }, baseRef: "HEAD", changedFiles: [] });
    expect(check.status).toBe("WARN");
    expect(check.details?.blocker).toBe(ISOLATION_PROVIDER_UNAVAILABLE);
  });

  it("never runs a required custom validator command when isolation cannot be established", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-iso-fail-"));
    roots.push(root);
    const check = await runSpecCommand({ root, config: isolatedConfig(), contract, spec: { id: "iso-command", adapter: "command", command: "echo hi", required: true }, baseRef: "HEAD", changedFiles: [] }, "echo hi", "custom");
    expect(check.status).toBe("FAIL");
    expect(check.message).toContain(ISOLATION_PROVIDER_UNAVAILABLE);
    expect(check.details?.blocker).toBe(ISOLATION_PROVIDER_UNAVAILABLE);
  });

  it("never runs a required configured validation command when isolation cannot be established", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-iso-fail-"));
    roots.push(root);
    const check = await runValidationCommand(root, { id: "iso-config-command", command: "echo hi", required: true }, { config: isolatedConfig() });
    expect(check.status).toBe("FAIL");
    expect(check.message).toContain(ISOLATION_PROVIDER_UNAVAILABLE);
    expect(check.details?.blocker).toBe(ISOLATION_PROVIDER_UNAVAILABLE);
  });

  it("rejects an unsupported configured isolation provider explicitly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-iso-fail-"));
    roots.push(root);
    const config = { ...isolatedConfig(), security: { isolation: { required: true, provider: "docker" } } };
    const check = await runExternalToolValidator({ root, config, contract, spec: { id: "iso-unsupported", adapter: "opengrep", command: "node -e 0", required: true }, baseRef: "HEAD", changedFiles: [] });
    expect(check.status).toBe("FAIL");
    expect(check.message).toContain(ISOLATION_PROVIDER_UNSUPPORTED);
    expect(state.runIsolatedCommand).not.toHaveBeenCalled();
  });
});
