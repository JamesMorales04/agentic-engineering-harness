import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockExecuteAgentPrompt = vi.hoisted(() => vi.fn());
const mockPrepareAgentExecutionIdentity = vi.hoisted(() => vi.fn());
const mockDispatchDistributedDelegation = vi.hoisted(() => vi.fn());
const mockRecordEvent = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../src/workers/agentPrompt.js", () => ({
  executeAgentPrompt: mockExecuteAgentPrompt,
  prepareAgentExecutionIdentity: mockPrepareAgentExecutionIdentity,
  materializeAgentPrompt: vi.fn(),
  operationArtifactRoot: vi.fn(),
  prepareAgentExecutionBinding: vi.fn(),
  prepareRuntimeSession: vi.fn(),
}));
vi.mock("../src/distributed/worker.js", () => ({
  dispatchDistributedDelegation: mockDispatchDistributedDelegation,
}));
vi.mock("../src/telemetry/events.js", () => ({
  recordEvent: mockRecordEvent,
}));

import {
  WAVE_OFF_PATCH_DENIED_EVENT_V1,
  WAVE_WORKTREE_UNREADABLE_HASH_V1,
  checkWaveUnitTurnOffPatchV1,
  checkWaveWorktreeOffPatchV1,
  createWaveOffPatchDenialV1,
  executeDelegation,
  findDistributedWaveOffPatchV1,
  findOffPatchWritesV1,
  isWaveWorktreeExcludedV1,
  listWavePatchFilesV1,
  snapshotWaveWorktreeV1,
  type WaveWorktreeSnapshotEntryV1,
} from "../src/agents/waveExecutor.js";
import { createWaveBase, integrateWaveChangeSets } from "../src/candidates/wave.js";
import type { ChangeSetV1 } from "../src/candidates/assembler.js";
import { sha256Utf8 } from "../src/core/digest.js";
import { loadOperation } from "../src/operations/state.js";
import { recordEvent } from "../src/telemetry/events.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runExecutable, runShell } from "../src/utils/process.js";

const recordEventMock = vi.mocked(recordEvent);

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  mockExecuteAgentPrompt.mockReset();
  mockPrepareAgentExecutionIdentity.mockReset();
  mockDispatchDistributedDelegation.mockReset();
  mockRecordEvent.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const TASK = "TASK-WAVE-LIVE-GATE";

function entry(overrides: Partial<WaveWorktreeSnapshotEntryV1> = {}): WaveWorktreeSnapshotEntryV1 {
  return { hash: "h1", mtimeMs: 1, size: 10, symlink: false, ctimeMs: 100, ino: 11, ...overrides };
}

function delegationFixtures(workUnitId: string, scope: string[]) {
  const task = {
    id: workUnitId,
    objective: `implement ${workUnitId}`,
    scope,
    dependencies: [],
    acceptanceRefs: [],
    requirementRefs: [],
    competencies: [],
    risk: "low",
    changeKinds: [],
    resourceClaims: [],
  } as never;
  const implementationSelection = {
    profile: "test",
    logicalAgent: "implementer",
    role: "Implementer",
    domains: [],
    runtimeName: "rt-test",
    runtimeAdapter: "test-adapter",
    paseoProvider: "test-adapter",
    modelAlias: "m-test",
    modelId: "m-test",
    modelName: "test-model",
    modelProvider: "test",
    transport: "inherit",
    temperature: 0,
    skills: [],
    mcps: [],
    args: [],
    permissions: { read: "allow", write: "allow", gitWrite: "allow", shell: "allow", network: "deny", delegate: "allow", review: "allow", validate: "allow" },
    runtimeCapabilities: {},
  } as never;
  const executionCatalog = {
    roleBindings: { Implementer: { runtimeId: "rt-test", modelAlias: "m-test" } },
    runtimeProfiles: [{ id: "rt-test", adapter: "test-adapter", capabilities: {} }],
    modelProfiles: [{ alias: "m-test", runtime: "rt-test", id: "m-test", model: "test-model", provider: "test" }],
  } as never;
  const participantAssignment = {
    participantId: `participant:${workUnitId}`,
    role: "Implementer",
    specialization: "general",
    competencies: [],
    skills: [],
    toolPack: { required: ["repository-read", "repository-write", "command-execute"], optional: [], forbidden: [] },
    budget: {},
    workUnitIds: [workUnitId],
    skillManifest: undefined,
  } as never;
  const config = { version: 1, project: { name: "fixture" } } as never;
  const contract = { task: { id: TASK }, scope: { allowed: ["**"] } } as never;
  const executionBlueprint = { digest: "test-blueprint", participants: [] } as never;
  return { task, implementationSelection, executionCatalog, participantAssignment, config, contract, executionBlueprint };
}

