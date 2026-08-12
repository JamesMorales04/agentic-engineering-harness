import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { HarnessProjectConfig, TaskContract } from "./types.js";

const validationCommandSchema = z.object({ id: z.string().min(1), command: z.string().min(1), required: z.boolean().optional(), timeoutSeconds: z.number().int().positive().optional(), workingDirectory: z.string().optional() });
const validatorSpecSchema = z.object({ id: z.string().min(1), adapter: z.string().min(1), command: z.string().min(1).optional(), required: z.boolean().optional(), timeoutSeconds: z.number().int().positive().optional(), workingDirectory: z.string().optional(), options: z.record(z.string(), z.unknown()).optional() });
const memoryBenchmarkProviderSchema = z.object({ name: z.string().min(1), command: z.string().min(1), timeoutSeconds: z.number().int().positive().optional() });
const projectSchema = z.object({
  version: z.literal(1), project: z.object({ name: z.string().min(1) }),
  agents: z.object({ configPath: z.string().optional(), generatedPath: z.string().optional(), activeProfile: z.string().optional(), required: z.boolean().optional(), findingsDir: z.string().optional() }).optional(),
  orchestration: z.object({ provider: z.string(), required: z.boolean().optional(), worker: z.object({ provider: z.string().optional(), model: z.string().optional(), maxRepairAttempts: z.number().int().nonnegative().optional(), timeoutSeconds: z.number().int().positive().optional(), titlePrefix: z.string().optional() }).optional() }).optional(),
  memory: z.object({ provider: z.string(), required: z.boolean().optional(), benchmark: z.object({ casesDir: z.string().optional(), resultsDir: z.string().optional(), providers: z.array(memoryBenchmarkProviderSchema).optional() }).optional() }).optional(),
  codeIntelligence: z.object({ provider: z.string(), required: z.boolean().optional(), graphPath: z.string().optional(), snapshotDir: z.string().optional(), refreshCommand: z.string().optional() }).optional(),
  sdd: z.object({ specsDir: z.string().optional(), contractsDir: z.string().optional(), reportsDir: z.string().optional(), repairsDir: z.string().optional(), runsDir: z.string().optional() }).optional(),
  validation: z.object({ baseRef: z.string().optional(), commands: z.array(validationCommandSchema).optional(), validators: z.array(validatorSpecSchema).optional(), frozenPaths: z.array(z.string()).optional(), requireSeal: z.boolean().optional(), opa: z.object({ enabled: z.boolean().optional(), policyDirs: z.array(z.string()).optional() }).optional() }).optional(),
  security: z.object({ sandbox: z.object({ provider: z.string().optional(), required: z.boolean().optional(), image: z.string().optional(), network: z.boolean().optional(), extraArgs: z.array(z.string()).optional() }).optional(), tools: z.array(z.string()).optional() }).optional(),
  telemetry: z.object({ enabled: z.boolean().optional(), required: z.boolean().optional(), localEventsFile: z.string().optional(), exporter: z.string().optional(), endpoint: z.string().optional(), headers: z.record(z.string(), z.string()).optional(), serviceName: z.string().optional() }).optional(),
  evals: z.object({ corpusDir: z.string().optional(), resultsDir: z.string().optional(), workspacesDir: z.string().optional() }).optional(),
  provenance: z.object({ outputDir: z.string().optional(), buildType: z.string().optional(), cosignKey: z.string().optional() }).optional()
});
const requirementSchema = z.object({ id: z.string().min(1), description: z.string().optional(), validator: z.string().optional(), validators: z.array(z.string()).optional() });
const taskSchema = z.object({
  version: z.literal(1), task: z.object({ id: z.string().min(1), title: z.string().min(1) }),
  source: z.object({ proposal: z.string().optional(), spec: z.string().optional(), design: z.string().optional(), tasks: z.string().optional(), acceptance: z.string().optional() }).optional(),
  git: z.object({ baseRef: z.string().optional() }).optional(), scope: z.object({ allowed: z.array(z.string()).optional(), forbidden: z.array(z.string()).optional(), frozen: z.array(z.string()).optional() }).optional(),
  routing: z.object({ intent: z.string().optional(), domains: z.array(z.string()).optional(), risk: z.enum(["low", "medium", "high"]).optional(), agent: z.string().optional(), reviewers: z.array(z.string()).optional(), profile: z.string().optional() }).optional(),
  requirements: z.array(requirementSchema).optional(), constraints: z.object({ breakingApiChanges: z.boolean().optional(), newDependencies: z.boolean().optional(), schemaChanges: z.boolean().optional(), maxFilesChanged: z.number().int().positive().optional(), maxLinesAdded: z.number().int().nonnegative().optional(), maxLinesDeleted: z.number().int().nonnegative().optional() }).optional(),
  impact: z.object({ forbiddenEdges: z.array(z.string()).optional(), forbiddenNodes: z.array(z.string()).optional(), allowedCommunities: z.array(z.string()).optional() }).optional(), repair: z.object({ maxAttempts: z.number().int().nonnegative().optional() }).optional(), verification: z.object({ commands: z.array(validationCommandSchema).optional(), validators: z.array(validatorSpecSchema).optional() }).optional()
});
export async function loadProjectConfig(root: string): Promise<HarnessProjectConfig> { return projectSchema.parse(YAML.parse(await fs.readFile(path.join(root, ".harness", "project.yaml"), "utf8"))) as HarnessProjectConfig; }
export async function loadTaskContract(root: string, taskId: string, config: HarnessProjectConfig): Promise<TaskContract> { const file = path.join(root, config.sdd?.contractsDir ?? ".harness/contracts", `${taskId}.yaml`); return taskSchema.parse(YAML.parse(await fs.readFile(file, "utf8"))) as TaskContract; }
