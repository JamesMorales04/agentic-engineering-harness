import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig, TaskContract, ValidationCheck } from "./types.js";

interface SealFile {
  version: 1;
  taskId: string;
  createdAt: string;
  artifacts: Array<{ path: string; sha256: string }>;
}

export async function sealTask(root: string, config: HarnessProjectConfig, contract: TaskContract): Promise<string> {
  const artifacts = await artifactPaths(root, config, contract);
  const seal: SealFile = {
    version: 1,
    taskId: contract.task.id,
    createdAt: new Date().toISOString(),
    artifacts: []
  };

  for (const relative of artifacts) {
    const content = await fs.readFile(path.resolve(root, relative));
    seal.artifacts.push({ path: relative, sha256: sha256(content) });
  }

  const output = sealPath(root, contract.task.id);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(seal, null, 2)}\n`);
  return output;
}

export async function verifyTaskSeal(root: string, contract: TaskContract, required = true): Promise<ValidationCheck> {
  const file = sealPath(root, contract.task.id);
  let seal: SealFile;
  try {
    seal = JSON.parse(await fs.readFile(file, "utf8")) as SealFile;
  } catch {
    return {
      id: "trust.seal",
      category: "trust-boundary",
      status: required ? "FAIL" : "WARN",
      message: `No valid seal exists for ${contract.task.id}. Run engineering-harness seal ${contract.task.id} before delegation.`
    };
  }

  const mismatches: Array<{ path: string; expected: string; actual?: string }> = [];
  for (const artifact of seal.artifacts) {
    try {
      const current = await fs.readFile(path.resolve(root, artifact.path));
      const actual = sha256(current);
      if (actual !== artifact.sha256) mismatches.push({ path: artifact.path, expected: artifact.sha256, actual });
    } catch {
      mismatches.push({ path: artifact.path, expected: artifact.sha256 });
    }
  }

  return {
    id: "trust.seal",
    category: "trust-boundary",
    status: mismatches.length ? "FAIL" : "PASS",
    message: mismatches.length ? `Sealed artifacts changed after freeze: ${mismatches.map((x) => x.path).join(", ")}` : "TaskContract and sealed SDD artifacts match their SHA-256 seal.",
    details: { mismatches, sealedAt: seal.createdAt }
  };
}

async function artifactPaths(root: string, config: HarnessProjectConfig, contract: TaskContract): Promise<string[]> {
  const contractsDir = config.sdd?.contractsDir ?? ".harness/contracts";
  const paths = [path.posix.join(contractsDir.replaceAll("\\", "/"), `${contract.task.id}.yaml`)];
  for (const source of Object.values(contract.source ?? {})) {
    if (source) paths.push(source.replaceAll("\\", "/"));
  }

  const unique = [...new Set(paths)];
  for (const relative of unique) {
    await fs.access(path.resolve(root, relative));
  }
  return unique;
}

function sealPath(root: string, taskId: string): string {
  return path.join(root, ".harness", "seals", `${taskId}.json`);
}

function sha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
