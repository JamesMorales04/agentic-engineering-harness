import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const operationMocks = vi.hoisted(() => ({
  startDetachedOperation: vi.fn(),
  realStartDetachedOperation: null as unknown,
  spawnOperationMonitor: vi.fn(),
  inspectPaseoNativeAgent: vi.fn()
}));

vi.mock("../src/operations/controller.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/controller.js")>();
  operationMocks.realStartDetachedOperation = actual.startDetachedOperation;
  operationMocks.startDetachedOperation.mockImplementation(actual.startDetachedOperation);
  return { ...actual, startDetachedOperation: operationMocks.startDetachedOperation };
});

vi.mock("../src/operations/monitorProcess.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/monitorProcess.js")>();
  return { ...actual, spawnOperationMonitor: operationMocks.spawnOperationMonitor };
});

vi.mock("../src/paseo/native.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/paseo/native.js")>();
  return { ...actual, inspectPaseoNativeAgent: operationMocks.inspectPaseoNativeAgent };
});

import { handleOperationMcpRequest } from "../src/operations/mcp.js";
import type { OperationKind, OperationPayload } from "../src/operations/state.js";
import type { StartOperationOptions } from "../src/operations/controller.js";
import { loadOperation } from "../src/operations/state.js";

const roots: string[] = [];
const previousRoot = process.env.AEH_CONTROL_ROOT;
const previousAgent = process.env.PASEO_AGENT_ID;
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.AEH_CONTROL_ROOT; else process.env.AEH_CONTROL_ROOT = previousRoot;
  if (previousAgent === undefined) delete process.env.PASEO_AGENT_ID; else process.env.PASEO_AGENT_ID = previousAgent;
  operationMocks.startDetachedOperation.mockReset();
  operationMocks.spawnOperationMonitor.mockReset();
  operationMocks.inspectPaseoNativeAgent.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("operation MCP error provenance", () => {
  it("retains the created operation identity when a post-create start step throws ENOENT", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-tool-postcreate-"));
    roots.push(root);
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "project.yaml"), "version: 1\nproject:\n  name: demo\norchestration:\n  provider: paseo\n");
    process.env.AEH_CONTROL_ROOT = root;
    process.env.PASEO_AGENT_ID = "lead-postcreate";
    operationMocks.inspectPaseoNativeAgent.mockResolvedValue({ lastUserMessageAt: "2026-10-03T12:00:00.000Z" });
    operationMocks.spawnOperationMonitor.mockRejectedValue(Object.assign(new Error("monitor entry disappeared"), { code: "ENOENT" }));

    const realStart = operationMocks.realStartDetachedOperation as typeof import("../src/operations/controller.js").startDetachedOperation;
    operationMocks.startDetachedOperation.mockImplementationOnce((
      startRoot: string,
      kind: OperationKind,
      payload: OperationPayload,
      options: StartOperationOptions
    ) => realStart(startRoot, kind, payload, {
      ...options,
      spawnProcess: (() => ({ pid: 9876, once: () => undefined, unref: () => undefined })) as never
    }));

    const result = await handleOperationMcpRequest({
      jsonrpc: "2.0", id: "reused-jsonrpc-id", method: "tools/call",
      params: {
        name: "aeh_operation_start_audit",
        arguments: {
          request: "Review the operation runtime behavior.",
          operationIntent: { version: 1, requestedOutcome: "Produce a bounded audit result." }
        }
      }
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({
      version: 1,
      code: "OPERATION_START_FAILED_AFTER_CREATE",
      category: "CONTROLLER_STATE",
      path: "operationId",
      operationCreated: true,
      relationship: "CURRENT_OPERATION",
      recoverable: false,
      retryDisposition: "DO_NOT_RETRY",
      relatedOperationId: expect.any(String)
    });
    const operationId = structured.relatedOperationId as string;
    await expect(loadOperation(root, operationId)).resolves.toMatchObject({ id: operationId });
  });
});
