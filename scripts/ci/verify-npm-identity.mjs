#!/usr/bin/env node
// Canonical npm resume-identity gate: registry EXISTENCE is not identity.
// Compares the registry tarball digest (dist.integrity, fallback dist.shasum)
// against a locally packed tarball of the current checkout. Exit 0 =
// identical (safe to resume), 1 = MISMATCH (fail closed), 2 = absent.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [name, version] = process.argv.slice(2);
if (!name || !version) {
  console.error("usage: verify-npm-identity.mjs <package-name> <version>");
  process.exit(2);
}
const spec = `${name}@${version}`;
const view = (field) => {
  try {
    return execFileSync("npm", ["view", spec, field], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};

let algo = "sha512";
let expected = view("dist.integrity");
if (!expected) {
  const shasum = view("dist.shasum");
  if (!shasum) {
    console.error(`npm identity: ${spec} is NOT on the registry (nothing to resume).`);
    process.exit(2);
  }
  algo = "sha1";
  expected = shasum;
}

const dir = mkdtempSync(join(tmpdir(), "aeh-npm-identity-"));
try {
  execFileSync("npm", ["pack", "--pack-destination", dir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  if (!tgz) {
    console.error("npm identity: local pack produced no tarball (fail closed).");
    process.exit(1);
  }
  const bytes = readFileSync(join(dir, tgz));
  const actual =
    algo === "sha512" ? `sha512-${createHash("sha512").update(bytes).digest("base64")}` : createHash("sha1").update(bytes).digest("hex");
  if (actual !== expected) {
    console.error(
      `npm identity MISMATCH for ${spec}: registry tarball content differs from the local tarball. Refusing to resume, publish over, or release (fail closed).`,
    );
    process.exit(1);
  }
  console.log(`npm identity verified: ${spec} registry content matches the local tarball.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
