#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`Unsupported semantic version '${value}'. Expected MAJOR.MINOR.PATCH.`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function incrementVersion(value, bump) {
  const parsed = parseVersion(value);
  if (bump === "major") return `${parsed.major + 1}.0.0`;
  if (bump === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  if (bump === "patch") return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  if (bump === "current") return value;
  throw new Error(`Unsupported release bump '${bump}'.`);
}

export function chooseBumpFromMessages(messages) {
  const text = messages.join("\n\n");
  if (/(^|\n)[a-z]+(?:\([^\n)]+\))?!:/i.test(text) || /(^|\n)BREAKING(?: CHANGE|-CHANGE):/i.test(text)) return "major";
  if (/(^|\n)feat(?:\([^\n)]+\))?:/i.test(text)) return "minor";
  return "patch";
}

export function resolveTargetVersion({ currentVersion, currentPublished, requestedBump = "auto", messages = [] }) {
  if (!currentPublished) {
    return { version: currentVersion, bump: "current", shouldPublish: true, reason: "current package version is not published" };
  }
  if (requestedBump === "current") {
    return { version: currentVersion, bump: "current", shouldPublish: false, reason: "current package version is already published" };
  }
  const bump = requestedBump === "auto" ? chooseBumpFromMessages(messages) : requestedBump;
  return { version: incrementVersion(currentVersion, bump), bump, shouldPublish: true, reason: `${bump} bump from published ${currentVersion}` };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function currentPackageIsPublished(name, version) {
  try {
    return run("npm", ["view", `${name}@${version}`, "version", "--json"]).replaceAll('"', "") === version;
  } catch {
    return false;
  }
}

function latestReleaseTag() {
  try { return run("git", ["describe", "--tags", "--match", "v[0-9]*", "--abbrev=0"]); }
  catch { return undefined; }
}

function commitMessages(tag) {
  try {
    const output = tag
      ? run("git", ["log", `${tag}..HEAD`, "--format=%B%x00"])
      : run("git", ["log", "-1", "--format=%B%x00"]);
    return output.split("\0").map((item) => item.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function appendOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value)}\n`);
}

const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  const requestedBump = process.argv[2] ?? "auto";
  if (!["auto", "current", "patch", "minor", "major"].includes(requestedBump)) throw new Error(`Invalid bump '${requestedBump}'.`);
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const published = currentPackageIsPublished(pkg.name, pkg.version);
  const tag = latestReleaseTag();
  const result = resolveTargetVersion({ currentVersion: pkg.version, currentPublished: published, requestedBump, messages: commitMessages(tag) });
  const payload = { ...result, currentVersion: pkg.version, packageName: pkg.name, latestTag: tag ?? null, versionChanged: result.version !== pkg.version };
  appendOutput("version", payload.version);
  appendOutput("bump", payload.bump);
  appendOutput("should_publish", payload.shouldPublish);
  appendOutput("version_changed", payload.versionChanged);
  appendOutput("reason", payload.reason);
  console.log(JSON.stringify(payload, null, 2));
}
