import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R10-F6: bind every S13 certification lane envelope to the exact campaign harness revision that
 * produced it, so a later reviewer can recompute the harness sources from the artifact alone.
 */
export async function harnessRevisionV1(entryFile) {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const names = [...new Set([
    path.basename(entryFile ?? ""),
    "s13CampaignHarnessRevision.mjs",
    "s13GovernedCampaignPolicy.mjs",
    "s13ExternalEffectAuthorization.mjs"
  ])].filter(Boolean);
  const digest = crypto.createHash("sha256");
  const files = [];
  for (const name of names) {
    let bytes = Buffer.alloc(0);
    try { bytes = await fs.readFile(path.join(directory, name)); } catch { /* a missing companion is recorded as empty bytes */ }
    files.push({ file: name, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
    digest.update(`${name}\0`);
    digest.update(bytes);
  }
  return { files, digest: digest.digest("hex") };
}
