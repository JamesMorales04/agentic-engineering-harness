import path from "node:path";
import type { HarnessProjectConfig, TaskContract, ValidationCheck } from "../core/types.js";
import { commandExists, runProcess } from "../utils/process.js";

export async function runOpaPolicies(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  changedFiles: string[],
  frozenChangedFiles: string[]
): Promise<ValidationCheck> {
  if (!config.validation?.opa?.enabled) {
    return { id: "policy.opa", category: "policy", status: "SKIP", message: "OPA policy evaluation disabled." };
  }

  if (!(await commandExists("opa", root))) {
    return { id: "policy.opa", category: "policy", status: "WARN", message: "OPA is enabled but the opa executable is not installed." };
  }

  const policyDirs = config.validation.opa.policyDirs ?? [];
  if (!policyDirs.length) {
    return { id: "policy.opa", category: "policy", status: "WARN", message: "OPA is enabled but no policyDirs are configured." };
  }

  const args = policyDirs.map((dir) => `--data ${quote(path.resolve(root, dir))}`).join(" ");
  const input = {
    workerRole: "implementation-worker",
    changedFiles,
    frozenChangedFiles,
    taskContract: contract,
    newDependencies: [],
    schemaChanged: false
  };

  const inputJson = JSON.stringify(input);
  const command = `printf %s ${quote(inputJson)} | opa eval --format=json ${args} --stdin-input data`;
  const result = await runProcess(command, { cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    return {
      id: "policy.opa",
      category: "policy",
      status: "FAIL",
      message: "OPA policy evaluation failed to execute.",
      details: { stderr: result.stderr, stdout: result.stdout }
    };
  }

  try {
    const parsed = JSON.parse(result.stdout) as { result?: Array<{ expressions?: Array<{ value?: unknown }> }> };
    const value = parsed.result?.[0]?.expressions?.[0]?.value;
    const denies = collectDenies(value);
    return {
      id: "policy.opa",
      category: "policy",
      status: denies.length ? "FAIL" : "PASS",
      message: denies.length ? `OPA denied the change: ${denies.join("; ")}` : "OPA policies allowed the change.",
      details: { denies }
    };
  } catch (error) {
    return {
      id: "policy.opa",
      category: "policy",
      status: "FAIL",
      message: "OPA returned an unreadable result.",
      details: { error: String(error), stdout: result.stdout }
    };
  }
}

function collectDenies(value: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key === "deny") {
        if (Array.isArray(child)) out.push(...child.map(String));
        else if (child && typeof child === "object") out.push(...Object.keys(child as Record<string, unknown>));
        else if (child) out.push(String(child));
      }
      visit(child);
    }
  };
  visit(value);
  return [...new Set(out)];
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
