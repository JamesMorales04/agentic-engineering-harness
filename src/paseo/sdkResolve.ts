import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { runProcess, type ProcessResult } from "../utils/process.js";

const PASEO_CLIENT_PACKAGE = "@getpaseo/client";

type ProcessRunner = (command: string, options: Parameters<typeof runProcess>[1]) => Promise<ProcessResult>;

export interface PaseoSdkResolution {
  resolved?: string;
  diagnostics: string[];
}

/**
 * Resolve the Paseo client that belongs to the active Paseo CLI installation.
 *
 * mise's npm backend installs tools into a synthetic project and may expose a
 * shim on PATH instead of the real package binary. Resolving relative to that
 * shim cannot see the CLI's node_modules. `mise which` and `mise where` expose
 * the actual binary/install root, which lets Node resolve the exact client
 * version shipped with that CLI.
 */
export async function resolvePaseoSdkFromCli(root: string, runner: ProcessRunner = runProcess): Promise<PaseoSdkResolution> {
  const diagnostics: string[] = [];
  const starts = new Set<string>();

  const commandPath = await capturePath(runner, "command -v paseo", root, "command -v paseo", diagnostics);
  if (commandPath) await addExecutableStarts(starts, commandPath);

  const misePath = await capturePath(runner, "mise which paseo", root, "mise which paseo", diagnostics);
  if (misePath) await addExecutableStarts(starts, misePath);

  const miseRoot = await capturePath(runner, "mise where 'npm:@getpaseo/cli'", root, "mise where npm:@getpaseo/cli", diagnostics);
  if (miseRoot) starts.add(path.resolve(miseRoot));

  for (const start of starts) {
    const resolved = resolvePackageWalkingUp(start, PASEO_CLIENT_PACKAGE);
    if (resolved) return { resolved, diagnostics };
  }

  return { diagnostics };
}

async function capturePath(runner: ProcessRunner, command: string, root: string, label: string, diagnostics: string[]): Promise<string | undefined> {
  try {
    const result = await runner(command, { cwd: root, timeoutMs: 15_000 });
    const value = result.exitCode === 0 ? lastNonEmptyLine(result.stdout) : undefined;
    diagnostics.push(`${label}: ${value ?? `unavailable (exit ${result.exitCode})`}`);
    return value;
  } catch (error) {
    diagnostics.push(`${label}: ${String(error)}`);
    return undefined;
  }
}

async function addExecutableStarts(starts: Set<string>, executable: string): Promise<void> {
  const absolute = path.resolve(executable);
  starts.add(path.dirname(absolute));
  const real = await fs.realpath(absolute).catch(() => absolute);
  starts.add(path.dirname(real));
}

function resolvePackageWalkingUp(start: string, packageName: string): string | undefined {
  let current = path.resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const resolver = createRequire(path.join(current, "__aeh_paseo_sdk_loader__.cjs"));
      return resolver.resolve(packageName);
    } catch { /* keep walking toward the npm synthetic-project root */ }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function lastNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
}
