import fs from "node:fs/promises";
import path from "node:path";
import type { ValidationCheck } from "../core/types.js";
import { commandExists } from "../utils/process.js";
import type { ValidationContext } from "./types.js";
import { missingTool, runSpecCommand } from "./toolCommand.js";

export async function runGherkinValidator(context: ValidationContext): Promise<ValidationCheck> {
  if (context.spec.command) return runSpecCommand(context, context.spec.command, "acceptance");
  if (!(await commandExists("dotnet", context.root))) return missingTool(context.spec, "dotnet", "acceptance");

  const project = await findReqnrollProject(context.root);
  if (!project) {
    return {
      id: context.spec.id,
      category: "acceptance",
      status: context.spec.required ? "FAIL" : "WARN",
      message: "No .NET project referencing Reqnroll was found. Configure validator.command for non-.NET Gherkin runners."
    };
  }

  const content = await fs.readFile(project, "utf8");
  const filterProperty = /Reqnroll\.xUnit/i.test(content) ? "Category" : "TestCategory";
  const command = `dotnet test ${quote(project)} --filter "${filterProperty}=${context.contract.task.id}"`;
  const check = await runSpecCommand(context, command, "acceptance", { project, filterProperty });
  const output = `${String(check.details?.stdout ?? "")}\n${String(check.details?.stderr ?? "")}`;
  if (check.status === "PASS" && /No test matches|Total tests:\s*0|0 tests?\b/i.test(output)) {
    return { ...check, status: "FAIL", message: `Reqnroll executed but no scenarios tagged @${context.contract.task.id} were discovered.` };
  }
  return check;
}

async function findReqnrollProject(root: string): Promise<string | undefined> {
  for (const file of await walk(root)) {
    if (!file.endsWith(".csproj")) continue;
    try {
      const content = await fs.readFile(file, "utf8");
      if (/Reqnroll\./i.test(content)) return file;
    } catch { /* ignore generated/vendor projects */ }
  }
  return undefined;
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "bin" || entry.name === "obj") continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file); else out.push(file);
    }
  };
  await visit(root);
  return out;
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
