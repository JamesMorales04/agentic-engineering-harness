import fs from "node:fs/promises";
import path from "node:path";
import { commandExists } from "../../utils/process.js";
import { GenericBddExecutionProvider } from "./bddExecution.js";
import type { ProviderDetection, ValidationProviderContext } from "./types.js";

/** Optional compatibility adapter. It is never selected by the generic BDD path. */
export class ReqnrollBddProvider extends GenericBddExecutionProvider {
  override readonly id: string = "reqnroll";

  override async detect(context: ValidationProviderContext): Promise<ProviderDetection | undefined> {
    const explicit = await super.detect(context);
    if (explicit) return explicit;
    if (!(await commandExists("dotnet", context.root))) return undefined;
    const project = await findProject(context.root);
    if (!project) return undefined;
    const content = await fs.readFile(project, "utf8"); const filterProperty = /Reqnroll\.xUnit/i.test(content) ? "Category" : "TestCategory";
    return { provider: "reqnroll", command: `dotnet test '${project.replaceAll("'", "'\\''")}' --filter '${filterProperty}=${context.contract.task.id}'`, runtime: ".NET", reason: "explicit optional Reqnroll compatibility adapter" };
  }
}

async function findProject(root: string): Promise<string | undefined> {
  for (const file of await walk(root)) {
    if (!file.endsWith(".csproj")) continue;
    try { if (/Reqnroll\./i.test(await fs.readFile(file, "utf8"))) return file; } catch { /* generated/vendor project */ }
  }
  return undefined;
}

async function walk(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "bin", "obj"].includes(entry.name)) continue;
      const file = path.join(directory, entry.name); if (entry.isDirectory()) await visit(file); else output.push(file);
    }
  };
  await visit(root); return output;
}
