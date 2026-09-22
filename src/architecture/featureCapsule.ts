import fs from "node:fs/promises";
import path from "node:path";
import { assertFeatureCapsule, serializeFeatureCapsule, type AssuranceLevel, type FeatureCapsuleV1, type RouteEvidence } from "./contracts.js";

export interface DelegatedFeatureCapsuleInput {
  taskId: string;
  objective: string;
  scope: { allowed: string[]; forbidden?: string[] };
  constraints?: Record<string, unknown>;
  acceptance?: string[];
  contextRefs?: string[];
  candidateRevision?: Record<string, unknown>;
  assurance: AssuranceLevel;
  routeEvidence: RouteEvidence[];
}

export function createDelegatedFeatureCapsule(input: DelegatedFeatureCapsuleInput): FeatureCapsuleV1 {
  return assertFeatureCapsule({
    version: 1,
    taskId: input.taskId,
    objective: input.objective,
    scope: input.scope,
    ...(input.constraints ? { constraints: input.constraints } : {}),
    ...(input.acceptance?.length ? { acceptance: input.acceptance } : {}),
    ...(input.contextRefs?.length ? { contextRefs: input.contextRefs } : {}),
    ...(input.candidateRevision ? { candidateRevision: input.candidateRevision } : {}),
    route: "DELEGATED",
    assurance: input.assurance,
    routeEvidence: input.routeEvidence,
    progress: { total: 0, completed: 0, inProgress: 0, blocked: 0 },
    workUnits: []
  });
}

export async function persistFeatureCapsule(root: string, capsule: FeatureCapsuleV1): Promise<string> {
  const value = assertFeatureCapsule(capsule);
  const file = path.resolve(root, ".harness", "capsules", `${safeId(value.taskId ?? value.featureId ?? "feature")}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${serializeFeatureCapsule(value)}\n`, { encoding: "utf8", mode: 0o600 });
  return path.relative(root, file).replaceAll("\\", "/");
}

function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
