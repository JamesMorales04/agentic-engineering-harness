import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validateAgentOutput } from "../agents/outputContracts.js";
import { operationArtifactDir, resolveOperationStateRoot } from "../operations/state.js";
import {
  acceptStructuredResult,
  loadStructuredResultChannel,
  type AcceptedStructuredResult,
  type StructuredResultSource
} from "./resultGateway.js";

export async function commitStructuredResult<T = unknown>(
  root: string,
  operationId: string,
  channelId: string,
  payload: unknown,
  source: StructuredResultSource
): Promise<AcceptedStructuredResult<T>> {
  const lock = path.join(operationArtifactDir(resolveOperationStateRoot(root), operationId), "result-channels", `${safe(channelId)}.commit.lock`);
  return withLock(lock, async () => {
    const channel = await loadStructuredResultChannel(root, operationId, channelId);
    const turn = channel.activeTurn;
    if (!turn) throw new Error("AEH_RESULT_NO_ACTIVE_TURN: no controller-activated result turn exists.");
    if (turn.status === "ACCEPTED" && turn.sha256 && turn.artifact) {
      const validation = validateAgentOutput(turn.contract, payload);
      if (!validation.ok) throw new Error(`RESULT_ALREADY_ACCEPTED: ${validation.issues.join("; ")}`);
      const normalized = validation.value as T;
      const sha256 = crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
      if (sha256 !== turn.sha256) throw new Error("CONFLICTING_RESULT: the active turn already has a different accepted payload.");
      return { artifact: turn.artifact, sha256, payload: normalized, source: turn.source ?? source, turnId: turn.id, channelId };
    }
    return acceptStructuredResult<T>(root, operationId, channelId, payload, source);
  });
}

function safe(value: string): string { return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "result"; }
async function withLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const handle = await fs.open(file, "wx");
      try { return await action(); }
      finally { await handle.close().catch(() => undefined); await fs.rm(file, { force: true }).catch(() => undefined); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
