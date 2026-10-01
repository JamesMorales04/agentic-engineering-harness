import type { HarnessProjectConfig } from "../core/types.js";
export interface AgentAuditReport {
    ok: boolean;
    checks: Array<{
        id: string;
        status: "PASS" | "FAIL" | "WARN";
        message: string;
    }>;
}
export declare function auditAgentTopology(root: string, config: HarnessProjectConfig, profile?: string, options?: {
    checkGenerated?: boolean;
}): Promise<AgentAuditReport>;
