import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProject } from "../src/core/init.js";
import { executeOperation } from "../src/operations/controller.js";
import { loadOperationPortfolio } from "../src/operations/portfolio.js";
import {
  claimControllerEpoch,
  loadOperation,
  operationEventsFile,
  saveOperation,
  type OperationEvent,
  type OperationRecordV2
} from "../src/operations/state.js";
import { readManagedRuntimeSnapshot } from "../src/runtime/managed.js";
import { listManagedProcessHandles } from "../src/utils/process.js";

const operationEnvironmentKeys = [
  "AEH_CONTROL_ROOT",
  "AEH_OPERATION_ID",
  "AEH_OPERATION_KIND",
  "AEH_OPERATION_STATE_REDIRECT",
  "AEH_OPERATION_WORKSPACE_ID",
  "AEH_CONTROLLER_EPOCH",
  "AEH_CONTROLLER_TOKEN",
  "GIT_CEILING_DIRECTORIES"
] as const;

const roots: string[] = [];
let previousEnvironment: Record<string, string | undefined> = {};

afterEach(async () => {
  for (const key of operationEnvironmentKeys) {
    const value = previousEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnvironment = {};
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function queuedChangeOperation(root: string, id: string, request: string): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id,
    kind: "change",
    status: "QUEUED",
    phase: "queued",
    root,
    payload: { request },
    revision: 1,
    operationExecutionRevision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    intent: { request, classification: "CHANGE", priority: 50 },
    supervision: { required: true, materialized: false, generations: [] },
    stages: { queued: { name: "queued", status: "RUNNING", revision: 1, startedAt: now } },
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  };
}

async function readOperationEvents(root: string, operationId: string): Promise<OperationEvent[]> {
  const text = await fs.readFile(operationEventsFile(root, operationId), "utf8");
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as OperationEvent);
}

describe("operation startup failure regression", () => {
  it("fenced-fails a claimed RUNNING operation when the configured Git base ref is unresolvable", async () => {
    previousEnvironment = Object.fromEntries(operationEnvironmentKeys.map((key) => [key, process.env[key]]));
    for (const key of operationEnvironmentKeys) delete process.env[key];

    // Production-initialized temporary project, deliberately left non-Git so
    // the configured base ref can never resolve.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-startup-failure-"));
    roots.push(root);
    await initializeProject(root);
    // Keep Git from discovering a repository above the temporary root.
    process.env.GIT_CEILING_DIRECTORIES = root;

    const projectName = "startup-failure-regression";
    const configuredBaseRef = "refs/heads/aeh-startup-failure-missing";
    await fs.writeFile(
      path.join(root, ".harness", "project.yaml"),
      `version: 1\nproject:\n  name: ${projectName}\nvalidation:\n  baseRef: ${configuredBaseRef}\n`,
      "utf8"
    );

    const operation = queuedChangeOperation(root, "CHANGE-STARTUP-FAILURE", "exercise startup failure finalization");
    await saveOperation(root, operation);
    const owned = await claimControllerEpoch(root, operation.id, `controller:test:${operation.id}`);
    expect(owned.status).toBe("QUEUED");
    expect(owned.controller?.epoch).toBeGreaterThan(0);

    const result = await executeOperation(root, operation.id);

    const diagnostic = `No resolvable Git base ref found; configured baseRef=${configuredBaseRef}.`;
    expect(result.status).toBe("FAILED");
    expect(result.phase).toBe("failed");
    expect(result.error).toContain(diagnostic);

    const events = await readOperationEvents(root, operation.id);
    expect(events.some((event) => event.status === "RUNNING" && event.revision < result.revision)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      version: 1,
      operationId: operation.id,
      type: "operation.terminal",
      status: "FAILED",
      phase: "failed",
      revision: result.revision
    });

    const portfolio = await loadOperationPortfolio(root, projectName);
    expect(portfolio.project).toBe(projectName);
    expect(portfolio.operations[operation.id]).toMatchObject({
      operationId: operation.id,
      kind: "change",
      status: "FAILED",
      phase: "failed",
      revision: result.revision,
      updatedAt: result.updatedAt
    });

    expect(result.participants).toEqual({});
    expect(result.participantReceipts ?? {}).toEqual({});
    expect(await listManagedProcessHandles(root, operation.id)).toEqual([]);
    expect((await readManagedRuntimeSnapshot(root)).providerLeases).toEqual([]);
    expect((await loadOperation(root, operation.id)).status).toBe("FAILED");
  });
});
