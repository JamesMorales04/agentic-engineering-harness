import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const localManifest = path.join(moduleRoot, "package.json");
const runningFromRelease = existsSync(localManifest);
const packageManifest = runningFromRelease ? localManifest : path.join(moduleRoot, "..", "package.json");
const pkg = JSON.parse(readFileSync(packageManifest, "utf8")) as { version: string };

export const VERSION = pkg.version;
export const PACKAGE_ROOT = runningFromRelease ? moduleRoot : path.resolve(moduleRoot, "..");
