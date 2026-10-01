import { createHash } from "node:crypto";
import { SerenaSemanticProvider } from "../context/repository/serena.js";
import { createSerenaWriterLeaseSync, SERENA_READ_ONLY_TOOLS, serenaPoolSocketPath } from "../providers/serenaProxy.js";

export type SerenaPoolAccessV1 = "read" | "write";
export interface SerenaPoolKeyV1 {
  projectId: string;
  canonicalRoot: string;
  workspaceId: string;
  serenaVersion: string;
}
export interface SerenaPoolSessionV1 {
  sessionId: string;
  key: SerenaPoolKeyV1;
  access: SerenaPoolAccessV1;
  ownerId: string;
  editingEnabled: boolean;
  mcpServer: ReturnType<SerenaSemanticProvider["mcpServer"]>;
  allowedTools: string[];
  deniedTools: string[];
  socketPath: string;
}

export class SerenaPoolOwnershipError extends Error {
  constructor(message: string) { super(message); this.name = "SerenaPoolOwnershipError"; }
}

function normalizeRoot(value: string): string {
  if (!value.trim()) throw new SerenaPoolOwnershipError("canonicalRoot must not be empty.");
  return value.replaceAll("\\", "/").replace(/\/$/, "");
}

function key(value: SerenaPoolKeyV1): string {
  return [value.projectId, normalizeRoot(value.canonicalRoot), value.workspaceId, value.serenaVersion].join("\u0000");
}

interface PoolEntry {
  key: SerenaPoolKeyV1;
  provider: SerenaSemanticProvider;
  sessions: Map<string, SerenaPoolSessionV1>;
}

export class SerenaPoolV1 {
  private readonly entries = new Map<string, PoolEntry>();
  constructor(private readonly provider = new SerenaSemanticProvider()) {}

  acquire(input: SerenaPoolKeyV1 & { ownerId: string; access?: SerenaPoolAccessV1; editingEnabled?: boolean }): SerenaPoolSessionV1 {
    if (!input.ownerId.trim()) throw new SerenaPoolOwnershipError("ownerId must not be empty.");
    const poolKey = key(input);
    const entry = this.entries.get(poolKey) ?? { key: { ...input, canonicalRoot: normalizeRoot(input.canonicalRoot) }, provider: this.provider, sessions: new Map() };
    const access = input.access ?? "read";
    const active = [...entry.sessions.values()];
    const conflict = active.find((session) => session.ownerId !== input.ownerId && session.access === "write" && access === "write");
    if (conflict) throw new SerenaPoolOwnershipError(`Serena workspace is leased by ${conflict.ownerId} with ${conflict.access} access.`);
    if (access === "write" && input.editingEnabled !== true) throw new SerenaPoolOwnershipError("Serena editing must be explicitly enabled for a writer lease.");
    const sessionId = `serena:${createHash("sha256").update(`${poolKey}\u0000${input.ownerId}\u0000${Date.now()}\u0000${active.length}`).digest("hex").slice(0, 20)}`;
    const writerLease = access === "write" && input.editingEnabled === true ? createSerenaWriterLeaseSync({ canonicalRoot: entry.key.canonicalRoot, projectId: entry.key.projectId, workspaceId: entry.key.workspaceId, ownerId: input.ownerId }) : undefined;
    const editingEnabled = Boolean(writerLease);
    const proxyEntry = process.env.AEH_ENTRY_FILE?.trim() || process.argv[1] || "aeh";
    const allowedTools = editingEnabled ? ["*"] : [...SERENA_READ_ONLY_TOOLS];
    const deniedTools = editingEnabled ? [] : ["replace_content", "replace_in_files", "replace_symbol_body", "insert_after_symbol", "insert_before_symbol", "rename_symbol", "safe_delete_symbol", "write_memory", "edit_memory", "delete_memory", "rename_memory", "onboarding"];
    const providerServer = entry.provider.mcpServer(entry.key.canonicalRoot);
    const socketPath = serenaPoolSocketPath(entry.key);
    const mcpServer = {
      ...providerServer,
      description: editingEnabled ? "AEH-managed Serena semantic service through a leased writer proxy." : "AEH-managed read-only Serena semantic retrieval proxy.",
      command: [process.execPath, proxyEntry, "provider", "serena-proxy"],
      environment: {
        ...(providerServer.environment ?? {}),
        AEH_SERENA_ROOT: entry.key.canonicalRoot,
        AEH_SERENA_COMMAND: providerServer.command?.[0] ?? "serena",
        AEH_SERENA_ACCESS: editingEnabled ? "write" : "read",
        AEH_SERENA_ALLOWED_TOOLS: allowedTools.join(","),
        AEH_SERENA_PROJECT_ID: entry.key.projectId,
        AEH_SERENA_WORKSPACE_ID: entry.key.workspaceId,
        AEH_SERENA_POOL_SOCKET: socketPath,
        AEH_SERENA_POOL_ROOT: entry.key.canonicalRoot,
        AEH_SERENA_POOL_COMMAND: providerServer.command?.[0] ?? "serena",
        ...(writerLease ? { AEH_SERENA_WRITER_LEASE_FILE: writerLease.filePath, AEH_SERENA_WRITER_LEASE_TOKEN: writerLease.token } : {})
      },
      toolPolicy: { allow: allowedTools, deny: deniedTools }
    };
    const session: SerenaPoolSessionV1 = { sessionId, key: entry.key, access, ownerId: input.ownerId, editingEnabled, allowedTools, deniedTools, socketPath, mcpServer };
    entry.sessions.set(sessionId, session);
    this.entries.set(poolKey, entry);
    return structuredClone(session);
  }

  release(sessionId: string, ownerId: string): void {
    for (const [poolKey, entry] of this.entries) {
      const session = entry.sessions.get(sessionId);
      if (!session) continue;
      if (session.ownerId !== ownerId) throw new SerenaPoolOwnershipError(`Serena session ${sessionId} is owned by ${session.ownerId}.`);
      entry.sessions.delete(sessionId);
      if (!entry.sessions.size) this.entries.delete(poolKey);
      return;
    }
  }

  snapshot(): SerenaPoolSessionV1[] {
    return [...this.entries.values()].flatMap((entry) => [...entry.sessions.values()].map((session) => structuredClone(session)));
  }
}

/** One controller-local pool is shared by all launch-spec projections. */
export const managedSerenaPool = new SerenaPoolV1();
