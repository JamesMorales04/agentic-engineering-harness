#!/usr/bin/env node
// Canonical npm resume-identity gate: registry EXISTENCE is not identity.
// Compares the registry tarball digest (dist.integrity, fallback dist.shasum)
// against a local tarball. Exit 0 = identical (safe to resume), 1 = MISMATCH
// (fail closed), 2 = proven-absent only (clean empty/E404 on successful query),
// 3 = UNKNOWN (registry lookup failure: network/auth/parse; fail loudly and
// NEVER take the publish path).
//
// Trust boundary (U3): this gate trusts the npm registry TLS channel —
// `npm view <name>@<version> dist.integrity` as served over TLS is the ground
// truth for what installers receive. A registry compromise or a valid-TLS MITM
// serving attacker bytes with matching integrity is explicitly outside threat model
// (no client-side gate can detect a lying registry).
//
// Retain+reuse (N1): pass --tarball <path> to compare THE SAME packed bytes
// retained as a workflow artifact instead of repacking the checkout (repacks
// can differ across retries: publish-then-fail-later + retry-repacks-differently
// would exit 1 forever). Pass --record <file> to persist the local digest for
// the digest-only fallback; pass --local-digest <digest> to compare the
// registry integrity against the RECORDED first-pack digest without repacking.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
let name;
let version;
let tarballPath;
let recordPath;
let localDigest;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--tarball") {
    tarballPath = argv[(i += 1)];
  } else if (a === "--record") {
    recordPath = argv[(i += 1)];
  } else if (a === "--local-digest") {
    localDigest = argv[(i += 1)];
  } else if (!name) {
    name = a;
  } else if (!version) {
    version = a;
  } else {
    console.error(`usage: verify-npm-identity.mjs <package-name> <version> [--tarball <tgz>] [--record <digest-file>] [--local-digest <digest>]`);
    process.exit(3);
  }
}
if (!name || !version) {
  console.error("usage: verify-npm-identity.mjs <package-name> <version> [--tarball <tgz>] [--record <digest-file>] [--local-digest <digest>]");
  process.exit(3);
}
if (tarballPath && localDigest) {
  console.error("npm identity UNKNOWN: --tarball and --local-digest are mutually exclusive (fail closed).");
  process.exit(3);
}
const spec = `${name}@${version}`;
const view = (field) => {
  const r = spawnSync("npm", ["view", spec, field], { encoding: "utf8" });
  return {
    status: r.status ?? 1,
    out: (r.stdout ?? "").trim(),
    err: (r.stderr ?? "").trim(),
  };
};

const is404 = (text) => /E404|\b404\b/i.test(text ?? "");
const isValidSha512 = (s) => /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(s ?? "");
const isValidSha1 = (s) => /^[a-f0-9]{40}$/i.test((s ?? "").trim());
// Transport/auth failure markers force UNKNOWN (exit 3) even when a 404
// string is also present (fail closed, never publish on UNKNOWN).
const isTransportFailure = (t) =>
  /ENET|EAI_AGAIN|ETIMEDOUT|ECONN|ENOTFOUND|EACCES|E401|E403|EAUTH|ENEEDAUTH|EOTP|E500|E502|E503|socket|timeout|\bnetwork\b|\bauth\b|unauthorized|forbidden/i.test(
    t ?? "",
  );

