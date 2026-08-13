import { extractMarkedJson } from "../agents/structuredOutput.js";
import {
  acceptedStructuredResultForAgent,
  reconcileStructuredResult,
  type StructuredResultResolution
} from "./resultGateway.js";
import { commitStructuredResult } from "./resultCommit.js";

export async function resolveStructuredResult<T = unknown>(
  root: string,
  input: {
    operationId: string;
    agentId?: string;
    logicalAgent: string;
    role?: string;
    contract: string;
    phase?: string;
    stdout: string;
    stderr?: string;
  }
): Promise<StructuredResultResolution<T>> {
  if (input.agentId) {
    const accepted = await acceptedStructuredResultForAgent<T>(root, input.agentId).catch(() => undefined);
    if (accepted) {
      const candidate = optionalCandidate(input.stdout, input.stderr ?? "");
      if (candidate === undefined) return { ok: true, accepted };
      try {
        return { ok: true, accepted: await commitStructuredResult<T>(root, input.operationId, accepted.channelId, candidate, "captured") };
      } catch (error) {
        return { ok: false, failure: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  return reconcileStructuredResult<T>(root, input);
}

function optionalCandidate(stdout: string, stderr: string): unknown | undefined {
  if (!stdout.trim() && !stderr.trim()) return undefined;
  try { return extractMarkedJson(stdout, stderr); } catch { return undefined; }
}
