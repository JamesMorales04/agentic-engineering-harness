import fs from "node:fs/promises";
import path from "node:path";

export interface SelfCheckoutRuntimePlan {
  selfCheckout: boolean;
  currentEntry: string;
  localEntry: string;
  localEntryReady: boolean;
  shouldRelaunch: boolean;
  checkoutVersion?: string;
}

export async function planSelfCheckoutRuntime(root: string, currentEntry: string): Promise<SelfCheckoutRuntimePlan> {
  const projectRoot = path.resolve(root);
  const resolvedEntry = path.resolve(currentEntry);
  const localEntry = path.resolve(projectRoot, "dist/main.js");
  const manifest = await readManifest(projectRoot);
  const selfCheckout = manifest?.name === "agentic-engineering-harness";
  const localEntryReady = await exists(localEntry);
  return {
    selfCheckout,
    currentEntry: resolvedEntry,
    localEntry,
    localEntryReady,
    shouldRelaunch: selfCheckout && resolvedEntry !== localEntry,
    checkoutVersion: typeof manifest?.version === "string" ? manifest.version : undefined
  };
}

export function resolveStartProjectRoot(argv: string[], cwd = process.cwd()): string {
  const valueOptions = new Set(["lead", "title"]);
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (valueOptions.has(name)) index += 1;
  }
  return path.resolve(cwd, positional[0] ?? ".");
}

async function readManifest(root: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.resolve(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
