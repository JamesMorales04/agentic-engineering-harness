import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Canonical } from "../src/core/digest.js";
import {
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
  applyRepairScopeAmendment,
  createRepairScopeBlockerReceipt,
  listRepairScopeAmendments,
  repairScopeAmendmentPath,
} from "../src/candidates/repairScope.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { runShell } from "../src/utils/process.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/**
 * Luna blocker (pr/amendment-exact-paths): amendment scanning stops at the
 * first ENOENT, so a numbering gap (amendment 1 absent, valid amendment 2
 * present) scans as "none" and admission writes amendment 1 — bypassing the
 * one-amendment limit. These tests pin the gap fixture: the scan must see
 * past the gap and admission must reject against the true discovered set.
 */
describe("repair scope amendment gap tolerance (numbering-gap bypass)", () => {
  it("scan discovers a higher-numbered amendment past a missing lower index", async () => {
    const root = await createRepo();
    const config = projectConfig();
    await writeGapAmendment(root, "REPAIR-GAP", 2, "op-gap");
    const found = await listRepairScopeAmendments(root, config, "REPAIR-GAP");
    expect(found).toHaveLength(1);
    expect(found[0]!.amendmentPath).toContain("scope-amendment-2.json");
  });

  it("admission rejects a second amendment when a gap hides the prior one", async () => {
    const root = await createRepo();
    const task = contract();
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const operationId = "CHANGE-REPAIR-GAP-1";
    // Gap fixture: amendment 1 absent, valid amendment 2 present. The
    // one-amendment limit is already exhausted; admission must fail closed
    // instead of writing amendment 1.
    await writeGapAmendment(root, task.task.id, 2, operationId);
    const blocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: task.task.id,
      workUnitId: "W1",
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
    });
    const binding = syntheticBinding(operationId);
    const ledgerDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-gap-ledger-"));
    roots.push(ledgerDir);
    const ledger = new HumanDecisionLedgerV2(ledgerDir);
    const requestId = "request:repair-scope-gap-1";
    const decision = await ledger.recordProductChoice(
      {
        ...binding,
        purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
        kind: "CHOOSE",
        actorId: "human:control-center:test",
        reason: "gap-fixture second approval attempt",
      },
      requestId,
    );
    await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
    await expect(
      applyRepairScopeAmendment({
        root,
        config,
        contract: task,
        blocker,
        authorization: { decision, binding, requestId },
        ledger,
      }),
    ).rejects.toThrow(/Only 1 repair scope amendment\(s\) per task/);
    // No second amendment file may have been written into the gap.
    await expect(fs.stat(repairScopeAmendmentPath(root, task.task.id, 1))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("scan fails closed on an unaccountable amendment-like file (no silent truncation)", async () => {
    const root = await createRepo();
    const config = projectConfig();
    const sibling = repairScopeAmendmentPath(root, "REPAIR-GAP", 1).replace("-1.json", "-evil.json");
    await fs.mkdir(path.dirname(sibling), { recursive: true });
    await fs.writeFile(sibling, "{}\n");
    await expect(listRepairScopeAmendments(root, config, "REPAIR-GAP")).rejects.toThrow(
      /REPAIR_SCOPE_AMENDMENT_SCAN_INVALID/,
    );
  });
});

async function writeGapAmendment(root: string, taskId: string, index: number, operationId: string): Promise<void> {
  const amendmentPath = repairScopeAmendmentPath(root, taskId, index);
  const body = {
    version: 1 as const,
    mechanism: "DETERMINISTIC" as const,
    operationId,
    taskId,
    blockerDigest: "a".repeat(64),
    exemptedPaths: ["package-lock.json"],
    decidedBy: "human" as const,
    decisionReason: "gap-fixture prior approval",
    decidedAt: "2026-01-01T00:00:00.000Z",
    decisionId: "decision:12345678-1234-1234-1234-123456789012",
    requestId: "request:gap-fixture-1",
    decidedActor: "human:control-center:test",
    amendedScope: ["package-lock.json", "src/**"],
    contractPath: `.harness/contracts/${taskId}.yaml`,
    sealPath: `.harness/seals/${taskId}.json`,
    amendmentPath: path.relative(root, amendmentPath).replaceAll("\\", "/"),
  };
  const amendment = { ...body, amendmentDigest: sha256Canonical(body) };
  await fs.mkdir(path.dirname(amendmentPath), { recursive: true });
  await fs.writeFile(amendmentPath, `${JSON.stringify(amendment, null, 2)}\n`);
}

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-gap-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "acceptance"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "package-lock.json"), '{"lockfileVersion":1}\n');
  await fs.writeFile(path.join(root, "acceptance", "flow.feature"), "Then the value is correct\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", {
    cwd: root,
  });
  return root;
}

async function writeContractAndSeal(root: string, config: HarnessProjectConfig, task: TaskContract): Promise<void> {
  const { default: YAML } = await import("yaml");
  const dir = path.join(root, config.sdd?.contractsDir ?? ".harness/contracts");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${task.task.id}.yaml`), YAML.stringify(task));
  const { sealTask } = await import("../src/core/seal.js");
  await fs.mkdir(path.join(root, "specs", "changes", task.task.id), { recursive: true });
  await fs.writeFile(path.join(root, "specs", "changes", task.task.id, "proposal.md"), "# proposal\n");
  await fs.writeFile(path.join(root, "specs", "changes", task.task.id, "spec.md"), "# spec\n");
  await sealTask(root, config, task);
}

function syntheticBinding(operationId: string) {
  return {
    operationId,
    candidate: createCandidateRevisionV1({ operationId, candidateId: `candidate:${operationId}:r1`, revision: 1, sourceDigest: "a".repeat(64) }),
    operationExecutionRevision: 1,
    policyDigest: "b".repeat(64),
    controllerEpoch: 0,
  };
}

function projectConfig(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "repair-gap-test" },
    sdd: { contractsDir: ".harness/contracts" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    telemetry: { enabled: false },
  };
}

function contract(): TaskContract {
  return {
    version: 1,
    task: { id: "REPAIR-GAP", title: "Repair needs lockfile" },
    source: { proposal: "specs/changes/REPAIR-GAP/proposal.md", spec: "specs/changes/REPAIR-GAP/spec.md" },
    git: { baseRef: "HEAD" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { route: "DELEGATED", assurance: "STANDARD" },
    verification: { commands: [] },
  };
}
