import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolvePaseoSdkFromCli } from "../src/paseo/sdkResolve.js";

function processResult(exitCode: number, stdout = "", stderr = "") {
  return { exitCode, stdout, stderr, durationMs: 1 };
}

async function writeClient(client: string, version: string): Promise<string> {
  const entry = path.join(client, "dist", "index.js");
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(path.join(client, "package.json"), JSON.stringify({
    name: "@getpaseo/client",
    version,
    type: "module",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } }
  }));
  await fs.writeFile(entry, "export const createPaseoClient = () => ({});\n");
  return entry;
}

describe("Paseo SDK resolution", () => {
  it("resolves the CLI-matched client through mise even when command -v returns a shim", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-sdk-resolve-"));
    const install = path.join(root, "mise", "installs", "npm-getpaseo-cli", "0.2.3");
    const client = path.join(install, "node_modules", "@getpaseo", "client");
    const entry = await writeClient(client, "0.2.3");

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
    expect(resolution.diagnostics.some((item) => item.startsWith("node resolution:"))).toBe(true);
  });

  it("physically locates a CLI-matched client in a non-hoisted mise store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-sdk-store-"));
    const installs = path.join(root, "mise", "installs", "npm-getpaseo-cli");
    const exactInstall = path.join(installs, "0.3.1");
    const latestInstall = path.join(installs, "latest");
    const binary = path.join(latestInstall, "node_modules", ".bin", "paseo");
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, "#!/usr/bin/env node\n");

    // Deliberately keep the client out of every Node resolution ancestor. This
    // models package-manager store layouts where the dependency exists inside
    // the mise prefix but is not hoisted to <install>/node_modules.
    const client = path.join(exactInstall, ".aube-store", "objects", "client-0.3.1", "node_modules", "@getpaseo", "client");
    const entry = await writeClient(client, "0.3.1");

    const runner = vi.fn(async (command: string) => {
      if (command === "command -v paseo") return processResult(0, `${binary}\n`);
      if (command === "mise which paseo") return processResult(0, `${binary}\n`);
      if (command === "mise where 'npm:@getpaseo/cli'") return processResult(0, `${exactInstall}\n`);
      throw new Error(`unexpected command: ${command}`);
    });

    const resolution = await resolvePaseoSdkFromCli(root, runner as never);
    expect(path.resolve(resolution.resolved!)).toBe(path.resolve(entry));
    expect(resolution.diagnostics).toContain(`physical scan root: ${path.resolve(exactInstall)}`);
    expect(resolution.diagnostics).toContain(`physical client: ${path.join(client, "package.json")}`);
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
