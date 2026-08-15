import type { McpServerConfig } from "../../core/types.js";
import { commandExists, runProcess } from "../../utils/process.js";
import type { ProviderHealth } from "../compression/types.js";
import { providerVersions } from "../../providers/versions.js";

export const SERENA_VERSION = providerVersions.serena;

export class SerenaSemanticProvider {
  readonly name = "serena";
  constructor(private readonly command = "serena") {}

  async doctor(root: string): Promise<ProviderHealth> {
    if (!(await commandExists(this.command, root))) return { ok: false, message: `Serena executable '${this.command}' was not found in the reconciled toolchain PATH.` };
    const result = await runProcess(`${quote(this.command)} --version`, { cwd: root, timeoutMs: 15_000 });
    if (result.exitCode !== 0) return { ok: false, message: `Serena health check failed: ${result.stderr || result.stdout}` };
    const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
    return { ok: version.includes(SERENA_VERSION), version, message: version.includes(SERENA_VERSION) ? `Serena semantic retrieval ready (${version}).` : `Serena version drift: expected ${SERENA_VERSION}, got ${version}.` };
  }

  mcpServer(root: string): McpServerConfig {
    return { description: "AEH-managed local Serena semantic repository retrieval; editing is disabled by default.", type: "local", command: [this.command, "start-mcp-server", "--context", "ide-assistant", "--project", root], enabled: true, timeoutMs: 30_000 };
  }
}

export function semanticFirstInstruction(): string {
  return ["Semantic repository policy:", "1. Locate relevant symbols before reading complete files.", "2. Inspect symbol bodies only when required.", "3. Find referencing symbols before broad repository search.", "4. Read complete files only when file-level context is semantically required.", "5. Do not use Serena memory as AEH historical memory; Engram remains memory authority.", "6. Serena editing is disabled unless the assigned role and frozen scope explicitly permit it."].join("\n");
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
