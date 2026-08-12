import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { HarnessProjectConfig, TaskContract } from "./types.js";

const validationCommandSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  required: z.boolean().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  workingDirectory: z.string().optional()
});

const validatorSpecSchema = z.object({
  id: z.string().min(1),
  adapter: z.string().min(1),
  command: z.string().min(1).optional(),
  required: z.boolean().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  workingDirectory: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional()
});

const projectSchema = z.object({
  version: z.literal(1),
  project: z.object({ name: z.string().min(1) }),
  orchestration: z.object({
    provider: z.string(),
    required: z.boolean().optional(),
    worker: z.object({
      provider: z.string().optional(),
      model: z.string().optional(),
      maxRepairAttempts: z.number().int().nonnegative().optional(),
      timeoutSeconds: z.number().int().positive().optional(),
      titlePrefix: z.string().optional()
    }).optional()
  }).optional(),
  memory: z.object({ provider: z.string(), required: z.boolean().optional() }).optional(),
  codeIntelligence: z.object({
    provider: z.string(),
    required: z.boolean().optional(),
    graphPath: z.string().optional(),
    snapshotDir: z.string().optional(),
    refreshCommand: z.string().optional()
  }).optional(),
  sdd: z.object({
    specsDir: z.string().optional(),
    contractsDir: z.string().optional(),
    reportsDir: z.string().optional(),
    repairsDir: z.string().optional(),
    runsDir: z.string().optional()
  }).optional(),
  validation: z.object({
    baseRef: z.string().optional(),
    commands: z.array(validationCommandSchema).optional(),
    validators: z.array(validatorSpecSchema).optional(),
    frozenPaths: z.array(z.string()).optional(),
    requireSeal: z.boolean().optional(),
    opa: z.object({
      enabled: z.boolean().optional(),
      policyDirs: z.array(z.string()).optional()
    }).optional()
  }).optional(),
  security: z.object({
    sandbox: z.object({
      provider: z.string().optional(),
      required: z.boolean().optional(),
      image: z.string().optional(),
      network: z.boolean().optional(),
      extraArgs: z.array(z.string()).optional()
    }).optional(),
    tools: z.array(z.string()).optional()
  }).optional(),
  telemetry: z.object({
    enabled: z.boolean().optional(),
    localEventsFile: z.string().optional()
  }).optional()
});

const requirementSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  validator: z.string().optional(),
  validators: z.array(z.string()).optional()
});

const taskSchema = z.object({
  version: z.literal(1),
  task: z.object({ id: z.string().min(1), title: z.string().min(1) }),
  source: z.object({
    proposal: z.string().optional(),
    spec: z.string().optional(),
    design: z.string().optional(),
    tasks: z.string().optional(),
    acceptance: z.string().optional()
  }).optional(),
  git: z.object({ baseRef: z.string().optional() }).optional(),
  scope: z.object({
    allowed: z.array(z.string()).optional(),
    forbidden: z.array(z.string()).optional(),
    frozen: z.array(z.string()).optional()
  }).optional(),
  requirements: z.array(requirementSchema).optional(),
  constraints: z.object({
    breakingApiChanges: z.boolean().optional(),
    newDependencies: z.boolean().optional(),
    schemaChanges: z.boolean().optional(),
    maxFilesChanged: z.number().int().positive().optional(),
    maxLinesAdded: z.number().int().nonnegative().optional(),
    maxLinesDeleted: z.number().int().nonnegative().optional()
  }).optional(),
  impact: z.object({
    forbiddenEdges: z.array(z.string()).optional(),
    forbiddenNodes: z.array(z.string()).optional(),
    allowedCommunities: z.array(z.string()).optional()
  }).optional(),
  repair: z.object({ maxAttempts: z.number().int().nonnegative().optional() }).optional(),
  verification: z.object({
    commands: z.array(validationCommandSchema).optional(),
    validators: z.array(validatorSpecSchema).optional()
  }).optional()
});

export async function loadProjectConfig(root: string): Promise<HarnessProjectConfig> {
  const file = path.join(root, ".harness", "project.yaml");
  const raw = await fs.readFile(file, "utf8");
  return projectSchema.parse(YAML.parse(raw)) as HarnessProjectConfig;
}

export async function loadTaskContract(root: string, taskId: string, config: HarnessProjectConfig): Promise<TaskContract> {
  const contractsDir = config.sdd?.contractsDir ?? ".harness/contracts";
  const file = path.join(root, contractsDir, `${taskId}.yaml`);
  const raw = await fs.readFile(file, "utf8");
  return taskSchema.parse(YAML.parse(raw)) as TaskContract;
}
