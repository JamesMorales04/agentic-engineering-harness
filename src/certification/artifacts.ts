import fs from "node:fs/promises";
import path from "node:path";
import type { CertificationReport } from "./types.js";
import { sha256Canonical } from "../core/digest.js";

export async function writeCertificationReport(root: string, report: CertificationReport, directory = ".harness/certifications"): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(report.certificationId)) throw new Error("Unsafe certification id.");
  const base = path.resolve(root, directory);
  const relative = path.relative(path.resolve(root), base);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Certification report directory escapes the repository.");
  await fs.mkdir(base, { recursive: true });
  const file = path.join(base, `${report.certificationId}.json`);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await fs.writeFile(file, json, { flag: "wx" });
  return file;
}

export function certificationReportDigest(report: CertificationReport): string { return sha256Canonical(report); }
