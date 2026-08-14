import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveChangeInputs } from "../src/operations/changeInputs.js";

afterEach(() => {
  delete process.env.AEH_OPERATION_ID;
  delete process.env.AEH_CONTROL_ROOT;
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

  it("fails before semantic work when a referenced audit is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-input-missing-"));
    await expect(resolveChangeInputs(root, "CHANGE-TEST", "Fix AUDIT-20260814T002155Z-missing1 now.")).rejects.toThrow(/CHANGE_INPUT_ARTIFACT_MISSING/);
  });

  it("ignores requests with no durable audit reference", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-input-none-"));
    await expect(resolveChangeInputs(root, "CHANGE-TEST", "Improve the request routing flow.")).resolves.toEqual([]);
  });
});
