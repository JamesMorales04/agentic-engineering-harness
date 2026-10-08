#!/usr/bin/env node
// Canonical artifact-provenance gate (DETERMINISTIC mechanism).
// Binds a retained npm tarball to the release SHA that produced it, so a
// stale/replaced same-version artifact can never reach `npm publish` or a
// GitHub Release. No model reasoning: exact string equality on release_sha,
// recomputed sha512 digest equality, and name/version equality.
//
// Sidecar schema (written at pack/upload time, uploaded ALONGSIDE the tarball):
//   { "release_sha": "<40-hex git sha>", "tarball_sha512": "sha512-<base64>",
//     "name": "<package name>", "version": "<version>" }
//
// Verify mode (fail closed, exit 1 on absent/invalid/mismatch with loud error):
//   verify-artifact-provenance.mjs --tarball <tgz> --provenance <json>
//     --release-sha <sha> --name <pkg> --version <ver>
//
// Write mode (used at fresh-pack time):
//   verify-artifact-provenance.mjs --write --tarball <tgz> --provenance <json>
//     --release-sha <sha>
// (name/version are read from ./package.json in write mode.)
//
// Recheck mode (TOCTOU bind: recompute sha512 of the exact bytes about to be
// consumed and compare to the sidecar digest, fail closed on mismatch):
//   verify-artifact-provenance.mjs --recheck <tarball> <sidecar>
//   verify-artifact-provenance.mjs --recheck --tarball <tgz> --provenance <json>
// Call this IN THE SAME shell step, immediately before EACH upload of the
// tarball and EACH `npm publish` invocation (and before each identity-gate
// consumption in confirm/repair steps). It reuses the comparison logic below
// (single implementation: same hash, same digest regex, same fail-closed
// semantics as verify mode, digest-only since release_sha/name/version were
// already bound by the earlier full verify).
//
// Honest residual model: the recheck NARROWS but cannot CLOSE a file-based
// handoff to a separate process (`npm publish`, the upload-artifact action,
// or the identity-gate consumer re-reading the file). A swap after the
// recheck needs NO preimage — any bytes cross. Threat model: runner-local
// swap only (requires workspace-write on this runner mid-step; NOT remotely
// exploitable). Defense in depth: (1) pre-consume recheck before every
// publish/Release consumption fails closed on swapped bytes; (2) the
// single-tgz upload guard ensures only the verified file crosses the artifact
// boundary; (3) POST-PUBLISH ATTESTATION queries the registry ground truth
// (`npm view <name>@<version> dist.integrity` vs the sidecar digest) after
// `npm publish` and, on mismatch, fails LOUDLY + runs `npm deprecate` to
// block installs — converting a runner-local swap from silent compromise to
// detected-and-deprecated with bounded blast radius.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
let tarballPath;
let provenancePath;
let releaseSha;
let expectedName;
let expectedVersion;
let writeMode = false;
let recheckMode = false;
const positionals = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--tarball") {
    tarballPath = argv[(i += 1)];
  } else if (a === "--provenance") {
    provenancePath = argv[(i += 1)];
  } else if (a === "--release-sha") {
    releaseSha = argv[(i += 1)];
  } else if (a === "--name") {
    expectedName = argv[(i += 1)];
  } else if (a === "--version") {
    expectedVersion = argv[(i += 1)];
  } else if (a === "--write") {
    writeMode = true;
  } else if (a === "--recheck") {
    recheckMode = true;
  } else if (a.startsWith("--")) {
    console.error(
      `usage: verify-artifact-provenance.mjs --tarball <tgz> --provenance <json> --release-sha <sha> [--name <pkg> --version <ver>] [--write]`,
    );
    console.error(`   or: verify-artifact-provenance.mjs --recheck <tarball> <sidecar>`);
    console.error(`   or: verify-artifact-provenance.mjs --recheck --tarball <tgz> --provenance <json>`);
    process.exit(1);
  } else {
    positionals.push(a);
  }
}

