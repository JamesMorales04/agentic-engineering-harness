import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDir = path.join(root, "node_modules", ".bin");
const entry = path.join(root, "dist", "main.js");

try {
  await fs.access(entry);
} catch {
  throw new Error(`Cannot link AEH self-development bin because ${entry} does not exist. Run npm run build first.`);
}

await fs.mkdir(binDir, { recursive: true });
for (const name of ["aeh", "engineering-harness"]) await writeBin(name);

async function writeBin(name) {
  const sh = path.join(binDir, name);
  const cmd = `${sh}.cmd`;
  const ps1 = `${sh}.ps1`;
  const relative = "../../dist/main.js";

  await fs.rm(sh, { force: true });
  await fs.writeFile(sh, `#!/bin/sh\nexec node \"$(dirname \"$0\")/${relative}\" \"$@\"\n`);
  await fs.chmod(sh, 0o755);

  await fs.rm(cmd, { force: true });
  await fs.writeFile(cmd, `@ECHO OFF\r\nnode \"%~dp0\\..\\..\\dist\\main.js\" %*\r\n`);

  await fs.rm(ps1, { force: true });
  await fs.writeFile(ps1, `#!/usr/bin/env pwsh\n& node \"$PSScriptRoot/../../dist/main.js\" $args\nexit $LASTEXITCODE\n`);
}

if (process.env.AEH_SELF_BIN_VERBOSE === "1") console.log(`Linked repo-local AEH bins in ${binDir}`);
