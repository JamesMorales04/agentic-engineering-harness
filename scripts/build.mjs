import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const releases = path.join(dist, "releases");
const buildLock = path.join(dist, ".build.lock");
const releaseId = `release-${Date.now()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const staging = path.join(root, `.aeh-build-${process.pid}-${crypto.randomUUID()}`);
const release = path.join(releases, releaseId);
const runtimeAssets = [
  { source: "templates", destination: "templates", kind: "directory" },
  { source: "presets", destination: "presets", kind: "directory" },
  { source: "policies", destination: "policies", kind: "directory" },
  { source: "schemas", destination: "schemas", kind: "directory" },
  { source: "maturity", destination: "maturity", kind: "directory" },
  { source: "skills", destination: "skills", kind: "directory" },
  { source: "scripts/headroom-bridge.py", destination: "scripts/headroom-bridge.py", kind: "file" },
];

const launcher = `#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const distRoot = path.dirname(fileURLToPath(import.meta.url));
const releaseId = (await fs.readFile(path.join(distRoot, "current"), "utf8")).trim();
if (!/^[A-Za-z0-9._-]+$/.test(releaseId)) {
  throw new Error("Invalid AEH build release pointer");
}
await import(pathToFileURL(path.join(distRoot, "releases", releaseId, "main.js")).href);
`;

async function runTsc() {
  const command = process.platform === "win32" ? "tsc.cmd" : "tsc";
  await new Promise((resolve, reject) => {
    const child = spawn(command, ["-p", "tsconfig.json", "--outDir", staging], {
      cwd: root,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`TypeScript build failed${signal ? ` (${signal})` : ` with exit code ${code}`}`));
    });
  });
}

async function runControlCenterBuild(outputDirectory) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  await new Promise((resolve, reject) => {
    const child = spawn(command, ["run", "build", "--workspace=@aeh/control-center", "--", "--outDir", outputDirectory], {
      cwd: root,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`Control Center build failed${signal ? ` (${signal})` : ` with exit code ${code}`}`));
    });
  });
}

async function atomicallyWrite(file, contents, mode) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, contents, { mode });
  await fs.rename(temporary, file);
}

async function acquireBuildLock() {
  await fs.mkdir(dist, { recursive: true });
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const handle = await fs.open(buildLock, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try { owner = Number.parseInt((await fs.readFile(buildLock, "utf8")).trim(), 10); } catch { owner = undefined; }
      let alive = false;
      if (owner && owner !== process.pid) {
        try { process.kill(owner, 0); alive = true; } catch { alive = false; }
      }
      if (!alive || Date.now() >= deadline) {
        await fs.rm(buildLock, { force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function pruneReleases() {
  const pointer = (await fs.readFile(path.join(dist, "current"), "utf8")).trim();
  const entries = (await fs.readdir(releases, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^release-[A-Za-z0-9._-]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const keep = new Set([pointer, ...entries.slice(0, 2)]);
  for (const name of entries) {
    if (keep.has(name)) continue;
    // Only remove exact generated release directories after the new pointer
    // and launcher are live. Never remove dist itself or a non-release path.
    await fs.rm(path.join(releases, name), { recursive: true, force: true });
  }
}

async function digestRelease(directory) {
  const files = [];
  async function collect(current) {
    const entries = (await fs.readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await collect(absolute);
      else if (entry.isFile()) files.push(path.relative(directory, absolute).replaceAll(path.sep, "/"));
      else if (entry.isSymbolicLink()) files.push(path.relative(directory, absolute).replaceAll(path.sep, "/"));
    }
  }
  await collect(directory);
  const digest = crypto.createHash("sha256");
  for (const relative of files.sort()) {
    const absolute = path.join(directory, relative);
    const stat = await fs.lstat(absolute);
    const content = stat.isSymbolicLink() ? await fs.readlink(absolute) : await fs.readFile(absolute);
    digest.update(relative).update("\0").update(content).update("\0");
  }
  return digest.digest("hex");
}

function gitValue(args) {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}

await acquireBuildLock();
let releaseComplete = false;
try {
  await fs.mkdir(releases, { recursive: true });
  await runControlCenterBuild(path.join(staging, "ui", "control-center", "dist"));
  await runTsc();
  await fs.cp(staging, release, { recursive: true, force: true });
  await fs.cp(path.join(root, "package.json"), path.join(release, "package.json"));
  for (const asset of runtimeAssets) {
    const source = path.join(root, asset.source);
    const destination = path.join(release, asset.destination);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (asset.kind === "directory") await fs.cp(source, destination, { recursive: true, force: true });
    else await fs.copyFile(source, destination);
  }
  const packageInfo = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const identity = {
    version: 1,
    packageVersion: packageInfo.version,
    gitSha: gitValue(["rev-parse", "HEAD"]) || "unknown",
    releaseId,
    buildDigest: await digestRelease(release),
    dirty: Boolean(gitValue(["status", "--porcelain", "--untracked-files=normal"]))
  };
  await fs.writeFile(path.join(release, "build-identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
  releaseComplete = true;

  // The pointer is the only live build state that changes. Every release is
  // complete before this rename, so concurrent CLI invocations see one
  // coherent module graph rather than a partially rebuilt dist directory.
  await atomicallyWrite(path.join(dist, "current"), `${releaseId}\n`);
  await atomicallyWrite(path.join(dist, "main.js"), launcher, 0o755);
  await fs.chmod(path.join(dist, "main.js"), 0o755);
  await pruneReleases();
  console.log(`Built ${releaseId}`);
} finally {
  if (!releaseComplete) await fs.rm(release, { recursive: true, force: true });
  await fs.rm(staging, { recursive: true, force: true });
  await fs.rm(buildLock, { force: true });
}
