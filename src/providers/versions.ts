import { readFileSync } from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "../version.js";

const versions = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "templates", "provider-versions.json"), "utf8")) as Record<string, string>;

export const providerVersions = versions as {
  headroom: string;
  graphify: string;
  engram: string;
  serena: string;
  trivy: string;
  opengrep: string;
  playwright: string;
  pnpm: string;
};
