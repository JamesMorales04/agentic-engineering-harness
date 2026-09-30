import type { HarnessProjectConfig } from "../core/types.js";
import type { ContextEnvelope, ContextMetrics } from "./types.js";
export declare function recordContextMetrics(root: string, config: HarnessProjectConfig, envelope: ContextEnvelope, metrics: ContextMetrics): Promise<void>;
