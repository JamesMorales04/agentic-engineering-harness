export interface MemoryRecord {
  id?: string;
  project: string;
  type: "decision" | "bug" | "discovery" | "convention" | "summary" | string;
  title: string;
  content: string;
  source?: string;
  sourceSha256?: string;
  createdAt?: string;
  supersedes?: string;
  tags?: string[];
}

export interface MemoryProvider {
  readonly name: string;
  doctor(root: string): Promise<{ ok: boolean; message: string }>;
  remember(record: MemoryRecord): Promise<string | undefined>;
  recall(project: string, query: string): Promise<MemoryRecord[]>;
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
  build?(root: string): Promise<void>;
  refresh?(root: string): Promise<void>;
  update?(root: string): Promise<void>;
  load?(root: string): Promise<unknown | undefined>;
  isFresh?(root: string): Promise<boolean>;
  impact?(root: string, diffRef?: string): Promise<CodeImpactReport>;
}

export interface SemanticRepositoryProvider {
  readonly name: string;
  doctor(root: string): Promise<{ ok: boolean; message: string; version?: string }>;
  mcpServer?(root: string): unknown;
}

export interface ContextCompressionProvider {
  readonly name: string;
  doctor(root: string): Promise<{ ok: boolean; message: string; version?: string }>;
}

export interface OrchestrationProvider {
  readonly name: string;
  doctor(root: string): Promise<{ ok: boolean; message: string }>;
}