function okSession(logicalAgent: string) {
  return { provider: "test-worker", logicalAgent, exitCode: 0, stdout: "done", stderr: "" };
}

describe("wave live off-patch gate (FAM-WAVE residual)", () => {
  it("pure matcher flags only touched files outside scope", () => {
    const snap = new Map<string, WaveWorktreeSnapshotEntryV1>([
      ["src/a.ts", entry({ hash: "h1" })],
      ["src/b.ts", entry({ hash: "h2", ctimeMs: 100, ino: 12 })],
    ]);
    const cur = new Map<string, WaveWorktreeSnapshotEntryV1>([
      ["src/a.ts", entry({ hash: "h1x", mtimeMs: 2, size: 12 })],
      ["src/b.ts", entry({ hash: "h2", ctimeMs: 100, ino: 12 })],
      ["outside/evil.ts", entry({ hash: "he" })],
    ]);
    // Unit A claims src/a.ts: only the outside file is off-patch.
    expect(findOffPatchWritesV1({ snapshot: snap, current: cur, allowedScope: ["src/a.ts"] })).toEqual([
      "outside/evil.ts",
    ]);
    // Untouched in-scope-adjacent files are never flagged.
    expect(findOffPatchWritesV1({ snapshot: snap, current: snap, allowedScope: ["src/a.ts"] })).toEqual([]);
  });

  it("denial receipt is deterministic and stable", () => {
    const a = createWaveOffPatchDenialV1({
      operationId: "OP",
      taskId: TASK,
      workUnitId: "uB",
      participantId: "p1",
      files: ["outside/evil.ts"],
    });
    const b = createWaveOffPatchDenialV1({
      operationId: "OP",
      taskId: TASK,
      workUnitId: "uB",
      participantId: "p1",
      files: ["outside/evil.ts"],
    });
    expect(a.digest).toBe(b.digest);
    expect(a.fileCount).toBe(1);
  });

  it("two-unit wave via executeDelegation (mocked worker): unit B off-scope write is denied live, event site fires, root keeps only unit A", async () => {
    const root = await createRepo();
    const operationId = `RUN-WAVE-LIVE-${crypto.randomUUID().slice(0, 8)}`;
    const base = await createOperation(root, operationId);

    const baseInput = {
      root,
      stateRoot: root,
      operationId,
      waveBase: base,
    };
    const fixA = delegationFixtures("uA", ["src/a.ts"]);
    const fixB = delegationFixtures("uB", ["src/b.ts"]);

    // Mocked worker for unit A: writes in-scope only.
    mockExecuteAgentPrompt.mockImplementationOnce(async (worktree: string) => {
      await fs.writeFile(path.join(worktree, "src", "a.ts"), "export const a = 2;\n");
      return okSession("uA");
    });
    const resultA = await executeDelegation({ ...baseInput, ...fixA });
    expect(resultA.status).toBe("PASS");
    expect(resultA.changeSet?.changedFiles).toEqual(["src/a.ts"]);

    // Mocked worker for unit B: writes outside its claimed pathspec.
    mockExecuteAgentPrompt.mockImplementationOnce(async (worktree: string) => {
      await fs.writeFile(path.join(worktree, "outside", "evil.ts"), "export const evil = 1;\n");
      return okSession("uB");
    });
    const resultB = await executeDelegation({ ...baseInput, ...fixB });
    expect(resultB.status).toBe("FAIL");
    expect(resultB.message).toContain("OFF_PATCH_WRITE_DENIED");
    expect(resultB.changedFiles).toEqual(["outside/evil.ts"]);
    expect(resultB.patch).toBe("");
    expect(resultB.changeSet).toBeUndefined();

    // The EXECUTOR's emission site fired (not a helpers-only direct call):
    // recordEvent mock observed the denial from inside executeDelegation.
    expect(recordEventMock).toHaveBeenCalledWith(
      root,
      expect.anything(),
      WAVE_OFF_PATCH_DENIED_EVENT_V1,
      expect.objectContaining({ operationId, taskId: TASK, workUnitId: "uB", status: "FAIL", fileCount: 1 })
    );
    const denialCalls = mockRecordEvent.mock.calls.filter((call) => call[2] === WAVE_OFF_PATCH_DENIED_EVENT_V1);
    expect(denialCalls.length).toBe(1);
    expect(denialCalls[0]?.[3]).toMatchObject({ workUnitId: "uB", files: ["outside/evil.ts"] });

    // ChangeSet layer (defense-in-depth): B's escaping ChangeSet is rejected,
    // A's in-scope ChangeSet integrates; root receives only A's patch.
    const changeA = await makeChangeSet(root, base, "uA", "src/a.ts", "export const a = 2;\n");
    const changeB = await makeChangeSet(root, base, "uB", "outside/evil.ts", "export const evil = 1;\n");
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });
    const result = await integrateWaveChangeSets({
      root,
      stateRoot: root,
      operationId,
      taskId: TASK,
      wave,
      submissions: [
        { workUnitId: "uA", changeSet: changeA, allowedScope: ["src/a.ts"] },
        { workUnitId: "uB", changeSet: changeB, allowedScope: ["src/b.ts"] },
      ],
    });
    expect(result.integrated.map((s) => s.workUnitId)).toEqual(["uA"]);
    expect(result.reconciliationRequired.map((r) => r.workUnitId)).toEqual(["uB"]);
    const aContent = await fs.readFile(path.join(root, "src", "a.ts"), "utf8");
    expect(aContent).toContain("export const a = 2;");
    const evilContent = await fs.readFile(path.join(root, "outside", "evil.ts"), "utf8");
    expect(evilContent).toContain("export const evil = 0;");
  });

  it("(P1a) distributed branch denies off-scope changed files AND patch-smuggled files with denial + reconciliation routing", async () => {
    const root = await createRepo();
    const operationId = `RUN-WAVE-DIST-${crypto.randomUUID().slice(0, 8)}`;
    const base = await createOperation(root, operationId);
    const fix = delegationFixtures("uB", ["src/b.ts"]);
    const distConfig = {
      version: 1,
      project: { name: "fixture" },
      workflow: { planning: { distributed: true } },
      distributed: { enabled: true },
    } as never;
    const distAssignment = {
      ...(fix.participantAssignment as unknown as Record<string, unknown>),
      roleInvocationPolicy: { outputContract: "implementer" },
    } as never;
    mockPrepareAgentExecutionIdentity.mockImplementation(async () => ({}) as never);

    const evilPatch = [
      "diff --git a/outside/evil.ts b/outside/evil.ts",
      "--- a/outside/evil.ts",
      "+++ b/outside/evil.ts",
      "@@ -1 +1 @@",
      "-export const evil = 0;",
      "+export const evil = 1;",
    ].join("\n");
    const cleanPatch = [
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-export const b = 1;",
      "+export const b = 2;",
    ].join("\n");
    async function delegateDistributed() {
      return executeDelegation({
        root,
        stateRoot: root,
        operationId,
        config: distConfig,
        contract: fix.contract,
        implementationSelection: fix.implementationSelection,
        executionCatalog: fix.executionCatalog,
        task: fix.task,
        participantAssignment: distAssignment,
        executionBlueprint: fix.executionBlueprint,
        waveBase: base,
      });
    }
    // Case 1 (the :962 site): the changed-file list is clean so no
    // scope-escape correction triggers, but the RETURNED PATCH smuggles an
    // off-scope file — previously returned PASS here without any live-gate
    // equivalent. Now denied terminally with event + reconciliation routing.
    mockDispatchDistributedDelegation.mockResolvedValueOnce({
      version: 2,
      jobId: "j1",
      workerId: "w1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "PASS",
      session: okSession("uB"),
      changedFiles: ["src/b.ts"],
      patch: evilPatch,
      observedCandidateSourceDigest: (base as { sourceDigest?: string }).sourceDigest,
      message: "ok",
    });
    const denied = await delegateDistributed();
    expect(denied.status).toBe("FAIL");
    expect(denied.distributed).toBe(true);
    expect(denied.message).toContain("OFF_PATCH_WRITE_DENIED");
    expect(denied.message?.startsWith("WAVE_RECONCILIATION_REQUIRED")).toBe(true);
    expect(denied.changedFiles).toEqual(["outside/evil.ts"]);
    expect(denied.patch).toBe("");
    expect(denied.changeSet).toBeUndefined();
    expect(recordEventMock).toHaveBeenCalledWith(
      root,
      expect.anything(),
      WAVE_OFF_PATCH_DENIED_EVENT_V1,
      expect.objectContaining({ workUnitId: "uB", status: "FAIL", distributed: true, fileCount: 1 })
    );

    // Case 2: changed-file list names the off-scope file → the pre-existing
    // scope-escape ONE-correction path still applies (unchanged semantics);
    // a clean correction is accepted with the correction flag set.
    mockRecordEvent.mockClear();
    mockDispatchDistributedDelegation.mockResolvedValueOnce({
      version: 2,
      jobId: "j2",
      workerId: "w1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "PASS",
      session: okSession("uB"),
      changedFiles: ["outside/evil.ts"],
      patch: evilPatch,
      observedCandidateSourceDigest: (base as { sourceDigest?: string }).sourceDigest,
      message: "ok",
    });
    mockDispatchDistributedDelegation.mockResolvedValueOnce({
      version: 2,
      jobId: "j3",
      workerId: "w1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "PASS",
      session: okSession("uB"),
      changedFiles: ["src/b.ts"],
      patch: cleanPatch,
      observedCandidateSourceDigest: (base as { sourceDigest?: string }).sourceDigest,
      message: "corrected",
    });
    const corrected = await delegateDistributed();
    expect(corrected.status).toBe("PASS");
    expect(corrected.escapeCorrectionUsed).toBe(true);
    expect(corrected.changeSet?.changedFiles).toEqual(["src/b.ts"]);

    // Pure helper: patch-file extraction feeds the distributed check.
    expect(listWavePatchFilesV1(evilPatch)).toEqual(["outside/evil.ts"]);
    expect(
      findDistributedWaveOffPatchV1({ changedFiles: ["src/b.ts"], patch: evilPatch, allowedScope: ["src/b.ts"] })
    ).toEqual(["outside/evil.ts"]);
    expect(findDistributedWaveOffPatchV1({ changedFiles: ["src/b.ts"], patch: "", allowedScope: ["src/b.ts"] })).toEqual([]);
  });

  it("(P1b) unreadable regular file is denied fail-closed (in-scope or out), non-regular entries skipped", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-wave-unreadable-"));
    roots.push(dir);
    await fs.writeFile(path.join(dir, "readable.ts"), "export const ok = 1;\n");
    await fs.writeFile(path.join(dir, "secret.ts"), "export const secret = 1;\n");
    await fs.chmod(path.join(dir, "secret.ts"), 0o000);
    try {
      const snap = await snapshotWaveWorktreeV1(dir);
      // Not skipped: recorded with the unreadable sentinel.
      expect(snap.get("secret.ts")?.hash).toBe(WAVE_WORKTREE_UNREADABLE_HASH_V1);
      // Off-scope unreadable is a violation.
      expect(await checkWaveWorktreeOffPatchV1(dir, snap, ["readable.ts"])).toEqual(["secret.ts"]);
      // In-scope unreadable is STILL a violation (unprovable containment).
      expect(await checkWaveWorktreeOffPatchV1(dir, snap, ["readable.ts", "secret.ts"])).toEqual(["secret.ts"]);
    } finally {
      await fs.chmod(path.join(dir, "secret.ts"), 0o644);
    }
  });

  it("(P1b) delegation denies a newly written mode-000 file live via the executor site", async () => {
    const root = await createRepo();
    const operationId = `RUN-WAVE-UNREAD-${crypto.randomUUID().slice(0, 8)}`;
    const base = await createOperation(root, operationId);
    const fix = delegationFixtures("uB", ["src/b.ts"]);
    mockExecuteAgentPrompt.mockImplementationOnce(async (worktree: string) => {
      const target = path.join(worktree, "outside", "secret.ts");
      await fs.writeFile(target, "export const secret = 1;\n");
      await fs.chmod(target, 0o000);
      return okSession("uB");
    });
    const result = await executeDelegation({ root, stateRoot: root, operationId, waveBase: base, ...fix });
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("OFF_PATCH_WRITE_DENIED");
    expect(result.changedFiles).toEqual(["outside/secret.ts"]);
    expect(recordEventMock).toHaveBeenCalledWith(
      root,
      expect.anything(),
      WAVE_OFF_PATCH_DENIED_EVENT_V1,
      expect.objectContaining({ workUnitId: "uB", status: "FAIL" })
    );
  });

  it("(P1c) identity signals catch mtime-restored write+revert; per-invocation check catches cross-call revert", async () => {
    // Pure matcher: ctime-only or inode-only drift marks the file touched, so
    // an off-scope write+revert with restored bytes+mtime is still a
    // violation (in-scope touches stay unflagged — scope filter unchanged).
    const prev = entry({ hash: "same", mtimeMs: 5, size: 20, ctimeMs: 100, ino: 11 });
    const snap = new Map([["src/a.ts", prev]]);
    expect(
      findOffPatchWritesV1({
        snapshot: snap,
        current: new Map([["src/a.ts", { ...prev, ctimeMs: 101 }]]),
        allowedScope: ["src/a.ts"],
      })
    ).toEqual([]);
    expect(
      findOffPatchWritesV1({
        snapshot: snap,
        current: new Map([["src/a.ts", { ...prev, ctimeMs: 101 }]]),
        allowedScope: ["src/b.ts"],
      })
    ).toEqual(["src/a.ts"]);
    expect(
      findOffPatchWritesV1({
        snapshot: snap,
        current: new Map([["src/a.ts", { ...prev, ino: 12 }]]),
        allowedScope: ["src/b.ts"],
      })
    ).toEqual(["src/a.ts"]);
    expect(findOffPatchWritesV1({ snapshot: snap, current: snap, allowedScope: ["src/b.ts"] })).toEqual([]);

    // Live round-trip: write evil, restore original bytes AND mtime — the
    // end-state content compare is blind, but ctime still convicts.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-wave-revert-"));
    roots.push(dir);
    const target = path.join(dir, "src-a.ts");
    await fs.writeFile(target, "export const a = 1;\n");
    const stat0 = await fs.stat(target);
    const snap0 = await snapshotWaveWorktreeV1(dir);
    await fs.writeFile(target, "export const evil = 1;\n");
    await fs.writeFile(target, "export const a = 1;\n");
    // Exact full-precision mtime restore (floored snapshot mtimeMs agrees).
    await fs.utimes(target, stat0.atime, stat0.mtime);
    const restored = await snapshotWaveWorktreeV1(dir);
    // Content fully restored: the hash channel agrees ...
    expect(restored.get("src-a.ts")?.hash).toBe(snap0.get("src-a.ts")?.hash);
    // ... yet the gate still flags the off-scope file via ctime.
    expect(await checkWaveWorktreeOffPatchV1(dir, snap0, ["src-b.ts"])).toEqual(["src-a.ts"]);

    // Cross-call revert is caught by per-invocation pairing: the check after
    // the FIRST invocation fires while the write is still present, even
    // though a later invocation reverts to a clean end-state.
    await fs.writeFile(target, "export const evil = 1;\n");
    const afterFirstCall = await checkWaveUnitTurnOffPatchV1(dir, snap0, ["src-b.ts"]);
    expect(afterFirstCall.offPatch).toEqual(["src-a.ts"]);
    await fs.writeFile(target, "export const a = 1;\n");
    // End-state compare alone would miss a fully restored revert (absent the
    // ctime signal); the per-invocation post-check above is what guarantees
    // detection across calls. Intra-single-call write+revert with fully
    // restored bytes+mtime+ctime+inode remains the documented residual.
    expect(afterFirstCall.current.get("src-a.ts")?.hash).not.toBe(snap0.get("src-a.ts")?.hash);
  });

  it("(D23) managed-provisioned .config/mise droppings never trip OFF_PATCH_WRITE_DENIED while real escapes still deny", async () => {
    // NARROW enforcement parity: only toolchain-provisioned paths are
    // excluded (exact conf.d/aeh.toml, exact mise.lock, locks/ descendants).
    // Project-authored files (config.toml) and the bare prefix dir stay enforced.
    expect(isWaveWorktreeExcludedV1(".config/mise/conf.d/aeh.toml")).toBe(true);
    expect(isWaveWorktreeExcludedV1(".config/mise/locks/node-22.23.2")).toBe(true);
    expect(isWaveWorktreeExcludedV1(".config/mise/mise.lock")).toBe(true);
    expect(isWaveWorktreeExcludedV1(".config/mise/config.toml")).toBe(false);
    expect(isWaveWorktreeExcludedV1(".config/mise/settings.toml")).toBe(false);
    expect(isWaveWorktreeExcludedV1(".config/mise")).toBe(false);
    // Narrow: sibling .config paths are NOT provisioned.
    expect(isWaveWorktreeExcludedV1(".config/other")).toBe(false);
    expect(isWaveWorktreeExcludedV1(".config")).toBe(false);

    // Pure matcher: provisioned droppings filtered; project-authored decoy
    // and real escape kept.
    expect(
      findOffPatchWritesV1({
        snapshot: [],
        current: [
          ".config/mise/conf.d/aeh.toml",
          ".config/mise/locks/node-22.23.2",
          ".config/mise/mise.lock",
          ".config/mise/config.toml",
          ".serena/scratch.json",
          "graphify-out/x.json",
          "outside/evil.ts",
        ],
        allowedScope: ["src/a.ts"],
      })
    ).toEqual([".config/mise/config.toml", "outside/evil.ts"]);

    // Distributed helper: provisioned files in EITHER channel are filtered;
    // the project-authored decoy in either channel still denies.
    const misePatch = [
      "diff --git a/.config/mise/conf.d/aeh.toml b/.config/mise/conf.d/aeh.toml",
      "--- /dev/null",
      "+++ b/.config/mise/conf.d/aeh.toml",
      "@@ -0,0 +1 @@",
      "+[tools]",
    ].join("\n");
    const decoyPatch = [
      "diff --git a/.config/mise/config.toml b/.config/mise/config.toml",
      "--- /dev/null",
      "+++ b/.config/mise/config.toml",
      "@@ -0,0 +1 @@",
      "+[tools]",
    ].join("\n");
    expect(
      findDistributedWaveOffPatchV1({
        changedFiles: [".config/mise/conf.d/aeh.toml", ".config/mise/locks/node-22.23.2", ".config/mise/mise.lock"],
        patch: misePatch,
        allowedScope: ["src/a.ts"],
      })
    ).toEqual([]);
    expect(
      findDistributedWaveOffPatchV1({ changedFiles: [".config/mise/config.toml"], patch: decoyPatch, allowedScope: ["src/a.ts"] })
    ).toEqual([".config/mise/config.toml"]);
    expect(
      findDistributedWaveOffPatchV1({
        changedFiles: [".config/mise/conf.d/aeh.toml", "outside/evil.ts"],
        patch: misePatch,
        allowedScope: ["src/a.ts"],
      })
    ).toEqual(["outside/evil.ts"]);

    // Live: toolchain droppings written post-snapshot are invisible to the
    // gate and excluded from the walker snapshot; the decoy and a real
    // escape still deny.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-wave-d23-"));
    roots.push(dir);
    await fs.writeFile(path.join(dir, "src-a.ts"), "export const a = 1;\n");
    const snap = await snapshotWaveWorktreeV1(dir);
    await fs.mkdir(path.join(dir, ".config", "mise", "conf.d"), { recursive: true });
    await fs.writeFile(path.join(dir, ".config", "mise", "conf.d", "aeh.toml"), "[tools]\n");
    await fs.mkdir(path.join(dir, ".config", "mise", "locks"), { recursive: true });
    await fs.writeFile(path.join(dir, ".config", "mise", "locks", "node-22.23.2"), "{}\n");
    await fs.writeFile(path.join(dir, ".config", "mise", "mise.lock"), "{}\n");
    await fs.mkdir(path.join(dir, ".serena"), { recursive: true });
    await fs.writeFile(path.join(dir, ".serena", "scratch.json"), "{}\n");
    expect(await checkWaveWorktreeOffPatchV1(dir, snap, ["src-a.ts"])).toEqual([]);
    const afterDroppings = await checkWaveUnitTurnOffPatchV1(dir, snap, ["src-a.ts"]);
    expect(afterDroppings.offPatch).toEqual([]);
    const snap2 = await snapshotWaveWorktreeV1(dir);
    expect([...snap2.keys()].sort()).toEqual(["src-a.ts"]);
    // Project-authored decoy written post-snapshot trips the gate.
    await fs.writeFile(path.join(dir, ".config", "mise", "config.toml"), "[tools]\nnode = '22'\n");
    expect(await checkWaveWorktreeOffPatchV1(dir, snap, ["src-a.ts"])).toEqual([".config/mise/config.toml"]);
    // Real off-patch write alongside droppings still trips the gate.
    await fs.mkdir(path.join(dir, "outside"), { recursive: true });
    await fs.writeFile(path.join(dir, "outside", "evil.ts"), "export const evil = 1;\n");
    expect(await checkWaveWorktreeOffPatchV1(dir, snap, ["src-a.ts"])).toEqual([".config/mise/config.toml", "outside/evil.ts"]);
  });

  it("(P2) heartbeat and provider-generated scratch never read as off-patch writes", async () => {
    expect(isWaveWorktreeExcludedV1(".aeh-direct-heartbeat.json")).toBe(true);
    // R2: nested heartbeat-named files are NOT excluded (DIRECT exclusion is
    // root-only; a nested heartbeat name is an ordinary off-patch write).
    expect(isWaveWorktreeExcludedV1("outside/.aeh-direct-heartbeat.json")).toBe(false);
    expect(isWaveWorktreeExcludedV1(".serena")).toBe(true);
    expect(isWaveWorktreeExcludedV1(".serena/scratch.json")).toBe(true); // root-anchored prefix: nested scratch excluded like the DIRECT pathspec `:(exclude).serena/**`
    expect(isWaveWorktreeExcludedV1("graphify-out/x.json")).toBe(true);
    expect(isWaveWorktreeExcludedV1("src/a.ts")).toBe(false);
    // String-set matcher mode: harness-owned files filtered, real escape kept,
    // including nested heartbeat-named escapes.
    expect(
      findOffPatchWritesV1({
        snapshot: [],
        current: [".aeh-direct-heartbeat.json", ".serena", "graphify-out", "outside/evil.ts", "outside/.aeh-direct-heartbeat.json"],
        allowedScope: ["src/a.ts"],
      })
    ).toEqual(["outside/.aeh-direct-heartbeat.json", "outside/evil.ts"]);

    // Live: heartbeat refresh + provider scratch written post-snapshot are invisible.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-wave-excl-"));
    roots.push(dir);
    await fs.writeFile(path.join(dir, "src-a.ts"), "export const a = 1;\n");
    const snap = await snapshotWaveWorktreeV1(dir);
    await fs.writeFile(path.join(dir, ".aeh-direct-heartbeat.json"), '{"version":1}\n');
    await fs.mkdir(path.join(dir, ".serena"), { recursive: true });
    await fs.writeFile(path.join(dir, ".serena", "scratch.json"), "{}\n");
    await fs.mkdir(path.join(dir, "graphify-out"), { recursive: true });
    await fs.writeFile(path.join(dir, "graphify-out", "x.json"), "{}\n");
    expect(await checkWaveWorktreeOffPatchV1(dir, snap, ["src-a.ts"])).toEqual([]);
    const snap2 = await snapshotWaveWorktreeV1(dir);
    expect([...snap2.keys()].sort()).toEqual(["src-a.ts"]);
    // R2 live: a nested heartbeat-named file written post-snapshot is denied.
    await fs.mkdir(path.join(dir, "outside"), { recursive: true });
    await fs.writeFile(path.join(dir, "outside", ".aeh-direct-heartbeat.json"), "{}\n");
    expect(await checkWaveWorktreeOffPatchV1(dir, snap, ["src-a.ts"])).toEqual([
      "outside/.aeh-direct-heartbeat.json",
    ]);
  });
});

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-wave-live-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "outside"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, "src", "b.ts"), "export const b = 1;\n");
  await fs.writeFile(path.join(root, "outside", "evil.ts"), "export const evil = 0;\n");
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
  return root;
}

