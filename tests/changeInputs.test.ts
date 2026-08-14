import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveChangeInputs } from "../src/operations/changeInputs.js";

// resolveOperationStateRoot honors AEH_OPERATION_ID + AEH_CONTROL_ROOT when the
// process runs inside a controller context. Isolate the tests from any ambient
// values so they always exercise the passed-in control root deterministically.
const AMBIENT_AEH_ENV = ["AEH_OPERATION_ID", "AEH_CONTROL_ROOT"] as const;
const ambientAehEnv: Partial<Record<(typeof AMBIENT_AEH_ENV)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of AMBIENT_AEH_ENV) {
    ambientAehEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of AMBIENT_AEH_ENV) {
    const saved = ambientAehEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

describe("CHANGE durable inputs", () => {
  it("freezes a referenced audit with provenance and sha256", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-input-"));
    const auditId = "AUDIT-20260814T002155Z-47fdeae2";
    const payload = {
      status: "DEGRADED",
      summary: "Audit summary",
      consolidatedFindings: [
        { id: "CON-001" },
        { id: "CON-002" }
      ],
      unresolved: ["product decision"]
    };
    const raw = `${JSON.stringify(payload, null, 2)}\n`;
    await fs.mkdir(path.join(root, ".harness", "audits"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "audits", `${auditId}.json`), raw);

    const inputs = await resolveChangeInputs(root, "CHANGE-TEST", `Fix all findings from ${auditId}.`);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual(expect.objectContaining({
      id: auditId,
      kind: "audit",
      sourceArtifact: `.harness/audits/${auditId}.json`,
      sha256: crypto.createHash("sha256").update(raw).digest("hex")
    }));
    expect(inputs[0].summary).toEqual(expect.objectContaining({ findingCount: 2, findingIds: ["CON-001", "CON-002"] }));
    const frozen = JSON.parse(await fs.readFile(path.join(root, inputs[0].artifact), "utf8")) as { payload: unknown; input: { sha256: string } };
    expect(frozen.payload).toEqual(payload);
    expect(frozen.input.sha256).toBe(inputs[0].sha256);
  });

  it("normalizes .json-suffixed references to the same artifact as the bare id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-input-normalize-"));
    const auditId = "AUDIT-20260814T002155Z-47fdeae2";
    const payload = { status: "CLEAN", summary: "No findings" };
    const raw = `${JSON.stringify(payload, null, 2)}\n`;
    await fs.mkdir(path.join(root, ".harness", "audits"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "audits", `${auditId}.json`), raw);

    const withExtension = await resolveChangeInputs(root, "CHANGE-TEST", `Fix findings from ${auditId}.json.`);
    const withoutExtension = await resolveChangeInputs(root, "CHANGE-TEST", `Fix findings from ${auditId}.`);

    expect(withExtension).toHaveLength(1);
    expect(withoutExtension).toHaveLength(1);
    // The id is canonicalized without the .json extension.
    expect(withExtension[0].id).toBe(auditId);
    expect(withExtension[0]).toEqual(withoutExtension[0]);
    expect(withExtension[0].sourceArtifact).toBe(`.harness/audits/${auditId}.json`);
    expect(withExtension[0].artifact).toBe(withoutExtension[0].artifact);

    // The frozen envelope keeps the id without the extension.
    const frozen = JSON.parse(await fs.readFile(path.join(root, withExtension[0].artifact), "utf8")) as { input: { id: string; kind: string }; payload: unknown };
    expect(frozen.input.id).toBe(auditId);
    expect(frozen.input.kind).toBe("audit");
    expect(frozen.payload).toEqual(payload);
  });

  it("deduplicates references given with and without the .json extension", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-input-dedupe-"));
    const auditId = "AUDIT-20260814T002155Z-47fdeae2";
    await fs.mkdir(path.join(root, ".harness", "audits"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "audits", `${auditId}.json`), `${JSON.stringify({ status: "CLEAN" })}\n`);

    const inputs = await resolveChangeInputs(root, "CHANGE-TEST", `Use ${auditId} and ${auditId}.json.`);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].id).toBe(auditId);
  });

  it("fails before semantic work when a referenced audit is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-input-missing-"));
    await expect(resolveChangeInputs(root, "CHANGE-TEST", "Fix AUDIT-20260814T002155Z-missing1 now.")).rejects.toThrow(/CHANGE_INPUT_ARTIFACT_MISSING/);
  });

  it("still fails with CHANGE_INPUT_ARTIFACT_MISSING for nonexistent .json-suffixed references", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-input-missing-json-"));
    await expect(resolveChangeInputs(root, "CHANGE-TEST", "Fix AUDIT-20260814T002155Z-missing1.json now.")).rejects.toThrow(/CHANGE_INPUT_ARTIFACT_MISSING/);
  });

  it("ignores requests with no durable audit reference", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-input-none-"));
    await expect(resolveChangeInputs(root, "CHANGE-TEST", "Improve the request routing flow.")).resolves.toEqual([]);
  });
});
