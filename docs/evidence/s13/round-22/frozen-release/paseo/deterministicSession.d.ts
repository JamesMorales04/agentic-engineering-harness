import type { HarnessProjectConfig } from "../core/types.js";
import { type PaseoStartOptions, type PaseoStartResult } from "./start.js";
import { type EngineeringIntent } from "../audit/intent.js";
import { type IntentDecisionV1 } from "../audit/intentDecision.js";
import { type InformationalAnswer } from "../informational/answer.js";
export interface DeterministicPaseoTurnResult {
    version: 1;
    intent: EngineeringIntent;
    session: {
        agentId: string;
        state: "idle" | "received-completion";
        turnCount: number;
    };
    userTurn: {
        id: string;
        prompt: string;
        accepted: boolean;
    };
    decision: IntentDecisionV1;
    operation?: {
        id: string;
        kind: "audit";
        status: string;
        phase: string;
        revision: number;
        result?: Record<string, unknown>;
    };
    validation: {
        status: string;
        checks: Array<{
            id: string;
            status: string;
            message: string;
        }>;
    };
    completion: {
        status: string;
        agentId: string;
        attempts: number;
    };
    lead: {
        wakeReceived: boolean;
        message: string;
    };
    supervisorSpawned: boolean;
    answer?: InformationalAnswer;
    human: string;
}
/**
 * A deterministic Paseo SDK boundary for black-box and packaged journeys.
 * The normal start path remains unchanged; this boundary replaces only the
 * external daemon/model conversation with a file-backed fake SDK session.
 */
export declare function startDeterministicPaseoHarness(root: string, config: HarnessProjectConfig, options?: PaseoStartOptions): Promise<PaseoStartResult>;
export declare function runDeterministicPaseoTurn(root: string, config: HarnessProjectConfig, prompt: string, scriptedDecision?: IntentDecisionV1): Promise<DeterministicPaseoTurnResult>;
