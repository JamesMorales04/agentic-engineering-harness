import type { AgentProviderResult, CertificationCapability, CertificationCheck, CertificationOracle, CertificationOracleContext, CertificationOracleResult } from "./types.js";
import { CERTIFICATION_CAPABILITY_MATRIX } from "./types.js";
import { createCertificationOracleResult } from "./oracle.js";

/** One deterministic journey-evidence result keyed by a capability `requiredEvidence` id. */
export interface CapabilityJourneyEvidence {
  ok: boolean;
  detail?: unknown;
}

export interface CapabilityJourneyVerificationContext {
  candidateRoot: string;
  actor?: AgentProviderResult;
}

export type CapabilityJourneyVerifier = (context: CapabilityJourneyVerificationContext) => Promise<Record<string, CapabilityJourneyEvidence>>;

/** A command the real provider actor must have executed successfully for the journey to count. */
export interface CapabilityActorCommandRequirement {
  label?: string;
  contains: string;
  output?: RegExp;
}

export interface CapabilityJourneyOracleOptions {
  id: string;
  capability: CertificationCapability;
  verify: CapabilityJourneyVerifier;
  actorCommands?: CapabilityActorCommandRequirement[];
}

interface ActorCommandExecution {
  command: string;
  exitCode: unknown;
  output: string;
}

/**
 * Deterministic oracle for one capability journey over a freshly packed candidate.
 *
 * The verifier may only read durable artifacts produced inside the disposable candidate
 * fixture. The provider transcript is consulted only to prove that the real provider
 * actually executed the declared journey command; it can never satisfy required evidence
 * on its own.
 */
export function createCapabilityJourneyOracle(options: CapabilityJourneyOracleOptions): CertificationOracle {
  return {
    id: options.id,
    independent: true,
    async evaluate({ candidate, actor }: CertificationOracleContext): Promise<CertificationOracleResult> {
      const requirement = CERTIFICATION_CAPABILITY_MATRIX.find((item) => item.capability === options.capability);
      if (!requirement) throw new Error(`Unknown certification capability '${options.capability}'.`);
      const evidence = await options.verify({ candidateRoot: candidate.root, actor });
      const checks: CertificationCheck[] = [];
      const oracleEvidence: Record<string, unknown> = {};
      let evidenceOk = true;
      for (const id of requirement.requiredEvidence) {
        const item = evidence[id];
        const ok = item?.ok === true;
        evidenceOk = evidenceOk && ok;
        checks.push({
          id,
          category: "journey",
          status: ok ? "PASS" : "FAIL",
          required: true,
          message: ok ? `Journey evidence '${id}' verified for ${options.capability}.` : `Journey evidence '${id}' was not verified for ${options.capability}.`,
          evidence: { detail: item?.detail ?? null }
        });
        oracleEvidence[id] = { ok, detail: item?.detail ?? null };
      }
      const executions = actorCommandExecutions(actor);
      const actorChecks = (options.actorCommands ?? []).map((command) => {
        const matched = executions.find((execution) => execution.command.includes(command.contains));
        const exitOk = matched?.exitCode === 0;
        const outputOk = !command.output || command.output.test(matched?.output ?? "");
        const ok = Boolean(matched) && exitOk && outputOk;
        return {
          id: `actor.command:${command.label ?? command.contains}`,
          category: "provider",
          status: ok ? "PASS" as const : "FAIL" as const,
          required: true,
          message: ok ? `Provider executed '${command.contains}'.` : `Provider did not prove successful execution of '${command.contains}'.`,
          evidence: { matched: Boolean(matched), exitCode: matched?.exitCode ?? null, output: (matched?.output ?? "").slice(-2_000) }
        };
      });
      checks.push(...actorChecks);
      const actorOk = actorChecks.every((check) => check.status === "PASS");
      const modelOk = evidenceOk && actorOk;
      checks.push({
        id: "model.evidence",
        category: "provider",
        status: modelOk ? "PASS" : "FAIL",
        required: true,
        message: modelOk
          ? "Deterministic oracle verified the capability journey and the real provider execution."
          : "Deterministic oracle did not verify both the capability journey evidence and the real provider command execution.",
        evidence: { capability: options.capability, evidenceOk, actorOk, executions: executions.map((execution) => ({ command: execution.command.slice(0, 500), exitCode: execution.exitCode })) }
      });
      return createCertificationOracleResult({ oracleId: options.id, checks, evidence: { capability: options.capability, ...oracleEvidence } });
    }
  };
}

/** Extract successful/failed command executions recorded by the real provider (Codex `item.completed` JSONL). */
export function actorCommandExecutions(actor?: AgentProviderResult): ActorCommandExecution[] {
  const executions: ActorCommandExecution[] = [];
  for (const event of actor?.events ?? []) {
    if (event.type !== "json" || !event.data || typeof event.data !== "object") continue;
    const data = event.data as Record<string, unknown>;
    if (data.type !== "item.completed" || !data.item || typeof data.item !== "object") continue;
    const item = data.item as Record<string, unknown>;
    if (typeof item.command !== "string") continue;
    executions.push({ command: item.command, exitCode: item.exit_code, output: String(item.aggregated_output ?? "") });
  }
  return executions;
}