const fail = (msg) => {
  console.error(`artifact provenance REFUSED (fail closed, refusing publish and Release): ${msg}`);
  process.exit(1);
};

// Single implementation of the digest comparison (shared by verify + recheck).
const DIGEST_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const computeTarballDigest = (tgzPath) =>
  `sha512-${createHash("sha512").update(readFileSync(tgzPath)).digest("base64")}`;
const readSidecarDigest = (sidecarPath) => {
  if (!existsSync(sidecarPath)) {
    fail(`provenance sidecar ${sidecarPath} is ABSENT; the tarball is UNVERIFIED. Refusing publish and Release.`);
  }
  let parsed;
  try {
    const raw = readFileSync(sidecarPath, "utf8");
    if (!raw.trim()) fail(`provenance sidecar ${sidecarPath} is empty; refusing publish and Release.`);
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`provenance sidecar ${sidecarPath} is INVALID (${err?.message ?? err}); refusing publish and Release.`);
  }
  if (typeof parsed?.tarball_sha512 !== "string" || !parsed.tarball_sha512) {
    fail(`provenance sidecar ${sidecarPath} is missing required field "tarball_sha512"; refusing publish and Release.`);
  }
  if (!DIGEST_RE.test(parsed.tarball_sha512)) {
    fail(`provenance sidecar ${sidecarPath} has a malformed tarball_sha512 digest; refusing publish and Release.`);
  }
  return parsed.tarball_sha512;
};
const assertDigestMatch = (tgzPath, sidecarPath) => {
  if (!existsSync(tgzPath) || statSync(tgzPath).size === 0) {
    fail(`retained tarball ${tgzPath} is missing or empty; refusing to publish it.`);
  }
  const expected = readSidecarDigest(sidecarPath);
  const actual = computeTarballDigest(tgzPath);
  if (actual !== expected) {
    fail(
      `TOCTOU recheck MISMATCH: tarball ${tgzPath} content differs from the sidecar digest ` +
        `(swapped between verify and consume? expected ${expected} got ${actual}). Refusing publish and Release.`,
    );
  }
  return actual;
};

if (recheckMode) {
  if (writeMode) {
    console.error(`usage: --recheck is mutually exclusive with --write.`);
    process.exit(1);
  }
  // Positional form: --recheck <tarball> <sidecar> (preferred in workflow steps).
  if (!tarballPath && !provenancePath && positionals.length === 2) {
    [tarballPath, provenancePath] = positionals;
  } else if (positionals.length !== 0) {
    console.error(`usage: verify-artifact-provenance.mjs --recheck <tarball> <sidecar>`);
    console.error(`   or: verify-artifact-provenance.mjs --recheck --tarball <tgz> --provenance <json>`);
    process.exit(1);
  }
  if (!tarballPath || !provenancePath) {
    console.error(`usage: verify-artifact-provenance.mjs --recheck <tarball> <sidecar>`);
    console.error(`   or: verify-artifact-provenance.mjs --recheck --tarball <tgz> --provenance <json>`);
    process.exit(1);
  }
  const actual = assertDigestMatch(tarballPath, provenancePath);
  console.log(`artifact provenance rechecked (TOCTOU bind): ${tarballPath} tarball_sha512=${actual}`);
  process.exit(0);
}
if (positionals.length !== 0) {
  console.error(
    `usage: verify-artifact-provenance.mjs --tarball <tgz> --provenance <json> --release-sha <sha> [--name <pkg> --version <ver>] [--write]`,
  );
  process.exit(1);
}

if (!tarballPath || !provenancePath || !releaseSha) {
  console.error(
    `usage: verify-artifact-provenance.mjs --tarball <tgz> --provenance <json> --release-sha <sha> [--name <pkg> --version <ver>] [--write]`,
  );
  process.exit(1);
}
if (!/^[0-9a-fA-F]{40}$/.test(releaseSha)) {
  fail(`expected release_sha is not a 40-hex git SHA: ${JSON.stringify(releaseSha)}`);
}

