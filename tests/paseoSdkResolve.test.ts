import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolvePaseoSdkFromCli } from "../src/paseo/sdkResolve.js";

function processResult(exitCode: number, stdout = "", stderr = "") {
  return { exitCode, stdout, stderr, durationMs: 1 };
}

describe("Paseo SDK resolution", () => {
  it("resolves the CLI-matched client through mise even when command -v returns a shim", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-sdk-resolve-"));
    const install = path.join(root, "mise", "installs", "npm-getpaseo-cli", "0.2.3");
    const client = path.join(install, "node_modules", "@getpaseo", "client");
    const entry = path.join(client, "dist", "index.js");
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(path.join(client, "package.json"), JSON.stringify({
      name: "@getpaseo/client",
      version: "0.2.3",
      type: "module",
      exports: { ".": "./dist/index.js" }
    }));
    await fs.writeFile(entry, "export const createPaseoClient = () => ({});\n");

    const shim = path.join(root, "mise", "shims", "paseo");
    const binary = path.join(install, "bin", "paseo");
    const runner = vi.fn(async (command: string) => {
      if (command === "command -v paseo") return processResult(0, `${shim}\n`);
      if (command === "mise which paseo") return processResult(0, `${binary}\n`);
      if (command === "mise where 'npm:@getpaseo/cli'") return processResult(0, `${install}\n`);
      throw new Error(`unexpected command: ${command}`);
    });

    const resolution = await resolvePaseoSdkFromCli(root, runner as never);
    expect(path.resolve(resolution.resolved!)).toBe(path.resolve(entry));
    expect(resolution.diagnostics).toContain(`command -v paseo: ${shim}`);
    expect(resolution.diagnostics).toContain(`mise which paseo: ${binary}`);
  });

  it("returns diagnostics instead of throwing when mise is unavailable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-sdk-no-mise-"));
    const runner = vi.fn(async (command: string) => command === "command -v paseo"
      ? processResult(0, "/tmp/mise-shims/paseo\n")
      : processResult(127, "", "mise: command not found"));

    const resolution = await resolvePaseoSdkFromCli(root, runner as never);
    expect(resolution.resolved).toBeUndefined();
    expect(resolution.diagnostics.some((item) => item.startsWith("mise which paseo: unavailable"))).toBe(true);
  });
});
