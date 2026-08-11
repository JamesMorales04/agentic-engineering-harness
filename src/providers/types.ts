export interface MemoryRecord {
  id?: string;
  project: string;
  type: "decision" | "bug" | "discovery" | "convention" | "summary" | string;
  title: string;
  content: string;
  source?: string;
  supersedes?: string;
  tags?: string[];
}

export interface MemoryProvider {
  readonly name: string;
  doctor(root: string): Promise<{ ok: boolean; message: string }>;
  remember?(record: MemoryRecord): Promise<string | undefined>;
  recall?(project: string, query: string): Promise<MemoryRecord[]>;
}

export interface CodeImpactReport {
  provider: string;
  affectedNodes?: string[];
  affectedCommunities?: string[];
  raw?: unknown;
}

export interface CodeIntelligenceProvider {
  readonly name: string;
  doctor(root: string): Promise<{ ok: boolean; message: string }>;
  update?(root: string): Promise<void>;
  impact?(root: string, diffRef?: string): Promise<CodeImpactReport>;
}

export interface OrchestrationProvider {
  readonly name: string;
  doctor(root: string): Promise<{ ok: boolean; message: string }>;
}
