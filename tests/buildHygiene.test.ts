import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(".");

describe("repository build hygiene", () => {
  it("publishes builds without removing the live dist entrypoint", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { bin: Record<string, string>; files: string[]; scripts: Record<string, string>; workspaces: string[] };
    const build = await fs.readFile(path.join(root, "scripts/build.mjs"), "utf8");
    expect(pkg.scripts.build).toBe("node scripts/build.mjs");
    expect(build).toContain(".aeh-build-");
    expect(build).toContain("atomicallyWrite(path.join(dist, \"current\")");
    expect(build).toContain("coherent module graph");
    expect(build).toContain("acquireBuildLock");
    expect(build).toContain("pruneReleases");
    expect(build).toContain("runControlCenterBuild");
    expect(build).toContain("--workspace=@aeh/control-center");
    expect(build).toContain('source: "scripts/headroom-bridge.py", destination: "scripts/headroom-bridge.py", kind: "file"');
    expect(build).not.toContain("rmSync(path.join(dist");
    expect(pkg.scripts.prepare).toBe("npm run build && node scripts/link-self-bin.mjs");
    expect(pkg.scripts.aeh).toBe("node ./dist/main.js");
    expect(pkg.files).toContain("scripts/link-self-bin.mjs");
    expect(pkg.files).toContain("scripts/headroom-bridge.py");
    expect(pkg.bin.aeh).toBe("./dist/main.js");
    expect(pkg.workspaces).toContain("ui/control-center");
    expect(pkg.files).not.toContain("ui/control-center/dist");
  });

  it("keeps dist/main.js available while a real build is running", async () => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build", "--silent"], { cwd: root, stdio: "ignore" });
    const completion = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    const missing: string[] = [];
    const invocations: Promise<number | null>[] = [];
    const deadline = Date.now() + 30_000;
    while (child.exitCode === null && Date.now() < deadline) {
      try { await fs.access(path.join(root, "dist", "main.js")); }
      catch { missing.push(new Date().toISOString()); }
      if (invocations.length < 12 && await fs.access(path.join(root, "dist", "main.js")).then(() => true, () => false)) {
        invocations.push(new Promise<number | null>((resolve) => {
          const probe = spawn(process.execPath, [path.join(root, "dist", "main.js"), "--version"], {
            cwd: root,
            stdio: "ignore",
          });
          probe.once("close", (code) => resolve(code));
          probe.once("error", () => resolve(null));
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (child.exitCode === null) child.kill("SIGKILL");
    const exitCode = await completion;
    expect(missing).toEqual([]);
    expect(exitCode).toBe(0);
    expect(invocations.length).toBeGreaterThan(0);
    expect(await Promise.all(invocations)).not.toContain(null);
    expect(await Promise.all(invocations)).not.toContain(1);
    const releases = (await fs.readdir(path.join(root, "dist", "releases"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("release-"));
    expect(releases.length).toBeLessThanOrEqual(3);
  }, 45_000);

  it("publishes the React frontend inside the current immutable backend release", async () => {
    const releaseId = (await fs.readFile(path.join(root, "dist", "current"), "utf8")).trim();
    expect(releaseId).toMatch(/^release-[A-Za-z0-9._-]+$/);
    const identity = JSON.parse(await fs.readFile(path.join(root, "dist", "releases", releaseId, "build-identity.json"), "utf8")) as { version: number; packageVersion: string; gitSha: string; releaseId: string; buildDigest: string; dirty: boolean };
    const packageInfo = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { version: string };
    expect(identity).toMatchObject({ version: 1, packageVersion: packageInfo.version, releaseId });
    expect(identity.gitSha).toMatch(/^(unknown|[a-f0-9]{40,64})$/);
    expect(identity.buildDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof identity.dirty).toBe("boolean");
    const uiRoot = path.join(root, "dist", "releases", releaseId, "ui", "control-center", "dist");
    const index = await fs.readFile(path.join(uiRoot, "index.html"), "utf8");
    const assetPaths = [...index.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]);
    expect(assetPaths.length).toBeGreaterThan(0);
    for (const assetPath of assetPaths) {
      const relative = assetPath.replace(/^\//, "");
      await expect(fs.access(path.join(uiRoot, relative))).resolves.toBeUndefined();
    }
    await expect(fs.access(path.join(root, "ui", "control-center", "dist", "index.html"))).rejects.toThrow();
  });

  it("includes the Headroom bridge in built and packed releases and lets the packaged provider doctor resolve it", async () => {
    const packageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-headroom-pack-"));
    const extractDirectory = path.join(packageDirectory, "extract");
    const packDirectory = path.join(packageDirectory, "pack");
    const packSourceDirectory = path.join(packageDirectory, "pack-source");
    await fs.mkdir(extractDirectory, { recursive: true });
    await fs.mkdir(packDirectory, { recursive: true });
    await fs.mkdir(packSourceDirectory, { recursive: true });
    try {
      const releaseId = (await fs.readFile(path.join(root, "dist", "current"), "utf8")).trim();
      const builtPackageRoot = path.join(root, "dist", "releases", releaseId);
      const builtBridge = path.join(builtPackageRoot, "scripts", "headroom-bridge.py");
      expect(await fs.readFile(builtBridge, "utf8")).toBe(await fs.readFile(path.join(root, "scripts", "headroom-bridge.py"), "utf8"));
      const identity = JSON.parse(await fs.readFile(path.join(builtPackageRoot, "build-identity.json"), "utf8")) as { buildDigest: string };
      expect(await digestReleaseForTest(builtPackageRoot)).toBe(identity.buildDigest);
      await assertHeadroomDoctor(builtPackageRoot, path.join(packageDirectory, "built-consumer"));

      const packageInfo = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { files: string[]; scripts: Record<string, string> };
      const packManifest = { ...JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")), scripts: { ...packageInfo.scripts } } as { scripts: Record<string, string> };
      delete packManifest.scripts.prepare;
      await fs.writeFile(path.join(packSourceDirectory, "package.json"), `${JSON.stringify(packManifest, null, 2)}\n`);
      for (const item of packageInfo.files) {
        const source = path.join(root, item);
        const destination = path.join(packSourceDirectory, item);
        const stat = await fs.stat(source);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        if (stat.isDirectory()) await fs.cp(source, destination, { recursive: true });
        else await fs.copyFile(source, destination);
      }
      await runProcess(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--ignore-scripts", "--pack-destination", packDirectory, "--cache", path.join(packageDirectory, "npm-cache")], packSourceDirectory);
      const tarballName = (await fs.readdir(packDirectory)).find((name) => name.endsWith(".tgz"));
      expect(tarballName).toBeTruthy();
      const tarball = path.join(packDirectory, tarballName!);
      await runProcess("tar", ["-xzf", tarball, "-C", extractDirectory], packageDirectory);
      const consumerPackageRoot = path.join(extractDirectory, "package");
      const packedReleaseId = (await fs.readFile(path.join(consumerPackageRoot, "dist", "current"), "utf8")).trim();
      const packedReleaseRoot = path.join(consumerPackageRoot, "dist", "releases", packedReleaseId);
      expect(await fs.readFile(path.join(packedReleaseRoot, "scripts", "headroom-bridge.py"), "utf8")).toBe(await fs.readFile(path.join(root, "scripts", "headroom-bridge.py"), "utf8"));
      const packedIdentity = JSON.parse(await fs.readFile(path.join(packedReleaseRoot, "build-identity.json"), "utf8")) as { buildDigest: string };
      expect(await digestReleaseForTest(packedReleaseRoot)).toBe(packedIdentity.buildDigest);
      await assertHeadroomDoctor(packedReleaseRoot, path.join(packageDirectory, "packed-consumer"));
    } finally {
      await fs.rm(packageDirectory, { recursive: true, force: true });
    }
  }, 45_000);

  it("ignores Harness runtime state by default and allowlists repository-owned configuration", async () => {
    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".harness/*");
    expect(gitignore).toContain("!.harness/project.yaml");
    expect(gitignore).toContain("!.harness/toolchain.yaml");
    expect(gitignore).toContain("!.harness/agents.source.jsonc");
    expect(gitignore).toContain("!.harness/otel-collector.yaml");
    expect(gitignore).not.toContain(".harness/runs/");
  });
});

async function assertHeadroomDoctor(packageRoot: string, consumerRoot: string): Promise<void> {
  const modulePath = path.join(packageRoot, "context", "compression", "headroom.js");
  const { HeadroomCompressionProvider, HEADROOM_VERSION } = await import(pathToFileURL(modulePath).href) as typeof import("../src/context/compression/headroom.js");
  const fakeBin = path.join(consumerRoot, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakePython = path.join(fakeBin, "python-shim");
  const headroom = path.join(fakeBin, "headroom");
  const response = JSON.stringify({ version: 1, providerVersion: HEADROOM_VERSION });
  await fs.writeFile(fakePython, `#!/bin/sh
set -eu
case "${"$"}{2:-}" in
  --version) echo "Headroom ${HEADROOM_VERSION}" ;;
  --doctor) printf '%s\\n' '${response}' ;;
  *) exit 21 ;;
esac
`, { mode: 0o755 });
  await fs.chmod(fakePython, 0o755);
  await fs.writeFile(headroom, `#!${fakePython}\nexit 22\n`, { mode: 0o755 });
  await fs.chmod(headroom, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
  try {
    const doctor = await new HeadroomCompressionProvider().doctor(consumerRoot);
    expect(doctor.ok).toBe(true);
    expect(doctor.version).toContain(HEADROOM_VERSION);
    expect(doctor.message).toContain("Headroom local compressor ready");
  } finally {
    process.env.PATH = previousPath;
  }
}

async function digestReleaseForTest(directory: string): Promise<string> {
  const files: string[] = [];
  async function collect(current: string): Promise<void> {
    const entries = (await fs.readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await collect(absolute);
      else if (entry.isFile() && path.relative(directory, absolute).replaceAll(path.sep, "/") !== "build-identity.json") files.push(path.relative(directory, absolute).replaceAll(path.sep, "/"));
      else if (entry.isSymbolicLink()) files.push(path.relative(directory, absolute).replaceAll(path.sep, "/"));
    }
  }
  await collect(directory);
  const digest = crypto.createHash("sha256");
  for (const relative of files.sort()) {
    const absolute = path.join(directory, relative);
    const stat = await fs.lstat(absolute);
    const contents = stat.isSymbolicLink() ? await fs.readlink(absolute) : await fs.readFile(absolute);
    digest.update(relative).update("\0").update(contents).update("\0");
  }
  return digest.digest("hex");
}

function runProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} failed${signal ? ` (${signal})` : ` with exit code ${code}`}: ${stderr || stdout}`));
    });
  });
}
