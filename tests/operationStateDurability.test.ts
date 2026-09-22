import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadOperation, operationEventsFile, operationFile, patchOperation, saveOperation } from "../src/operations/state.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function seededOperation(): Promise<{ root: string; stateFile: string; eventFile: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-outbox-"));
  roots.push(root);
  const now = "2026-09-23T00:00:00.000Z";
  const record = {
    version: 1 as const,
    id: "OUTBOX-1",
    kind: "audit" as const,
    status: "RUNNING" as const,
    phase: "review",
    root,
    payload: { request: "review" },
    createdAt: now,
    updatedAt: now
  };
  await saveOperation(root, record);
  return { root, stateFile: operationFile(root, record.id), eventFile: operationEventsFile(root, record.id) };
}

describe("durable operation event outbox", () => {
  it("recovers the event after the state replacement succeeds but event persistence fails", async () => {
    const { root, stateFile, eventFile } = await seededOperation();
    const initialLog = await fs.readFile(eventFile, "utf8");

    // A directory at the event-file path makes event persistence fail after the
    // new state and its private outbox marker have already been atomically saved.
    await fs.rm(eventFile);
    await fs.mkdir(eventFile);
    await expect(patchOperation(root, "OUTBOX-1", { phase: "reviewing" })).rejects.toThrow();
    const interrupted = JSON.parse(await fs.readFile(stateFile, "utf8")) as { revision: number; _pendingOperationEvent?: { type: string; phase: string } };
    expect(interrupted).toMatchObject({ revision: 2, _pendingOperationEvent: { type: "operation.updated", phase: "reviewing" } });

    await fs.rm(eventFile, { recursive: true });
    // Preserve the original event and simulate a torn append at the boundary.
    await fs.writeFile(eventFile, `${initialLog}{"version":1`);
    const recovered = await loadOperation(root, "OUTBOX-1");
    const lines = (await fs.readFile(eventFile, "utf8")).trim().split("\n");
    const events = lines.map((line) => JSON.parse(line) as { type: string; revision: number; phase: string });

    expect(recovered).toMatchObject({ revision: 2, phase: "reviewing" });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "operation.updated", revision: 2, phase: "reviewing" });
    expect(JSON.parse(await fs.readFile(stateFile, "utf8"))).not.toHaveProperty("_pendingOperationEvent");
  });

  it("does not duplicate an event when the process fails after append and before clearing the outbox", async () => {
    const { root, stateFile, eventFile } = await seededOperation();
    const originalRename = fs.rename.bind(fs);
    let stateReplacements = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (String(destination) === stateFile && ++stateReplacements === 2) throw new Error("injected crash before outbox clear");
      return originalRename(source, destination);
    });

    await expect(patchOperation(root, "OUTBOX-1", { phase: "reviewing" })).rejects.toThrow("injected crash");
    vi.restoreAllMocks();
    const eventsBeforeRecovery = (await fs.readFile(eventFile, "utf8")).trim().split("\n");
    expect(eventsBeforeRecovery).toHaveLength(2);
    expect(JSON.parse(await fs.readFile(stateFile, "utf8"))).toHaveProperty("_pendingOperationEvent.type", "operation.updated");

    const recovered = await loadOperation(root, "OUTBOX-1");
    const eventsAfterRecovery = (await fs.readFile(eventFile, "utf8")).trim().split("\n");
    expect(recovered).toMatchObject({ revision: 2, phase: "reviewing" });
    expect(eventsAfterRecovery).toHaveLength(2);
    expect(JSON.parse(await fs.readFile(stateFile, "utf8"))).not.toHaveProperty("_pendingOperationEvent");
  });
});