async function createOperation(root: string, operationId: string) {
  const now = new Date().toISOString();
  await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: TASK }, createdAt: now, updatedAt: now });
  return (await loadOperation(root, operationId)).candidateRevision!;
}

async function makeChangeSet(
  root: string,
  base: NonNullable<Awaited<ReturnType<typeof loadOperation>>["candidateRevision"]>,
  workUnitId: string,
  file: string,
  content: string
): Promise<ChangeSetV1> {
  const absolute = path.join(root, file);
  const previous = await fs.readFile(absolute, "utf8").catch(() => "");
  const indexFile = path.join(root, ".git", `aeh-test-index-${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    const readTree = await runExecutable("git", ["read-tree", "HEAD"], { cwd: root, timeoutMs: 30_000, env });
    const stageCurrent = readTree.exitCode === 0 ? await runExecutable("git", ["add", "-A"], { cwd: root, timeoutMs: 30_000, env }) : readTree;
    const baseTree = stageCurrent.exitCode === 0 ? await runExecutable("git", ["write-tree"], { cwd: root, timeoutMs: 30_000, env }) : stageCurrent;
    if (baseTree.exitCode !== 0 || !baseTree.stdout.trim()) throw new Error(`test base snapshot failed: ${baseTree.stderr || baseTree.stdout}`);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
    const stageChange = await runExecutable("git", ["add", "-A", "--", file], { cwd: root, timeoutMs: 30_000, env });
    if (stageChange.exitCode !== 0) throw new Error(`test change staging failed: ${stageChange.stderr || stageChange.stdout}`);
    const diff = await runExecutable("git", ["diff", "--cached", "--binary", baseTree.stdout.trim(), "--", file], { cwd: root, timeoutMs: 30_000, env });
    if (diff.exitCode !== 0 || !diff.stdout.trim()) throw new Error(`test patch generation failed: ${diff.stderr || diff.stdout}`);
    return {
      version: 1,
      operationId: base.operationId,
      taskId: base.taskId!,
      workUnitId,
      participantId: `participant:${workUnitId}`,
      baseCandidateRevision: base.revision,
      baseCandidateDigest: base.identityDigest,
      changedFiles: [file],
      patch: diff.stdout,
      patchDigest: sha256Utf8(diff.stdout),
    };
  } finally {
    await fs.writeFile(absolute, previous);
    await fs.rm(indexFile, { force: true }).catch(() => undefined);
  }
}