if (writeMode) {
  if (!existsSync(tarballPath) || statSync(tarballPath).size === 0) {
    fail(`cannot write provenance: tarball ${tarballPath} is missing or empty.`);
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync("./package.json", "utf8"));
  } catch (err) {
    fail(`cannot write provenance: failed to read ./package.json: ${err?.message ?? err}`);
  }
  if (!pkg?.name || !pkg?.version) {
    fail(`cannot write provenance: ./package.json is missing name/version.`);
  }
  const digest = computeTarballDigest(tarballPath);
  const sidecar = { release_sha: releaseSha, tarball_sha512: digest, name: pkg.name, version: pkg.version };
  try {
    writeFileSync(provenancePath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
  } catch (err) {
    fail(`cannot write provenance sidecar ${provenancePath}: ${err?.message ?? err}`);
  }
  console.log(`artifact provenance recorded: ${pkg.name}@${pkg.version} release_sha=${releaseSha} tarball_sha512=${digest}`);
  process.exit(0);
}

if (!expectedName || !expectedVersion) {
  console.error(
    `usage: verify-artifact-provenance.mjs --tarball <tgz> --provenance <json> --release-sha <sha> --name <pkg> --version <ver>`,
  );
  process.exit(1);
}

// --- Verify mode: every check fails closed (exit 1), loud on stderr. ---
if (!existsSync(tarballPath) || statSync(tarballPath).size === 0) {
  fail(`retained tarball ${tarballPath} is missing or empty; refusing to pack over it silently.`);
}
if (!existsSync(provenancePath)) {
  fail(
    `provenance sidecar ${provenancePath} is ABSENT for release_sha=${releaseSha} ${expectedName}@${expectedVersion}; ` +
      `the retained tarball is UNVERIFIED (stale/replaced same-version artifact?). Refusing publish and Release.`,
  );
}
let sidecar;
try {
  const raw = readFileSync(provenancePath, "utf8");
  if (!raw.trim()) fail(`provenance sidecar ${provenancePath} is empty; refusing publish and Release.`);
  sidecar = JSON.parse(raw);
} catch (err) {
  fail(`provenance sidecar ${provenancePath} is INVALID (${err?.message ?? err}); refusing publish and Release.`);
}
for (const field of ["release_sha", "tarball_sha512", "name", "version"]) {
  if (typeof sidecar?.[field] !== "string" || !sidecar[field]) {
    fail(`provenance sidecar ${provenancePath} is missing required field ${JSON.stringify(field)}; refusing publish and Release.`);
  }
}
if (sidecar.release_sha !== releaseSha) {
  fail(
    `provenance release_sha MISMATCH: sidecar binds ${JSON.stringify(sidecar.release_sha)} but current release_sha is ` +
      `${JSON.stringify(releaseSha)} (stale/replaced artifact for ${expectedName}@${expectedVersion}?). Refusing publish and Release.`,
  );
}
if (sidecar.name !== expectedName || sidecar.version !== expectedVersion) {
  fail(
    `provenance name/version MISMATCH: sidecar binds ${JSON.stringify(`${sidecar.name}@${sidecar.version}`)} but ` +
      `expected ${JSON.stringify(`${expectedName}@${expectedVersion}`)}. Refusing publish and Release.`,
  );
}
if (!DIGEST_RE.test(sidecar.tarball_sha512)) {
  fail(`provenance sidecar ${provenancePath} has a malformed tarball_sha512 digest; refusing publish and Release.`);
}
const actual = computeTarballDigest(tarballPath);
if (actual !== sidecar.tarball_sha512) {
  fail(
    `provenance digest MISMATCH for ${expectedName}@${expectedVersion} at release_sha=${releaseSha}: retained tarball ` +
      `content differs from the sidecar digest (replaced/tampered artifact?). Refusing publish and Release.`,
  );
}
console.log(`artifact provenance verified: ${expectedName}@${expectedVersion} release_sha=${releaseSha} tarball_sha512=${actual}`);
