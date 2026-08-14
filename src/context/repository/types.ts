export interface RepositoryNode {
  id: string;
  file: string;
  symbol?: string;
  signature?: string;
  centrality?: number;
  changed?: boolean;
  community?: string;
}

export interface RepositoryEdge { from: string; to: string; kind?: string; }

export interface RepositoryContextMap {
  nodes: RepositoryNode[];
  edges: RepositoryEdge[];
  provider: "graphify" | "filesystem" | string;
  generatedAt?: string;
}

export interface RepositoryRankRequest {
  explicitPaths?: string[];
  allowedPaths?: string[];
  changedFiles?: string[];
  findingLocations?: string[];
  symbol?: string;
  referenceIds?: string[];
  maxGraphHops?: number;
}

export interface RankedRepositoryNode extends RepositoryNode { score: number; reasons: string[]; distance?: number; }