// Registry lookup: distinguish proven-absent (exit 2) from UNKNOWN (exit 3).
// R3: exit 2 requires an AUTHORITATIVE absence result for the VERSION query
// itself. Digest-field lookups (dist.integrity/dist.shasum) MUST NOT contribute
// to the absence decision: an E404 on a digest field combined with a FAILED
// version query (network/auth error, empty output) is UNKNOWN (exit 3), never
// absent. Authoritative absent is EITHER:
//   (a) version query fails (non-zero) with E404/404 ON THE VERSION QUERY with
//       transport success (no transport/auth failure markers), OR
//   (b) version query succeeds (zero) with clean empty output (successful query
//       proving the version is absent).
// ANY version-query transport/auth/parse failure (non-zero without a clean
// version-query E404, empty failure, auth/network markers) is exit 3 UNKNOWN.
let algo = "sha512";
let expected = "";
const rIntegrity = view("dist.integrity");
if (rIntegrity.status === 0 && rIntegrity.out) {
  expected = rIntegrity.out;
  algo = "sha512";
} else {
  const rShasum = view("dist.shasum");
  if (rShasum.status === 0 && rShasum.out) {
    expected = rShasum.out;
    algo = "sha1";
  } else {
    // No usable digest from either field: prove absence via the VERSION query
    // ONLY. Digest-field 404s are ignored for the absence decision (R3).
    const rVersion = view("version");
    const versionText = `${rVersion.out}\n${rVersion.err}`;
    const versionSays404 = rVersion.status !== 0 && is404(versionText);
    if (versionSays404 && !isTransportFailure(versionText)) {
      console.error(`npm identity: ${spec} is NOT on the registry (nothing to resume).`);
      process.exit(2);
    }
    if (rVersion.status === 0 && !rVersion.out && !isTransportFailure(versionText)) {
      // Successful query with clean empty output proves absence (transport success).
      console.error(`npm identity: ${spec} is NOT on the registry (nothing to resume).`);
      process.exit(2);
    }
    if (rVersion.status === 0 && rVersion.out) {
      // Version exists but integrity is missing/unreadable: cannot prove identity.
      console.error(`npm identity UNKNOWN for ${spec}: version is present but dist.integrity/dist.shasum is missing or unreadable (fail closed, never publish).`);
      process.exit(3);
    }
    console.error(
      `npm identity UNKNOWN for ${spec}: registry lookup failed (network/auth/parse). Failing closed; never publish on UNKNOWN. ` +
        `integrity(status=${rIntegrity.status}) shasum lookup failed without an authoritative VERSION-query absence.`,
    );
    process.exit(3);
  }
}

if (algo === "sha512" && !isValidSha512(expected)) {
  console.error(`npm identity UNKNOWN for ${spec}: malformed dist.integrity from registry (fail closed, never publish).`);
  process.exit(3);
}
if (algo === "sha1" && !isValidSha1(expected)) {
  console.error(`npm identity UNKNOWN for ${spec}: malformed dist.shasum from registry (fail closed, never publish).`);
  process.exit(3);
}

const hashBytes = (bytes, which) =>
  which === "sha512" ? `sha512-${createHash("sha512").update(bytes).digest("base64")}` : createHash("sha1").update(bytes).digest("hex");

let actual = "";
if (localDigest) {
  actual = localDigest.trim();
  const looksSha512 = actual.startsWith("sha512-");
  const looksSha1 = isValidSha1(actual);
  if (!looksSha512 && !looksSha1) {
    console.error(`npm identity UNKNOWN for ${spec}: malformed --local-digest (fail closed, never publish).`);
    process.exit(3);
  }
  // Digest-only fallback compares the RECORDED first-pack digest against the
  // registry integrity with no repack (rebuild-nondeterminism safe).
} else if (tarballPath) {
  if (!existsSync(tarballPath) || statSync(tarballPath).size === 0) {
    console.error(`npm identity: retained tarball ${tarballPath} is missing or empty (fail closed).`);
    process.exit(1);
  }
  const bytes = readFileSync(tarballPath);
  actual = hashBytes(bytes, algo);
} else {
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
    actual = hashBytes(bytes, algo);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (recordPath) {
  try {
    mkdirSync(dirname(recordPath), { recursive: true });
    writeFileSync(recordPath, `${actual}\n`, "utf8");
  } catch (err) {
    console.error(`npm identity: failed to record digest to ${recordPath}: ${err?.message ?? err} (fail closed).`);
    process.exit(1);
  }
}

if (actual !== expected) {
  console.error(
    `npm identity MISMATCH for ${spec}: registry tarball content differs from the local tarball. Refusing to resume, publish over, or release (fail closed).`,
  );
  process.exit(1);
}
console.log(`npm identity verified: ${spec} registry content matches the local tarball.`);
